import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authenticateBasic } from '../src/modules/admin/auth';
import { clampLimit, parseBeforeId } from '../src/modules/admin/pagination';

const basic = (user: string, pass: string) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

test('authenticateBasic matches the admin account and rejects a wrong password', () => {
  const accounts = [{ user: 'admin', password: 'secret' }];
  assert.equal(authenticateBasic(basic('admin', 'secret'), accounts), 'admin');
  assert.equal(authenticateBasic(basic('admin', 'wrong'), accounts), null);
});

test('authenticateBasic matches a second, independent credential without accepting it for the first', () => {
  const accounts = [
    { user: 'admin', password: 'admin-secret' },
    { user: 'whatsapp-bridge', password: 'bridge-secret' },
  ];
  assert.equal(authenticateBasic(basic('whatsapp-bridge', 'bridge-secret'), accounts), 'whatsapp-bridge');
  assert.equal(authenticateBasic(basic('admin', 'bridge-secret'), accounts), null);
  assert.equal(authenticateBasic(basic('whatsapp-bridge', 'admin-secret'), accounts), null);
});

test('authenticateBasic never matches an account with no password configured (opt-in only)', () => {
  const accounts = [{ user: 'whatsapp-bridge', password: '' }];
  assert.equal(authenticateBasic(basic('whatsapp-bridge', ''), accounts), null);
  assert.equal(authenticateBasic(basic('whatsapp-bridge', 'anything'), accounts), null);
});

test('authenticateBasic rejects a missing or malformed Authorization header', () => {
  const accounts = [{ user: 'admin', password: 'secret' }];
  assert.equal(authenticateBasic(undefined, accounts), null);
  assert.equal(authenticateBasic('not-basic-at-all', accounts), null);
});

test('clampLimit falls back to the default for missing or invalid input', () => {
  assert.equal(clampLimit(undefined, 100, 500), 100);
  assert.equal(clampLimit('not-a-number', 100, 500), 100);
  assert.equal(clampLimit('0', 100, 500), 100);
  assert.equal(clampLimit('-5', 100, 500), 100);
});

test('clampLimit passes through a valid value and caps at max', () => {
  assert.equal(clampLimit('50', 100, 500), 50);
  assert.equal(clampLimit('9999', 100, 500), 500);
});

test('parseBeforeId returns null for missing/invalid input, else the parsed id', () => {
  assert.equal(parseBeforeId(undefined), null);
  assert.equal(parseBeforeId('abc'), null);
  assert.equal(parseBeforeId('0'), null);
  assert.equal(parseBeforeId('42'), 42);
});
