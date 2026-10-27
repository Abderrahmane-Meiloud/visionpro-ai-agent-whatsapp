import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeBusinessTools } from '../src/modules/tools/registry';
import { validateDraftItems } from '../src/modules/tools/orders';
import { validateTemplateSend, renderPreview } from '../src/modules/whatsapp/templates';
import type { BusinessProvider } from '../src/modules/tools/provider';

// In-memory fake provider so tool dispatch is testable with no DB.
const fakeProvider: BusinessProvider = {
  async findProducts(q) { return q.includes('carp') ? [{ id: 1, sku: 'RUG-1', name: 'Carpet', description: null, category: 'home' }] : []; },
  async getProductBySku(sku) { return sku === 'RUG-1' ? { id: 1, sku: 'RUG-1', name: 'Carpet', description: null, category: 'home' } : null; },
  async getPrice(id) { return id === 1 ? { amount: 500, currency: 'MRU' } : null; },
  async getStock(id) { return id === 1 ? 7 : null; },
};
const okDraft = async (_p: any, _c: number, items: any) => ({ ok: true as const, order: { id: 99, total: 500, currency: 'MRU', items } });

test('business tool defs are READ + create_order_draft ONLY (no confirm/cancel tool for the AI)', () => {
  const { names } = makeBusinessTools(fakeProvider, okDraft as any);
  assert.deepEqual([...names].sort(), ['check_stock', 'create_order_draft', 'get_price', 'get_product'].sort());
  assert.ok(![...names].some((n) => /confirm|cancel|charge|refund/.test(n)), 'no mutate-order tool exposed to the AI');
});

test('dispatch returns accurate product/price/stock and the correct error for missing data', async () => {
  const { dispatch } = makeBusinessTools(fakeProvider, okDraft as any);
  assert.deepEqual(await dispatch('get_product', { query: 'carpet' }, 1), { ok: true, data: { products: [{ sku: 'RUG-1', name: 'Carpet', category: 'home' }] }, error_code: null, safe_user_message: null });
  assert.equal((await dispatch('get_product', { query: 'nope' }, 1)).error_code, 'NOT_FOUND');
  assert.deepEqual((await dispatch('get_price', { sku: 'RUG-1' }, 1)).data, { sku: 'RUG-1', name: 'Carpet', amount: 500, currency: 'MRU' });
  assert.equal((await dispatch('get_price', { sku: 'MISSING' }, 1)).error_code, 'NOT_FOUND');
  assert.deepEqual((await dispatch('check_stock', { sku: 'RUG-1' }, 1)).data, { sku: 'RUG-1', available: true, qty: 7 });
});

test('dispatch rejects an unknown tool', async () => {
  const { dispatch } = makeBusinessTools(fakeProvider, okDraft as any);
  assert.equal((await dispatch('delete_everything', {}, 1)).error_code, 'UNKNOWN_TOOL');
});

test('create_order_draft dispatch returns a draft needing confirmation', async () => {
  const { dispatch } = makeBusinessTools(fakeProvider, okDraft as any);
  const r = await dispatch('create_order_draft', { items: [{ sku: 'RUG-1', qty: 2 }] }, 1);
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { order_id: 99, total: 500, currency: 'MRU', needs_confirmation: true });
});

test('validateDraftItems enforces sku + integer qty 1..1000', () => {
  assert.match(validateDraftItems([]).error!, /non-empty/);
  assert.match(validateDraftItems([{ sku: '', qty: 1 }]).error!, /needs a sku/);
  assert.match(validateDraftItems([{ sku: 'X', qty: 0 }]).error!, /invalid qty/);
  assert.match(validateDraftItems([{ sku: 'X', qty: 1.5 }]).error!, /invalid qty/);
  assert.match(validateDraftItems([{ sku: 'X', qty: 5000 }]).error!, /invalid qty/);
  assert.deepEqual(validateDraftItems([{ sku: 'X', qty: 3 }]).items, [{ sku: 'X', qty: 3 }]);
});

test('validateTemplateSend checks approval, variable count and non-empty values; renderPreview fills placeholders', () => {
  assert.equal(validateTemplateSend(null, []).error, 'unknown template');
  assert.match(validateTemplateSend({ variables: 1, status: 'disabled', language: 'fr' }, ['x']).error!, /not approved/);
  assert.match(validateTemplateSend({ variables: 2, status: 'approved', language: 'fr' }, ['x']).error!, /expected 2/);
  assert.match(validateTemplateSend({ variables: 1, status: 'approved', language: 'fr' }, ['  ']).error!, /cannot be empty/);
  assert.deepEqual(validateTemplateSend({ variables: 2, status: 'approved', language: 'fr' }, ['Ali', '3']).params, ['Ali', '3']);
  assert.equal(renderPreview('Hi {{1}}, your order {{2}} is ready', ['Ali', '#99']), 'Hi Ali, your order #99 is ready');
});
