import { cfg } from '../../config';
import { fromEvolutionWaId } from './rules';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// EVOLUTION_API_BASE override lets tests point this at a fake local server, same pattern as
// META_GRAPH_BASE in ../whatsapp/client.ts.
const base = () => (process.env.EVOLUTION_API_BASE || cfg.evolutionApiBaseUrl).replace(/\/+$/, '');

/** True only for the local simulator's own fake sink (loopback) — never a real WhatsApp send,
 *  regardless of EVOLUTION_REAL_OUTBOUND_ENABLED. Anything else is a REAL send attempt. */
function isLoopbackBase(url: string): boolean {
  try { return /^(?:localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(new URL(url).hostname); } catch { return false; }
}

/** Bounded exponential backoff on network errors, 429 and 5xx. Never logs the API key. */
async function withRetry(label: string, fn: () => Promise<Response>, tries = 3): Promise<Response> {
  let last = '';
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fn();
      if (res.ok) return res;
      last = `${res.status} ${(await res.text()).slice(0, 300)}`;
      if (res.status < 500 && res.status !== 429) break; // 4xx is not retryable
    } catch (e: any) {
      last = e.message;
    }
    await sleep(500 * 2 ** i);
  }
  throw new Error(`${label} failed: ${last}`);
}

/**
 * Send a free-form text message through the existing Evolution API `vision` instance (pilot
 * transport only — see docs/26_EVOLUTION_PILOT.md). Wire shape follows Evolution API v2's
 * documented `POST /message/sendText/{instance}` contract (`apikey` header, `{ number, text }`
 * body). VERIFY this against the live instance's own API docs before depending on it beyond the
 * pilot: Evolution's wire shape has changed across major versions (v1 nested the text under
 * `textMessage`; v2 flattens it), and this was written from documentation, not a confirmed live
 * send (no live outbound send has been authorized yet — see HANDOFF.md / docs/26).
 */
export async function sendEvolutionText(waId: string, body: string): Promise<string> {
  if (!cfg.evolutionApiBaseUrl && !process.env.EVOLUTION_API_BASE) throw new Error('EVOLUTION_API_BASE_URL not set');
  if (!cfg.evolutionApiKey) throw new Error('EVOLUTION_API_KEY not set');
  // Fail-closed real-outbound gate: a loopback base (the local simulator's own fake sink) is never
  // a real send and is always allowed; anything else is a REAL send attempt and requires the
  // explicit, defaults-to-false EVOLUTION_REAL_OUTBOUND_ENABLED — this is the one place ALL outbound
  // paths (manual reply, AI auto-reply, retry) converge, so this check cannot be bypassed by any of
  // them. See config.ts's evolutionRealOutboundEnabled docstring.
  if (!isLoopbackBase(base()) && !cfg.evolutionRealOutboundEnabled) {
    throw new Error('EVOLUTION_REAL_OUTBOUND_ENABLED is false: real Evolution outbound sending is disabled');
  }
  const number = fromEvolutionWaId(waId);
  const res = await withRetry('evolution.sendText', () =>
    fetch(`${base()}/message/sendText/${encodeURIComponent(cfg.evolutionInstanceName)}`, {
      method: 'POST',
      headers: { apikey: cfg.evolutionApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number, text: body.slice(0, 4000) }),
    }),
  );
  const j: any = await res.json();
  const id = j?.key?.id ?? j?.message?.key?.id ?? j?.messageId;
  if (!id) throw new Error('evolution sendText: no message id in response');
  return 'evo:' + id;
}
