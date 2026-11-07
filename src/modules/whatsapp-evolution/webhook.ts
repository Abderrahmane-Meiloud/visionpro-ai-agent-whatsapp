import crypto from 'node:crypto';
import { Router, json } from 'express';
import { cfg } from '../../config';
import { q, setSetting } from '../../db';
import { log } from '../../log';
import { FailureThrottle } from '../../security/throttle';
import { ingest } from '../conversations';
import {
  EVOLUTION_PILOT_CHANNEL, digitsFromJid, extractEvolutionText, isGroupOrBroadcast,
  isRealInboundSenderAllowed, isStaleHistorySync, resolvePhoneBearingJid, timingSafeEqualStr, toEvolutionWaId,
} from './rules';

/** Per-request trace line: stage + reason code ONLY — never a message body, phone number, JID,
 *  path secret, or auth header value. `rid` correlates every stage of one delivery (and, for
 *  MESSAGES_UPSERT, one item within it) without revealing who it was from, so a real delivery's
 *  exact failing stage can be identified from logs alone. See docs/26_EVOLUTION_PILOT.md. */
function trace(rid: string, stage: string, reason?: string): void {
  log.info('evolution_webhook.trace', reason ? { rid, stage, reason } : { rid, stage });
}

/**
 * Isolated, minimal webhook receiver for the Evolution API pilot transport (EXPERIMENTAL,
 * owner-authorized, non-production — see docs/26_EVOLUTION_PILOT.md). This router is mounted on
 * its OWN listener (see src/index.ts), bound to EVOLUTION_WEBHOOK_PORT, which exposes nothing
 * else — never the admin panel, never the Meta webhook. That is the only port a tunnel should ever
 * point at for this pilot.
 *
 * Auth: a long random path secret is REQUIRED (`/webhooks/evolution/pilot/<secret>`). If
 * EVOLUTION_WEBHOOK_AUTH_HEADER is also set, a matching `Authorization: Bearer <secret>` header is
 * additionally required — effective only if the Evolution instance's own webhook config is set to
 * send custom headers back (verify against the live instance; the path secret is the guaranteed
 * fallback regardless). Both checks are constant-time; a bad attempt gets 404 (never confirms the
 * path exists to a prober) and is throttled per IP. The secret itself is never logged.
 */
export const evolutionWebhook = Router();

const badAuth = new FailureThrottle(20, 5 * 60_000);

evolutionWebhook.get('/webhooks/evolution/pilot/health', (_req, res) => {
  res.json({ ok: true, pilot: 'evolution', instance: cfg.evolutionInstanceName });
});

evolutionWebhook.post('/webhooks/evolution/pilot/:secret', json({ limit: '2mb' }), async (req, res) => {
  const ip = req.ip ?? 'unknown';
  const rid = crypto.randomBytes(6).toString('hex'); // correlates this delivery's stages; carries no identity
  trace(rid, 'arrival');

  if (badAuth.blocked(ip)) { trace(rid, 'auth', 'throttled'); return void res.sendStatus(429); }

  const expectedSecret = cfg.evolutionWebhookPathSecret;
  if (!expectedSecret || !timingSafeEqualStr(req.params.secret, expectedSecret)) {
    badAuth.record(ip);
    log.warn('evolution_webhook.bad_path_secret', { ip });
    trace(rid, 'auth', 'bad_path_secret');
    return void res.sendStatus(404);
  }
  if (cfg.evolutionWebhookAuthHeader) {
    const header = req.header('authorization') || '';
    if (!timingSafeEqualStr(header, `Bearer ${cfg.evolutionWebhookAuthHeader}`)) {
      badAuth.record(ip);
      log.warn('evolution_webhook.bad_auth_header', { ip });
      trace(rid, 'auth', 'bad_auth_header');
      return void res.sendStatus(404);
    }
  }
  trace(rid, 'auth', 'ok');

  const payload = req.body ?? {};
  if (payload.instance !== cfg.evolutionInstanceName) {
    log.warn('evolution_webhook.wrong_instance', { got: payload.instance });
    trace(rid, 'event_parsing', 'wrong_instance');
    return void res.sendStatus(200); // ack, ignore — never process another instance's traffic here
  }

  const event = String(payload.event ?? '').toUpperCase().replace(/[.\s]+/g, '_');
  trace(rid, 'event_parsing', event || 'empty');

  if (event === 'CONNECTION_UPDATE') {
    const state = payload.data?.state ?? payload.data?.connection ?? 'unknown';
    log.info('evolution_webhook.connection_update', { state });
    await setSetting('evolution_pilot_connection_state', { state, at: new Date().toISOString() }, 'evolution-webhook').catch(() => {});
    return void res.sendStatus(200);
  }

  if (event !== 'MESSAGES_UPSERT') { trace(rid, 'event_parsing', 'out_of_scope'); return void res.sendStatus(200); }

  const items: any[] = Array.isArray(payload.data) ? payload.data : [payload.data].filter(Boolean);
  let failed = false;
  let idx = 0;
  for (const item of items) {
    idx += 1;
    const irid = `${rid}.${idx}`;
    try {
      const key = item?.key ?? {};
      const rawJid: string = key.remoteJid ?? '';
      if (!rawJid || !key.id) { trace(irid, 'event_parsing', 'missing_key_or_jid'); continue; }
      if (key.fromMe) { trace(irid, 'event_parsing', 'from_me'); continue; } // our own outgoing send, echoed back
      if (isGroupOrBroadcast(rawJid)) { trace(irid, 'event_parsing', 'group_or_broadcast'); continue; }
      if (isStaleHistorySync(item.messageTimestamp)) { trace(irid, 'stale_filter', 'stale'); continue; }
      trace(irid, 'stale_filter', 'ok');

      // WhatsApp's privacy-preserving "LID" JIDs (`<opaque-id>@lid`) don't carry the phone number
      // in `remoteJid` itself — see rules.ts's resolvePhoneBearingJid docstring. Fails closed
      // (never falls back to guessing) rather than weakening the allowlist check below.
      const remoteJid = resolvePhoneBearingJid(rawJid, key);
      if (remoteJid === null) {
        log.warn('evolution_webhook.lid_no_phone_mapping');
        trace(irid, 'allowlist', 'lid_unresolved');
        continue;
      }

      // REAL-inbound allowlist (fail-closed; never applies to the simulator, which never reaches
      // this route). Rejected BEFORE the dedupe-table insert below and before ingest() — no
      // message content, phone number, or JID is ever persisted or logged for a sender not on
      // this list, only the fact that a rejection happened. See docs/26_EVOLUTION_PILOT.md.
      if (!isRealInboundSenderAllowed(remoteJid, cfg.evolutionRealInboundAllowlist)) {
        log.warn('evolution_webhook.sender_not_allowlisted');
        trace(irid, 'allowlist', 'not_allowlisted');
        continue;
      }
      trace(irid, 'allowlist', 'ok');

      const eventKey = `evo:${cfg.evolutionInstanceName}:${key.id}`;
      const seen = await q(
        `INSERT INTO webhook_events(provider, event_key, payload) VALUES('evolution',$1,$2) ON CONFLICT (event_key) DO NOTHING RETURNING id`,
        [eventKey, JSON.stringify(item)]);
      if (!seen.length) { trace(irid, 'persistence', 'duplicate'); continue; } // duplicate delivery

      const digits = digitsFromJid(remoteJid);
      if (!digits) { trace(irid, 'persistence', 'no_digits'); continue; }
      const text = extractEvolutionText(item.message);
      await ingest({
        waId: toEvolutionWaId(remoteJid),
        name: item.pushName,
        messageId: 'evo:' + key.id,
        type: text ? 'text' : 'unsupported',
        text,
        channel: EVOLUTION_PILOT_CHANNEL,
      });
      await q(`UPDATE webhook_events SET status='PROCESSED', processed_at=now() WHERE event_key=$1`, [eventKey]);
      trace(irid, 'persistence', 'ok');
    } catch (e: any) {
      log.error('evolution_webhook.process_error', { err: e.message });
      trace(irid, 'persistence', 'error');
      failed = true;
    }
  }
  res.sendStatus(failed ? 500 : 200);
});
