import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { isDailyCapExceeded, sanitizeReply } from '../src/modules/agent';
import { canSendFreeForm, shouldApplyStatus, verifySignature } from '../src/modules/whatsapp/rules';

const sig = (b: Buffer, s: string) => 'sha256=' + crypto.createHmac('sha256', s).update(b).digest('hex');

test('webhook signature', () => {
  const body = Buffer.from('{"a":1}');
  assert.equal(verifySignature(body, sig(body, 'secret'), 'secret'), true);
  assert.equal(verifySignature(body, sig(body, 'wrong'), 'secret'), false);
  assert.equal(verifySignature(body, undefined, 'secret'), false);
  assert.equal(verifySignature(body, sig(body, 'secret'), ''), false); // no secret configured = reject
  assert.equal(verifySignature(Buffer.from('{"a":2}'), sig(body, 'secret'), 'secret'), false); // tampered body
});

test('24h customer-service window', () => {
  const now = new Date('2026-09-27T12:00:00Z');
  assert.equal(canSendFreeForm(new Date('2026-09-27T00:00:00Z'), now), true);
  assert.equal(canSendFreeForm(new Date('2026-09-26T11:59:00Z'), now), false);
  assert.equal(canSendFreeForm(null, now), false);
});

test('status webhooks never move backwards', () => {
  assert.equal(shouldApplyStatus('sent', 'delivered'), true);
  assert.equal(shouldApplyStatus('read', 'delivered'), false);
  assert.equal(shouldApplyStatus(null, 'sent'), true);
});

test('reply sanitizer strips code/JSON leakage', () => {
  assert.equal(sanitizeReply('Bonjour ```{"x":1}``` !'), 'Bonjour  !');
  assert.equal(sanitizeReply('{"tool":"x"}'), '');
});

test('daily AI reply cap', () => {
  assert.equal(isDailyCapExceeded(0, 0), false); // 0 = no cap configured, never blocks
  assert.equal(isDailyCapExceeded(1_000_000, 0), false);
  assert.equal(isDailyCapExceeded(49, 50), false);
  assert.equal(isDailyCapExceeded(50, 50), true); // at the cap, not just over it
  assert.equal(isDailyCapExceeded(51, 50), true);
});
