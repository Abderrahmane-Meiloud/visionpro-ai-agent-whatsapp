import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redact } from '../src/log';
import { FailureThrottle } from '../src/security/throttle';
import { assertDisposableTestDb } from '../src/db-safety';
import { filenameForMime } from '../src/modules/transcription';

test('redact drops credential/content/PII keys and masks phone numbers in free text', () => {
  const out: any = redact({
    reqId: 'abc', count: 3,
    authorization: 'Bearer sk-secret', password: 'hunter2', access_token: 'tok', wa_id: '22233445566',
    text: 'customer private message', transcription: 'voice content', display_name: 'Ahmed',
    note: 'call me on +222 33 44 55 66 today',
  });
  assert.equal(out.reqId, 'abc');
  assert.equal(out.count, 3);
  for (const k of ['authorization', 'password', 'access_token', 'wa_id', 'text', 'transcription', 'display_name']) {
    assert.equal(out[k], '[redacted]', `${k} must be redacted`);
  }
  assert.equal(out.note, 'call me on [phone] today'); // phone masked in otherwise-safe text
});

test('redact masks credential-shaped substrings in free text (defense-in-depth)', () => {
  assert.equal(redact('auth Bearer abc.def_123-xyz'), 'auth Bearer [redacted]');
  assert.equal(redact('key sk-proj-ABCDEFGH123456'), 'key [redacted-key]');
  assert.equal(redact('meta EAAGGGGGGGGGGGGGGGGGGGGGGGGG tail'), 'meta [redacted-token] tail');
  assert.equal(redact('ring +222 33 44 55 66 now'), 'ring [phone] now');
});

test('redact truncates very long strings and caps nesting depth', () => {
  const long = 'x'.repeat(900);
  assert.equal(redact(long), 'x'.repeat(500) + '…(+400)');
  const deep = { a: { b: { c: { d: { e: 'too deep' } } } } };
  assert.equal((redact(deep) as any).a.b.c.d, '[…]');
});

test('FailureThrottle blocks only after max failures, within the window, and resets on success', () => {
  const t = new FailureThrottle(3, 1000);
  const now = 1_000_000;
  assert.equal(t.blocked('ip', now), false);
  t.record('ip', now); t.record('ip', now); // 2 failures
  assert.equal(t.blocked('ip', now), false);
  t.record('ip', now); // 3rd failure => at cap
  assert.equal(t.blocked('ip', now), true);
  t.reset('ip');
  assert.equal(t.blocked('ip', now), false);
});

test('FailureThrottle counts expire after the window', () => {
  const t = new FailureThrottle(1, 1000);
  t.record('ip', 0); t.record('ip', 0);
  assert.equal(t.blocked('ip', 500), true);
  assert.equal(t.blocked('ip', 1500), false); // window elapsed
});

test('FailureThrottle keys are independent', () => {
  const t = new FailureThrottle(1, 1000);
  t.record('a', 0); t.record('a', 0);
  assert.equal(t.blocked('a', 0), true);
  assert.equal(t.blocked('b', 0), false);
});

test('assertDisposableTestDb allows only a local DB whose name marks it as a test DB', () => {
  assert.doesNotThrow(() => assertDisposableTestDb('postgresql://postgres@localhost:55432/smoke'));
  assert.doesNotThrow(() => assertDisposableTestDb('postgresql://u:p@127.0.0.1:5432/my_test_db'));
});

test('assertDisposableTestDb refuses remote hosts, non-test names, and missing/invalid URLs', () => {
  assert.throws(() => assertDisposableTestDb('postgresql://u:p@db.supabase.co:5432/postgres'), /non-local/);
  assert.throws(() => assertDisposableTestDb('postgresql://u:p@something.render.com:5432/smoke'), /non-local/);
  assert.throws(() => assertDisposableTestDb('postgresql://postgres@localhost:5432/production'), /not clearly a test/);
  assert.throws(() => assertDisposableTestDb(undefined), /not set/);
  assert.throws(() => assertDisposableTestDb('not a url'), /valid URL|not clearly a test|non-local/);
  // explicit override bypasses the guard
  assert.doesNotThrow(() => assertDisposableTestDb('postgresql://u:p@db.supabase.co/postgres', true));
});

test('filenameForMime maps the real MIME to a correct extension (and defaults to ogg)', () => {
  assert.equal(filenameForMime('audio/ogg; codecs=opus'), 'voice.ogg'); // WhatsApp voice note
  assert.equal(filenameForMime('audio/mpeg'), 'voice.mp3');
  assert.equal(filenameForMime('audio/mp4'), 'voice.m4a');
  assert.equal(filenameForMime('audio/wav'), 'voice.wav');
  assert.equal(filenameForMime('audio/webm'), 'voice.webm');
  assert.equal(filenameForMime('application/octet-stream'), 'voice.ogg'); // unknown -> safe default
  assert.equal(filenameForMime(undefined), 'voice.ogg');
});
