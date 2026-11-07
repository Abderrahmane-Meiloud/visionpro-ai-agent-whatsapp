import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkProdConfig } from '../src/config';
import {
  digitsFromJid, extractEvolutionText, fromEvolutionWaId, isGroupOrBroadcast, isPilotAutoReplyAllowed,
  isRealInboundSenderAllowed, isStaleHistorySync, resolvePhoneBearingJid, timingSafeEqualStr, toEvolutionWaId,
} from '../src/modules/whatsapp-evolution/rules';

test('timingSafeEqualStr', () => {
  assert.equal(timingSafeEqualStr('secret', 'secret'), true);
  assert.equal(timingSafeEqualStr('secret', 'wrong'), false);
  assert.equal(timingSafeEqualStr('secret', 'secretlonger'), false); // length mismatch, never throws
  assert.equal(timingSafeEqualStr('', ''), true);
});

test('isGroupOrBroadcast', () => {
  assert.equal(isGroupOrBroadcast('12036300000000@g.us'), true, 'group JID');
  assert.equal(isGroupOrBroadcast('status@broadcast'), true, 'status broadcast');
  assert.equal(isGroupOrBroadcast('22212345678@broadcast'), true, 'broadcast suffix');
  assert.equal(isGroupOrBroadcast('22212345678@s.whatsapp.net'), false, 'ordinary 1:1 chat');
});

test('isStaleHistorySync', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  assert.equal(isStaleHistorySync(undefined, now), false, 'no timestamp reported -> let it through');
  assert.equal(isStaleHistorySync(now / 1000, now), false, 'live message, same instant');
  assert.equal(isStaleHistorySync(now / 1000 - 30, now), false, '30s old is still live');
  assert.equal(isStaleHistorySync(now / 1000 - 180, now), true, '3 minutes old = history-sync replay');
});

test('extractEvolutionText', () => {
  assert.equal(extractEvolutionText({ conversation: 'hello' }), 'hello');
  assert.equal(extractEvolutionText({ extendedTextMessage: { text: 'hi there' } }), 'hi there');
  assert.equal(extractEvolutionText({ ephemeralMessage: { message: { conversation: 'vanish' } } }), 'vanish');
  assert.equal(extractEvolutionText({ imageMessage: { caption: 'nope' } }), undefined, 'non-text message types are out of scope for the pilot');
  assert.equal(extractEvolutionText(undefined), undefined);
});

test('wa_id namespace isolation (evo: prefix)', () => {
  assert.equal(toEvolutionWaId('22212345678@s.whatsapp.net'), 'evo:22212345678');
  assert.equal(digitsFromJid('22212345678@s.whatsapp.net'), '22212345678');
  assert.equal(fromEvolutionWaId('evo:22212345678'), '22212345678');
  assert.equal(fromEvolutionWaId('22212345678'), '22212345678', 'a bare Meta wa_id is returned unchanged (never collides with the pilot namespace)');
});

test('isPilotAutoReplyAllowed: master switch + allowlist, both required', () => {
  assert.equal(isPilotAutoReplyAllowed('evo:22212345678', false, ['22212345678']), false, 'master switch off blocks even an allowlisted number');
  assert.equal(isPilotAutoReplyAllowed('evo:22212345678', true, []), false, 'empty allowlist blocks everyone');
  assert.equal(isPilotAutoReplyAllowed('evo:22212345678', true, ['22200000000']), false, 'non-allowlisted number blocked');
  assert.equal(isPilotAutoReplyAllowed('evo:22212345678', true, ['22212345678']), true, 'allowlisted number + switch on => allowed');
  assert.equal(isPilotAutoReplyAllowed('evo:', true, ['']), false, 'empty digits never match, even if the allowlist is sloppy');
});

test('isRealInboundSenderAllowed: fail-closed, never applies to anything but an exact allowlisted number', () => {
  assert.equal(isRealInboundSenderAllowed('22212345678@s.whatsapp.net', []), false, 'empty allowlist rejects everyone — fail closed');
  assert.equal(isRealInboundSenderAllowed('22212345678@s.whatsapp.net', ['22299999999']), false, 'non-allowlisted sender rejected');
  assert.equal(isRealInboundSenderAllowed('22212345678@s.whatsapp.net', ['22212345678']), true, 'allowlisted sender accepted');
  assert.equal(isRealInboundSenderAllowed('22212345678@g.us', ['22212345678']), true, 'pure digit match — group/broadcast filtering happens separately, before this check');
});

test('resolvePhoneBearingJid: non-LID JIDs pass through unchanged', () => {
  assert.equal(resolvePhoneBearingJid('22212345678@s.whatsapp.net', {}), '22212345678@s.whatsapp.net');
  assert.equal(resolvePhoneBearingJid('22212345678@g.us', {}), '22212345678@g.us');
});

test('resolvePhoneBearingJid: @lid resolves via a phone-bearing alternate field when present', () => {
  assert.equal(
    resolvePhoneBearingJid('998877665544332@lid', { remoteJidAlt: '22212345678@s.whatsapp.net' }),
    '22212345678@s.whatsapp.net',
    'remoteJidAlt is the primary field evolution-api uses for this',
  );
  assert.equal(
    resolvePhoneBearingJid('998877665544332@lid', { participantAlt: '22212345678@s.whatsapp.net' }),
    '22212345678@s.whatsapp.net',
    'falls back to participantAlt',
  );
  assert.equal(
    resolvePhoneBearingJid('998877665544332@lid', { senderPn: '22212345678@s.whatsapp.net' }),
    '22212345678@s.whatsapp.net',
    'falls back to senderPn',
  );
});

test('resolvePhoneBearingJid: @lid with no phone-bearing alternate returns null — never guesses', () => {
  assert.equal(resolvePhoneBearingJid('998877665544332@lid', {}), null);
  assert.equal(resolvePhoneBearingJid('998877665544332@lid', { remoteJidAlt: '' }), null, 'an empty alternate is not a usable phone number');
});

test('checkProdConfig refuses to boot in production if the Evolution pilot is configured at all', () => {
  const base = {
    databaseUrl: 'postgresql://x', verifyToken: 'vt', adminPassword: 'a'.repeat(16), allowTestFaults: false,
    graphVersion: 'v1', appSecret: 's', phoneNumberId: '1', accessToken: 't',
  };
  const evoOff = { evolutionApiBaseUrl: '', evolutionPilotAutoReplyEnabled: false, evolutionPilotSimulationMode: false };
  assert.deepEqual(checkProdConfig({ ...base, ...evoOff }).errors, [], 'no Evolution config -> no error');
  assert.ok(
    checkProdConfig({ ...base, ...evoOff, evolutionApiBaseUrl: 'https://evo.example' }).errors
      .some((e) => /EVOLUTION_API_BASE_URL/.test(e)),
    'EVOLUTION_API_BASE_URL set -> production boot refused',
  );
  assert.ok(
    checkProdConfig({ ...base, ...evoOff, evolutionPilotAutoReplyEnabled: true }).errors
      .some((e) => /EVOLUTION_PILOT_AUTO_REPLY_ENABLED/.test(e)),
    'auto-reply enabled -> production boot refused',
  );
  assert.ok(
    checkProdConfig({ ...base, ...evoOff, evolutionPilotSimulationMode: true }).errors
      .some((e) => /EVOLUTION_PILOT_SIMULATION_MODE/.test(e)),
    'simulation mode enabled -> production boot refused',
  );
});
