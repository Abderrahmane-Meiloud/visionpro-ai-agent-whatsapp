import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildChatRequest, resolveFinalReply, HANDOFF_TEXT, effectiveReplyCap } from '../src/modules/agent';

test('buildChatRequest uses GPT-5+/6-compatible params and the handoff tool', () => {
  const body = buildChatRequest('gpt-5.6-terra', [{ role: 'user', content: 'hi' }]) as any;
  // GPT-5+/6 reject max_tokens and non-default temperature; we must send max_completion_tokens
  // and omit temperature. These assertions fail loudly if anyone reintroduces the old params.
  assert.equal(body.model, 'gpt-5.6-terra');
  assert.equal(typeof body.max_completion_tokens, 'number');
  assert.equal('max_tokens' in body, false);
  assert.equal('temperature' in body, false);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  // exactly one tool, the Chat Completions function shape, named request_human_handoff
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].type, 'function');
  assert.equal(body.tools[0].function.name, 'request_human_handoff');
  assert.ok(body.tools[0].function.parameters.required.includes('language'));
});

test('resolveFinalReply returns a sanitized reply when the model produced content', () => {
  assert.equal(resolveFinalReply('Bonjour !', false, 'fr'), 'Bonjour !');
  // code/JSON leakage is stripped by sanitizeReply
  assert.equal(resolveFinalReply('Bonjour ```{"x":1}``` !', false, 'fr'), 'Bonjour  !');
});

test('resolveFinalReply falls back to the handoff acknowledgement when handed off with no text', () => {
  assert.equal(resolveFinalReply('', true, 'hassaniya'), HANDOFF_TEXT.hassaniya);
  assert.equal(resolveFinalReply(null, true, 'en'), HANDOFF_TEXT.en);
  // unknown language falls back to French
  assert.equal(resolveFinalReply('', true, 'wolof'), HANDOFF_TEXT.fr);
});

test('resolveFinalReply throws on an empty reply that was NOT a handoff (surface to a human)', () => {
  assert.throws(() => resolveFinalReply('', false, 'fr'), /empty model reply/);
  assert.throws(() => resolveFinalReply(null, false, 'fr'), /empty model reply/);
  // content that sanitizes down to nothing (pure tool JSON) is also treated as empty
  assert.throws(() => resolveFinalReply('{"tool":"x"}', false, 'fr'), /empty model reply/);
});

test('effectiveReplyCap always enforces a non-zero cap for real replies (0/unset -> conservative default)', () => {
  assert.equal(effectiveReplyCap(50, 1000), 50);     // explicit positive wins
  assert.equal(effectiveReplyCap(0, 1000), 1000);    // unset -> conservative default
  assert.equal(effectiveReplyCap(-5, 1000), 1000);   // invalid -> default
  assert.equal(effectiveReplyCap(0, 0), 1000);       // default also unset -> hard floor 1000 (never "no cap")
});

test('HANDOFF_TEXT covers all four supported languages', () => {
  for (const lang of ['hassaniya', 'fr', 'ar', 'en']) {
    assert.equal(typeof HANDOFF_TEXT[lang], 'string');
    assert.ok(HANDOFF_TEXT[lang].length > 0);
  }
});
