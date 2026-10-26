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
};

export type ProdConfigInput = Pick<typeof cfg,
  'databaseUrl' | 'verifyToken' | 'adminPassword' | 'allowTestFaults' | 'graphVersion' | 'appSecret' | 'phoneNumberId' | 'accessToken'>;

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
