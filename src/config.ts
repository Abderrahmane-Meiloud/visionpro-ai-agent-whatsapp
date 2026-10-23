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
  textModel: opt('OPENAI_TEXT_MODEL', 'gpt-6-luna'),
  fallbackModel: opt('OPENAI_TEXT_FALLBACK_MODEL'),
  transcribeModel: opt('OPENAI_TRANSCRIBE_MODEL', 'gpt-4o-mini-transcribe'),
  // AGENT_MOCK=true answers with a canned reply so the WhatsApp pipe can be tested before an OpenAI key exists
  mock: opt('AGENT_MOCK') === 'true',
  // Spending/kill-switch control (Phase 1 Beta): 0 or unset = no cap. Counted against real
  // AI-sent replies in the last rolling day (see agent/index.ts's isDailyCapExceeded).
  replyDailyCallCap: Number(opt('REPLY_DAILY_CALL_CAP', '0')),
  maxToolCalls: Number(opt('MAX_TOOL_CALLS_PER_TURN', '6')),
  debounceMs: Number(opt('DEBOUNCE_MS', '1500')),
  companyName: opt('COMPANY_NAME', 'Demo Company'),
  adminUser: opt('ADMIN_USER', 'admin'),
  adminPassword: opt('ADMIN_PASSWORD'),
  // Separate, optional service-to-service credential (e.g. the VisionPro WhatsApp bridge) —
  // inactive (can never match anything) until BRIDGE_PASSWORD is set; see
  // modules/admin/auth.ts's authenticateBasic(), which skips any account with no password.
  bridgeUser: opt('BRIDGE_USER', 'whatsapp-bridge'),
  bridgePassword: opt('BRIDGE_PASSWORD'),
};

/** Fail fast in production if anything needed to run safely is missing. */
export function assertProdConfig() {
  if (!cfg.production) return;
  const need: [string, string][] = [
    ['DATABASE_URL', cfg.databaseUrl], ['META_WEBHOOK_VERIFY_TOKEN', cfg.verifyToken], ['ADMIN_PASSWORD', cfg.adminPassword],
  ];
  const missing = need.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);
  // Meta creds may arrive after first boot (webhook verification only needs the verify token). Without them
  // every webhook is rejected (no app secret) and sends fail loudly, so this is safe, just not functional.
  const meta = ['META_GRAPH_API_VERSION', 'META_APP_SECRET', 'META_PHONE_NUMBER_ID', 'META_ACCESS_TOKEN'].filter((k) => !process.env[k]);
  if (meta.length) console.warn(`WARNING: Meta not fully configured, missing: ${meta.join(', ')}`);
}
