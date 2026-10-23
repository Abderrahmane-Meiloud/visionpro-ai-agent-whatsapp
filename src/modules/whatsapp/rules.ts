import crypto from 'node:crypto';

/** Meta signs the raw body: header `X-Hub-Signature-256: sha256=<hmac_sha256(appSecret, rawBody)>`. */
export function verifySignature(raw: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !appSecret || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(raw).digest('hex');
  const given = header.slice(7);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** WhatsApp only allows free-form replies within 24h of the customer's last message. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;
export function canSendFreeForm(lastInboundAt: Date | null, now = new Date()): boolean {
  return !!lastInboundAt && now.getTime() - lastInboundAt.getTime() < WINDOW_MS;
}

/** Status webhooks can arrive out of order; never move backwards. */
const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };
export function shouldApplyStatus(current: string | null, next: string): boolean {
  return (RANK[next] ?? 0) > (RANK[current ?? ''] ?? 0);
}
