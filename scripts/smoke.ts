// End-to-end smoke test: real Postgres + fake Meta Graph server. Run: npm run smoke (needs DATABASE_URL)
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';

const SECRET = 'testsecret', ADMIN = 'Basic ' + Buffer.from('admin:pw').toString('base64');
const sent: any[] = [];
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d));
  req.on('end', () => {
    if (req.url?.endsWith('/messages') && b.includes('"text"')) sent.push(JSON.parse(b));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ messages: [{ id: 'wamid.OUT' + sent.length }] }));
  });
}).listen(4010);

const env = { ...process.env, PORT: '4011', NODE_ENV: 'production', META_GRAPH_BASE: 'http://localhost:4010', META_GRAPH_API_VERSION: 'vX',
  META_APP_SECRET: SECRET, META_PHONE_NUMBER_ID: '1', META_ACCESS_TOKEN: 't', META_WEBHOOK_VERIFY_TOKEN: 'vt', ADMIN_PASSWORD: 'pw', AGENT_MOCK: 'true', DEBOUNCE_MS: '200' };
const app = spawn('node', ['--import', 'tsx', 'src/index.ts'], { env, stdio: 'inherit', shell: process.platform === 'win32' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const url = 'http://localhost:4011';

function hook(id: string, text: string, sigSecret = SECRET) {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '22200000001', profile: { name: 'Test' } }], messages: [{ from: '22200000001', id, type: 'text', text: { body: text } }] } }] }] });
  const sig = 'sha256=' + crypto.createHmac('sha256', sigSecret).update(body).digest('hex');
  return fetch(url + '/webhooks/meta/whatsapp', { method: 'POST', headers: { 'x-hub-signature-256': sig, 'content-type': 'application/json' }, body });
}
const adm = (p: string, m = 'GET', b?: any) => fetch(url + p, { method: m, headers: { Authorization: ADMIN, 'content-type': 'application/json' }, body: b && JSON.stringify(b) }).then((r) => r.json());

(async () => {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(url + '/api/health')).ok) break; } catch {} await sleep(500); }
  assert.equal((await fetch(url + '/webhooks/meta/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42')).status, 200, 'verify ok');
  assert.equal((await fetch(url + '/webhooks/meta/whatsapp?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=42')).status, 403, 'verify bad token');
  assert.equal((await hook('wamid.BAD', 'x', 'wrong')).status, 401, 'bad signature rejected');
  assert.equal((await fetch(url + '/api/conversations')).status, 401, 'admin needs auth');

  const id = 'wamid.' + Date.now();
  assert.equal((await hook(id, 'salam')).status, 200);
  assert.equal((await hook(id, 'salam')).status, 200); // duplicate delivery
  await sleep(1500);
  assert.equal(sent.length, 1, 'duplicate webhook => exactly one reply');

  const conv = (await adm('/api/conversations'))[0];
  await adm(`/api/conversations/${conv.id}/takeover`, 'POST');
  await hook(id + 'b', 'hello?'); await sleep(1200);
  assert.equal(sent.length, 1, 'no AI reply in HUMAN mode');

  await adm(`/api/conversations/${conv.id}/return-to-ai`, 'POST');
  await adm('/api/agent/pause', 'POST');
  await hook(id + 'c', 'still there?'); await sleep(1200);
  assert.equal(sent.length, 1, 'no AI reply while globally paused');

  await adm('/api/agent/resume', 'POST');
  await hook(id + 'd', 'back'); await sleep(1200);
  assert.equal(sent.length, 2, 'AI replies again after resume');
  console.log('SMOKE OK');
})().catch((e) => { console.error('SMOKE FAIL', e.message); process.exitCode = 1; }).finally(() => { app.kill(); fake.close(); setTimeout(() => process.exit(), 300); });
