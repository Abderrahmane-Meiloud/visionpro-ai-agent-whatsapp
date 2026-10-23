/**
 * Pure parsing logic for Meta's `/debug_token` response — separated from the network call
 * (scripts/check_meta_credentials.ts) so it's testable without hitting the real Graph API.
 * Used to validate a META_ACCESS_TOKEN (scopes + expiry) BEFORE swapping it into production
 * .env, per the Phase 1 Beta work package's "credential rotation support" requirement — this is
 * a pre-flight check, not a live hot-reload (the agent still reads env at boot).
 */

export type DebugTokenResult =
  | { valid: true; scopes: string[]; expiresAt: string | null; appId: string | null }
  | { valid: false; error: string };

/** `raw` is the parsed JSON body of a GET .../debug_token response. Never throws — a malformed
 * or error-shaped response becomes `{ valid: false, error: ... }`, never an unhandled exception,
 * since this runs as an interactive pre-flight check an operator reads directly. */
export function parseDebugTokenResponse(raw: unknown): DebugTokenResult {
  if (typeof raw !== 'object' || raw === null || !('data' in raw)) {
    return { valid: false, error: 'Unexpected response shape (no "data" field) — check META_GRAPH_API_VERSION and that the token itself is well-formed.' };
  }
  const data = (raw as { data: unknown }).data;
  if (typeof data !== 'object' || data === null) {
    return { valid: false, error: 'Unexpected response shape ("data" is not an object).' };
  }
  const d = data as Record<string, unknown>;
  if (d.is_valid !== true) {
    const errorMessage = typeof d.error === 'object' && d.error !== null && 'message' in d.error
      ? String((d.error as Record<string, unknown>).message)
      : 'Token reported as invalid by Meta, no further detail in the response.';
    return { valid: false, error: errorMessage };
  }
  const scopes = Array.isArray(d.scopes) ? d.scopes.map((s) => String(s)) : [];
  const expiresAt = typeof d.expires_at === 'number' && d.expires_at > 0
    ? new Date(d.expires_at * 1000).toISOString()
    : null; // 0 or absent means "does not expire" (permanent System User token) — not an error.
  const appId = typeof d.app_id === 'string' ? d.app_id : null;
  return { valid: true, scopes, expiresAt, appId };
}
