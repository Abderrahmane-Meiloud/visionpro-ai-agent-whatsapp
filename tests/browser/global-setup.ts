import { spawn } from 'node:child_process';
import fs from 'node:fs';
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

  // Start the app: mock AI (no paid calls) and a non-routable Meta base (no real sends ever).
  const logFd = fs.openSync(path.join(os.tmpdir(), 'wa-pw-app.log'), 'a');
  const env = {
    ...process.env, PORT, NODE_ENV: 'development', AUTO_MIGRATE: 'true', AGENT_MOCK: 'true', DATABASE_URL,
    ADMIN_USER: 'admin', ADMIN_PASSWORD: ADMIN_PW, META_WEBHOOK_VERIFY_TOKEN: 'pw',
    META_GRAPH_BASE: 'http://127.0.0.1:1', META_GRAPH_API_VERSION: 'vX',
    META_APP_SECRET: 'x', META_PHONE_NUMBER_ID: '1', META_ACCESS_TOKEN: 't',
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
    const convA = (await db.query(`INSERT INTO conversations(customer_id, mode, last_inbound_at) VALUES($1,'AI',now()) RETURNING id`, [a])).rows[0].id;
    const convB = (await db.query(`INSERT INTO conversations(customer_id, mode, last_inbound_at) VALUES($1,'HUMAN_PENDING',now()) RETURNING id`, [b])).rows[0].id;
    await db.query(
      `INSERT INTO messages(conversation_id, direction, sender_type, message_type, text, delivery_status) VALUES
       ($1,'IN','CUSTOMER','TEXT','Bonjour, je veux des infos',NULL),
       ($1,'OUT','AI','TEXT','Bonjour! Comment puis-je vous aider?','read'),
       ($2,'IN','CUSTOMER','TEXT','Je veux parler a une personne',NULL)`, [convA, convB]);
    await db.query(`INSERT INTO handoffs(conversation_id, reason) VALUES($1,'customer asked for a person')`, [convB]);

    // P2-C seed: a product + approved template (via admin API), a DRAFT order, and a closed-window conversation.
    const post = (p: string, body: any) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: basic }, body: JSON.stringify(body) });
    await post('/api/products', { sku: 'RUG-1', name: 'Carpet', amount: 500, currency: 'MRU', qty: 10 });
    await post('/api/templates', { name: 'Reminder', meta_template_name: 'reminder_fr', language: 'fr', body_preview: 'Bonjour {{1}}', variables: 1 });
    const prodId = (await db.query(`SELECT id FROM products WHERE sku='RUG-1'`)).rows[0].id;
    await db.query(`INSERT INTO orders(conversation_id, status, items, currency, total, created_by) VALUES($1,'DRAFT',$2,'MRU',500,'AI')`,
      [convA, JSON.stringify([{ product_id: prodId, sku: 'RUG-1', name: 'Carpet', qty: 1, unit_amount: 500 }])]);
    // close Bob's 24h window so the composer shows the template picker when he is selected
    await db.query(`UPDATE conversations SET last_inbound_at = now() - interval '25 hours' WHERE id=$1`, [convB]);
    await db.query(`UPDATE messages SET created_at = now() - interval '25 hours' WHERE conversation_id=$1`, [convB]);
  } finally {
    await db.end();
  }
}
