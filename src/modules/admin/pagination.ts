/**
 * Clamps a client-supplied "limit" query value to [1, max], falling back to `def` for anything
 * missing or not a positive integer. Never throws — this only ever bounds a read query's page
 * size, so a malformed value degrades to the existing default rather than erroring the request.
 */
export function clampLimit(raw: unknown, def: number, max: number): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
}

/**
 * Parses an optional "before_id" cursor (a message's own bigint id) for backward pagination
 * past the default page. Returns null for anything missing or not a positive integer — treated
 * as "no cursor", i.e. start from the most recent message, identical to the endpoint's
 * pre-pagination behavior.
 */
export function parseBeforeId(raw: unknown): number | null {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}
