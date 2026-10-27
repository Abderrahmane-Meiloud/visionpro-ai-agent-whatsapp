import { cfg } from '../../config';
import { q } from '../../db';

/** Vocabulary as a context prompt: biases the STT toward client terms; not fine-tuning. */
async function vocabPrompt(): Promise<string> {
  const rows = await q(`SELECT term, alternates FROM vocabulary WHERE active ORDER BY id LIMIT 200`);
  const terms = rows.flatMap((r) => [r.term, ...(r.alternates ?? [])]);
  return `${cfg.companyName}. Hassaniya Arabic, French, English. ${terms.join(', ')}`.slice(0, 900);
}

/**
 * OpenAI detects the audio format from the upload's filename extension (+ content type), so the
 * filename must match the real MIME — not a hardcoded `.ogg`. WhatsApp voice notes are usually
 * `audio/ogg; codecs=opus`, but forwarded/other audio can arrive as mp3/m4a/wav/etc. Unknown types
 * fall back to `ogg` (WhatsApp's native voice format).
 */
const MIME_EXT: Record<string, string> = {
  'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/oga': 'ogg',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mpga': 'mp3',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'm4a',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/webm': 'webm', 'video/mp4': 'mp4', 'audio/amr': 'amr', 'audio/3gpp': '3gp',
};
export function filenameForMime(mime: string | undefined): string {
  const base = (mime ?? '').split(';')[0].trim().toLowerCase();
  return `voice.${MIME_EXT[base] ?? 'ogg'}`;
}

/** Returns trimmed transcript; empty string means "could not understand". */
export async function transcribe(buf: Buffer, mime: string): Promise<string> {
  if (!cfg.openaiKey) throw new Error('OPENAI_API_KEY not set');
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buf)], { type: mime }), filenameForMime(mime));
  form.append('model', cfg.transcribeModel);
  form.append('prompt', await vocabPrompt());
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.openaiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`STT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return String(((await res.json()) as any).text ?? '').trim();
}
