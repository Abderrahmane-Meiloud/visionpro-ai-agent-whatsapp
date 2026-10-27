import { localProvider, type BusinessProvider } from './provider';
import { createDraft } from './orders';

/** Tool result shape consumed by runAgent (same contract as the handoff tool result). */
export type ToolResult = { ok: boolean; data: any; error_code: string | null; safe_user_message: string | null };
const err = (code: string, msg: string): ToolResult => ({ ok: false, data: null, error_code: code, safe_user_message: msg });
const ok = (data: any): ToolResult => ({ ok: true, data, error_code: null, safe_user_message: null });

/**
 * Build the business tool definitions + a dispatcher, parameterized by a provider so unit tests can
 * inject a fake with no DB. The AI gets READ tools + create_order_draft ONLY — there is deliberately
 * NO confirm/cancel tool, so the model can never confirm, charge, refund or cancel an order.
 */
export function makeBusinessTools(provider: BusinessProvider = localProvider, draft = createDraft) {
  const defs = [
    { type: 'function', function: { name: 'get_product', description: 'Look up products in the catalog by name or SKU.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'get_price', description: 'Get the current price for a product SKU. Never state a price without calling this.', parameters: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] } } },
    { type: 'function', function: { name: 'check_stock', description: 'Check current stock availability for a product SKU. Never claim availability without calling this.', parameters: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] } } },
    { type: 'function', function: { name: 'create_order_draft', description: 'Prepare a DRAFT order. A human must confirm it; never tell the customer it is confirmed or paid.', parameters: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'integer' } }, required: ['sku', 'qty'] } } }, required: ['items'] } } },
  ];
  const names = new Set(defs.map((d) => d.function.name));

  async function dispatch(name: string, args: any, conversationId: number): Promise<ToolResult> {
    try {
      if (name === 'get_product') {
        const query = String(args?.query ?? '').trim();
        if (!query) return err('BAD_INPUT', 'I need a product name to search.');
        const products = await provider.findProducts(query);
        if (!products.length) return err('NOT_FOUND', 'I could not find that product; let me get a colleague.');
        return ok({ products: products.map((p) => ({ sku: p.sku, name: p.name, category: p.category })) });
      }
      if (name === 'get_price') {
        const p = await lookupSku(provider, args?.sku);
        if (!p) return err('NOT_FOUND', 'I could not find that product; let me get a colleague.');
        const price = await provider.getPrice(p.id);
        if (!price) return err('NO_PRICE', 'I cannot confirm the price right now; a colleague will help.');
        return ok({ sku: p.sku, name: p.name, amount: price.amount, currency: price.currency });
      }
      if (name === 'check_stock') {
        const p = await lookupSku(provider, args?.sku);
        if (!p) return err('NOT_FOUND', 'I could not find that product; let me get a colleague.');
        const qty = await provider.getStock(p.id);
        if (qty == null) return err('NO_STOCK_DATA', 'I cannot confirm availability right now; a colleague will help.');
        return ok({ sku: p.sku, available: qty > 0, qty });
      }
      if (name === 'create_order_draft') {
        const r = await draft(provider, conversationId, args?.items);
        if (!r.ok) return err('DRAFT_FAILED', 'I could not prepare that order; a colleague will help.');
        return ok({ order_id: r.order.id, total: Number(r.order.total), currency: r.order.currency, needs_confirmation: true });
      }
      return err('UNKNOWN_TOOL', 'Unsupported request; let me get a colleague.');
    } catch {
      return err('TOOL_ERROR', 'Something went wrong; let me get a colleague.');
    }
  }
  return { defs, dispatch, names };
}

async function lookupSku(provider: BusinessProvider, raw: any) {
  const sku = String(raw ?? '').trim();
  return sku ? provider.getProductBySku(sku) : null;
}
