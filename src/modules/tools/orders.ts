import { audit, q, tx } from '../../db';
import type { Actor } from '../handoff';
import type { BusinessProvider } from './provider';

export type DraftItem = { product_id: number; sku: string; name: string; qty: number; unit_amount: number };

/** Pure validation of raw draft items from the AI tool call. Qty must be an integer in 1..1000. */
export function validateDraftItems(raw: any): { items?: { sku: string; qty: number }[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'items must be a non-empty array' };
  if (raw.length > 50) return { error: 'too many items (max 50)' };
  const items: { sku: string; qty: number }[] = [];
  for (const it of raw) {
    const sku = String(it?.sku ?? '').trim();
    const qty = Number(it?.qty);
    if (!sku) return { error: 'each item needs a sku' };
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000) return { error: `invalid qty for ${sku} (must be 1..1000)` };
    items.push({ sku, qty });
  }
  return { items };
}

/** AI-facing: create a DRAFT order only. Requires every product + price to exist (no inventing). */
export async function createDraft(provider: BusinessProvider, conversationId: number, rawItems: any, createdBy = 'AI'):
  Promise<{ ok: true; order: any } | { ok: false; error: string }> {
  const v = validateDraftItems(rawItems);
  if (v.error) return { ok: false, error: v.error };
  const items: DraftItem[] = [];
  let currency = 'MRU';
  let total = 0;
  for (const { sku, qty } of v.items!) {
    const p = await provider.getProductBySku(sku);
    if (!p) return { ok: false, error: `unknown product: ${sku}` };
    const price = await provider.getPrice(p.id);
    if (!price) return { ok: false, error: `no price available for ${sku}` };
    currency = price.currency;
    items.push({ product_id: p.id, sku: p.sku, name: p.name, qty, unit_amount: price.amount });
    total += price.amount * qty;
  }
  const order = (await q(
    `INSERT INTO orders(conversation_id, status, items, currency, total, created_by) VALUES($1,'DRAFT',$2,$3,$4,$5) RETURNING *`,
    [conversationId, JSON.stringify(items), currency, total, createdBy],
  ))[0];
  await audit(createdBy, 'order.draft', 'order', order.id, null, { total, items: items.length, conversationId }, 'agent');
  return { ok: true, order };
}

export type ConfirmResult =
  | { kind: 'ok'; order: any }
  | { kind: 'issues'; issues: any[] }
  | { kind: 'conflict'; status: string }
  | { kind: 'not_found' };

/** Staff-only, transactional. Revalidates price + stock under row locks, blocks on any mismatch,
 *  decrements stock, and flips DRAFT->CONFIRMED atomically (the WHERE status='DRAFT' guard also
 *  prevents duplicate/concurrent confirmation). */
export async function confirmOrder(orderId: number, actor: Actor): Promise<ConfirmResult> {
  const result = await tx<ConfirmResult>(async (c) => {
    const o = (await c.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [orderId])).rows[0];
    if (!o) return { kind: 'not_found' };
    if (o.status !== 'DRAFT') return { kind: 'conflict', status: o.status }; // already confirmed/cancelled
    const issues: any[] = [];
    let total = 0;
    for (const it of o.items as DraftItem[]) {
      const price = (await c.query(`SELECT amount FROM product_prices WHERE product_id=$1`, [it.product_id])).rows[0];
      const inv = (await c.query(`SELECT qty FROM inventory WHERE product_id=$1 FOR UPDATE`, [it.product_id])).rows[0];
      if (!price) issues.push({ sku: it.sku, issue: 'no_price' });
      else if (Number(price.amount) !== Number(it.unit_amount)) issues.push({ sku: it.sku, issue: 'price_changed', was: Number(it.unit_amount), now: Number(price.amount) });
      if (!inv || Number(inv.qty) < it.qty) issues.push({ sku: it.sku, issue: 'insufficient_stock', have: inv ? Number(inv.qty) : 0, need: it.qty });
      total += Number(it.unit_amount) * it.qty;
    }
    if (issues.length) return { kind: 'issues', issues }; // no state change
    for (const it of o.items as DraftItem[]) await c.query(`UPDATE inventory SET qty=qty-$2, updated_at=now() WHERE product_id=$1`, [it.product_id, it.qty]);
    const upd = (await c.query(`UPDATE orders SET status='CONFIRMED', confirmed_by=$2, confirmed_at=now(), total=$3 WHERE id=$1 AND status='DRAFT' RETURNING *`, [orderId, actor.username, total])).rows[0];
    if (!upd) return { kind: 'conflict', status: 'processed' };
    return { kind: 'ok', order: upd };
  });
  if (result.kind === 'ok') await audit(actor.username, 'order.confirm', 'order', orderId, null, { total: Number(result.order.total) });
  return result;
}

/** Staff-only. Cancels a DRAFT, or a CONFIRMED order (restocking it). Idempotent-safe. */
export async function cancelOrder(orderId: number, actor: Actor): Promise<ConfirmResult> {
  const result = await tx<ConfirmResult>(async (c) => {
    const o = (await c.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [orderId])).rows[0];
    if (!o) return { kind: 'not_found' };
    if (o.status === 'CANCELLED') return { kind: 'conflict', status: 'CANCELLED' };
    if (o.status === 'CONFIRMED') for (const it of o.items as DraftItem[]) await c.query(`UPDATE inventory SET qty=qty+$2, updated_at=now() WHERE product_id=$1`, [it.product_id, it.qty]);
    const upd = (await c.query(`UPDATE orders SET status='CANCELLED', cancelled_by=$2, cancelled_at=now() WHERE id=$1 AND status IN ('DRAFT','CONFIRMED') RETURNING *`, [orderId, actor.username])).rows[0];
    if (!upd) return { kind: 'conflict', status: o.status };
    return { kind: 'ok', order: upd };
  });
  if (result.kind === 'ok') await audit(actor.username, 'order.cancel', 'order', orderId, null, { from: 'DRAFT/CONFIRMED' });
  return result;
}

export async function listOrders(status: string, limit = 100) {
  const params: any[] = [];
  let where = '';
  if (['DRAFT', 'CONFIRMED', 'CANCELLED'].includes(status)) { params.push(status); where = 'WHERE status=$1'; }
  params.push(Math.min(Math.max(1, limit), 500));
  return q(`SELECT id, conversation_id, status, items, currency, total, created_by, confirmed_by, cancelled_by, created_at FROM orders ${where} ORDER BY id DESC LIMIT $${params.length}`, params);
}
