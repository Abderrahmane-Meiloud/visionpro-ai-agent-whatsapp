/**
 * Safety guard for destructive test operations (the smoke test TRUNCATEs tables). It refuses to
 * run unless DATABASE_URL clearly points at a DISPOSABLE, LOCAL test database — so the smoke test
 * can never wipe a production or application database (Supabase/Render/any remote host are remote
 * and are rejected outright). An explicit `allow` escape hatch exists for unusual local setups.
 */
export function assertDisposableTestDb(databaseUrl: string | undefined, allow = false): void {
  if (allow) return; // operator opted out via SMOKE_ALLOW_DESTRUCTIVE=1 (takes responsibility)
  if (!databaseUrl) throw new Error('refusing destructive test: DATABASE_URL is not set');

  let u: URL;
  try { u = new URL(databaseUrl); } catch { throw new Error('refusing destructive test: DATABASE_URL is not a valid URL'); }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
  if (!LOCAL.has(host)) {
    throw new Error(`refusing destructive test against non-local host "${host}" (only localhost is allowed)`);
  }

  const dbName = decodeURIComponent(u.pathname.replace(/^\//, '')).toLowerCase();
  if (!dbName) throw new Error('refusing destructive test: no database name in DATABASE_URL');
  if (!/(smoke|test)/.test(dbName)) {
    throw new Error(`refusing destructive test: database "${dbName}" is not clearly a test DB (its name must contain "smoke" or "test")`);
  }
}
