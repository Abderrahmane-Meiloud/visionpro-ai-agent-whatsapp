import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkProdConfig, type ProdConfigInput } from '../src/config';

const ok: ProdConfigInput = {
  databaseUrl: 'postgresql://u:p@db/app',
  verifyToken: 'verify-token',
  adminPassword: 'a-strong-admin-password',
  allowTestFaults: false,
  graphVersion: 'v21.0', appSecret: 's', phoneNumberId: '1', accessToken: 't',
};

test('checkProdConfig passes a fully-configured production setup', () => {
  const r = checkProdConfig(ok);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('checkProdConfig errors on missing required env, weak/placeholder password', () => {
  const r = checkProdConfig({ ...ok, databaseUrl: '', verifyToken: '', adminPassword: '' });
  assert.ok(r.errors.some((e) => /Missing env/.test(e) && /DATABASE_URL/.test(e) && /ADMIN_PASSWORD/.test(e)));
  assert.ok(checkProdConfig({ ...ok, adminPassword: 'short' }).errors.some((e) => /at least 16/.test(e)));
  assert.ok(checkProdConfig({ ...ok, adminPassword: 'CHANGE_ME_LONG_RANDOM' }).errors.some((e) => /placeholder/.test(e)));
});

test('checkProdConfig REFUSES ALLOW_TEST_FAULTS in production', () => {
  const r = checkProdConfig({ ...ok, allowTestFaults: true });
  assert.ok(r.errors.some((e) => /ALLOW_TEST_FAULTS must not be set in production/.test(e)));
});

test('checkProdConfig warns (does not error) when Meta creds are incomplete', () => {
  const r = checkProdConfig({ ...ok, appSecret: '', accessToken: '' });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => /Meta not fully configured/.test(w)));
});
