import crypto from 'node:crypto';

export type Credential = { user: string; password: string };

const timingSafeEqual = (a: string, b: string): boolean => {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

/**
 * Parses an HTTP Basic `Authorization` header and returns the matched account's configured
 * username if it matches any of `accounts` (first match wins), or null otherwise.
 *
 * Each `accounts` entry whose `password` is falsy is skipped entirely — this is what makes a
 * second credential (e.g. a service-to-service bridge account) opt-in: absent its password env
 * var, it can never match anything, so existing deployments that only ever configure the admin
 * account see no behavior change at all.
 */
export function authenticateBasic(authorizationHeader: string | undefined, accounts: Credential[]): string | null {
  const [u, ...p] = Buffer.from((authorizationHeader ?? '').replace(/^Basic /, ''), 'base64')
    .toString()
    .split(':');
  const password = p.join(':');
  for (const account of accounts) {
    if (!account.password) continue;
    if (timingSafeEqual(u ?? '', account.user) && timingSafeEqual(password, account.password)) {
      return u ?? null;
    }
  }
  return null;
}
