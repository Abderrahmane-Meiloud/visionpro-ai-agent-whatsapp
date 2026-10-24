/**
 * Minimal structured (JSON-line) logger with strict redaction. No dependencies.
 *
 * Everything logged goes through redact(): credentials, message content and personal data are
 * never written to logs. We log event names + safe metadata (ids, counts, status, durations),
 * never customer text/transcripts, phone numbers, tokens or secrets.
 */

// Keys whose values are always dropped, matched case-insensitively (substring match). Covers
// credentials/secrets and message-content / PII fields used across this codebase.
const SENSITIVE_KEY = /authorization|password|passwd|secret|token|api[_-]?key|openai|bearer|cookie|\btext\b|transcription|\bbody\b|content|caption|wa_?id|msisdn|phone|display_name|\bname\b|\bto\b|\bfrom\b|recipient/i;

const MAX_STR = 500;
const MAX_DEPTH = 4;

// Mask runs that look like a phone number in free text (leading optional +, digits grouped by
// spaces/parens/dots). Deliberately NOT bridging '-' so dash-separated UUIDs (request ids) are
// left intact; PII phone fields are already dropped by key above, so this is just a safety net.
const PHONE_RE = /\+?\d[\d\s().]{5,}\d/g;

function redactString(s: string): string {
  // Defense-in-depth: scrub credential-shaped substrings in case one ever reaches a log value
  // (e.g. inside an upstream Meta/OpenAI error body). Key-based redaction above already drops
  // the fields we control; this catches tokens embedded in free text.
  const masked = s
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '[redacted-key]')   // OpenAI-style API keys
    .replace(/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]')         // Authorization header values
    .replace(/\bEA[A-Za-z0-9]{20,}/g, '[redacted-token]')             // Meta/Facebook access tokens
    .replace(PHONE_RE, '[phone]');
  return masked.length > MAX_STR ? masked.slice(0, MAX_STR) + `…(+${masked.length - MAX_STR})` : masked;
}

export function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { error: redactString(value.message) };
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return '[unloggable]';
}

type Level = 'info' | 'warn' | 'error';
function emit(level: Level, event: string, fields?: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(fields ?? {}) as object) });
  (level === 'error' ? console.error : console.log)(line);
}

export const log = {
  info: (event: string, fields?: Record<string, unknown>) => emit('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit('error', event, fields),
};
