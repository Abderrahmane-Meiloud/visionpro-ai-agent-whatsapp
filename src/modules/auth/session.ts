import crypto from 'node:crypto';
import { cfg } from '../../config';
import { q } from '../../db';

const sha256 = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export type ResolvedSession = { user: { id: number; username: string; role: string }; csrf: string; sessionId: number };

/** Pure: decide whether a session is still valid. Extracted for unit tests. */
export function sessionValid(expiresAt: Date, lastSeen: Date, active: boolean, idleMins: number, now = Date.now()): boolean {
  if (!active) return false;
  if (expiresAt.getTime() <= now) return false;
  if (idleMins > 0 && now - lastSeen.getTime() > idleMins * 60_000) return false;
  return true;
}

/** Pure: constant-time CSRF token comparison. */
export function csrfOk(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Pure: read one cookie value from a Cookie header. */
export function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export async function createSession(userId: number, ip?: string, userAgent?: string): Promise<{ token: string; csrf: string }> {
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + cfg.sessionTtlHours * 3_600_000);
  await q(
    `INSERT INTO sessions(token_hash, user_id, csrf, expires_at, last_seen_at, ip, user_agent)
     VALUES($1,$2,$3,$4,now(),$5,$6)`,
    [sha256(token), userId, csrf, expires, ip ?? null, (userAgent ?? '').slice(0, 300)],
  );
  return { token, csrf };
}

/** Resolve a raw cookie token to a live session, enforcing expiry, idle timeout and user.active.
 *  Any invalid/expired/deactivated session is deleted (server-side revocation) and returns null. */
export async function resolveSession(token: string): Promise<ResolvedSession | null> {
  const rows = await q<any>(
    `SELECT s.id, s.csrf, s.expires_at, s.last_seen_at, u.id AS uid, u.username, u.role, u.active
     FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1`,
    [sha256(token)],
  );
  const s = rows[0];
  if (!s) return null;
  if (!sessionValid(new Date(s.expires_at), new Date(s.last_seen_at), s.active, cfg.sessionIdleMins)) {
    await q(`DELETE FROM sessions WHERE id=$1`, [s.id]);
    return null;
  }
  await q(`UPDATE sessions SET last_seen_at=now() WHERE id=$1`, [s.id]);
  return { user: { id: s.uid, username: s.username, role: s.role }, csrf: s.csrf, sessionId: s.id };
}

export async function destroySession(sessionId: number): Promise<void> {
  await q(`DELETE FROM sessions WHERE id=$1`, [sessionId]);
}

export async function sweepExpiredSessions(): Promise<void> {
  await q(`DELETE FROM sessions WHERE expires_at <= now()`);
}
