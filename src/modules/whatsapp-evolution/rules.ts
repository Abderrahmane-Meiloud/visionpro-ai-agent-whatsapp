import crypto from 'node:crypto';

/**
 * Pure, unit-testable rules for the Evolution API pilot transport. Mirrors
 * `src/modules/whatsapp/rules.ts`'s pattern (signature/window checks kept as pure functions so the
 * webhook route itself stays thin). See docs/26_EVOLUTION_PILOT.md for the full scope of this
 * experimental, non-production-only transport.
 */

/** Constant-time string compare (secret length is not leaked by timing). Mismatched lengths are
 *  always unequal but short-circuit before the timing-safe compare (no secret bytes compared). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** True for a group (`...@g.us`) or broadcast/status JID — ignored during the pilot. */
export function isGroupOrBroadcast(remoteJid: string): boolean {
  return remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast') || remoteJid === 'status@broadcast';
}

/** True when a message is old enough to be a reconnect/history-sync replay rather than a live
 *  inbound message. Evolution/Baileys does not label history-sync distinctly in the webhook body,
 *  so staleness of `messageTimestamp` (unix seconds) is the practical signal during the pilot. */
export function isStaleHistorySync(messageTimestampSec: number | undefined, now = Date.now(), maxAgeMs = 2 * 60_000): boolean {
  if (!messageTimestampSec) return false; // no timestamp reported: don't guess, let it through
  return now - messageTimestampSec * 1000 > maxAgeMs;
}

/** Extracts a plain-text body from a Baileys-shaped `message` object, or undefined if this isn't
 *  a recognized text message (the pilot is text-only; anything else falls through to the existing
 *  "unsupported message type" handoff path, same as the Meta transport). */
export function extractEvolutionText(message: any): string | undefined {
  return (
    message?.conversation
    ?? message?.extendedTextMessage?.text
    ?? message?.ephemeralMessage?.message?.conversation
    ?? message?.ephemeralMessage?.message?.extendedTextMessage?.text
    ?? undefined
  );
}

/** Bare digits from a Baileys JID (`"22212345678@s.whatsapp.net"` -> `"22212345678"`). */
export function digitsFromJid(remoteJid: string): string {
  return (remoteJid.split('@')[0] ?? '').replace(/\D/g, '');
}

export const EVOLUTION_WA_ID_PREFIX = 'evo:';

/** The pilot's isolated customer-id namespace, so a pilot customer can never collide with (or be
 *  confused for) a real Meta-channel customer record, even for the same real phone number. */
export function toEvolutionWaId(remoteJid: string): string {
  return EVOLUTION_WA_ID_PREFIX + digitsFromJid(remoteJid);
}

/** Strips the pilot namespace prefix back to the bare number the Evolution API expects. */
export function fromEvolutionWaId(waId: string): string {
  return waId.startsWith(EVOLUTION_WA_ID_PREFIX) ? waId.slice(EVOLUTION_WA_ID_PREFIX.length) : waId;
}

/**
 * Gate for AUTOMATIC AI replies on the pilot channel only. Independent of `conversations.mode`
 * (HUMAN/PAUSED) — this is an additional, pilot-only restriction: even with the master switch on,
 * only an explicitly authorized test number is ever auto-replied to, so a stranger who happens to
 * message the connected pilot number is never auto-answered.
 */
export function isPilotAutoReplyAllowed(waId: string, autoReplyEnabled: boolean, allowedTestNumbers: string[]): boolean {
  if (!autoReplyEnabled) return false;
  const digits = fromEvolutionWaId(waId).replace(/\D/g, '');
  return !!digits && allowedTestNumbers.includes(digits);
}

/**
 * WhatsApp has been migrating contacts to a privacy-preserving "LID" JID form (`<opaque-id>@lid`)
 * instead of the phone-number JID (`<digits>@s.whatsapp.net`). For an `@lid` message, the part
 * before `@` is NOT the phone number — matching it against a phone-number allowlist would either
 * silently reject the real authorized sender, or (worse) silently match the wrong person if the
 * allowlist ever contained a LID-shaped value. Verified against evolution-api's own GitHub (PRs
 * #1955, #2450, #2673 — all addressing this exact gap in `messages.upsert`, as of Nov 2026):
 * when WhatsApp supplies a phone-bearing alternate for a `@lid` contact, Baileys/Evolution carries
 * it on a sibling field of `key`; different versions have used different field names, so every
 * name observed in the wild is checked, not just one guessed name.
 *
 * Returns the ORIGINAL jid unchanged when it isn't `@lid` (the common case today). Returns `null`
 * — never a guess — when it IS `@lid` and no phone-bearing alternate is present: callers MUST
 * treat `null` as "cannot verify identity" and reject, not as a pass. This fixes the
 * incompatibility without weakening authorization: a LID message still cannot pass the real
 * inbound allowlist unless a phone number can actually be recovered from it.
 */
export function resolvePhoneBearingJid(remoteJid: string, key: any): string | null {
  if (!remoteJid.endsWith('@lid')) return remoteJid;
  const alt = key?.remoteJidAlt ?? key?.participantAlt ?? key?.senderPn ?? null;
  return typeof alt === 'string' && alt.length > 0 ? alt : null;
}

export const EVOLUTION_PILOT_CHANNEL = 'whatsapp_evolution_pilot';

/**
 * Gate for the REAL inbound webhook route only (never the simulator, which doesn't call this).
 * Fail-closed: an empty allowlist means nothing is accepted. This is checked BEFORE any
 * persistence, dedupe-table insert, or logging of message content — see webhook.ts. Independent
 * of isPilotAutoReplyAllowed, which only gates whether an already-persisted message gets an
 * automatic reply; this one decides whether the message is processed at all.
 */
export function isRealInboundSenderAllowed(remoteJid: string, allowlist: string[]): boolean {
  const digits = digitsFromJid(remoteJid);
  return !!digits && allowlist.includes(digits);
}
