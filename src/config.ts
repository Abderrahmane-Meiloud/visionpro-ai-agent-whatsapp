const opt = (k: string, d = '') => process.env[k] ?? d;

export const cfg = {
  port: Number(opt('PORT', '3000')),
  production: opt('NODE_ENV') === 'production',
  databaseUrl: opt('DATABASE_URL'),
  graphVersion: opt('META_GRAPH_API_VERSION'), // must be set from Meta's current docs; no default on purpose
  appSecret: opt('META_APP_SECRET'),
  phoneNumberId: opt('META_PHONE_NUMBER_ID'),
  accessToken: opt('META_ACCESS_TOKEN'),
  verifyToken: opt('META_WEBHOOK_VERIFY_TOKEN'),
  openaiKey: opt('OPENAI_API_KEY'),
  // Default verified against OpenAI's docs (Oct 2026): gpt-5.6-terra is the model OpenAI's own
  // function-calling guide uses for Chat Completions + tools, which is exactly how the agent runs.
  // The GPT-6 tiers (gpt-6-luna/gpt-6-sol) exist but their tool-calling support on Chat Completions
  // is NOT confirmed (GPT-6 Astra/6.1 Sol require the Responses API for tools) — validate with one
  // live call before overriding to a GPT-6 model.
  textModel: opt('OPENAI_TEXT_MODEL', 'gpt-5.6-terra'),
  fallbackModel: opt('OPENAI_TEXT_FALLBACK_MODEL'),
  // gpt-4o-mini-transcribe is deprecated (shut down 2027-02-26); gpt-transcribe is the current
  // recommended file-transcription model and still supports the `prompt` context field we use.
  transcribeModel: opt('OPENAI_TRANSCRIBE_MODEL', 'gpt-transcribe'),
  // AGENT_MOCK=true answers with a canned reply so the WhatsApp pipe can be tested before an OpenAI key exists
  mock: opt('AGENT_MOCK') === 'true',
  // Spend kill-switch: counted against real AI-sent replies in the last rolling day. When AGENT_MOCK
  // is false a NON-ZERO cap is always enforced — 0/unset falls back to the conservative
  // REPLY_DAILY_CALL_CAP_DEFAULT (see agent/index.ts effectiveReplyCap). Mock mode never counts.
  replyDailyCallCap: Number(opt('REPLY_DAILY_CALL_CAP', '0')),
  defaultReplyCap: Number(opt('REPLY_DAILY_CALL_CAP_DEFAULT', '1000')),
  maxToolCalls: Number(opt('MAX_TOOL_CALLS_PER_TURN', '6')),
  debounceMs: Number(opt('DEBOUNCE_MS', '1500')),
  // Hard cap on the characters of Approved Knowledge injected into the system prompt (bounded retrieval).
  promptKbCharBudget: Number(opt('PROMPT_KB_CHAR_BUDGET', '12000')),
  companyName: opt('COMPANY_NAME', 'Demo Company'),
  adminUser: opt('ADMIN_USER', 'admin'),
  adminPassword: opt('ADMIN_PASSWORD'),
  // Separate, optional service-to-service credential (e.g. the VisionPro WhatsApp bridge) —
  // inactive (can never match anything) until BRIDGE_PASSWORD is set; see
  // modules/admin/auth.ts's authenticateBasic(), which skips any account with no password.
  bridgeUser: opt('BRIDGE_USER', 'whatsapp-bridge'),
  bridgePassword: opt('BRIDGE_PASSWORD'),
  // P2-A session policy (cookie sessions, node:crypto scrypt). Absolute + idle expiry.
  sessionTtlHours: Number(opt('SESSION_TTL_HOURS', '168')), // 7 days absolute
  sessionIdleMins: Number(opt('SESSION_IDLE_MINS', '720')), // 12h idle (0 disables idle check)
  // Production-INERT test seam for the deterministic webhook failure/retry test. It is REFUSED in
  // production (see checkProdConfig): the app will not boot with NODE_ENV=production and this set.
  allowTestFaults: opt('ALLOW_TEST_FAULTS') === '1',
  // Schema is NOT auto-applied at boot in production (avoids locking a populated DB); run the
  // migration explicitly (npm run migrate). Dev/test keep auto-migrate for convenience.
  autoMigrate: opt('AUTO_MIGRATE', opt('NODE_ENV') === 'production' ? 'false' : 'true') === 'true',
  // Business-data provider for the agent's catalog/price/stock tools. Default `local` preserves
  // the pre-integration behavior (reads the agent's own Postgres products/product_prices/inventory
  // tables, see src/modules/tools/provider.ts). `visionpro` routes those tool calls to Marketing
  // OS's /api/v1/catalog/products instead — no cross-DB SQL, no new tool exposed to the LLM.
  businessProvider: (opt('BUSINESS_PROVIDER', 'local') === 'visionpro' ? 'visionpro' : 'local') as 'visionpro' | 'local',
  visionproBaseUrl: opt('VISIONPRO_BASE_URL', ''),
  visionproBridgeEmail: opt('VISIONPRO_BRIDGE_EMAIL', 'whatsapp-bridge@internal.visionpro'),
  visionproBridgePassword: opt('VISIONPRO_BRIDGE_PASSWORD', ''),

  // --- Evolution API pilot transport (EXPERIMENTAL, owner-authorized, non-production only) ---
  // This is NOT the project's official channel (see docs/14_WHATSAPP_POLICY_AND_COMPLIANCE.md and
  // docs/26_EVOLUTION_PILOT.md). It reuses the same agent core, catalog tools and safety rules as
  // the Meta Cloud API path above, through an entirely separate transport, DB channel tag
  // ('whatsapp_evolution_pilot'), customer-id namespace ('evo:' prefix) and network listener, so it
  // can never mix with or silently affect production Meta conversations. Setting
  // EVOLUTION_API_BASE_URL is what turns the isolated pilot webhook listener on at all; it defaults
  // to off. `assertProdConfig` below hard-refuses to boot in production if any of this is set.
  evolutionApiBaseUrl: opt('EVOLUTION_API_BASE_URL', ''), // e.g. https://your-evolution-host.example — NOT the Manager UI URL
  evolutionInstanceName: opt('EVOLUTION_INSTANCE_NAME', 'vision'),
  evolutionApiKey: opt('EVOLUTION_API_KEY', ''),
  // Separate, minimal listener port — only this port should ever be exposed via a tunnel; it serves
  // nothing but the pilot webhook route (never admin, never the Meta webhook).
  evolutionWebhookPort: Number(opt('EVOLUTION_WEBHOOK_PORT', '3100')),
  // Long random path segment the inbound webhook URL must include (`/webhooks/evolution/pilot/<secret>`).
  evolutionWebhookPathSecret: opt('EVOLUTION_WEBHOOK_PATH_SECRET', ''),
  // Optional extra defense-in-depth: if set, the webhook ALSO requires `Authorization: Bearer <this>`.
  // Only effective if the Evolution instance's webhook config actually sends custom headers back —
  // verify this against the live instance before relying on it; the path secret above is the
  // guaranteed fallback either way. See docs/26_EVOLUTION_PILOT.md.
  evolutionWebhookAuthHeader: opt('EVOLUTION_WEBHOOK_AUTH_HEADER', ''),
  // Master switch for AUTOMATIC AI replies on the pilot channel. Inbound messages are always
  // received, deduped and persisted once EVOLUTION_API_BASE_URL is set (so the receiver itself can
  // be verified) — but no automatic reply is ever sent unless this is explicitly true AND the
  // sender is in evolutionPilotAllowedTestNumbers below.
  evolutionPilotAutoReplyEnabled: opt('EVOLUTION_PILOT_AUTO_REPLY_ENABLED') === 'true',
  // Comma-separated allowlist of bare digit phone numbers. Even with auto-reply enabled, only these
  // numbers ever get an automatic AI reply through the pilot channel — never a random inbound sender.
  evolutionPilotAllowedTestNumbers: opt('EVOLUTION_PILOT_ALLOWED_TEST_NUMBERS', '')
    .split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean),
  // Mounts an extra, clearly-separate set of routes on the SAME isolated pilot listener: a fake
  // `/message/sendText/:instance` sink (so EVOLUTION_API_BASE_URL can point back at this same
  // process instead of any real Evolution server) and a tiny browser page to drive a full
  // simulated customer conversation. Never talks to a real WhatsApp account by construction. See
  // docs/26_EVOLUTION_PILOT.md.
  evolutionPilotSimulationMode: opt('EVOLUTION_PILOT_SIMULATION_MODE') === 'true',
  // REAL-inbound sender allowlist (distinct from evolutionPilotAllowedTestNumbers, which only
  // gates AUTO-REPLY after a message is already persisted). This gates the real webhook route
  // (src/modules/whatsapp-evolution/webhook.ts) itself: a sender not on this list is rejected
  // BEFORE any dedupe-table insert, any ingest()/persistence, any logging of message content —
  // fail-closed, so an empty list means "reject everything". Never applies to the simulator
  // (simulate.ts never goes through this route at all). See docs/26_EVOLUTION_PILOT.md.
  evolutionRealInboundAllowlist: opt('EVOLUTION_REAL_INBOUND_ALLOWLIST', '')
    .split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean),
  // Fail-closed master switch for REAL (non-loopback) Evolution OUTBOUND sends — manual replies, AI
  // replies, and retries alike, since all three converge on sendEvolutionText(). Defaults to false.
  // Deliberately independent of evolutionPilotAutoReplyEnabled/evolutionPilotSimulationMode: those
  // gate the AUTO-reply decision or the receiver's fake sink, but neither actually stops a manual
  // reply from reaching a real, non-loopback EVOLUTION_API_BASE_URL — a real gap found during
  // verification. sendEvolutionText() enforces this before the real HTTP call (never for a loopback
  // base URL, which is what the local simulator always uses). See docs/26_EVOLUTION_PILOT.md.
  evolutionRealOutboundEnabled: opt('EVOLUTION_REAL_OUTBOUND_ENABLED') === 'true',
};

export type ProdConfigInput = Pick<typeof cfg,
  'databaseUrl' | 'verifyToken' | 'adminPassword' | 'allowTestFaults' | 'graphVersion' | 'appSecret' | 'phoneNumberId' | 'accessToken'
  | 'evolutionApiBaseUrl' | 'evolutionPilotAutoReplyEnabled' | 'evolutionPilotSimulationMode' | 'evolutionRealOutboundEnabled'>;

/** Pure: production safety checks. Errors block boot; warnings are advisory. Unit-tested. */
export function checkProdConfig(c: ProdConfigInput): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const missing = [['DATABASE_URL', c.databaseUrl], ['META_WEBHOOK_VERIFY_TOKEN', c.verifyToken], ['ADMIN_PASSWORD', c.adminPassword]]
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) errors.push(`Missing env: ${missing.join(', ')}`);
  if (c.adminPassword && c.adminPassword.length < 16) errors.push('ADMIN_PASSWORD must be at least 16 characters in production');
  if (/CHANGE_ME/i.test(c.adminPassword ?? '')) errors.push('ADMIN_PASSWORD is still the .env.example placeholder; set a real secret');
  // The test fault-injection seam must never be enabled in production.
  if (c.allowTestFaults) errors.push('ALLOW_TEST_FAULTS must not be set in production');
  // The Evolution API pilot is a narrowly scoped, owner-authorized EXPERIMENT (see
  // docs/26_EVOLUTION_PILOT.md) — never the production transport. Refuse to boot in production if
  // it is configured at all, so this cannot drift into an accidental production dependency.
  if (c.evolutionApiBaseUrl) errors.push('EVOLUTION_API_BASE_URL must not be set in production (experimental, non-production pilot transport only)');
  if (c.evolutionPilotAutoReplyEnabled) errors.push('EVOLUTION_PILOT_AUTO_REPLY_ENABLED must not be set in production');
  if (c.evolutionPilotSimulationMode) errors.push('EVOLUTION_PILOT_SIMULATION_MODE must not be set in production');
  if (c.evolutionRealOutboundEnabled) errors.push('EVOLUTION_REAL_OUTBOUND_ENABLED must not be set in production');
  const meta = [['META_GRAPH_API_VERSION', c.graphVersion], ['META_APP_SECRET', c.appSecret], ['META_PHONE_NUMBER_ID', c.phoneNumberId], ['META_ACCESS_TOKEN', c.accessToken]]
    .filter(([, v]) => !v).map(([k]) => k);
  if (meta.length) warnings.push(`Meta not fully configured, missing: ${meta.join(', ')}`);
  return { errors, warnings };
}

/** Fail fast in production if anything needed to run safely is missing or unsafe. Dev/test skip. */
export function assertProdConfig() {
  if (!cfg.production) return;
  const { errors, warnings } = checkProdConfig(cfg);
  for (const w of warnings) console.warn(`WARNING: ${w}`);
  if (errors.length) throw new Error(errors.join('; '));
}
