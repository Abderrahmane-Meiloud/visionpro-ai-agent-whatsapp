import assert from 'node:assert/strict';
import { test } from 'node:test';
import { grantsFor, hasPermission } from '../src/modules/auth/rbac';
import { hashPassword, verifyPassword } from '../src/modules/auth/users';
import { sessionValid, csrfOk, parseCookie } from '../src/modules/auth/session';

test('RBAC grants: admin all, agent limited, viewer/service read-only', () => {
  assert.deepEqual(grantsFor('admin').sort(), ['confirm_orders', 'handle_conversations', 'manage_knowledge', 'manage_settings', 'manage_users', 'view'].sort());
  assert.equal(hasPermission('admin', 'confirm_orders'), true);
  assert.equal(hasPermission('agent', 'confirm_orders'), false);
  assert.deepEqual(grantsFor('agent').sort(), ['handle_conversations', 'view'].sort());
  assert.deepEqual(grantsFor('viewer'), ['view']);
  // service (bridge): the VisionPro Marketing OS Agent AI proxy's own trusted credential — can
  // handle conversations/settings/knowledge, but never manage staff users or confirm orders.
  assert.deepEqual(grantsFor('service').sort(), ['handle_conversations', 'manage_knowledge', 'manage_settings', 'view'].sort());
  assert.deepEqual(grantsFor('nonsense'), []);
  assert.equal(hasPermission('agent', 'handle_conversations'), true);
  assert.equal(hasPermission('agent', 'manage_users'), false);
  assert.equal(hasPermission('service', 'handle_conversations'), true); // Agent AI proxy can take over/reply
  assert.equal(hasPermission('service', 'manage_users'), false); // still never staff management
  assert.equal(hasPermission('service', 'confirm_orders'), false); // still never order confirm/cancel
  assert.equal(hasPermission('viewer', 'handle_conversations'), false);
});

test('password hashing: scrypt round-trip, wrong password rejected, salted (non-deterministic)', () => {
  const h = hashPassword('correct horse battery staple');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(verifyPassword('correct horse battery staple', h), true);
  assert.equal(verifyPassword('wrong', h), false);
  assert.notEqual(hashPassword('same'), hashPassword('same')); // unique salt each time
  assert.equal(verifyPassword('x', 'not-a-valid-hash'), false); // malformed stored value never throws
});

test('sessionValid enforces active, absolute expiry and idle timeout', () => {
  const now = 1_000_000_000_000;
  const future = new Date(now + 3600_000);
  const past = new Date(now - 1000);
  const recent = new Date(now - 60_000);
  const stale = new Date(now - 60 * 60_000);
  assert.equal(sessionValid(future, recent, true, 720, now), true);
  assert.equal(sessionValid(past, recent, true, 720, now), false);   // absolute expiry
  assert.equal(sessionValid(future, stale, true, 30, now), false);   // idle exceeded (30 min)
  assert.equal(sessionValid(future, stale, true, 0, now), true);     // idle disabled (0)
  assert.equal(sessionValid(future, recent, false, 720, now), false); // deactivated user
});

test('csrfOk: constant-time equality, rejects mismatch/empty', () => {
  assert.equal(csrfOk('abc123', 'abc123'), true);
  assert.equal(csrfOk('abc123', 'abc124'), false);
  assert.equal(csrfOk('abc', 'abcdef'), false); // length mismatch
  assert.equal(csrfOk(undefined, 'abc'), false);
  assert.equal(csrfOk('abc', undefined), false);
});

test('parseCookie extracts a named cookie and ignores others', () => {
  assert.equal(parseCookie('sid=TOKEN123; other=1', 'sid'), 'TOKEN123');
  assert.equal(parseCookie('a=1; sid=XYZ', 'sid'), 'XYZ');
  assert.equal(parseCookie('a=1; b=2', 'sid'), null);
  assert.equal(parseCookie(undefined, 'sid'), null);
});
