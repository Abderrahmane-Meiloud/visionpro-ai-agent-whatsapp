import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDebugTokenResponse } from '../src/modules/whatsapp/token_check';

test('parseDebugTokenResponse reports a valid token with scopes and expiry', () => {
  const result = parseDebugTokenResponse({
    data: {
      is_valid: true,
      app_id: '123456',
      scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
      expires_at: 1800000000,
    },
  });
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.deepEqual(result.scopes, ['whatsapp_business_messaging', 'whatsapp_business_management']);
    assert.equal(result.appId, '123456');
    assert.equal(result.expiresAt, new Date(1800000000 * 1000).toISOString());
  }
});

test('parseDebugTokenResponse treats expires_at=0 as a permanent (never-expiring) token', () => {
  const result = parseDebugTokenResponse({ data: { is_valid: true, scopes: [], expires_at: 0 } });
  assert.equal(result.valid, true);
  if (result.valid) assert.equal(result.expiresAt, null);
});

test('parseDebugTokenResponse reports an invalid token with Meta\'s own error message', () => {
  const result = parseDebugTokenResponse({
    data: { is_valid: false, error: { message: 'Error validating access token: Session has expired.' } },
  });
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.error, /Session has expired/);
});

test('parseDebugTokenResponse never throws on a malformed response, reports it as invalid instead', () => {
  assert.equal(parseDebugTokenResponse(null).valid, false);
  assert.equal(parseDebugTokenResponse({}).valid, false);
  assert.equal(parseDebugTokenResponse({ data: 'not an object' }).valid, false);
  assert.equal(parseDebugTokenResponse({ data: { is_valid: true } }).valid, true); // scopes/expiry just default empty/null
});
