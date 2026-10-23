/**
 * Pre-flight Meta access-token validation — run this BEFORE swapping a new META_ACCESS_TOKEN
 * into production .env, so a bad/expired/under-scoped token is caught here instead of as a
 * live webhook/send failure. Does not modify anything; read-only call to Meta's own
 * /debug_token endpoint. Self-inspection: the token being checked is also used as the
 * inspecting token (Meta supports this for a token to debug itself).
 *
 * Usage (no new dependency added for this — export the two vars from your .env into the shell
 * first, same convention this project already uses for scripts/smoke.ts):
 *   set -a; source .env; set +a; npx tsx scripts/check_meta_credentials.ts
 *
 * Exit code 0 = token valid; 1 = invalid or the check itself failed (network/config problem) —
 * safe to wire into a pre-deploy step that checks the exit code.
 */
import { parseDebugTokenResponse } from '../src/modules/whatsapp/token_check';

async function main(): Promise<void> {
  const version = process.env.META_GRAPH_API_VERSION;
  const token = process.env.META_ACCESS_TOKEN;

  if (!version) {
    console.error('META_GRAPH_API_VERSION is not set — copy the current version from the Meta dashboard first.');
    process.exit(1);
  }
  if (!token) {
    console.error('META_ACCESS_TOKEN is not set — nothing to check.');
    process.exit(1);
  }

  const url = `https://graph.facebook.com/${version}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`;
  let json: unknown;
  try {
    const res = await fetch(url);
    json = await res.json();
  } catch (e) {
    console.error(`Could not reach Meta's Graph API: ${(e as Error).message}`);
    process.exit(1);
  }

  const result = parseDebugTokenResponse(json);
  if (!result.valid) {
    console.error(`Token is NOT valid: ${result.error}`);
    process.exit(1);
  }

  console.log('Token is valid.');
  console.log(`  App ID: ${result.appId ?? '(not reported)'}`);
  console.log(`  Scopes: ${result.scopes.join(', ') || '(none reported)'}`);
  console.log(`  Expires: ${result.expiresAt ?? 'never (permanent token)'}`);
  const required = ['whatsapp_business_messaging', 'whatsapp_business_management'];
  const missing = required.filter((s) => !result.scopes.includes(s));
  if (missing.length) {
    console.warn(`  WARNING: missing expected production scope(s): ${missing.join(', ')}`);
  }
}

main();
