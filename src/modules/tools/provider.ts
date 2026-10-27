import { q } from '../../db';

/**
 * Provider-independent business data interface. The agent and order logic depend only on this, so a
 * future real backend can implement it WITHOUT any change here. Ships with a local Postgres provider
 * only — there is no direct integration with Marketing OS or any external system.
 */
export type Product = { id: number; sku: string; name: string; description: string | null; category: string | null };
export type PriceInfo = { amount: number; currency: string };

export interface BusinessProvider {
  findProducts(query: string): Promise<Product[]>;
  getProductBySku(sku: string): Promise<Product | null>;
  getPrice(productId: number): Promise<PriceInfo | null>;
  getStock(productId: number): Promise<number | null>;
}

/** Local Postgres-backed provider. All reads are bounded (LIMIT) and parameterized. */
export const localProvider: BusinessProvider = {
  async findProducts(query) {
    return q<Product>(
      `SELECT id, sku, name, description, category FROM products WHERE active AND (name ILIKE $1 OR sku ILIKE $1) ORDER BY id LIMIT 10`,
      [`%${query}%`],
    );
  },
  async getProductBySku(sku) {
    return (await q<Product>(`SELECT id, sku, name, description, category FROM products WHERE active AND sku=$1`, [sku]))[0] ?? null;
  },
  async getPrice(productId) {
    const r = (await q<{ amount: string; currency: string }>(`SELECT amount, currency FROM product_prices WHERE product_id=$1`, [productId]))[0];
    return r ? { amount: Number(r.amount), currency: r.currency } : null;
  },
  async getStock(productId) {
    const r = (await q<{ qty: string }>(`SELECT qty FROM inventory WHERE product_id=$1`, [productId]))[0];
    return r ? Number(r.qty) : null;
  },
};
