import path from 'node:path';
import express, { NextFunction, Request, Response, Router } from 'express';
import { cfg } from '../../config';
import { audit, getSetting, pool, q, setSetting } from '../../db';
import { returnToAI, takeover } from '../handoff';
import { sendText } from '../whatsapp/client';
import { canSendFreeForm } from '../whatsapp/rules';
import { authenticateBasic } from './auth';
import { clampLimit, parseBeforeId } from './pagination';

export const admin = Router();

// public liveness check for Docker/Traefik
admin.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
});

// HTTP Basic auth over HTTPS. Two independent accounts: the human admin, and an optional
// service-to-service credential (e.g. the VisionPro WhatsApp bridge) — see config.ts/auth.ts.
// Add a users/roles table only if real multi-staff logins are ever needed.
function auth(req: Request, res: Response, next: NextFunction) {
  const matchedUser = authenticateBasic(req.header('authorization'), [
    { user: cfg.adminUser, password: cfg.adminPassword },
    { user: cfg.bridgeUser, password: cfg.bridgePassword },
  ]);
  if (matchedUser) {
    (req as any).user = matchedUser;
    return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="admin"').sendStatus(401);
}
admin.use(auth);
admin.use(express.json({ limit: '200kb' }));
const who = (req: Request) => (req as any).user as string;

admin.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// `limit` is optional (defaults to 100, capped at 500) — omitting it is byte-for-byte the same
// query admin.html has always sent; a higher explicit limit exists for the WhatsApp bridge,
// which needs to see further down the active-conversation list than the dashboard's default
// view ever did (see docs/ VisionPro Phase 1 plan's note on this 100-conversation cap).
admin.get('/api/conversations', async (req, res) => {
  const limit = clampLimit(req.query.limit, 100, 500);
  res.json(await q(`
    SELECT c.id, c.mode, c.last_message_at, c.assigned_user, cu.wa_id, cu.display_name,
      (SELECT COALESCE(text, transcription) FROM messages m WHERE m.conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_text,
      (SELECT reason FROM handoffs h WHERE h.conversation_id=c.id AND h.status='PENDING' ORDER BY id DESC LIMIT 1) AS handoff_reason
    FROM conversations c JOIN customers cu ON cu.id=c.customer_id ORDER BY c.last_message_at DESC LIMIT $1`, [limit]));
});

// `limit`/`before_id` are optional (default 200/none, limit capped at 500) — omitting both is
// byte-for-byte the same query admin.html has always sent. `before_id` (a message's own bigint
// id) lets a caller page backward past the default 200-message window — the WhatsApp bridge
// uses this to backfill a conversation's older history instead of silently losing it.
admin.get('/api/conversations/:id', async (req, res) => {
  const limit = clampLimit(req.query.limit, 200, 500);
  const beforeId = parseBeforeId(req.query.before_id);
  res.json(await q(
    `SELECT id, direction, sender_type, message_type, text, transcription, delivery_status, processing_status, error, created_at
     FROM messages WHERE conversation_id=$1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
    [req.params.id, beforeId, limit],
  ).then((r) => r.reverse()));
});

admin.post('/api/conversations/:id/takeover', async (req, res) => { await takeover(Number(req.params.id), who(req)); res.json({ ok: true }); });
admin.post('/api/conversations/:id/return-to-ai', async (req, res) => { await returnToAI(Number(req.params.id), who(req)); res.json({ ok: true }); });

admin.post('/api/conversations/:id/messages', async (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return void res.status(400).json({ error: 'empty' });
  const c = (await q(`SELECT c.id, c.last_inbound_at, cu.wa_id FROM conversations c JOIN customers cu ON cu.id=c.customer_id WHERE c.id=$1`, [req.params.id]))[0];
  if (!c) return void res.sendStatus(404);
  if (!canSendFreeForm(c.last_inbound_at)) return void res.status(409).json({ error: '24h window closed: only an approved template can be sent' });
  const waId = await sendText(c.wa_id, text);
  await q(`INSERT INTO messages(conversation_id, whatsapp_message_id, direction, sender_type, message_type, text, delivery_status) VALUES($1,$2,'OUT','HUMAN','TEXT',$3,'sent')`, [c.id, waId, text]);
  await q(`UPDATE conversations SET last_message_at=now() WHERE id=$1`, [c.id]);
  await audit(who(req), 'message.send', 'conversation', c.id, null, { text });
  res.json({ ok: true });
});

// global kill switch, effective before the next AI send
admin.post('/api/agent/pause', async (req, res) => { await setSetting('ai_enabled', false, who(req)); res.json({ ai_enabled: false }); });
admin.post('/api/agent/resume', async (req, res) => { await setSetting('ai_enabled', true, who(req)); res.json({ ai_enabled: true }); });
admin.get('/api/agent-settings', async (_req, res) => {
  res.json({
    ai_enabled: await getSetting('ai_enabled', true),
    voice_notes_enabled: await getSetting('voice_notes_enabled', true),
    extra_instructions: await getSetting('extra_instructions', ''),
    // Honest, boot-time signal only — "the four env vars are non-empty", never a claim that the
    // token is actually valid (that needs a live Graph API call; see scripts/check_meta_credentials.ts,
    // deliberately not run on every status poll).
    meta_configured: Boolean(cfg.graphVersion && cfg.appSecret && cfg.phoneNumberId && cfg.accessToken),
  });
});
admin.patch('/api/agent-settings', async (req, res) => {
  for (const k of ['voice_notes_enabled', 'extra_instructions']) if (k in (req.body ?? {})) await setSetting(k, req.body[k], who(req));
  res.json({ ok: true });
});

// knowledge + vocabulary CRUD; "delete" = archive, every change audited with old/new
function crud(name: string, table: string, cols: string[], jsonCols: string[] = []) {
  admin.get(`/api/${name}`, async (_req, res) => res.json(await q(`SELECT * FROM ${table} ORDER BY id DESC LIMIT 500`)));
  admin.post(`/api/${name}`, async (req, res) => {
    const vals = cols.map((c) => (jsonCols.includes(c) ? JSON.stringify(req.body[c] ?? []) : req.body[c] ?? null));
    const r = await q(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, vals);
    await audit(who(req), `${name}.create`, table, r[0].id, null, r[0]);
    res.json(r[0]);
  });
  admin.put(`/api/${name}/:id`, async (req, res) => {
    const old = (await q(`SELECT * FROM ${table} WHERE id=$1`, [req.params.id]))[0];
    if (!old) return void res.sendStatus(404);
    const vals = cols.map((c) => (c in req.body ? (jsonCols.includes(c) ? JSON.stringify(req.body[c]) : req.body[c]) : old[c]));
    const r = await q(`UPDATE ${table} SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(',')}, updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id, ...vals]);
    await audit(who(req), `${name}.update`, table, req.params.id, old, r[0]);
    res.json(r[0]);
  });
  admin.delete(`/api/${name}/:id`, async (req, res) => {
    const old = (await q(`SELECT * FROM ${table} WHERE id=$1`, [req.params.id]))[0];
    await q(`UPDATE ${table} SET active=false, updated_at=now() WHERE id=$1`, [req.params.id]);
    await audit(who(req), `${name}.archive`, table, req.params.id, old, { active: false });
    res.json({ ok: true });
  });
}
crud('knowledge', 'knowledge_articles', ['title', 'content', 'category', 'active']);
crud('vocabulary', 'vocabulary', ['term', 'alternates', 'language', 'meaning', 'examples', 'active'], ['alternates', 'examples']);

admin.get('/api/stats', async (_req, res) => {
  res.json((await q(`SELECT
    (SELECT count(*) FROM messages WHERE direction='IN' AND created_at > now()-interval '1 day') AS messages_today,
    (SELECT count(*) FROM handoffs WHERE requested_at > now()-interval '1 day') AS handoffs_today,
    (SELECT count(*) FROM messages WHERE processing_status='FAILED' AND created_at > now()-interval '1 day') AS failed_today,
    (SELECT count(*) FROM messages WHERE message_type='AUDIO' AND error IS NOT NULL AND created_at > now()-interval '1 day') AS failed_stt_today`))[0]);
});
admin.get('/api/logs', async (_req, res) => res.json(await q(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200`)));
