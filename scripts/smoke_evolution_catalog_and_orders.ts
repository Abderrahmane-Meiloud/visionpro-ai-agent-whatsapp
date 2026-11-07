// Deterministic catalog + order workflow test — Evolution pilot. Run:
//   DATABASE_URL=postgresql://... npm run smoke:evolution:catalog
//
// *** This is NOT an "AI conversation" test. *** It never runs the agent/LLM loop (mock or real) —
// it calls the exact same tool-dispatch functions the agent would call (get_product/get_price/
// check_stock/create_order_draft, from src/modules/tools/registry.ts) directly, against the REAL
// VisionPro Marketing OS catalog provider over HTTP. This is deterministic and repeatable because
// it never depends on an LLM's choices; scripts/smoke_evolution_pilot.ts and the simulate.ts page
// are what exercise the actual mock-AI conversation pipeline — a different concern, kept separate.
//
// Preconditions (documented, not auto-started by this script):
//   - Marketing OS backend running and reachable at VISIONPRO_BASE_URL (checked below)
//   - VISIONPRO_BRIDGE_EMAIL/VISIONPRO_BRIDGE_PASSWORD valid, with the bridge role granted
//     products:read (services/api/scripts/ensure_whatsapp_bridge_account.py)
//   - At least one active product visible to that account (this script creates its own throwaway
//     one via the catalog's own provider contract if the fixed SKU below isn't found — no, it does
//     NOT create products; see the printed hint if SMOKE_SKU is not found)
//   - A real (or disposable) Postgres reachable at DATABASE_URL, for the WhatsApp agent's own
//     conversations/orders tables (completely separate from Marketing OS's database)
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { makeBridgeAccountTokenResolver, makeVisionProBusinessProvider } from '../src/modules/tools/provider.visionpro';
import { makeBusinessTools } from '../src/modules/tools/registry';
import { confirmOrder } from '../src/modules/tools/orders';

const DATABASE_URL = process.env.DATABASE_URL;
const VISIONPRO_BASE_URL = process.env.VISIONPRO_BASE_URL || 'http://localhost:8000';
const VISIONPRO_BRIDGE_EMAIL = process.env.VISIONPRO_BRIDGE_EMAIL || 'whatsapp-bridge@internal.visionpro';
const VISIONPRO_BRIDGE_PASSWORD = process.env.VISIONPRO_BRIDGE_PASSWORD;
// A real, authorized, clearly-labeled TEST product created for this purpose (never real customer data).
const SMOKE_SKU = process.env.SMOKE_SKU || 'SIM-TEST-RUG-001';

if (!DATABASE_URL) { console.error('SMOKE FAIL: DATABASE_URL is not set'); process.exit(1); }
if (!VISIONPRO_BRIDGE_PASSWORD) { console.error('SMOKE FAIL: VISIONPRO_BRIDGE_PASSWORD is not set'); process.exit(1); }

const db = new Pool({ connectionString: DATABASE_URL, max: 2 });
const RUN_TAG = 'catalogsmoke' + Date.now();

(async () => {
  console.log('=== DETERMINISTIC TOOL-DISPATCH TEST (no LLM, no AI conversation of any kind) ===');

  const provider = makeVisionProBusinessProvider({
    baseUrl: VISIONPRO_BASE_URL,
    getAccessToken: makeBridgeAccountTokenResolver({
      baseUrl: VISIONPRO_BASE_URL, email: VISIONPRO_BRIDGE_EMAIL, password: VISIONPRO_BRIDGE_PASSWORD,
    }),
  });
  const tools = makeBusinessTools(provider);

  // A minimal conversation row is all orders.conversation_id needs — no webhook, no agent turn.
  const cust = (await db.query(
    `INSERT INTO customers(wa_id, display_name) VALUES($1,'Catalog Smoke Test')
     ON CONFLICT (wa_id) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id`,
    [`evo:det-${RUN_TAG}`],
  )).rows[0];
  const conv = (await db.query(
    `INSERT INTO conversations(customer_id, channel) VALUES($1,'whatsapp_evolution_pilot')
     ON CONFLICT (customer_id) DO UPDATE SET last_message_at=now() RETURNING id`,
    [cust.id],
  )).rows[0];
  const convId: number = conv.id;

  try {
    // --- 1. product search (real HTTP call to Marketing OS, real bridge auth) ---
    const search = await tools.dispatch('get_product', { query: 'rug' }, convId);
    console.log('get_product("rug") ->', JSON.stringify(search));
    assert.equal(search.ok, true, 'get_product must succeed against the real catalog');
    assert.ok(search.data.products.some((p: any) => p.sku === SMOKE_SKU), `expected to find ${SMOKE_SKU} in the search results`);

    // --- 2. price retrieval ---
    const price = await tools.dispatch('get_price', { sku: SMOKE_SKU }, convId);
    console.log('get_price ->', JSON.stringify(price));
    assert.equal(price.ok, true, 'get_price must succeed');
    assert.equal(price.data.currency, 'USD');
    assert.ok(price.data.amount > 0, 'price must be a real positive amount, never invented/zero');

    // --- 3. stock check ---
    const stock = await tools.dispatch('check_stock', { sku: SMOKE_SKU }, convId);
    console.log('check_stock ->', JSON.stringify(stock));
    assert.equal(stock.ok, true, 'check_stock must succeed');
    assert.equal(typeof stock.data.qty, 'number');

    // --- 4. unknown SKU must fail closed, never invent data ---
    const unknown = await tools.dispatch('get_price', { sku: 'NO-SUCH-SKU-' + RUN_TAG }, convId);
    assert.equal(unknown.ok, false, 'an unknown SKU must never return a fabricated price');
    console.log('get_price(unknown sku) correctly failed closed ->', unknown.error_code);

    // --- 5. order/"lead" creation: a DRAFT order, same tool the agent could call ---
    // (There is no separate "lead" entity in this schema — a new customer+conversation IS the
    // lead-equivalent here, created above; this is the transactional "order" half of that flow.)
    const qty = 2;
    const draft = await tools.dispatch('create_order_draft', { items: [{ sku: SMOKE_SKU, qty }] }, convId);
    console.log('create_order_draft ->', JSON.stringify(draft));
    assert.equal(draft.ok, true, 'order draft creation must succeed with valid stock/price');
    assert.equal(draft.data.needs_confirmation, true, 'the AI tool must never produce an already-confirmed order');
    assert.equal(Number(draft.data.total), price.data.amount * qty, 'draft total must be computed from the real price, not invented');

    const orderRow = (await db.query(`SELECT status, total FROM orders WHERE id=$1`, [draft.data.order_id])).rows[0];
    assert.equal(orderRow.status, 'DRAFT', 'order persists as DRAFT — confirmation remains staff-only, the AI tool cannot confirm it');

    // --- staff confirmation, through the VisionPro provider — this is the exact path that had a
    // real bug: confirmOrder() used to hardcode queries against this app's own LOCAL
    // products/inventory tables, which can (and did, in manual testing) collide by coincidence
    // with an unrelated local product sharing the same synthetic per-process id. Confirming here
    // must revalidate against the SAME real Marketing OS data get_price/check_stock already read,
    // by SKU, not by that id — see orders.ts::confirmOrder's docstring.
    const localInventoryBefore = (await db.query(`SELECT product_id, qty FROM inventory ORDER BY product_id`)).rows;
    const confirm = await confirmOrder(Number(draft.data.order_id), { id: null, username: 'smoke-test' }, provider);
    console.log('confirmOrder (visionpro provider) ->', JSON.stringify(confirm));
    assert.equal(confirm.kind, 'ok', 'confirmation must succeed when the real price/stock still match');
    const confirmedRow = (await db.query(`SELECT status FROM orders WHERE id=$1`, [draft.data.order_id])).rows[0];
    assert.equal(confirmedRow.status, 'CONFIRMED', 'order flips to CONFIRMED');
    // The decisive regression check: this app's own LOCAL `inventory` table (a completely
    // unrelated namespace from the VisionPro-sourced order) must be untouched by this
    // confirmation — that table is only meaningful for the local provider.
    const localInventoryAfter = (await db.query(`SELECT product_id, qty FROM inventory ORDER BY product_id`)).rows;
    assert.deepEqual(localInventoryAfter, localInventoryBefore, 'confirming a VisionPro-sourced order never writes to this app\'s own unrelated local inventory table');

    console.log('SMOKE OK (evolution catalog + order, deterministic, no LLM)');
  } finally {
    await db.query(`DELETE FROM orders WHERE conversation_id=$1`, [convId]);
    await db.query(`DELETE FROM messages WHERE conversation_id=$1`, [convId]);
    await db.query(`DELETE FROM conversations WHERE id=$1`, [convId]);
    await db.query(`DELETE FROM customers WHERE id=$1`, [cust.id]);
    await db.end();
  }
})().catch((e) => { console.error('SMOKE FAIL', e.message); process.exitCode = 1; });
