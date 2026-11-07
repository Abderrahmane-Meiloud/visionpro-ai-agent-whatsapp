import { Router, json } from 'express';
import crypto from 'node:crypto';
import { cfg } from '../../config';
import { q } from '../../db';
import { ingest } from '../conversations';
import { EVOLUTION_PILOT_CHANNEL, timingSafeEqualStr, toEvolutionWaId } from './rules';

/**
 * FULLY ISOLATED SIMULATION SANDBOX (EVOLUTION_PILOT_SIMULATION_MODE=true only). Mounted on the
 * same isolated listener as the real pilot webhook (see docs/26_EVOLUTION_PILOT.md), but this is a
 * deliberately separate concern: it never talks to any real Evolution server or real WhatsApp
 * account. It exists because the real `vision` instance turned out to be connected to the owner's
 * personal daily-use WhatsApp number — this sandbox lets the full pipeline (inbound -> agent ->
 * catalog -> mock reply) be exercised with zero possibility of touching that account, by:
 *   1. A fake `/message/sendText/:instance` sink standing in for the real Evolution API — point
 *      EVOLUTION_API_BASE_URL at THIS SAME process (e.g. http://localhost:3100) instead of any
 *      real host, and sendEvolutionText's outbound calls simply loop back here.
 *   2. A tiny one-page UI + API that drives a synthetic inbound message through the exact same
 *      `ingest()` codepath the real webhook uses, under a fixed, obviously-fake simulation JID.
 */
export const evolutionSimulate = Router();

export const SIMULATION_DIGITS = '00000000000';
export const SIMULATION_JID = `${SIMULATION_DIGITS}@s.whatsapp.net`; // digits must be present — toEvolutionWaId/the allowlist match on digits, not on the JID string

// --- 1. Fake outbound sink (stands in for the real Evolution API's sendText endpoint) ---
const sentLog: { number: string; text: string }[] = [];
evolutionSimulate.post('/message/sendText/:instance', json({ limit: '1mb' }), (req, res) => {
  const { number, text } = req.body ?? {};
  sentLog.push({ number: String(number ?? ''), text: String(text ?? '') });
  if (sentLog.length > 500) sentLog.shift();
  // Must be unique across process restarts too — the DB this loops back into persists across
  // them (it's not torn down like the automated smoke test's), and `whatsapp_message_id` is
  // UNIQUE, so a small in-memory counter that resets to 1 on every restart would collide with a
  // row from a previous run.
  res.json({ key: { id: 'SIM_OUT_' + crypto.randomBytes(8).toString('hex') } });
});

// --- 2. Simulated conversation UI + API ---
function requireSecret(req: any, res: any): boolean {
  const expected = cfg.evolutionWebhookPathSecret;
  if (!expected || !timingSafeEqualStr(String(req.params.secret ?? ''), expected)) {
    res.sendStatus(404);
    return false;
  }
  return true;
}

evolutionSimulate.get('/webhooks/evolution/pilot/simulate/:secret', (req, res) => {
  if (!requireSecret(req, res)) return;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.send(SIMULATE_PAGE_HTML.replace(/__SECRET__/g, encodeURIComponent(req.params.secret)));
});

evolutionSimulate.post('/webhooks/evolution/pilot/simulate/:secret/message', json({ limit: '64kb' }), async (req, res) => {
  if (!requireSecret(req, res)) return;
  const text = String(req.body?.text ?? '').trim().slice(0, 4000);
  if (!text) return void res.status(400).json({ error: 'text is required' });

  const messageId = 'sim-' + crypto.randomBytes(8).toString('hex');
  await ingest({
    waId: toEvolutionWaId(SIMULATION_JID),
    name: 'Simulation',
    messageId: 'evo:' + messageId,
    type: 'text',
    text,
    channel: EVOLUTION_PILOT_CHANNEL,
  });

  // The reply runs on the normal debounce timer (cfg.debounceMs) — poll briefly for it rather
  // than assuming a fixed delay, same pattern the test scripts use.
  const conv = (await q<{ id: number }>(
    `SELECT c.id FROM conversations c JOIN customers cu ON cu.id=c.customer_id WHERE cu.wa_id=$1`,
    [toEvolutionWaId(SIMULATION_JID)],
  ))[0];

  // Wait for this inbound message to reach a terminal status (it's processed, debounced, on the
  // normal pipeline — same as a real message). Once terminal, the most recent OUT message in this
  // conversation (if any) is the reply to it: turns are processed single-flight, in order.
  const deadline = Date.now() + 8000;
  let finalStatus: string | undefined;
  while (Date.now() < deadline) {
    finalStatus = (await q<{ processing_status: string }>(
      `SELECT processing_status FROM messages WHERE conversation_id=$1 AND whatsapp_message_id=$2`,
      [conv.id, 'evo:' + messageId],
    ))[0]?.processing_status;
    if (finalStatus && finalStatus !== 'PENDING' && finalStatus !== 'PROCESSING') break;
    await new Promise((r) => setTimeout(r, 200));
  }

  const replyRow = finalStatus === 'DONE'
    ? (await q<{ text: string }>(`SELECT text FROM messages WHERE conversation_id=$1 AND direction='OUT' ORDER BY id DESC LIMIT 1`, [conv.id]))[0]
    : undefined;

  res.json({
    status: finalStatus ?? 'TIMEOUT',
    reply: replyRow?.text ?? null,
    note: finalStatus === 'SKIPPED_PILOT_GATE'
      ? 'Message was received and persisted, but auto-reply is gated off for this sender (EVOLUTION_PILOT_AUTO_REPLY_ENABLED / allowlist).'
      : undefined,
  });
});

const SIMULATE_PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>VisionPro WhatsApp — Evolution Pilot Simulator</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;background:#0b1220;color:#e5e7eb}
h1{font-size:1.1rem}
.banner{background:#7c2d12;color:#fed7aa;padding:.6rem .8rem;border-radius:.5rem;font-size:.85rem;margin-bottom:1rem}
#log{border:1px solid #334155;border-radius:.5rem;padding:.75rem;min-height:200px;margin-bottom:1rem;background:#0f172a}
.msg{margin:.4rem 0;padding:.5rem .7rem;border-radius:.6rem;max-width:85%}
.in{background:#1d4ed8;margin-left:auto;text-align:right}
.out{background:#334155}
.row{display:flex;gap:.5rem}
input{flex:1;padding:.6rem;border-radius:.4rem;border:1px solid #334155;background:#0f172a;color:#e5e7eb}
button{padding:.6rem 1rem;border-radius:.4rem;border:none;background:#2563eb;color:white;cursor:pointer}
.note{color:#94a3b8;font-size:.8rem;margin-top:.5rem}
</style></head>
<body>
<h1>VisionPro WhatsApp Agent — Evolution Pilot Simulator</h1>
<div class="banner">SIMULATION ONLY — never touches a real WhatsApp account. Outbound sends loop back into this same local process.</div>
<div id="log"></div>
<div class="row"><input id="t" placeholder="Type a customer message…" autofocus><button id="send">Send</button></div>
<div class="note" id="note"></div>
<script>
const log = document.getElementById('log');
const note = document.getElementById('note');
function add(cls, text) { const d = document.createElement('div'); d.className = 'msg ' + cls; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; }
async function send() {
  const input = document.getElementById('t');
  const text = input.value.trim();
  if (!text) return;
  add('in', text); input.value = ''; note.textContent = 'waiting for the agent...';
  try {
    const res = await fetch(location.pathname + '/message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    const body = await res.json();
    note.textContent = body.note || '';
    if (body.reply) add('out', body.reply);
    else if (!body.note) add('out', '(no reply — status: ' + body.status + ')');
  } catch (e) { note.textContent = 'request failed: ' + e.message; }
}
document.getElementById('send').onclick = send;
document.getElementById('t').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
</script>
</body></html>`;
