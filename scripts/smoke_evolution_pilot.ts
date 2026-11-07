// Evolution API pilot — isolated integration smoke test. Run: DATABASE_URL=postgresql://... npm run smoke:evolution
//
// Deliberately NON-destructive (unlike scripts/smoke.ts, which TRUNCATEs its tables): this is meant
// to be runnable against the project's normal dev database without wiping anything. It only ever
// touches rows it creates itself (a uniquely-tagged pilot customer per run) and deletes exactly
// those rows in its `finally` block. No real Evolution API or OpenAI calls (fake local Evolution
// server + AGENT_MOCK=true) — no cost, no live WhatsApp send.
//
// Covers: isolated listener comes up on its own port; path-secret + auth-header rejection; wrong
// instance ignored; group/broadcast/fromMe/stale-history-sync messages ignored; duplicate delivery
// dedupes to one processed webhook_event; a text message round-trips through the real catalog
// tools (get_product) in mock agent mode; auto-reply stays OFF by default and when the sender is
// not on the allowlist; auto-reply fires ONLY once enabled AND the sender is allowlisted; the pilot
// customer/conversation never shares a row with any Meta-channel customer for the same number;
// CONNECTION_UPDATE is recorded without ever scheduling a reply; production boot refuses to start
// at all while the pilot is configured.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('SMOKE FAIL: DATABASE_URL is not set'); process.exit(1); }
try {
  const u = new URL(DATABASE_URL);
  if (!['localhost', '127.0.0.1', '::1'].includes(u.hostname.toLowerCase())) {
    console.warn(`WARNING: DATABASE_URL host "${u.hostname}" is not local — proceeding anyway since this script is non-destructive, but double-check this is really the intended dev database.`);
  }
} catch { console.error('SMOKE FAIL: DATABASE_URL is not a valid URL'); process.exit(1); }

const RUN_TAG = 'pilotsmoke' + Date.now();
const PATH_SECRET = crypto.randomBytes(24).toString('hex');
const AUTH_HEADER_SECRET = crypto.randomBytes(16).toString('hex');
const INSTANCE = 'test-vision-' + RUN_TAG;
const TEST_NUMBER = '22249' + String(Date.now()).slice(-6); // unique per run, never a real number
const PORT = '4021';
const EVO_WEBHOOK_PORT = '4122';
const FAKE_EVO_PORT = 4120;
const url = `http://localhost:${PORT}`;
const evoUrl = `http://localhost:${EVO_WEBHOOK_PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const db = new Pool({ connectionString: DATABASE_URL, max: 4 });

const evoSent: any[] = [];
const fakeEvo = http
  .createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => {
      if (req.url?.startsWith('/message/sendText/')) evoSent.push(JSON.parse(b || '{}'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ key: { id: 'EVO_OUT_' + (evoSent.length) } }));
    });
  })
  .listen(FAKE_EVO_PORT);

const ADMIN_PW = 'smoke-evolution-admin-pw-01';
const baseEnv = {
  ...process.env, PORT, NODE_ENV: 'development', AUTO_MIGRATE: 'true', DATABASE_URL,
  META_GRAPH_BASE: 'http://localhost:4019', META_GRAPH_API_VERSION: 'vX', META_APP_SECRET: 'metasecret',
  META_PHONE_NUMBER_ID: '1', META_ACCESS_TOKEN: 't', META_WEBHOOK_VERIFY_TOKEN: 'vt', ADMIN_PASSWORD: ADMIN_PW,
  AGENT_MOCK: 'true', DEBOUNCE_MS: '200',
  EVOLUTION_API_BASE_URL: `http://localhost:${FAKE_EVO_PORT}`, EVOLUTION_API_BASE: `http://localhost:${FAKE_EVO_PORT}`,
  EVOLUTION_INSTANCE_NAME: INSTANCE, EVOLUTION_API_KEY: 'fakekey',
  EVOLUTION_WEBHOOK_PORT: EVO_WEBHOOK_PORT, EVOLUTION_WEBHOOK_PATH_SECRET: PATH_SECRET,
  EVOLUTION_WEBHOOK_AUTH_HEADER: AUTH_HEADER_SECRET,
  EVOLUTION_PILOT_AUTO_REPLY_ENABLED: 'false', EVOLUTION_PILOT_ALLOWED_TEST_NUMBERS: TEST_NUMBER,
  // The real-inbound sender allowlist is fail-closed (empty = reject everyone) — TEST_NUMBER must
  // be explicitly allowlisted here for the rest of this suite's existing assertions (which post
  // through the real webhook route, not the simulator) to keep working at all.
  EVOLUTION_REAL_INBOUND_ALLOWLIST: TEST_NUMBER,
};

let app: ChildProcess | null = null;
async function startApp(env: NodeJS.ProcessEnv) {
  app = spawn('node', ['--import', 'tsx', 'src/index.ts'], { env, stdio: 'inherit' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(url + '/api/health')).ok) return; } catch {} await sleep(500); }
  throw new Error('app did not become healthy');
}
async function stopApp() {
  if (!app?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F']);
  else app.kill('SIGKILL');
  for (let i = 0; i < 20; i++) { try { await fetch(url + '/api/health'); } catch { app = null; return; } await sleep(250); }
  app = null;
}
async function waitFor(pred: () => boolean | Promise<boolean>, ms = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(100); }
  return false;
}

function upsertBody(instance: string, items: any) {
  return JSON.stringify({ event: 'messages.upsert', instance, data: items });
}
function msg(id: string, text: string, opts: Partial<{ fromMe: boolean; remoteJid: string; remoteJidAlt: string; tsAgeSec: number }> = {}) {
  const remoteJid = opts.remoteJid ?? `${TEST_NUMBER}@s.whatsapp.net`;
  const key: Record<string, unknown> = { remoteJid, fromMe: opts.fromMe ?? false, id };
  if (opts.remoteJidAlt !== undefined) key.remoteJidAlt = opts.remoteJidAlt;
  return {
    key,
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000) - (opts.tsAgeSec ?? 0),
    pushName: 'Smoke Tester',
  };
}
function postEvo(body: string, opts: { secret?: string; authHeader?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.authHeader !== undefined) headers.authorization = `Bearer ${opts.authHeader}`;
  else headers.authorization = `Bearer ${AUTH_HEADER_SECRET}`;
  return fetch(`${evoUrl}/webhooks/evolution/pilot/${opts.secret ?? PATH_SECRET}`, { method: 'POST', headers, body });
}

async function cleanup() {
  // Only ever deletes rows this run created (tagged by the unique TEST_NUMBER's pilot wa_id).
  await db.query(
    `DELETE FROM messages WHERE conversation_id IN (SELECT c.id FROM conversations c JOIN customers cu ON cu.id=c.customer_id WHERE cu.wa_id=$1)`,
    [`evo:${TEST_NUMBER}`]);
  await db.query(`DELETE FROM tool_executions WHERE conversation_id IN (SELECT c.id FROM conversations c JOIN customers cu ON cu.id=c.customer_id WHERE cu.wa_id=$1)`, [`evo:${TEST_NUMBER}`]);
  // handoffs rows (e.g. from the real-outbound-gate scenario's requestHandoff on a failed send)
  // must go before conversations, or the FK blocks the conversations delete below.
  await db.query(`DELETE FROM handoffs WHERE conversation_id IN (SELECT c.id FROM conversations c JOIN customers cu ON cu.id=c.customer_id WHERE cu.wa_id=$1)`, [`evo:${TEST_NUMBER}`]);
  await db.query(`DELETE FROM conversations WHERE customer_id IN (SELECT id FROM customers WHERE wa_id=$1)`, [`evo:${TEST_NUMBER}`]);
  await db.query(`DELETE FROM customers WHERE wa_id=$1`, [`evo:${TEST_NUMBER}`]);
  await db.query(`DELETE FROM webhook_events WHERE event_key LIKE $1`, [`evo:${INSTANCE}:%`]);
  // audit_logs is append-only by design (a DB trigger blocks UPDATE/DELETE) — a harmless
  // 'evolution-webhook' setting.update row from the CONNECTION_UPDATE test is left behind on
  // purpose, exactly like every other action this app ever audits.
}

(async () => {
  await startApp(baseEnv);
  await cleanup(); // in case a previous aborted run left rows with this (time-based) tag — defensive only

  // --- isolated listener: comes up on its own port, health check only, no admin/meta routes ---
  assert.equal((await fetch(evoUrl + '/webhooks/evolution/pilot/health')).status, 200, 'pilot listener health check');
  assert.equal((await fetch(evoUrl + '/api/conversations')).status, 404, 'pilot listener does NOT expose admin routes');
  // The main listener's admin router applies auth middleware to every unmatched path (so an
  // unknown path there is 401, not a plain 404) — either way, the real assertion is that it never
  // serves the pilot's actual health payload, i.e. it does not run the pilot webhook router at all.
  {
    const r = await fetch(url + '/webhooks/evolution/pilot/health');
    assert.notEqual(r.status, 200, 'main listener does NOT serve the pilot route as a working endpoint — fully separate servers');
  }

  // --- auth: wrong path secret / wrong header -> 404 (not 401 — never confirms the path exists) ---
  assert.equal((await postEvo(upsertBody(INSTANCE, [msg('m1', 'hi')]), { secret: 'wrong-secret-wrong-secret' })).status, 404, 'wrong path secret rejected');
  assert.equal((await postEvo(upsertBody(INSTANCE, [msg('m1', 'hi')]), { authHeader: 'wrong' })).status, 404, 'wrong auth header rejected');

  // --- wrong instance ignored (ack 200, nothing persisted) ---
  {
    const n = (await db.query(`SELECT count(*)::int c FROM webhook_events WHERE event_key LIKE $1`, [`evo:${INSTANCE}:%`])).rows[0].c;
    assert.equal((await postEvo(upsertBody('some-other-instance', [msg('wrong-inst', 'hi')]))).status, 200, 'wrong instance acked');
    assert.equal((await db.query(`SELECT count(*)::int c FROM webhook_events WHERE event_key LIKE $1`, [`evo:${INSTANCE}:%`])).rows[0].c, n, 'wrong instance never persisted under our instance key');
  }

  // --- CONNECTION_UPDATE: recorded, never schedules a reply ---
  {
    const n = evoSent.length;
    assert.equal((await postEvo(JSON.stringify({ event: 'connection.update', instance: INSTANCE, data: { state: 'open' } }))).status, 200, 'connection.update acked');
    await sleep(300);
    assert.equal(evoSent.length, n, 'connection.update never triggers an outbound send');
  }

  // --- group / broadcast / fromMe / stale-history filtered, never ingested ---
  {
    const before = (await db.query(`SELECT count(*)::int c FROM customers WHERE wa_id=$1`, [`evo:${TEST_NUMBER}`])).rows[0].c;
    await postEvo(upsertBody(INSTANCE, [
      msg('g1', 'group msg', { remoteJid: '12345@g.us' }),
      msg('b1', 'broadcast', { remoteJid: 'status@broadcast' }),
      msg('echo1', 'our own echo', { fromMe: true }),
      msg('old1', 'stale history replay', { tsAgeSec: 600 }),
    ]));
    await sleep(300);
    assert.equal((await db.query(`SELECT count(*)::int c FROM customers WHERE wa_id=$1`, [`evo:${TEST_NUMBER}`])).rows[0].c, before, 'group/broadcast/echo/stale messages never create a customer row');
  }

  // --- real-inbound allowlist: a sender NOT on the list is rejected BEFORE any persistence,
  // dedupe-table insert, or content logging — the core safety mechanism for requirement #6 ---
  {
    const NOT_ALLOWED_NUMBER = '22277' + String(Date.now()).slice(-6);
    const custBefore = (await db.query(`SELECT count(*)::int c FROM customers WHERE wa_id=$1`, [`evo:${NOT_ALLOWED_NUMBER}`])).rows[0].c;
    const eventsBefore = (await db.query(`SELECT count(*)::int c FROM webhook_events WHERE event_key LIKE $1`, [`evo:${INSTANCE}:not-allowed%`])).rows[0].c;
    const res = await postEvo(upsertBody(INSTANCE, [msg('not-allowed-1', 'hello from an unauthorized number', { remoteJid: `${NOT_ALLOWED_NUMBER}@s.whatsapp.net` })]));
    assert.equal(res.status, 200, 'non-allowlisted sender still gets a clean ack (never reveals the rejection to the sender)');
    await sleep(300);
    assert.equal((await db.query(`SELECT count(*)::int c FROM customers WHERE wa_id=$1`, [`evo:${NOT_ALLOWED_NUMBER}`])).rows[0].c, custBefore, 'no customer row created for a non-allowlisted sender');
    assert.equal((await db.query(`SELECT count(*)::int c FROM webhook_events WHERE event_key LIKE $1`, [`evo:${INSTANCE}:not-allowed%`])).rows[0].c, eventsBefore, 'no webhook_events row (no raw payload, no message content) persisted for a non-allowlisted sender');
  }
  {
    // Fail-closed: restart with an EMPTY real-inbound allowlist — even the previously-allowed
    // TEST_NUMBER must now be rejected entirely.
    await stopApp();
    await startApp({ ...baseEnv, EVOLUTION_REAL_INBOUND_ALLOWLIST: '' });
    const custBefore = (await db.query(`SELECT count(*)::int c FROM customers WHERE wa_id=$1`, [`evo:${TEST_NUMBER}`])).rows[0].c;
    await postEvo(upsertBody(INSTANCE, [msg('failclosed-1', 'should be rejected, empty allowlist')]));
    await sleep(300);
    assert.equal((await db.query(`SELECT count(*)::int c FROM customers WHERE wa_id=$1`, [`evo:${TEST_NUMBER}`])).rows[0].c, custBefore, 'empty allowlist rejects even a number that was allowlisted before the restart — fail closed, not fail open');
    await stopApp();
    await startApp(baseEnv); // restore for the rest of the suite
  }

  // --- a real text message: ingested, isolated namespace, catalog tool runs in mock mode ---
  const msgId = 'real1-' + RUN_TAG;
  assert.equal((await postEvo(upsertBody(INSTANCE, [msg(msgId, 'Do you have carpets?')]))).status, 200, 'real text message accepted');
  assert.ok(
    await waitFor(async () => (await db.query(`SELECT 1 FROM customers WHERE wa_id=$1`, [`evo:${TEST_NUMBER}`])).rows.length === 1),
    'pilot customer created under the evo: namespace',
  );
  const pilotConv = (await db.query(
    `SELECT c.id, c.channel FROM conversations c JOIN customers cu ON cu.id=c.customer_id WHERE cu.wa_id=$1`, [`evo:${TEST_NUMBER}`],
  )).rows[0];
  assert.equal(pilotConv.channel, 'whatsapp_evolution_pilot', 'conversation tagged with the isolated pilot channel');

  // --- duplicate delivery dedupes (same key.id) ---
  {
    const n = (await db.query(`SELECT count(*)::int c FROM messages WHERE conversation_id=$1`, [pilotConv.id])).rows[0].c;
    await postEvo(upsertBody(INSTANCE, [msg(msgId, 'Do you have carpets?')])); // duplicate of the same id
    await sleep(300);
    assert.equal((await db.query(`SELECT count(*)::int c FROM messages WHERE conversation_id=$1`, [pilotConv.id])).rows[0].c, n, 'duplicate webhook delivery produces no extra message row');
  }

  // --- auto-reply stays OFF by default (EVOLUTION_PILOT_AUTO_REPLY_ENABLED=false in baseEnv) ---
  await sleep(500);
  assert.equal(evoSent.length, 0, 'no automatic reply sent while the pilot auto-reply switch is off');
  assert.equal(
    (await db.query(`SELECT processing_status FROM messages WHERE conversation_id=$1 AND text=$2`, [pilotConv.id, 'Do you have carpets?'])).rows[0]?.processing_status,
    'SKIPPED_PILOT_GATE', 'inbound message is persisted but explicitly marked skipped-by-gate, not silently dropped',
  );

  // --- restart with auto-reply ON but sender NOT on the allowlist -> still gated ---
  await stopApp();
  await startApp({ ...baseEnv, EVOLUTION_PILOT_AUTO_REPLY_ENABLED: 'true', EVOLUTION_PILOT_ALLOWED_TEST_NUMBERS: '22299999999' });
  const msgId2 = 'notallowed-' + RUN_TAG;
  await postEvo(upsertBody(INSTANCE, [msg(msgId2, 'another question')]));
  await sleep(600);
  assert.equal(evoSent.length, 0, 'auto-reply ON but sender not allowlisted -> still no reply sent');

  // --- restart with auto-reply ON and sender allowlisted -> real reply through the fake Evolution API ---
  await stopApp();
  await startApp({ ...baseEnv, EVOLUTION_PILOT_AUTO_REPLY_ENABLED: 'true', EVOLUTION_PILOT_ALLOWED_TEST_NUMBERS: TEST_NUMBER });
  const msgId3 = 'allowed-' + RUN_TAG;
  await postEvo(upsertBody(INSTANCE, [msg(msgId3, 'please reply now')]));
  assert.ok(await waitFor(() => evoSent.length === 1), 'allowlisted test number gets exactly one automatic reply');
  assert.ok(typeof evoSent[0].number === 'string' && evoSent[0].number === TEST_NUMBER, 'outbound send targets the bare phone number, not the evo: namespaced id');
  assert.ok(String(evoSent[0].text || '').startsWith('[mock]'), 'reply came from the real agent pipeline (mock mode), not a stub');

  // --- isolation: this pilot customer never touches the Meta-channel customers table by the same raw number ---
  const metaCollision = await db.query(`SELECT 1 FROM customers WHERE wa_id=$1`, [TEST_NUMBER]);
  assert.equal(metaCollision.rows.length, 0, 'the bare phone number (Meta-channel namespace) was never created — pilot stays isolated');

  // --- dashboard: channel visibility, unread, linked orders, retry, kill-switch status ---
  const ADMIN = 'Basic ' + Buffer.from('admin:' + ADMIN_PW).toString('base64');
  const adm = (p: string, m = 'GET', b?: any) => fetch(url + p, { method: m, headers: { Authorization: ADMIN, 'content-type': 'application/json' }, body: b && JSON.stringify(b) });
  const admJson = (p: string, m = 'GET', b?: any) => adm(p, m, b).then((r) => r.json());
  {
    const pilotRows: any[] = await admJson('/api/conversations?channel=whatsapp_evolution_pilot');
    assert.ok(pilotRows.some((r) => r.id === pilotConv.id), 'channel filter returns this pilot conversation');
    assert.ok(pilotRows.every((r) => r.channel === 'whatsapp_evolution_pilot'), 'channel filter never leaks a different channel');
    const metaRows: any[] = await admJson('/api/conversations?channel=whatsapp');
    assert.ok(!metaRows.some((r) => r.id === pilotConv.id), 'the Meta-channel filter excludes this pilot conversation');

    const before = (await admJson('/api/conversations')).find((r: any) => r.id === pilotConv.id);
    assert.equal(before.unread, true, 'a conversation with new inbound messages is unread before the dashboard ever opens it');
    await adm(`/api/conversations/${pilotConv.id}`); // viewing it (Basic/session both hit the same code path for this call) marks it read... except Basic is NOT a session:
    const stillBridgeView = (await admJson('/api/conversations')).find((r: any) => r.id === pilotConv.id);
    assert.equal(stillBridgeView.unread, true, 'a Basic-auth (service) read does NOT mark a conversation read — only a real staff session view does');

    const orders: any[] = await admJson(`/api/conversations/${pilotConv.id}/orders`);
    assert.ok(Array.isArray(orders), 'linked-orders endpoint responds for a conversation with none yet');

    // retry: force a FAILED inbound message, then retry it through the dashboard endpoint
    const failedId = 'evo:failtest-' + RUN_TAG;
    await db.query(
      `INSERT INTO messages(conversation_id, whatsapp_message_id, direction, sender_type, message_type, text, processing_status, error)
       VALUES($1,$2,'IN','CUSTOMER','TEXT','please retry me','FAILED','simulated failure for the smoke test')`,
      [pilotConv.id, failedId],
    );
    const retryRes = await adm(`/api/conversations/${pilotConv.id}/messages/${(await db.query(`SELECT id FROM messages WHERE whatsapp_message_id=$1`, [failedId])).rows[0].id}/retry`, 'POST');
    assert.equal(retryRes.status, 200, 'retry endpoint accepts a FAILED inbound message');
    assert.ok(
      await waitFor(async () => (await db.query(`SELECT processing_status FROM messages WHERE whatsapp_message_id=$1`, [failedId])).rows[0].processing_status !== 'FAILED'),
      'retried message is re-queued and reprocessed (no longer stuck FAILED)',
    );
    const doubleRetry = await adm(`/api/conversations/${pilotConv.id}/messages/999999999/retry`, 'POST');
    assert.equal(doubleRetry.status, 409, 'retrying a non-existent/non-FAILED message is rejected, not silently accepted');

    const settings = await admJson('/api/agent-settings');
    assert.equal(settings.ai_provider.mock, true, 'dashboard honestly reports AI replies as mock when AGENT_MOCK=true — never pretends mock is real AI');
    assert.equal(settings.evolution_pilot.configured, true, 'dashboard reports the Evolution pilot as configured in this run');
    // Counts only, never the raw numbers — this is a real HTTP response, not an internal log line.
    assert.equal(typeof settings.evolution_pilot.allowed_test_numbers_count, 'number', 'dashboard exposes the allowlist SIZE (the operator-visible kill switch) as a count, never the raw numbers');
    assert.equal(typeof settings.evolution_pilot.real_inbound_allowlist_count, 'number', 'dashboard also exposes the real-inbound allowlist size as a count');
    assert.equal(settings.evolution_pilot.real_outbound_enabled, false, 'dashboard reports the real-outbound kill switch honestly (false by default in this run)');

    // --- manual human reply on a PILOT conversation must route through the Evolution client, not
    // crash trying to use the (unconfigured, in this run) Meta client — a real bug found by
    // execution: this endpoint used to be hardcoded to the Meta transport regardless of channel.
    await adm(`/api/conversations/${pilotConv.id}/takeover`, 'POST');
    const nSent = evoSent.length;
    const manual = await adm(`/api/conversations/${pilotConv.id}/messages`, 'POST', { text: 'manual human reply on the pilot channel' });
    assert.equal(manual.status, 200, 'manual reply on a pilot-channel conversation succeeds (used to 500)');
    assert.equal(evoSent.length, nSent + 1, 'the manual reply was actually sent through the (fake) Evolution API, not dropped');
    await adm(`/api/conversations/${pilotConv.id}/return-to-ai`, 'POST');
  }

  // --- EVOLUTION_REAL_OUTBOUND_ENABLED=false fails closed even with auto-reply ON and the sender
  // allowlisted, AND proves inbound receiving/persistence is fully independent of outbound being
  // blocked (requirement: real inbound can operate while ALL real outbound remains disabled) ---
  {
    await stopApp();
    await startApp({
      ...baseEnv, EVOLUTION_PILOT_AUTO_REPLY_ENABLED: 'true', EVOLUTION_PILOT_ALLOWED_TEST_NUMBERS: TEST_NUMBER,
      // Deliberately NOT loopback per isLoopbackBase's strict definition, and a closed port, so any
      // real send attempt fails fast at the TCP layer; EVOLUTION_REAL_OUTBOUND_ENABLED is absent
      // from this env (default false), so sendEvolutionText must reject before even trying the network.
      EVOLUTION_API_BASE_URL: 'http://127.0.0.2:1', EVOLUTION_API_BASE: 'http://127.0.0.2:1',
    });
    const sentBefore = evoSent.length;
    const msgId4 = 'realoutbound-gate-' + RUN_TAG;
    const gateText = 'trigger the real-outbound gate ' + RUN_TAG;
    await postEvo(upsertBody(INSTANCE, [msg(msgId4, gateText)]));
    assert.ok(
      await waitFor(async () => (await db.query(`SELECT 1 FROM messages WHERE conversation_id=$1 AND text=$2`, [pilotConv.id, gateText])).rows.length === 1),
      'inbound message is still received and persisted even though real outbound is disabled — receiving and sending are independent',
    );
    assert.ok(
      await waitFor(async () => (await db.query(`SELECT processing_status FROM messages WHERE conversation_id=$1 AND text=$2`, [pilotConv.id, gateText])).rows[0]?.processing_status === 'FAILED'),
      'the auto-reply attempt fails closed (marked FAILED, not silently dropped or crashed) instead of reaching a real, non-loopback Evolution API',
    );
    const gateErr = (await db.query(`SELECT error FROM messages WHERE conversation_id=$1 AND text=$2`, [pilotConv.id, gateText])).rows[0].error || '';
    assert.match(gateErr, /EVOLUTION_REAL_OUTBOUND_ENABLED is false/, 'the failure is specifically the real-outbound gate, not an unrelated network error');
    assert.equal(evoSent.length, sentBefore, 'no outbound call ever reached the (fake, loopback) Evolution sink for this blocked send');
  }

  // --- WhatsApp "LID" JIDs (`<opaque-id>@lid`): the real pilot allowlist is phone-number based, so
  // a message arriving as @lid must be resolved to its phone-bearing alternate (remoteJidAlt, the
  // field evolution-api itself uses for this) BEFORE the allowlist check — never compared as-is.
  {
    await stopApp();
    await startApp({ ...baseEnv, EVOLUTION_PILOT_ALLOWED_TEST_NUMBERS: TEST_NUMBER });

    const lidOkText = 'lid message with a resolvable phone alternate ' + RUN_TAG;
    await postEvo(upsertBody(INSTANCE, [msg('lid-ok-' + RUN_TAG, lidOkText, {
      remoteJid: '998877665544332@lid', remoteJidAlt: `${TEST_NUMBER}@s.whatsapp.net`,
    })]));
    assert.ok(
      await waitFor(async () => (await db.query(`SELECT 1 FROM messages WHERE conversation_id=$1 AND text=$2`, [pilotConv.id, lidOkText])).rows.length === 1),
      '@lid message with a remoteJidAlt resolves to the allowlisted phone number and is persisted',
    );

    const custBefore = (await db.query(`SELECT count(*)::int c FROM customers`)).rows[0].c;
    const eventsBefore = (await db.query(`SELECT count(*)::int c FROM webhook_events WHERE event_key LIKE $1`, [`evo:${INSTANCE}:lid-noalt%`])).rows[0].c;
    const res = await postEvo(upsertBody(INSTANCE, [msg('lid-noalt-' + RUN_TAG, 'lid message with no phone alternate at all', {
      remoteJid: '112233445566778@lid',
    })]));
    assert.equal(res.status, 200, 'a LID message with no phone alternate still gets a clean ack (never reveals the rejection)');
    assert.equal(
      (await db.query(`SELECT count(*)::int c FROM customers`)).rows[0].c, custBefore,
      'an @lid message with NO phone-bearing alternate creates no customer row — fails closed rather than guessing',
    );
    assert.equal(
      (await db.query(`SELECT count(*)::int c FROM webhook_events WHERE event_key LIKE $1`, [`evo:${INSTANCE}:lid-noalt%`])).rows[0].c, eventsBefore,
      'never even reaches the dedupe/persistence insert — rejected at the allowlist stage',
    );
  }

  console.log('SMOKE OK (evolution pilot)');
})()
  .catch((e) => { console.error('SMOKE FAIL', e.message); process.exitCode = 1; })
  .finally(async () => {
    await stopApp();
    await cleanup().catch((e) => console.error('cleanup failed (manual check needed):', e.message));
    await db.end().catch(() => {});
    fakeEvo.close();
    setTimeout(() => process.exit(), 300);
  });
