import { cfg } from '../../config';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const base = () => `${process.env.META_GRAPH_BASE || 'https://graph.facebook.com'}/${cfg.graphVersion}`;
const auth = () => ({ Authorization: `Bearer ${cfg.accessToken}` });

/** Bounded exponential backoff on network errors, 429 and 5xx. Never logs the token. */
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
 * Send a free-form text message. Free-form is only valid inside the 24h customer-service window;
 * callers must check canSendFreeForm() first.
 */
export async function sendText(to: string, body: string): Promise<string> {
  if (!cfg.graphVersion) throw new Error('META_GRAPH_API_VERSION not set');
  // Meta text bodies max out at 4096 chars
  const res = await withRetry('sendText', () =>
    fetch(`${base()}/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: body.slice(0, 4000), preview_url: false } }),
    }),
  );
  const j: any = await res.json();
  return j.messages?.[0]?.id as string;
}

export async function markRead(messageId: string): Promise<void> {
  try {
    await fetch(`${base()}/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
    });
  } catch { /* best effort */ }
}

export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;

export async function downloadMedia(mediaId: string): Promise<{ buf: Buffer; mime: string }> {
  const meta: any = await (await withRetry('mediaMeta', () => fetch(`${base()}/${mediaId}`, { headers: auth() }))).json();
  if (meta.file_size && meta.file_size > MAX_AUDIO_BYTES) throw new Error('media too large');
  const res = await withRetry('mediaDownload', () => fetch(meta.url, { headers: auth() }));
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_AUDIO_BYTES) throw new Error('media too large');
  return { buf, mime: meta.mime_type || 'audio/ogg' };
}
