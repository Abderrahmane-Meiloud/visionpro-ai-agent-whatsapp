/**
 * Read-only check of the Evolution API `vision` instance — run this BEFORE trusting it for the
 * pilot (docs/26_EVOLUTION_PILOT.md). Confirms the base URL + API key work and reports the
 * instance's connection state and connected phone number, so the owner can personally verify it is
 * an authorized test number — never a production/client-facing number — before any webhook is
 * configured or any live message is sent through it. Modifies nothing. Never prints the API key,
 * and deliberately strips any `token`/`hash`/`apikey` field some Evolution versions include in
 * this response before printing anything.
 *
 * Usage (same convention as scripts/check_meta_credentials.ts):
 *   set -a; source .env; set +a; npx tsx scripts/check_evolution_instance.ts
 */

/** Never print a full phone number or hostname — both are on the owner's explicit "never expose"
 *  list. Masks all but the last 2 digits (plus a length hint) so the owner can still sanity-check
 *  it's the expected test number without it being readable from tool output/logs. Fixed after this
 *  script was found to print the raw number and base-URL host unmasked. */
function maskNumber(n: string): string {
  const digits = String(n ?? '').replace(/\D/g, '');
  if (!digits) return '(not reported)';
  return `${'•'.repeat(Math.max(0, digits.length - 2))}${digits.slice(-2)} (${digits.length} digits)`;
}

function maskHost(url: string): string {
  try { return `https://[REDACTED_HOST]${new URL(url).pathname}`; } catch { return '[REDACTED_URL]'; }
}

function safeView(raw: any) {
  const i = raw?.instance ?? raw;
  return {
    instanceName: i?.instanceName ?? i?.name ?? '(unknown)',
    connectionStatus: i?.connectionStatus ?? i?.status ?? i?.state ?? '(unknown)',
    number: i?.number ?? i?.owner ?? '(not reported)',
    profileName: i?.profileName ?? null,
  };
}

async function main(): Promise<void> {
  const base = process.env.EVOLUTION_API_BASE_URL;
  const key = process.env.EVOLUTION_API_KEY;
  const instanceName = process.env.EVOLUTION_INSTANCE_NAME || 'vision';

  if (!base) { console.error('EVOLUTION_API_BASE_URL is not set.'); process.exit(1); }
  if (!key) { console.error('EVOLUTION_API_KEY is not set — nothing to check.'); process.exit(1); }
  if (/\/manager\b/i.test(base)) {
    console.warn('WARNING: this URL looks like it might be the Evolution Manager UI, not the API base URL. Double-check before proceeding.');
  }

  let body: any;
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/instance/fetchInstances`, { headers: { apikey: key }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) { console.error(`Evolution API returned HTTP ${res.status}. Base URL or API key is likely wrong.`); process.exit(1); }
    body = await res.json();
  } catch (e) {
    console.error(`Could not reach the Evolution API at ${maskHost(base)}: ${(e as Error).message}`);
    console.error('Confirm this is the API base URL (e.g. https://your-host), NOT the /manager UI URL.');
    process.exit(1);
  }

  const list = Array.isArray(body) ? body : (body.instances ?? body.data ?? []);
  const views = (Array.isArray(list) ? list : []).map(safeView);
  const mine = views.find((v) => v.instanceName === instanceName);

  console.log(`Reached the Evolution API. ${views.length} instance(s) visible to this API key.`);
  if (!mine) {
    console.error(`Instance "${instanceName}" was NOT found. Available instance names: ${views.map((v) => v.instanceName).join(', ') || '(none)'}`);
    process.exit(1);
  }

  console.log(`Instance "${instanceName}":`);
  console.log(`  connectionStatus: ${mine.connectionStatus}`);
  console.log(`  connected number: ${maskNumber(mine.number)}`);
  if (mine.connectionStatus !== 'open') {
    console.warn('  WARNING: instance is not in "open" state — it may not be connected to a real WhatsApp session right now.');
  }
  console.log('');
  console.log('OWNER ACTION REQUIRED before configuring the pilot webhook or sending any live test message:');
  console.log(`  Confirm the number above is an explicitly authorized TEST number — never a production or`);
  console.log('  client-facing number, and never a medical-client account. Do not proceed otherwise.');
}

main();
export {};
