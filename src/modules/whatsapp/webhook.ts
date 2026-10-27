import { Router, raw } from 'express';
import { cfg } from '../../config';
import { q } from '../../db';
import { log } from '../../log';
import { FailureThrottle } from '../../security/throttle';
import { ingest } from '../conversations';
import { shouldApplyStatus, verifySignature } from './rules';

export const webhook = Router();

// Abuse guard: only bad-signature requests are counted. A correctly signed Meta delivery (incl.
// retries) never touches this, so legitimate traffic is never throttled. 30 bad sigs / 5 min / IP.
const badSig = new FailureThrottle(30, 5 * 60_000);

/**
 * Production-INERT test seam. Runs ONLY when ALLOW_TEST_FAULTS=1 (never set in any real env). It
 * atomically claims an operator-armed flag (`agent_settings.test_fault_arm`) and throws once, so a
 * test can drive the processing-failure path (un-mark event + HTTP 500 → Meta retry) deterministically.
 * It is NOT triggered by any customer message id or content.
 */
async function maybeInjectFault(): Promise<void> {
  const armed = await q(`UPDATE agent_settings SET value='false'::jsonb WHERE key='test_fault_arm' AND value='true'::jsonb RETURNING key`);
  if (armed.length) throw new Error('injected test fault (armed via test_fault_arm)');
}

// Meta verification challenge
webhook.get('/webhooks/meta/whatsapp', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && cfg.verifyToken && req.query['hub.verify_token'] === cfg.verifyToken) {
    return void res.status(200).send(String(req.query['hub.challenge']));
  }
  res.sendStatus(403);
});

webhook.post('/webhooks/meta/whatsapp', raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const body: Buffer = req.body;
  const ip = req.ip ?? 'unknown';
  if (badSig.blocked(ip)) return void res.sendStatus(429); // IP has flooded bad signatures
  if (!verifySignature(body, req.header('x-hub-signature-256'), cfg.appSecret)) {
    badSig.record(ip);
    log.warn('webhook.bad_signature', { reqId: (req as any).reqId, ip });
    return void res.sendStatus(401);
  }
  let payload: any;
  try { payload = JSON.parse(body.toString('utf8')); } catch { return void res.sendStatus(400); }
  if (payload?.object !== 'whatsapp_business_account') return void res.sendStatus(200);
  let failed = false;
  for (const entry of payload.entry ?? []) for (const ch of entry.changes ?? []) {
    const v = ch.value ?? {};
    try {
      for (const m of v.messages ?? []) {
        const seen = await q(
          `INSERT INTO webhook_events(event_key, payload) VALUES($1,$2) ON CONFLICT (event_key) DO NOTHING RETURNING id`,
          [m.id, JSON.stringify(m)]);
        if (!seen.length) continue; // duplicate delivery
        if (cfg.allowTestFaults) await maybeInjectFault(); // no-op unless armed in a test
        const name = v.contacts?.find((c: any) => c.wa_id === m.from)?.profile?.name;
        await ingest({
          waId: m.from, name, messageId: m.id, type: m.type,
          text: m.text?.body, mediaId: (m.audio ?? m.image ?? m.document)?.id, mime: m.audio?.mime_type,
        });
        await q(`UPDATE webhook_events SET status='PROCESSED', processed_at=now() WHERE event_key=$1`, [m.id]);
      }
      for (const s of v.statuses ?? []) {
        const cur = (await q(`SELECT delivery_status FROM messages WHERE whatsapp_message_id=$1`, [s.id]))[0];
        if (cur && shouldApplyStatus(cur.delivery_status, s.status)) {
          await q(`UPDATE messages SET delivery_status=$2, error=CASE WHEN $2='failed' THEN $3 ELSE error END WHERE whatsapp_message_id=$1`,
            [s.id, s.status, s.errors ? JSON.stringify(s.errors).slice(0, 400) : null]);
        }
      }
    } catch (e: any) {
      // un-mark so Meta's retry is processed instead of being dropped as a duplicate
      log.error('webhook.process_error', { reqId: (req as any).reqId, err: e.message });
      for (const m of v.messages ?? []) await q(`DELETE FROM webhook_events WHERE event_key=$1 AND status<>'PROCESSED'`, [m.id]).catch(() => {});
      failed = true;
    }
  }
  // DB work is only a few ms (the AI turn runs later, debounced), so ack after persisting; 500 makes Meta retry
  res.sendStatus(failed ? 500 : 200);
});
