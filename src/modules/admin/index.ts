import path from 'node:path';
import express, { NextFunction, Request, Response, Router } from 'express';
import { cfg } from '../../config';
import { audit, getSetting, pool, q, setSetting } from '../../db';
import { log } from '../../log';
import { FailureThrottle } from '../../security/throttle';
import { assignConversation, returnToAI, takeover, type Actor } from '../handoff';
import { sendText } from '../whatsapp/client';
import { canSendFreeForm } from '../whatsapp/rules';
import { authenticateBasic } from './auth';
import { clampLimit, parseBeforeId } from './pagination';
import { grantsFor, hasPermission, type Permission, type Role } from '../auth/rbac';
import { createSession, csrfOk, destroySession, parseCookie, resolveSession } from '../auth/session';
import { createUser, getActiveUserByUsername, listUsers, setUserActive, setUserPassword, setUserRole, verifyPassword } from '../auth/users';
import { previewSystemPrompt } from '../agent';
import { isVolatile, lintArticle, parseVocabImport } from '../knowledge/validate';
import { cancelOrder, confirmOrder, listOrders } from '../tools/orders';
import { sendTemplate } from '../whatsapp/client';
import { renderPreview, validateTemplateSend } from '../whatsapp/templates';

export const admin = Router();

type ReqUser = { id: number | null; username: string; role: string };
const who = (req: Request) => (req as any).user as ReqUser;
const actor = (req: Request): Actor => ({ id: who(req).id, username: who(req).username });

// --- public endpoints (no auth) ---
admin.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
});
// SPA shell only (no data); the page shows a login form when /api/me returns 401. All /api/* are gated.
admin.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

admin.use(express.json({ limit: '200kb' }));

// Only FAILED auth attempts are counted (login + Basic), so correct credentials — including the
// bridge service account — are never throttled. 15 failures / 10 min / IP.
const loginFail = new FailureThrottle(15, 10 * 60_000);

function setSid(res: Response, token: string) {
  res.cookie('sid', token, { httpOnly: true, secure: cfg.production, sameSite: 'strict', path: '/', maxAge: cfg.sessionTtlHours * 3_600_000 });
}
function clearSid(res: Response) { res.clearCookie('sid', { path: '/' }); }

// --- login (public, throttled, safe generic error) ---
admin.post('/api/auth/login', async (req, res) => {
  const ip = req.ip ?? 'unknown';
  if (loginFail.blocked(ip)) return void res.sendStatus(429);
  const username = String(req.body?.username ?? '');
  const password = String(req.body?.password ?? '');
  const u = await getActiveUserByUsername(username); // active-only: deactivated users cannot log in
  if (!u || !verifyPassword(password, u.password_hash)) {
    loginFail.record(ip);
    log.warn('auth.login_failed', { reqId: (req as any).reqId, ip });
    return void res.status(401).json({ error: 'invalid credentials' }); // never reveal which part failed
  }
  loginFail.reset(ip);
  const { token, csrf } = await createSession(u.id, req.ip, req.header('user-agent'));
  setSid(res, token);
  await q(`UPDATE users SET last_login_at=now() WHERE id=$1`, [u.id]);
  await audit(u.username, 'auth.login', 'user', u.id, null, { ip });
  res.json({ user: { id: u.id, username: u.username, role: u.role }, csrf, permissions: grantsFor(u.role) });
});

// --- identity resolution: session cookie first, then Basic (bridge service / env bootstrap admin) ---
async function authResolve(req: Request, res: Response, next: NextFunction) {
  res.set('Cache-Control', 'no-store');
  const token = parseCookie(req.headers.cookie, 'sid');
  if (token) {
    const s = await resolveSession(token); // enforces expiry, idle timeout, user.active (revocation)
    if (s) { (req as any).user = s.user; (req as any).authKind = 'session'; (req as any).csrf = s.csrf; (req as any).sessionId = s.sessionId; return next(); }
  }
  const ip = req.ip ?? 'unknown';
  if (loginFail.blocked(ip)) return void res.sendStatus(429);
  const matched = authenticateBasic(req.header('authorization'), [
    { user: cfg.adminUser, password: cfg.adminPassword },
    { user: cfg.bridgeUser, password: cfg.bridgePassword },
  ]);
  if (matched) {
    loginFail.reset(ip);
    const role: Role = matched === cfg.bridgeUser ? 'service' : 'admin'; // bridge = read-only service
    (req as any).user = { id: null, username: matched, role } satisfies ReqUser;
    (req as any).authKind = 'basic';
    return next();
  }
  loginFail.record(ip);
  log.warn('admin.auth_failed', { reqId: (req as any).reqId, ip });
  // No WWW-Authenticate challenge: the SPA uses the cookie-session login form (a challenge would pop
  // the browser's native Basic dialog), and the bridge sends Basic preemptively so never needs it.
  res.status(401).json({ error: 'unauthorized' });
}
admin.use(authResolve);

// CSRF for cookie-authenticated state changes. Basic-auth (service/bootstrap: no cookie) is exempt —
// browsers don't auto-send Basic cross-site and the bridge is a server-to-server client.
admin.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if ((req as any).authKind !== 'session') return next();
  if (!csrfOk(req.header('x-csrf-token'), (req as any).csrf)) return void res.status(403).json({ error: 'csrf' });
  next();
});

const requirePermission = (perm: Permission) => (req: Request, res: Response, next: NextFunction) =>
  hasPermission(who(req).role, perm) ? next() : void res.status(403).json({ error: 'forbidden' });

// Ownership: admin acts on any conversation; an agent only on one assigned to them or unassigned.
async function requireConvAccess(req: Request, res: Response, next: NextFunction) {
  const u = who(req);
  if (!hasPermission(u.role, 'handle_conversations')) return void res.status(403).json({ error: 'forbidden' });
  if (u.role === 'admin') return next();
  const c = (await q(`SELECT assigned_user_id FROM conversations WHERE id=$1`, [req.params.id]))[0];
  if (!c) return void res.sendStatus(404);
  if (c.assigned_user_id == null || c.assigned_user_id === u.id) return next();
  return void res.status(403).json({ error: 'assigned to another agent' });
}

admin.get('/api/me', (req, res) => {
  const u = who(req);
  res.json({ user: u, permissions: grantsFor(u.role), csrf: (req as any).authKind === 'session' ? (req as any).csrf : null });
});
admin.post('/api/auth/logout', async (req, res) => {
  if ((req as any).authKind === 'session') {
    await destroySession((req as any).sessionId);
    clearSid(res);
    await audit(who(req).username, 'auth.logout', 'user', who(req).id ?? 0, null, null);
  }
  res.json({ ok: true });
});

// --- conversations (bridge-compatible: query shapes unchanged; `view` for reads) ---
// Optional filters (status, mode, assignee, q) are all additive — omitting them all yields the same
// rows the bridge has always received (plus two additive columns status/assigned_user_id that
// older consumers ignore). Everything is parameterized; search is a single bounded query (no N+1).
admin.get('/api/conversations', requirePermission('view'), async (req, res) => {
  const limit = clampLimit(req.query.limit, 100, 500);
  const u = who(req);
  const params: any[] = [];
  const where: string[] = [];
  const status = String(req.query.status ?? '');
  if (['OPEN', 'CLOSED', 'SNOOZED'].includes(status)) { params.push(status); where.push(`c.status = $${params.length}`); }
  const mode = String(req.query.mode ?? '');
  if (['AI', 'HUMAN', 'HUMAN_PENDING', 'PAUSED'].includes(mode)) { params.push(mode); where.push(`c.mode = $${params.length}`); }
  const assignee = String(req.query.assignee ?? '');
  if (assignee === 'me') { if (u.id == null) where.push('c.assigned_user_id IS NULL'); else { params.push(u.id); where.push(`c.assigned_user_id = $${params.length}`); } }
  else if (assignee === 'unassigned') where.push('c.assigned_user_id IS NULL');
  else if (/^\d+$/.test(assignee)) { params.push(Number(assignee)); where.push(`c.assigned_user_id = $${params.length}`); }
  const search = String(req.query.q ?? '').trim();
  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    where.push(`(cu.display_name ILIKE ${p} OR cu.wa_id ILIKE ${p} OR EXISTS(SELECT 1 FROM messages m2 WHERE m2.conversation_id=c.id AND COALESCE(m2.text,m2.transcription) ILIKE ${p}))`);
  }
  params.push(limit);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json(await q(`
    SELECT c.id, c.mode, c.status, c.assigned_user_id, c.last_message_at, c.assigned_user, cu.wa_id, cu.display_name,
      (SELECT COALESCE(text, transcription) FROM messages m WHERE m.conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_text,
      (SELECT reason FROM handoffs h WHERE h.conversation_id=c.id AND h.status='PENDING' ORDER BY id DESC LIMIT 1) AS handoff_reason
    FROM conversations c JOIN customers cu ON cu.id=c.customer_id ${whereSql} ORDER BY c.last_message_at DESC LIMIT $${params.length}`, params));
});

admin.get('/api/conversations/:id', requirePermission('view'), async (req, res) => {
  const limit = clampLimit(req.query.limit, 200, 500);
  const beforeId = parseBeforeId(req.query.before_id);
  res.json(await q(
    `SELECT id, direction, sender_type, message_type, text, transcription, delivery_status, processing_status, error, created_at
     FROM messages WHERE conversation_id=$1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
    [req.params.id, beforeId, limit],
  ).then((r) => r.reverse()));
});

admin.post('/api/conversations/:id/takeover', requireConvAccess, async (req, res) => { await takeover(Number(req.params.id), actor(req)); res.json({ ok: true }); });
admin.post('/api/conversations/:id/return-to-ai', requireConvAccess, async (req, res) => { await returnToAI(Number(req.params.id), actor(req)); res.json({ ok: true }); });

admin.post('/api/conversations/:id/messages', requireConvAccess, async (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return void res.status(400).json({ error: 'empty' });
  const c = (await q(`SELECT c.id, c.last_inbound_at, cu.wa_id FROM conversations c JOIN customers cu ON cu.id=c.customer_id WHERE c.id=$1`, [req.params.id]))[0];
  if (!c) return void res.sendStatus(404);
  if (!canSendFreeForm(c.last_inbound_at)) return void res.status(409).json({ error: '24h window closed: only an approved template can be sent' });
  const waId = await sendText(c.wa_id, text);
  await q(`INSERT INTO messages(conversation_id, whatsapp_message_id, direction, sender_type, message_type, text, delivery_status) VALUES($1,$2,'OUT','HUMAN','TEXT',$3,'sent')`, [c.id, waId, text]);
  await q(`UPDATE conversations SET last_message_at=now() WHERE id=$1`, [c.id]);
  await audit(who(req).username, 'message.send', 'conversation', c.id, null, { text });
  res.json({ ok: true });
});

// assignment: self-assign for any handler; assigning to others or unassigning requires admin.
admin.post('/api/conversations/:id/assign', requirePermission('handle_conversations'), async (req, res) => {
  const u = who(req);
  const id = Number(req.params.id);
  let userId: number | null;
  let username: string | null;
  if (req.body?.self) { userId = u.id; username = u.username; }
  else if (req.body?.unassign) {
    if (u.role !== 'admin') return void res.status(403).json({ error: 'forbidden' });
    userId = null; username = null;
  } else {
    if (u.role !== 'admin') return void res.status(403).json({ error: 'forbidden' });
    const target = (await q(`SELECT id, username FROM users WHERE id=$1 AND active=true`, [req.body?.user_id]))[0];
    if (!target) return void res.status(400).json({ error: 'unknown user' });
    userId = target.id; username = target.username;
  }
  const ok = await assignConversation(id, userId, username, actor(req));
  if (!ok) return void res.sendStatus(404);
  res.json({ ok: true });
});

// conversation inbox status (OPEN/CLOSED/SNOOZED) — organizational only, does NOT gate the AI pipeline.
admin.post('/api/conversations/:id/status', requireConvAccess, async (req, res) => {
  const status = String(req.body?.status ?? '');
  if (!['OPEN', 'CLOSED', 'SNOOZED'].includes(status)) return void res.status(400).json({ error: 'status must be OPEN|CLOSED|SNOOZED' });
  const id = Number(req.params.id);
  const old = (await q(`SELECT status FROM conversations WHERE id=$1`, [id]))[0];
  if (!old) return void res.sendStatus(404);
  const snooze = status === 'SNOOZED' ? (req.body?.snoozed_until ? new Date(req.body.snoozed_until) : new Date(Date.now() + 86_400_000)) : null;
  await q(`UPDATE conversations SET status=$2, closed_at=CASE WHEN $2='CLOSED' THEN now() ELSE NULL END, snoozed_until=$3 WHERE id=$1`, [id, status, snooze]);
  await audit(who(req).username, 'conversation.status', 'conversation', id, old, { status });
  res.json({ ok: true, status });
});

// internal notes: staff-only, never sent to WhatsApp, never in the AI history (separate table).
admin.get('/api/conversations/:id/notes', requirePermission('view'), async (req, res) =>
  res.json(await q(`SELECT id, author, body, created_at FROM conversation_notes WHERE conversation_id=$1 ORDER BY id`, [req.params.id])));
admin.post('/api/conversations/:id/notes', requireConvAccess, async (req, res) => {
  const body = String(req.body?.body ?? '').trim();
  if (!body) return void res.status(400).json({ error: 'empty' });
  const id = Number(req.params.id);
  const r = await q(`INSERT INTO conversation_notes(conversation_id, author, body) VALUES($1,$2,$3) RETURNING id, author, body, created_at`, [id, who(req).username, body.slice(0, 4000)]);
  await audit(who(req).username, 'note.add', 'conversation', id, null, { len: body.length });
  res.json(r[0]);
});

// --- agent settings (pause/resume = manage_settings; read = view) ---
admin.post('/api/agent/pause', requirePermission('manage_settings'), async (req, res) => { await setSetting('ai_enabled', false, who(req).username); res.json({ ai_enabled: false }); });
admin.post('/api/agent/resume', requirePermission('manage_settings'), async (req, res) => { await setSetting('ai_enabled', true, who(req).username); res.json({ ai_enabled: true }); });
admin.get('/api/agent-settings', requirePermission('view'), async (_req, res) => {
  res.json({
    ai_enabled: await getSetting('ai_enabled', true),
    voice_notes_enabled: await getSetting('voice_notes_enabled', true),
    extra_instructions: await getSetting('extra_instructions', ''),
    meta_configured: Boolean(cfg.graphVersion && cfg.appSecret && cfg.phoneNumberId && cfg.accessToken),
  });
});
admin.patch('/api/agent-settings', requirePermission('manage_settings'), async (req, res) => {
  for (const k of ['voice_notes_enabled', 'extra_instructions']) if (k in (req.body ?? {})) await setSetting(k, req.body[k], who(req).username);
  res.json({ ok: true });
});

// knowledge + vocabulary CRUD; reads = view, writes = manage_knowledge. "delete" = archive, all audited.
function crud(name: string, table: string, cols: string[], jsonCols: string[] = []) {
  admin.get(`/api/${name}`, requirePermission('view'), async (_req, res) => res.json(await q(`SELECT * FROM ${table} ORDER BY id DESC LIMIT 500`)));
  admin.post(`/api/${name}`, requirePermission('manage_knowledge'), async (req, res) => {
    const vals = cols.map((c) => (jsonCols.includes(c) ? JSON.stringify(req.body[c] ?? []) : req.body[c] ?? null));
    const r = await q(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, vals);
    await audit(who(req).username, `${name}.create`, table, r[0].id, null, r[0]);
    res.json(r[0]);
  });
  admin.put(`/api/${name}/:id`, requirePermission('manage_knowledge'), async (req, res) => {
    const old = (await q(`SELECT * FROM ${table} WHERE id=$1`, [req.params.id]))[0];
    if (!old) return void res.sendStatus(404);
    const vals = cols.map((c) => (c in req.body ? (jsonCols.includes(c) ? JSON.stringify(req.body[c]) : req.body[c]) : old[c]));
    const r = await q(`UPDATE ${table} SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(',')}, updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id, ...vals]);
    await audit(who(req).username, `${name}.update`, table, String(req.params.id), old, r[0]);
    res.json(r[0]);
  });
  admin.delete(`/api/${name}/:id`, requirePermission('manage_knowledge'), async (req, res) => {
    const old = (await q(`SELECT * FROM ${table} WHERE id=$1`, [req.params.id]))[0];
    await q(`UPDATE ${table} SET active=false, updated_at=now() WHERE id=$1`, [req.params.id]);
    await audit(who(req).username, `${name}.archive`, table, String(req.params.id), old, { active: false });
    res.json({ ok: true });
  });
}
// Knowledge: explicit routes so we can enforce the draft/published/archived lifecycle and set the
// volatile-content flag from the lint on every write. Reads = view, writes = manage_knowledge.
admin.get('/api/knowledge', requirePermission('view'), async (_req, res) => res.json(await q(`SELECT * FROM knowledge_articles ORDER BY id DESC LIMIT 500`)));
admin.post('/api/knowledge', requirePermission('manage_knowledge'), async (req, res) => {
  const { title, content, category, status } = req.body ?? {};
  if (!title || !content) return void res.status(400).json({ error: 'title and content required' });
  const st = ['draft', 'published', 'archived'].includes(status) ? status : 'published';
  const volatile = isVolatile(String(content));
  const r = await q(`INSERT INTO knowledge_articles(title, content, category, status, volatile_flag, active) VALUES($1,$2,$3,$4,$5,true) RETURNING *`,
    [title, content, category ?? null, st, volatile]);
  await audit(who(req).username, 'knowledge.create', 'knowledge_articles', r[0].id, null, r[0]);
  res.json({ ...r[0], warnings: lintArticle(String(content)) });
});
admin.put('/api/knowledge/:id', requirePermission('manage_knowledge'), async (req, res) => {
  const old = (await q(`SELECT * FROM knowledge_articles WHERE id=$1`, [req.params.id]))[0];
  if (!old) return void res.sendStatus(404);
  const b = req.body ?? {};
  const content = b.content ?? old.content;
  const status = ['draft', 'published', 'archived'].includes(b.status) ? b.status : old.status;
  const r = await q(
    `UPDATE knowledge_articles SET title=$2, content=$3, category=$4, status=$5, active=$6, volatile_flag=$7, updated_at=now() WHERE id=$1 RETURNING *`,
    [req.params.id, b.title ?? old.title, content, 'category' in b ? b.category : old.category, status, typeof b.active === 'boolean' ? b.active : old.active, isVolatile(String(content))],
  );
  await audit(who(req).username, 'knowledge.update', 'knowledge_articles', String(req.params.id), old, r[0]);
  res.json({ ...r[0], warnings: lintArticle(String(content)) });
});
admin.delete('/api/knowledge/:id', requirePermission('manage_knowledge'), async (req, res) => {
  const old = (await q(`SELECT * FROM knowledge_articles WHERE id=$1`, [req.params.id]))[0];
  if (!old) return void res.sendStatus(404);
  await q(`UPDATE knowledge_articles SET status='archived', active=false, updated_at=now() WHERE id=$1`, [req.params.id]);
  await audit(who(req).username, 'knowledge.archive', 'knowledge_articles', String(req.params.id), old, { status: 'archived', active: false });
  res.json({ ok: true });
});
admin.post('/api/knowledge/lint', requirePermission('manage_knowledge'), (req, res) => res.json({ warnings: lintArticle(String(req.body?.content ?? '')) }));
// Prompt preview = the exact system prompt (company knowledge/vocab/safety rules only). It contains
// NO credentials and NO customer conversation history (that is only ever in the per-turn messages).
admin.get('/api/knowledge/prompt-preview', requirePermission('manage_knowledge'), async (_req, res) => res.json({ prompt: await previewSystemPrompt() }));

crud('vocabulary', 'vocabulary', ['term', 'alternates', 'language', 'meaning', 'examples', 'active'], ['alternates', 'examples']);
// Validated bulk import (JSON array or CSV). Rows are validated in-process; a single multi-row INSERT avoids N+1.
admin.post('/api/vocabulary/import', requirePermission('manage_knowledge'), async (req, res) => {
  const { rows, errors } = parseVocabImport(String(req.body?.format ?? 'json'), String(req.body?.data ?? ''));
  let inserted = 0;
  if (rows.length) {
    const vals: any[] = [];
    const tuples = rows.map((row, i) => {
      const b = i * 5;
      vals.push(row.term, JSON.stringify(row.alternates), row.language, row.meaning, JSON.stringify(row.examples));
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},true)`;
    });
    await q(`INSERT INTO vocabulary(term, alternates, language, meaning, examples, active) VALUES ${tuples.join(',')}`, vals);
    inserted = rows.length;
  }
  await audit(who(req).username, 'vocabulary.import', 'vocabulary', 'bulk', null, { inserted, errors: errors.length });
  res.json({ inserted, errors });
});

// --- user management (admin only) ---
admin.get('/api/users', requirePermission('manage_users'), async (_req, res) => res.json(await listUsers()));
admin.post('/api/users', requirePermission('manage_users'), async (req, res) => {
  const { username, password, role } = req.body ?? {};
  if (!username || !password || String(password).length < 8 || !['admin', 'agent', 'viewer'].includes(role)) {
    return void res.status(400).json({ error: 'require username, password(>=8), role in admin|agent|viewer' });
  }
  try {
    const u = await createUser(String(username), String(password), role);
    await audit(who(req).username, 'user.create', 'user', u.id, null, { username: u.username, role: u.role });
    res.json(u);
  } catch (e: any) {
    if (/unique/i.test(e.message)) return void res.status(409).json({ error: 'username exists' });
    throw e;
  }
});
admin.patch('/api/users/:id', requirePermission('manage_users'), async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body ?? {};
  if (typeof b.active === 'boolean') await setUserActive(id, b.active);
  if (b.role && ['admin', 'agent', 'viewer'].includes(b.role)) await setUserRole(id, b.role);
  if (b.password) { if (String(b.password).length < 8) return void res.status(400).json({ error: 'password >=8' }); await setUserPassword(id, String(b.password)); }
  await audit(who(req).username, 'user.update', 'user', id, null, { active: b.active, role: b.role, password: b.password ? '[changed]' : undefined });
  res.json({ ok: true });
});

// ================= P2-C: business integrations, orders, templates, analytics =================

// catalog: products + price + stock. Reads = view, writes = manage_settings.
admin.get('/api/products', requirePermission('view'), async (_req, res) => res.json(await q(`
  SELECT p.id, p.sku, p.name, p.description, p.category, p.active, pr.amount, pr.currency, inv.qty
  FROM products p LEFT JOIN product_prices pr ON pr.product_id=p.id LEFT JOIN inventory inv ON inv.product_id=p.id
  ORDER BY p.id DESC LIMIT 500`)));
admin.post('/api/products', requirePermission('manage_settings'), async (req, res) => {
  const { sku, name, description, category, amount, currency, qty } = req.body ?? {};
  if (!sku || !name) return void res.status(400).json({ error: 'sku and name required' });
  try {
    const p = (await q(`INSERT INTO products(sku,name,description,category) VALUES($1,$2,$3,$4) RETURNING *`, [sku, name, description ?? null, category ?? null]))[0];
    if (amount != null) await q(`INSERT INTO product_prices(product_id,amount,currency) VALUES($1,$2,$3)`, [p.id, Number(amount), currency || 'MRU']);
    if (qty != null) await q(`INSERT INTO inventory(product_id,qty) VALUES($1,$2)`, [p.id, Math.max(0, Math.trunc(Number(qty)))]);
    await audit(who(req).username, 'product.create', 'products', p.id, null, { sku, name });
    res.json(p);
  } catch (e: any) { if (/unique/i.test(e.message)) return void res.status(409).json({ error: 'sku exists' }); throw e; }
});
admin.put('/api/products/:id', requirePermission('manage_settings'), async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body ?? {};
  const old = (await q(`SELECT * FROM products WHERE id=$1`, [id]))[0];
  if (!old) return void res.sendStatus(404);
  await q(`UPDATE products SET name=$2, description=$3, category=$4, active=$5, updated_at=now() WHERE id=$1`,
    [id, b.name ?? old.name, 'description' in b ? b.description : old.description, 'category' in b ? b.category : old.category, typeof b.active === 'boolean' ? b.active : old.active]);
  if (b.amount != null) await q(`INSERT INTO product_prices(product_id,amount,currency) VALUES($1,$2,$3) ON CONFLICT (product_id) DO UPDATE SET amount=$2, currency=$3, updated_at=now()`, [id, Number(b.amount), b.currency || 'MRU']);
  if (b.qty != null) await q(`INSERT INTO inventory(product_id,qty) VALUES($1,$2) ON CONFLICT (product_id) DO UPDATE SET qty=$2, updated_at=now()`, [id, Math.max(0, Math.trunc(Number(b.qty)))]);
  await audit(who(req).username, 'product.update', 'products', String(id), old, { price: b.amount, qty: b.qty });
  res.json({ ok: true });
});

// orders: AI creates DRAFTs; confirm/cancel are staff-only (confirm_orders) + conversation ownership.
async function orderConvAccess(req: Request, res: Response): Promise<boolean> {
  const o = (await q(`SELECT conversation_id FROM orders WHERE id=$1`, [req.params.id]))[0];
  if (!o) { res.sendStatus(404); return false; }
  const u = who(req);
  if (u.role !== 'admin') {
    const c = (await q(`SELECT assigned_user_id FROM conversations WHERE id=$1`, [o.conversation_id]))[0];
    if (c && c.assigned_user_id != null && c.assigned_user_id !== u.id) { res.status(403).json({ error: 'order belongs to another agent\'s conversation' }); return false; }
  }
  return true;
}
admin.get('/api/orders', requirePermission('view'), async (req, res) => res.json(await listOrders(String(req.query.status ?? ''), clampLimit(req.query.limit, 100, 500))));
admin.post('/api/orders/:id/confirm', requirePermission('confirm_orders'), async (req, res) => {
  if (!(await orderConvAccess(req, res))) return;
  const r = await confirmOrder(Number(req.params.id), actor(req));
  if (r.kind === 'not_found') return void res.sendStatus(404);
  if (r.kind === 'conflict') return void res.status(409).json({ error: `order is ${r.status}` });
  if (r.kind === 'issues') return void res.status(409).json({ error: 'revalidation failed', issues: r.issues });
  res.json({ ok: true, order: r.order });
});
admin.post('/api/orders/:id/cancel', requirePermission('confirm_orders'), async (req, res) => {
  if (!(await orderConvAccess(req, res))) return;
  const r = await cancelOrder(Number(req.params.id), actor(req));
  if (r.kind === 'ok') return void res.json({ ok: true, order: r.order });
  if (r.kind === 'not_found') return void res.sendStatus(404);
  return void res.status(409).json({ error: r.kind === 'conflict' ? `order is ${r.status}` : 'cannot cancel' });
});

// approved templates: registry (manage_settings) + send to one conversation (handler + ownership).
admin.get('/api/templates', requirePermission('view'), async (_req, res) => res.json(await q(`SELECT * FROM templates ORDER BY id DESC LIMIT 500`)));
admin.post('/api/templates', requirePermission('manage_settings'), async (req, res) => {
  const { name, meta_template_name, language, category, body_preview, variables, status } = req.body ?? {};
  if (!name || !meta_template_name || !language || !body_preview) return void res.status(400).json({ error: 'name, meta_template_name, language, body_preview required' });
  try {
    const r = (await q(`INSERT INTO templates(name,meta_template_name,language,category,body_preview,variables,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, meta_template_name, language, category ?? null, body_preview, Math.max(0, Math.trunc(Number(variables) || 0)), ['approved', 'disabled'].includes(status) ? status : 'approved', who(req).username]))[0];
    await audit(who(req).username, 'template.create', 'templates', r.id, null, r);
    res.json(r);
  } catch (e: any) { if (/unique/i.test(e.message)) return void res.status(409).json({ error: 'template name+language already exists' }); throw e; }
});
// Template send is the sanctioned OUTSIDE-24h-window path (free-form /messages stays 24h-gated). 1:1 only.
admin.post('/api/conversations/:id/template', requireConvAccess, async (req, res) => {
  const t = (await q(`SELECT * FROM templates WHERE id=$1`, [req.body?.template_id]))[0];
  const v = validateTemplateSend(t as any, req.body?.variables);
  if (v.error) return void res.status(400).json({ error: v.error });
  const c = (await q(`SELECT c.id, cu.wa_id FROM conversations c JOIN customers cu ON cu.id=c.customer_id WHERE c.id=$1`, [req.params.id]))[0];
  if (!c) return void res.sendStatus(404);
  const waId = await sendTemplate(c.wa_id, t.meta_template_name, t.language, v.params!);
  const preview = renderPreview(t.body_preview, v.params!);
  await q(`INSERT INTO messages(conversation_id,whatsapp_message_id,direction,sender_type,message_type,text,delivery_status) VALUES($1,$2,'OUT','HUMAN','TEMPLATE',$3,'sent')`, [c.id, waId, preview]);
  await q(`UPDATE conversations SET last_message_at=now() WHERE id=$1`, [c.id]);
  await audit(who(req).username, 'template.send', 'conversation', c.id, null, { template: t.meta_template_name, language: t.language });
  res.json({ ok: true });
});

// operational analytics — all queries date-bounded, grouped and parameterized.
admin.get('/api/reporting', requirePermission('view'), async (req, res) => {
  const days = Math.min(Math.max(1, Math.trunc(Number(req.query.days) || 7)), 90);
  const [volume, handoffs, failed, delivery, resp] = await Promise.all([
    q(`SELECT date_trunc('day',created_at)::date AS day, count(*)::int AS inbound FROM messages WHERE direction='IN' AND created_at > now()-($1||' days')::interval GROUP BY 1 ORDER BY 1`, [days]),
    q(`SELECT count(*)::int AS n FROM handoffs WHERE requested_at > now()-($1||' days')::interval`, [days]),
    q(`SELECT count(*) FILTER (WHERE processing_status='FAILED')::int AS failed_messages,
              count(*) FILTER (WHERE message_type='AUDIO' AND error IS NOT NULL)::int AS failed_stt
         FROM messages WHERE created_at > now()-($1||' days')::interval`, [days]),
    q(`SELECT delivery_status, count(*)::int AS n FROM messages WHERE direction='OUT' AND delivery_status IS NOT NULL AND created_at > now()-($1||' days')::interval GROUP BY 1`, [days]),
    q(`SELECT avg(secs)::numeric(10,1) AS avg_first_response_secs FROM (
         SELECT EXTRACT(EPOCH FROM (lead(created_at) OVER (PARTITION BY conversation_id ORDER BY id) - created_at)) AS secs,
                direction, lead(direction) OVER (PARTITION BY conversation_id ORDER BY id) AS next_dir
         FROM messages WHERE created_at > now()-($1||' days')::interval) t
       WHERE direction='IN' AND next_dir='OUT'`, [days]),
  ]);
  res.json({ days, volume, handoffs: handoffs[0].n, failed: failed[0], delivery, avg_first_response_secs: resp[0].avg_first_response_secs });
});

admin.get('/api/stats', requirePermission('view'), async (_req, res) => {
  res.json((await q(`SELECT
    (SELECT count(*) FROM messages WHERE direction='IN' AND created_at > now()-interval '1 day') AS messages_today,
    (SELECT count(*) FROM handoffs WHERE requested_at > now()-interval '1 day') AS handoffs_today,
    (SELECT count(*) FROM messages WHERE processing_status='FAILED' AND created_at > now()-interval '1 day') AS failed_today,
    (SELECT count(*) FROM messages WHERE message_type='AUDIO' AND error IS NOT NULL AND created_at > now()-interval '1 day') AS failed_stt_today`))[0]);
});
admin.get('/api/logs', requirePermission('view'), async (_req, res) => res.json(await q(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200`)));
