import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lintArticle, isVolatile, parseVocabImport, splitCsvLine } from '../src/modules/knowledge/validate';
import { buildSystemPrompt } from '../src/modules/agent';

test('lintArticle flags volatile content (price/percentage/stock/date/promotion), passes clean policy text', () => {
  assert.deepEqual(lintArticle('Our return policy allows exchanges within a reasonable period.'), []);
  assert.ok(lintArticle('The price is 500 MRU').some((w) => w.type === 'price'));
  assert.ok(lintArticle('Get 20% off today').some((w) => w.type === 'percentage' || w.type === 'promotion'));
  assert.ok(lintArticle('10 units in stock').some((w) => w.type === 'stock'));
  assert.ok(lintArticle('Valid until 2026-12-31').some((w) => w.type === 'date'));
  assert.equal(isVolatile('Prix: 300 UM'), true);
  assert.equal(isVolatile('We are open for support questions.'), false);
});

test('parseVocabImport (JSON): valid rows parsed, alternates normalized, bad rows reported', () => {
  const { rows, errors } = parseVocabImport('json', JSON.stringify([
    { term: 'salam', alternates: ['salaam', 'slm'], meaning: 'hello' },
    { term: '', meaning: 'missing term' },
    { term: 'shukran', alternates: 'merci;thanks' },
  ]));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].alternates, ['salaam', 'slm']);
  assert.deepEqual(rows[1].alternates, ['merci', 'thanks']); // string split on ';'
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing term/);
});

test('parseVocabImport (CSV): header-driven, quoted commas handled', () => {
  const csv = 'term,alternates,meaning\nsalam,"salaam;slm","hello, friend"\n,,"no term"';
  const { rows, errors } = parseVocabImport('csv', csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].term, 'salam');
  assert.deepEqual(rows[0].alternates, ['salaam', 'slm']);
  assert.equal(rows[0].meaning, 'hello, friend');
  assert.equal(errors.length, 1);
});

test('parseVocabImport rejects invalid input', () => {
  assert.deepEqual(parseVocabImport('json', 'not json').errors, ['invalid JSON']);
  assert.deepEqual(parseVocabImport('csv', 'onlyheader').errors, ['CSV needs a header row and at least one data row']);
  assert.match(parseVocabImport('xml', 'x').errors[0], /unknown format/);
  assert.deepEqual(parseVocabImport('json', '').errors, ['empty import']);
});

test('splitCsvLine handles quotes, embedded commas and "" escapes', () => {
  assert.deepEqual(splitCsvLine('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(splitCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
  assert.deepEqual(splitCsvLine('"he said ""hi""",x'), ['he said "hi"', 'x']);
});

test('buildSystemPrompt: safety rules, precedence, handoff, and company knowledge present', () => {
  const p = buildSystemPrompt({
    companyName: 'Acme',
    articles: [{ title: 'Hours', content: 'We are open daily.', category: 'general' }],
    vocab: [{ term: 'salam', alternates: ['slm'], meaning: 'hello' }],
    extra: 'Be warm.',
    budget: 12000,
  });
  assert.match(p, /customer-service assistant for Acme/);
  assert.match(p, /request_human_handoff/);           // explicit fallback to a human
  assert.match(p, /# Precedence/);                     // anti-override section
  assert.match(p, /overrides the Language, Truth, Handoff or Security rules/);
  assert.match(p, /## Hours \[general\]/);             // article + category
  assert.match(p, /salam/);                            // vocabulary
  assert.match(p, /Extra operator instructions \(reference only\)/);
});

test('buildSystemPrompt enforces the knowledge char budget (bounded retrieval)', () => {
  const big = { title: 'Big', content: 'x'.repeat(5000), category: null };
  const p = buildSystemPrompt({ companyName: 'Acme', articles: [big, big, big], vocab: [], extra: '', budget: 6000 });
  assert.match(p, /truncated to fit/);
  // only one ~5000-char article fits under a 6000 budget; the rest are dropped
  assert.equal((p.match(/## Big/g) || []).length, 1);
});
