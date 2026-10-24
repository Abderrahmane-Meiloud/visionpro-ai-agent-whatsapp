import crypto from 'node:crypto';
import { q } from '../../db';
import type { Role } from './rbac';

export type UserRow = { id: number; username: string; password_hash: string; role: Role; active: boolean };

// scrypt parameters (node:crypto, no external dependency). ~16MB memory, well under the 32MB default.
const N = 16384, R = 8, P = 1, KEYLEN = 64;

/** Encode as `scrypt$N$r$p$saltHex$keyHex`. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Constant-time verify. Never throws on a malformed stored value — returns false. */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, n, r, p, saltHex, keyHex] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const key = Buffer.from(keyHex, 'hex');
    const test = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), key.length, { N: +n, r: +r, p: +p });
    return key.length === test.length && crypto.timingSafeEqual(key, test);
  } catch {
    return false;
  }
}

/** Only active users are returned — a deactivated user can never authenticate. */
export async function getActiveUserByUsername(username: string): Promise<UserRow | null> {
  const r = await q<UserRow>(`SELECT id, username, password_hash, role, active FROM users WHERE username=$1 AND active=true`, [username]);
  return r[0] ?? null;
}

export async function listUsers() {
  return q(`SELECT id, username, role, active, created_at, last_login_at FROM users ORDER BY id`);
}

export async function createUser(username: string, password: string, role: Role) {
  const r = await q(`INSERT INTO users(username, password_hash, role) VALUES($1,$2,$3) RETURNING id, username, role, active`, [username, hashPassword(password), role]);
  return r[0];
}

export async function setUserActive(id: number, active: boolean) {
  await q(`UPDATE users SET active=$2, updated_at=now() WHERE id=$1`, [id, active]);
  if (!active) await q(`DELETE FROM sessions WHERE user_id=$1`, [id]); // revoke all sessions immediately
}

export async function setUserRole(id: number, role: Role) {
  await q(`UPDATE users SET role=$2, updated_at=now() WHERE id=$1`, [id, role]);
}

export async function setUserPassword(id: number, password: string) {
  await q(`UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1`, [id, hashPassword(password)]);
  await q(`DELETE FROM sessions WHERE user_id=$1`, [id]); // force re-login after a password change
}

/** Create the DB admin from the env bootstrap credentials ONLY when no users exist yet, so the
 *  owner can log into the dashboard immediately. Idempotent; never overwrites an existing user. */
export async function ensureBootstrapAdmin(username: string, password: string) {
  if (!username || !password) return;
  const existing = await q(`SELECT 1 FROM users LIMIT 1`);
  if (existing.length) return;
  await createUser(username, password, 'admin');
}
