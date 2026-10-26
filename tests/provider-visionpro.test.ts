import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeBusinessTools } from '../src/modules/tools/registry';
import { makeBridgeAccountTokenResolver, makeVisionProBusinessProvider } from '../src/modules/tools/provider.visionpro';

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null };

function makeFakeFetch(responder: (c: Call) => { status: number; body: unknown }): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const headers: Record<string, string> = {};
    const raw = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);
    const bodyText = typeof init?.body === 'string' ? init.body : null;
    const call: Call = { url, method: init?.method ?? 'GET', headers, body: bodyText };
    calls.push(call);
    const r = responder(call);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    }) as unknown as Response;
  };
  return { fetch: fakeFetch, calls };
}

const STATIC_TOKEN = async () => 'test-token';

test('findProducts hits /api/v1/catalog/products with q and bearer token', async () => {
  const { fetch: f, calls } = makeFakeFetch(() => ({
    status: 200,
    body: [
      { sku: 'A1', name: 'Alpha', category: null, description: null, image_url: null, price: { amount: 10, currency: 'MRU' }, stock: null },
    ],
  }));
  const provider = makeVisionProBusinessProvider({ baseUrl: 'http://marketing.test', getAccessToken: STATIC_TOKEN, fetchImpl: f });
  const result = await provider.findProducts('alph');
  assert.equal(result.length, 1);
  assert.equal(result[0].sku, 'A1');
  assert.equal(result[0].name, 'Alpha');
  assert.ok(typeof result[0].id === 'number', 'synthetic bigint-equivalent id assigned');

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/v1/catalog/products');
  assert.equal(url.searchParams.get('q'), 'alph');
  assert.equal(url.searchParams.get('limit'), '10');
  assert.equal(calls[0].headers['authorization'], 'Bearer test-token');
});

test('getProductBySku passes sku param and only returns an exact match', async () => {
  const { fetch: f, calls } = makeFakeFetch(() => ({
    status: 200,
    body: [
      { sku: 'EXACT', name: 'A', category: null, description: null, image_url: null, price: null, stock: null },
      { sku: 'EXACT-SUFFIX', name: 'B', category: null, description: null, image_url: null, price: null, stock: null },
    ],
  }));
  const provider = makeVisionProBusinessProvider({ baseUrl: 'http://marketing.test', getAccessToken: STATIC_TOKEN, fetchImpl: f });

  const match = await provider.getProductBySku('EXACT');
  assert.ok(match, 'exact-match product should return');
  assert.equal(match!.sku, 'EXACT');
  const missing = await provider.getProductBySku('UNKNOWN');
  // the server returns rows (the fake does not filter), the provider must still enforce exact match
  assert.equal(missing, null);
  assert.equal(new URL(calls[0].url).searchParams.get('sku'), 'EXACT');
});

test('getPrice uses the synthetic id from a prior lookup', async () => {
  const { fetch: f } = makeFakeFetch((c) => {
    const sku = new URL(c.url).searchParams.get('sku');
    return {
      status: 200,
      body: sku === 'P1' ? [{
        sku: 'P1', name: 'P', category: null, description: null, image_url: null,
        price: { amount: 42.5, currency: 'MRU' }, stock: null,
      }] : [],
    };
  });
  const provider = makeVisionProBusinessProvider({ baseUrl: 'http://marketing.test', getAccessToken: STATIC_TOKEN, fetchImpl: f });
  const p = await provider.getProductBySku('P1');
  assert.ok(p);
  const price = await provider.getPrice(p!.id);
  assert.deepEqual(price, { amount: 42.5, currency: 'MRU' });
  const unknownPrice = await provider.getPrice(9999);
  assert.equal(unknownPrice, null);
});

test('getStock always returns null (Marketing OS has no inventory column yet)', async () => {
  const { fetch: f } = makeFakeFetch(() => ({ status: 200, body: [] }));
  const provider = makeVisionProBusinessProvider({ baseUrl: 'http://marketing.test', getAccessToken: STATIC_TOKEN, fetchImpl: f });
  assert.equal(await provider.getStock(1), null);
  assert.equal(await provider.getStock(2), null);
});

test('end-to-end: makeBusinessTools backed by VisionPro provider -> get_product + get_price succeed, check_stock hands off', async () => {
  const { fetch: f } = makeFakeFetch((c) => {
    const u = new URL(c.url);
    const q = u.searchParams.get('q');
    const sku = u.searchParams.get('sku');
    if (sku === 'RUG-1' || q === 'carpet') {
      return {
        status: 200,
        body: [{
          sku: 'RUG-1', name: 'Carpet', category: 'home', description: null, image_url: null,
          price: { amount: 500, currency: 'MRU' }, stock: null,
        }],
      };
    }
    return { status: 200, body: [] };
  });
  const provider = makeVisionProBusinessProvider({ baseUrl: 'http://marketing.test', getAccessToken: STATIC_TOKEN, fetchImpl: f });
  const okDraft = async (_p: any, _c: number, items: any) => ({ ok: true as const, order: { id: 1, total: 1000, currency: 'MRU', items } });
  const { dispatch } = makeBusinessTools(provider, okDraft as any);

  const found = await dispatch('get_product', { query: 'carpet' }, 1);
  assert.equal(found.ok, true);
  assert.deepEqual(found.data.products, [{ sku: 'RUG-1', name: 'Carpet', category: 'home' }]);

  const priced = await dispatch('get_price', { sku: 'RUG-1' }, 1);
  assert.equal(priced.ok, true);
  assert.deepEqual(priced.data, { sku: 'RUG-1', name: 'Carpet', amount: 500, currency: 'MRU' });

  // No inventory data available -> dispatcher raises NO_STOCK_DATA -> system prompt turns this
  // into request_human_handoff. Verified against tools/registry.ts:40-44.
  const stock = await dispatch('check_stock', { sku: 'RUG-1' }, 1);
  assert.equal(stock.ok, false);
  assert.equal(stock.error_code, 'NO_STOCK_DATA');
});

test('non-2xx responses are swallowed by the provider (fail-closed -> handoff path)', async () => {
  const { fetch: f } = makeFakeFetch(() => ({ status: 500, body: { error: 'kaboom' } }));
  const provider = makeVisionProBusinessProvider({ baseUrl: 'http://marketing.test', getAccessToken: STATIC_TOKEN, fetchImpl: f });
  assert.deepEqual(await provider.findProducts('anything'), []);
  assert.equal(await provider.getProductBySku('X'), null);
});

test('makeBridgeAccountTokenResolver caches a token and returns empty string on failure', async () => {
  let loginCount = 0;
  const { fetch: f } = makeFakeFetch((c) => {
    if (c.url.endsWith('/api/v1/auth/login')) {
      loginCount++;
      return { status: 200, body: { access_token: `tok-${loginCount}`, refresh_token: 'ignored' } };
    }
    return { status: 404, body: {} };
  });
  const resolver = makeBridgeAccountTokenResolver({ baseUrl: 'http://marketing.test', email: 'x@y', password: 'p', fetchImpl: f });
  assert.equal(await resolver(), 'tok-1');
  assert.equal(await resolver(), 'tok-1', 'second call reuses the cached token');
  assert.equal(loginCount, 1);

  const { fetch: failingFetch } = makeFakeFetch(() => ({ status: 401, body: { error: 'nope' } }));
  const bad = makeBridgeAccountTokenResolver({ baseUrl: 'http://marketing.test', email: 'x@y', password: 'wrong', fetchImpl: failingFetch });
  assert.equal(await bad(), '', 'auth failure yields empty token, not an exception');
});
