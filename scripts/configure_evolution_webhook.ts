/**
 * Configures the webhook on the EXISTING Evolution API `vision` instance ONLY — never touches any
 * other instance. This MUTATES a live external system, so it is deliberately NOT run automatically
 * by anything in this repo. The owner runs it by hand, only after:
 *   1. scripts/check_evolution_instance.ts has confirmed the connected number is an authorized test
 *      number (never production/client-facing) — see docs/26_EVOLUTION_PILOT.md;
 *   2. the local app + Cloudflare Quick Tunnel are running and the tunnel's health path
 *      (https://<tunnel-host>/webhooks/evolution/pilot/health) has been confirmed reachable from
 *      the public internet.
 *
 * Usage:
 *   set -a; source .env; set +a
 *   PUBLIC_WEBHOOK_URL="https://<tunnel-host>/webhooks/evolution/pilot/$EVOLUTION_WEBHOOK_PATH_SECRET" \
 *     npx tsx scripts/configure_evolution_webhook.ts            # dry run: prints the exact payload, sends nothing
 *   ...same... npx tsx scripts/configure_evolution_webhook.ts --confirm   # actually applies it
 *
 * ROLLBACK: `npx tsx scripts/configure_evolution_webhook.ts --disable` (dry run) then `--disable
 * --confirm`. VERIFIED LIVE (2026-11-07): this Evolution API version's `/webhook/set` REJECTS
 * `enabled:false` without a `url` (`HTTP 400 "webhook requires property \"url\""`) — so, contrary
 * to this script's original assumption, --disable DOES need PUBLIC_WEBHOOK_URL set to the
 * last-known tunnel URL (it does not need to be reachable anymore, just the same string that was
 * last applied). This script now refuses to send a bodyless disable rather than silently no-op or
 * hit that 400 — see the check below. Do not rely on simply omitting PUBLIC_WEBHOOK_URL from the
 * enable command instead: without --disable, a missing PUBLIC_WEBHOOK_URL makes this script
 * refuse to run at all (see the checks below) — it sends nothing, which means the live webhook
 * stays exactly as it was. That is a no-op, not a rollback; this mistake was caught and fixed
 * before any live use.
 *
 * VERIFY before trusting this: the exact request shape for `POST /webhook/set/{instance}` (the
 * `webhook` wrapper, field names, whether `headers` is supported for custom auth headers) was
 * confirmed against this specific live instance on 2026-11-07 (both enable and disable calls
 * succeeded with this exact shape). Re-run scripts/check_evolution_instance.ts afterward to
 * confirm the instance is still only pointed at THIS webhook and nothing else changed.
 */

/** Masks anything secret-shaped before it is ever printed: the path-secret segment of a webhook
 *  URL, and any Authorization/Bearer header value — in EITHER pretty-printed (spaced) or compact
 *  (no-space) JSON, since the Evolution API's own raw response echoes compact JSON and a pattern
 *  tuned only for our own pretty-printed console.log missed that case once already. */
function redact(s: string): string {
  return s
    .replace(/(\/webhooks\/evolution\/pilot\/)[A-Za-z0-9_-]+/g, '$1[REDACTED_SECRET]')
    .replace(/Bearer\s+[A-Za-z0-9_-]+/gi, 'Bearer [REDACTED]');
}

async function main(): Promise<void> {
  const base = process.env.EVOLUTION_API_BASE_URL;
  const key = process.env.EVOLUTION_API_KEY;
  const instanceName = process.env.EVOLUTION_INSTANCE_NAME || 'vision';
  const publicWebhookUrl = process.env.PUBLIC_WEBHOOK_URL;
  const authHeaderSecret = process.env.EVOLUTION_WEBHOOK_AUTH_HEADER;
  const confirm = process.argv.includes('--confirm');
  const disable = process.argv.includes('--disable');
  const show = process.argv.includes('--show');

  if (!base) { console.error('EVOLUTION_API_BASE_URL is not set.'); process.exit(1); }
  if (!key) { console.error('EVOLUTION_API_KEY is not set.'); process.exit(1); }

  if (show) {
    // READ-ONLY: fetch whatever webhook config is live on this instance RIGHT NOW, before any
    // enable/disable call — so an existing, unexpected integration is seen and preserved as a
    // record rather than silently overwritten. Evolution API v2's documented contract for this is
    // `GET /webhook/find/{instance}`; unverified against this specific instance's exact version
    // until this call actually runs. Never prints the API key.
    try {
      const res = await fetch(`${base.replace(/\/+$/, '')}/webhook/find/${encodeURIComponent(instanceName)}`, {
        method: 'GET', headers: { apikey: key }, signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      console.log(`Current live webhook config for instance "${instanceName}": HTTP ${res.status}`);
      console.log(redact(text.slice(0, 2000)));
    } catch (e) {
      console.error(`Could not read the current webhook config: ${(e as Error).message}`);
      process.exit(1);
    }
    return;
  }

  let webhookConfig: Record<string, unknown>;
  if (disable) {
    // Rollback mode: turns the webhook off. VERIFIED LIVE: this API rejects enabled:false without
    // a url, so PUBLIC_WEBHOOK_URL (the last-known tunnel URL — it does not need to still be
    // reachable) is required here too. Fails fast with a clear message rather than sending a
    // request we already know will be rejected.
    if (!publicWebhookUrl) { console.error('PUBLIC_WEBHOOK_URL is not set — this live API requires `url` even to disable. Set it to the last-known tunnel URL (it no longer needs to be reachable).'); process.exit(1); }
    webhookConfig = { enabled: false, url: publicWebhookUrl };
  } else {
    if (!publicWebhookUrl) { console.error('PUBLIC_WEBHOOK_URL is not set — must be the full tunnel URL including the /webhooks/evolution/pilot/<secret> path. (Use --disable for rollback, which does not need this.)'); process.exit(1); }
    if (!publicWebhookUrl.startsWith('https://')) { console.error('PUBLIC_WEBHOOK_URL must be HTTPS.'); process.exit(1); }
    webhookConfig = {
      enabled: true,
      url: publicWebhookUrl,
      webhookByEvents: false,
      webhookBase64: false,
      events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
    };
    // Only attach custom headers if the instance's API is confirmed to support sending them back —
    // omit this entirely rather than guess if that is not yet verified for this version.
    if (authHeaderSecret) webhookConfig.headers = { Authorization: `Bearer ${authHeaderSecret}` };
  }

  console.log(`Target instance: "${instanceName}" (only this instance — no others are touched). Mode: ${disable ? 'DISABLE (rollback)' : 'ENABLE'}`);
  console.log('Webhook config to be applied:');
  console.log(redact(JSON.stringify({ webhook: webhookConfig }, null, 2)));

  if (!confirm) {
    console.log('\nDry run only — nothing was sent. Re-run with --confirm to actually apply this.');
    return;
  }

  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/webhook/set/${encodeURIComponent(instanceName)}`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhook: webhookConfig }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) { console.error(`Evolution API rejected the webhook config: HTTP ${res.status} ${redact(text.slice(0, 500))}`); process.exit(1); }
    console.log(`Applied. Response: ${redact(text.slice(0, 500))}`);
    console.log(disable
      ? 'Webhook disabled. Re-run scripts/check_evolution_instance.ts to confirm the instance state, independent of this script\'s own success message.'
      : 'Next: send one real test message from the authorized test number and confirm it is received (check the app logs / admin inbox) before enabling EVOLUTION_PILOT_AUTO_REPLY_ENABLED.');
  } catch (e) {
    console.error(`Request failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

main();
export {};
