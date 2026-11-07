import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { assertDisposableTestDb } from '../../src/db-safety';

const PIDFILE = path.join(os.tmpdir(), 'wa-pw-app.pid');
const PORT = process.env.PW_PORT || '4021';
const ADMIN_PW = 'browser-test-admin-password'; // matches playwright.config.ts httpCredentials
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default async function globalSetup() {
  const DATABASE_URL = process.env.DATABASE_URL;
  // Never run against a non-disposable DB (we TRUNCATE + seed below).
  assertDisposableTestDb(DATABASE_URL, process.env.SMOKE_ALLOW_DESTRUCTIVE === '1');

  // Fake Evolution sink: the "manual reply on a pilot conversation" browser test makes a REAL
  // outbound call to EVOLUTION_API_BASE_URL (exactly like production code does) — point it at this
  // local, in-process fake instead of any real server. Lives for the whole Playwright run (this
  // process doesn't exit until teardown); no separate close needed.
  const fakeEvo = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ key: { id: 'PW_FAKE_EVO_OUT' } })); });
  }).listen(4123);

  // Start the app: mock AI (no paid calls), a non-routable Meta base (no real sends ever), and the
  // Evolution pilot pointed at the fake sink above (never a real server, never real credentials).
  const logFd = fs.openSync(path.join(os.tmpdir(), 'wa-pw-app.log'), 'a');
  const env = {
    ...process.env, PORT, NODE_ENV: 'development', AUTO_MIGRATE: 'true', AGENT_MOCK: 'true', DATABASE_URL,
    ADMIN_USER: 'admin', ADMIN_PASSWORD: ADMIN_PW, META_WEBHOOK_VERIFY_TOKEN: 'pw',
    META_GRAPH_BASE: 'http://127.0.0.1:1', META_GRAPH_API_VERSION: 'vX',
    META_APP_SECRET: 'x', META_PHONE_NUMBER_ID: '1', META_ACCESS_TOKEN: 't',
    EVOLUTION_API_BASE_URL: 'http://localhost:4123', EVOLUTION_INSTANCE_NAME: 'vision', EVOLUTION_API_KEY: 'pwtest-not-real',
    EVOLUTION_WEBHOOK_PATH_SECRET: 'pwtest-path-secret', EVOLUTION_PILOT_AUTO_REPLY_ENABLED: 'false',
    EVOLUTION_PILOT_SIMULATION_MODE: 'true',
  };
  const child = spawn('node', ['--import', 'tsx', 'src/index.ts'], { env, detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref();
  fs.writeFileSync(PIDFILE, String(child.pid));
  let exited = false;
  child.on('exit', () => { exited = true; }); // e.g. port already in use → fail fast, don't shadow a stale app

  const base = `http://localhost:${PORT}`;
  let ok = false;
  for (let i = 0; i < 60; i++) {
    if (exited) throw new Error(`app process exited during startup — is port ${PORT} already in use? (see wa-pw-app.log)`);
    try { if ((await fetch(base + '/api/health')).ok) { ok = true; break; } } catch {}
    await sleep(500);
  }
  if (!ok) throw new Error('app did not become healthy for browser tests (see wa-pw-app.log)');

  // Ensure the staff accounts the browser tests log in with exist, idempotently (409 on re-run is
  // fine), independent of run order — the smoke test, if run first against the same disposable DB,
  // truncates users, so we cannot rely on ensureBootstrapAdmin. All creation is via the env
  // bootstrap-admin Basic credential (which authenticates regardless of DB users).
  const basic = 'Basic ' + Buffer.from('admin:' + ADMIN_PW).toString('base64');
  const mkUser = (username: string, password: string, role: string) =>
    fetch(base + '/api/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: basic }, body: JSON.stringify({ username, password, role }) }).catch(() => {});
  await mkUser('admin', ADMIN_PW, 'admin');   // DB admin used for the dashboard tests' login
  await mkUser('agent1', 'agentpass123', 'agent'); // non-admin for the role-gating test

  // Seed deterministic sample data: one AI conversation and one awaiting-human conversation.
  // Note: users/sessions are intentionally NOT truncated (keep the bootstrap admin); sessions is
  // cleared for a clean slate.
  const db = new Pool({ connectionString: DATABASE_URL, max: 3 });
  try {
    await db.query(`TRUNCATE customers, conversations, messages, webhook_events, knowledge_articles,
      vocabulary, agent_settings, handoffs, tool_executions, audit_logs, sessions,
      products, product_prices, inventory, orders, templates RESTART IDENTITY CASCADE`);
    const cust = async (wa: string, name: string) =>
      (await db.query(`INSERT INTO customers(wa_id, display_name) VALUES($1,$2) RETURNING id`, [wa, name])).rows[0].id;
    const a = await cust('111111111', 'Alice');
    const b = await cust('222222222', 'Bob');
    const p = await cust('evo:00000000000', 'PilotCustomer');
    const convA = (await db.query(`INSERT INTO conversations(customer_id, mode, last_inbound_at) VALUES($1,'AI',now()) RETURNING id`, [a])).rows[0].id;
    const convB = (await db.query(`INSERT INTO conversations(customer_id, mode, last_inbound_at) VALUES($1,'HUMAN_PENDING',now()) RETURNING id`, [b])).rows[0].id;
    // Evolution pilot conversation: unread (last_read_at NULL), distinct channel, for the pilot-
    // specific dashboard tests (channel filter/tag, unread badge, linked orders). Backdated an
    // hour so it sorts AFTER Alice/Bob in the default last_message_at DESC list order — several
    // existing generic tests act on "the first row" and must keep hitting Alice, not this one.
    const convP = (await db.query(
      `INSERT INTO conversations(customer_id, mode, channel, last_inbound_at, last_message_at) VALUES($1,'AI','whatsapp_evolution_pilot',now() - interval '1 hour',now() - interval '1 hour') RETURNING id`,
      [p],
    )).rows[0].id;
    await db.query(
      `INSERT INTO messages(conversation_id, direction, sender_type, message_type, text, delivery_status) VALUES
       ($1,'IN','CUSTOMER','TEXT','Bonjour, je veux des infos',NULL),
       ($1,'OUT','AI','TEXT','Bonjour! Comment puis-je vous aider?','read'),
       ($2,'IN','CUSTOMER','TEXT','Je veux parler a une personne',NULL),
       ($3,'IN','CUSTOMER','TEXT','Hello, do you have the test rug in stock?',NULL),
       ($3,'OUT','AI','TEXT','[mock] received: Hello, do you have the test rug in stock?','sent')`, [convA, convB, convP]);
    await db.query(`INSERT INTO handoffs(conversation_id, reason) VALUES($1,'customer asked for a person')`, [convB]);

    // P2-C seed: a product + approved template (via admin API), a DRAFT order, and a closed-window conversation.
    const post = (p: string, body: any) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: basic }, body: JSON.stringify(body) });
    await post('/api/products', { sku: 'RUG-1', name: 'Carpet', amount: 500, currency: 'MRU', qty: 10 });
    await post('/api/templates', { name: 'Reminder', meta_template_name: 'reminder_fr', language: 'fr', body_preview: 'Bonjour {{1}}', variables: 1 });
    const prodId = (await db.query(`SELECT id FROM products WHERE sku='RUG-1'`)).rows[0].id;
    await db.query(`INSERT INTO orders(conversation_id, status, items, currency, total, created_by) VALUES($1,'DRAFT',$2,'MRU',500,'AI')`,
      [convA, JSON.stringify([{ product_id: prodId, sku: 'RUG-1', name: 'Carpet', qty: 1, unit_amount: 500 }])]);
    // Linked order for the pilot conversation, so the "linked orders" dashboard panel has
    // something real to show for a channel-filtered, pilot-specific conversation.
    await db.query(`INSERT INTO orders(conversation_id, status, items, currency, total, created_by) VALUES($1,'DRAFT',$2,'USD',50,'AI')`,
      [convP, JSON.stringify([{ product_id: prodId, sku: 'RUG-1', name: 'Carpet', qty: 2, unit_amount: 25 }])]);
    // close Bob's 24h window so the composer shows the template picker when he is selected
    await db.query(`UPDATE conversations SET last_inbound_at = now() - interval '25 hours' WHERE id=$1`, [convB]);
    await db.query(`UPDATE messages SET created_at = now() - interval '25 hours' WHERE conversation_id=$1`, [convB]);
  } finally {
    await db.end();
  }
}
