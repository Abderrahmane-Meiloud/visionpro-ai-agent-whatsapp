import type { BusinessProvider, PriceInfo, Product } from './provider';

/**
 * HTTP-backed `BusinessProvider` that pulls catalog + price data from VisionPro Marketing OS,
 * so the WhatsApp agent and Marketing OS share one source of truth for products without any
 * cross-database SQL. The LLM never touches this module directly — it only sees the four
 * registry tools (get_product/get_price/check_stock/create_order_draft) and this is one of two
 * drop-in implementations behind that interface (the other being `./provider.ts`'s local one).
 *
 * Wire shape matches `services/api/app/api/catalog.py::CatalogProduct`:
 *   { sku, name, category, description, image_url,
 *     price: { amount, currency } | null,
 *     stock: { qty, available } | null }
 *
 * Marketing OS currently has NO inventory column (see catalog.py docstring); stock comes back
 * null and `getStock()` therefore returns null → the registry dispatcher raises NO_STOCK_DATA
 * → the agent hands off ("I cannot confirm availability right now; a colleague will help"). This
 * is deliberate: the WhatsApp agent's "never invent stock" rule (src/modules/agent/index.ts
 * system prompt) is enforced by the data path, not just the prompt text.
 *
 * ID handling: the Marketing OS catalog is UUID-keyed, but the agent's `Product.id` is a bigint
 * from the local Postgres schema. This module synthesizes a stable numeric id per SKU for the
 * lifetime of a process so `getPrice(productId)` works without a round-trip. It is deliberately
 * NOT persisted — a different VisionPro Marketing OS instance (or a restart) assigns different
 * numbers, which is fine because the agent never shares a `Product.id` across requests or
 * processes (verified: no code path persists `id` or sends it to the customer).
 */

export interface VisionProBusinessProviderOptions {
  baseUrl: string; // e.g. http://localhost:8000, no trailing slash required
  getAccessToken: () => Promise<string>; // injected so tests can supply a static token
  fetchImpl?: typeof fetch; // dependency seam for tests; defaults to global fetch
  timeoutMs?: number;
}

type CatalogWireProduct = {
  sku: string;
  name: string;
  category: string | null;
  description: string | null;
  image_url: string | null;
  price: { amount: number; currency: string } | null;
  stock: { qty: number; available: boolean } | null;
};

/**
 * Factory kept separate from the exported singleton so tests can build an instance with a stubbed
 * fetch and a static token, without any global state. The agent's `agent/index.ts` picks between
 * this and the local provider by env (BUSINESS_PROVIDER=visionpro|local, default local).
 */
export function makeVisionProBusinessProvider(opts: VisionProBusinessProviderOptions): BusinessProvider {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const timeout = opts.timeoutMs ?? 10_000;
  const doFetch = opts.fetchImpl ?? fetch;

  // Local, in-memory SKU → synthetic numeric id. Only ever grows within one process; a restart
  // reassigns. See module docstring on why that is safe for this agent's usage pattern.
  const skuToId = new Map<string, number>();
  const idToSku = new Map<number, string>();
  let nextId = 1;
  const idFor = (sku: string): number => {
    const existing = skuToId.get(sku);
    if (existing !== undefined) return existing;
    const id = nextId++;
    skuToId.set(sku, id);
    idToSku.set(id, sku);
    return id;
  };

  async function search(params: Record<string, string>): Promise<CatalogWireProduct[]> {
    const url = new URL(`${base}/api/v1/catalog/products`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const token = await opts.getAccessToken();
    const res = await doFetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      // Never leak the response body — may echo request details and tokens are in headers.
      throw new VisionProCatalogError(`catalog request failed (status ${res.status})`);
    }
    const body = (await res.json()) as CatalogWireProduct[];
    return Array.isArray(body) ? body : [];
  }

  function toProduct(wire: CatalogWireProduct): Product {
    return {
      id: idFor(wire.sku),
      sku: wire.sku,
      name: wire.name,
      description: wire.description,
      category: wire.category,
    };
  }

  return {
    async findProducts(query: string): Promise<Product[]> {
      const q = String(query ?? '').trim();
      if (!q) return [];
      try {
        const rows = await search({ q, limit: '10' });
        return rows.map(toProduct);
      } catch {
        return []; // fail-closed: dispatcher turns an empty result into NOT_FOUND → handoff
      }
    },

    async getProductBySku(sku: string): Promise<Product | null> {
      const s = String(sku ?? '').trim();
      if (!s) return null;
      try {
        const rows = await search({ sku: s });
        const match = rows.find((r) => r.sku === s);
        return match ? toProduct(match) : null;
      } catch {
        return null;
      }
    },

    async getPrice(productId: number): Promise<PriceInfo | null> {
      const sku = idToSku.get(productId);
      if (!sku) return null;
      try {
        const rows = await search({ sku });
        const match = rows.find((r) => r.sku === sku);
        if (!match || !match.price) return null;
        return { amount: match.price.amount, currency: match.price.currency };
      } catch {
        return null;
      }
    },

    async getStock(_productId: number): Promise<number | null> {
      // Marketing OS currently has no inventory column: catalog.py returns stock: null on every
      // row. Return null → the dispatcher raises NO_STOCK_DATA → `request_human_handoff`. See the
      // module docstring on why we deliberately do not fabricate a number here.
      return null;
    },
  };
}

export class VisionProCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisionProCatalogError';
  }
}

/**
 * Builds a token resolver that logs in with the bridge service-account credentials and refreshes
 * the access token once per 10 minutes (well under the 15-minute access-token lifetime; see
 * services/api/app/core/config.py's access_token_expire_minutes). On any auth failure, resolves
 * with an empty string so `search()` sees a 401 and the fail-closed branches above kick in rather
 * than this helper throwing into the agent's hot path.
 */
export function makeBridgeAccountTokenResolver(opts: {
  baseUrl: string;
  email: string;
  password: string;
  fetchImpl?: typeof fetch;
}): () => Promise<string> {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  let cached: { token: string; expiresAt: number } | null = null;

  return async () => {
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    try {
      const res = await doFetch(`${base}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: opts.email, password: opts.password }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return '';
      const body = (await res.json()) as { access_token?: string };
      if (!body.access_token) return '';
      cached = { token: body.access_token, expiresAt: Date.now() + 10 * 60_000 };
      return cached.token;
    } catch {
      return '';
    }
  };
}
