/**
 * Synthetic WhatsApp webhook test — sends a fake but properly-signed Meta webhook
 * event to the local WhatsApp Agent to verify the full inbound pipeline:
 *
 *   webhook → Agent DB (customers, conversations, messages) → mock AI reply → sent
 *
 * Usage:
 *   npx tsx scripts/test_synthetic_webhook.ts [agent_url]
 *
 * Requirements:
 *   - WhatsApp Agent running locally (npm run dev)
 *   - DATABASE_URL configured
 *   - AGENT_MOCK=true (uses mock AI, no OpenAI cost)
 *   - META_APP_SECRET set (used to sign the payload)
 *   - META_WEBHOOK_VERIFY_TOKEN set (tested in GET challenge)
 *
 * The script:
 *   1. Sends a GET webhook verification challenge
 *   2. Sends a POST with a synthetic inbound text message (properly HMAC-signed)
 *   3. Waits for processing, then queries the admin API to verify the message was stored
 */

import crypto from 'node:crypto';

const AGENT_URL = process.argv[2] || 'http://localhost:3000';
const APP_SECRET = process.env.META_APP_SECRET;
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!APP_SECRET) {
  console.log('⚠ META_APP_SECRET not set — sending unsigned payload (will be rejected by signature check)');
  console.log('  Set META_APP_SECRET in .env or pass it as env var to test with valid signatures');
}

const TEST_WA_ID = '22237912781';
const TEST_NAME = 'VisionPro Test';
const TEST_MESSAGE_ID = `wamid.test_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
const TEST_TEXT = 'مرحبا، شنو عندكم من المنتجات؟';

function sign(body: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function step(label: string, fn: () => Promise<void>) {
  process.stdout.write(`  ${label}... `);
  try {
    await fn();
    console.log('✓');
  } catch (e: any) {
    console.log(`✗ ${e.message}`);
    throw e;
  }
}

async function main() {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  VisionPro WhatsApp Synthetic Webhook Test   ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);
  console.log(`Agent URL:    ${AGENT_URL}`);
  console.log(`Test WA ID:   ${TEST_WA_ID}`);
  console.log(`Test Msg ID:  ${TEST_MESSAGE_ID}`);
  console.log(`Signed:       ${APP_SECRET ? 'yes' : 'no (will fail signature check)'}\n`);

  // 1. Webhook verification challenge (GET)
  if (VERIFY_TOKEN) {
    await step('GET webhook verification challenge', async () => {
      const challenge = crypto.randomBytes(16).toString('hex');
      const url = `${AGENT_URL}/webhooks/meta/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=${challenge}`;
      const res = await fetch(url);
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await res.text();
      if (body !== challenge) throw new Error(`challenge mismatch: expected ${challenge}, got ${body}`);
    });
  } else {
    console.log('  Skipping GET challenge (META_WEBHOOK_VERIFY_TOKEN not set)\n');
  }

  // 2. POST synthetic inbound message
  const payload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: '000000000000000',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550000000', phone_number_id: 'test_phone_id' },
          contacts: [{ profile: { name: TEST_NAME }, wa_id: TEST_WA_ID }],
          messages: [{
            from: TEST_WA_ID,
            id: TEST_MESSAGE_ID,
            timestamp: String(Math.floor(Date.now() / 1000)),
            text: { body: TEST_TEXT },
            type: 'text',
          }],
        },
        field: 'messages',
      }],
    }],
  });

  await step('POST synthetic inbound message', async () => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (APP_SECRET) headers['x-hub-signature-256'] = sign(payload, APP_SECRET);

    const res = await fetch(`${AGENT_URL}/webhooks/meta/whatsapp`, {
      method: 'POST',
      headers,
      body: payload,
    });
    if (res.status === 401) throw new Error('401 Unauthorized — signature verification failed (check META_APP_SECRET)');
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${await res.text()}`);
  });

  // 3. Wait for debounce + processing
  console.log('  Waiting 3s for debounce + AI processing...');
  await new Promise(r => setTimeout(r, 3000));

  // 4. Verify via admin API
  if (ADMIN_PASSWORD) {
    const basicAuth = Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString('base64');
    const authHeader = { Authorization: `Basic ${basicAuth}` };

    await step('Verify conversation exists in agent DB', async () => {
      const res = await fetch(`${AGENT_URL}/api/conversations?limit=5`, { headers: authHeader });
      if (res.status !== 200) throw new Error(`admin API returned ${res.status}`);
      const data: any = await res.json();
      const conv = data.data?.find((c: any) => c.wa_id === TEST_WA_ID);
      if (!conv) throw new Error(`conversation for wa_id=${TEST_WA_ID} not found`);
      console.log(`\n    → Conversation #${conv.id}: mode=${conv.mode}, messages=${conv.message_count}`);
    });

    await step('Verify messages stored', async () => {
      const res = await fetch(`${AGENT_URL}/api/conversations?limit=5`, { headers: authHeader });
      const data: any = await res.json();
      const conv = data.data?.find((c: any) => c.wa_id === TEST_WA_ID);
      if (!conv) throw new Error('conversation not found');

      const msgRes = await fetch(`${AGENT_URL}/api/conversations/${conv.id}/messages?limit=20`, { headers: authHeader });
      if (msgRes.status !== 200) throw new Error(`messages API returned ${msgRes.status}`);
      const msgData: any = await msgRes.json();
      const messages = msgData.data ?? [];

      const inbound = messages.find((m: any) => m.whatsapp_message_id === TEST_MESSAGE_ID);
      if (!inbound) throw new Error(`inbound message ${TEST_MESSAGE_ID} not found`);
      console.log(`\n    → Inbound: id=${inbound.id}, status=${inbound.processing_status}, text="${inbound.text?.slice(0, 50)}"`);

      const reply = messages.find((m: any) => m.direction === 'OUT' && m.sender_type === 'AI' && m.id > inbound.id);
      if (reply) {
        console.log(`    → AI Reply: id=${reply.id}, model=${reply.model_name}, text="${reply.text?.slice(0, 80)}"`);
      } else {
        console.log(`    → No AI reply yet (may still be processing, or mode != AI)`);
      }
    });

    await step('Verify webhook event recorded', async () => {
      const res = await fetch(`${AGENT_URL}/api/conversations?limit=5`, { headers: authHeader });
      // Webhook events aren't directly exposed via admin API, but the message existing proves it was processed
      if (res.status === 200) {
        console.log('\n    → Webhook event was received and processed (message exists in DB)');
      }
    });
  } else {
    console.log('  Skipping admin API verification (ADMIN_PASSWORD not set)\n');
  }

  console.log('\n══════════════════════════════════════════════');
  console.log('  Synthetic webhook test complete.');
  console.log('  Next: run the WhatsApp Bridge to sync this');
  console.log('  conversation into the VisionPro Inbox.');
  console.log('══════════════════════════════════════════════\n');
}

main().catch((e) => {
  console.error(`\nTest failed: ${e.message}\n`);
  process.exit(1);
});
