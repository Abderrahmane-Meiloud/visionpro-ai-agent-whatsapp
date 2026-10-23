import { cfg } from '../../config';
import { q } from '../../db';

/** Vocabulary as a context prompt: biases the STT toward client terms; not fine-tuning. */
async function vocabPrompt(): Promise<string> {
  const rows = await q(`SELECT term, alternates FROM vocabulary WHERE active ORDER BY id LIMIT 200`);
  const terms = rows.flatMap((r) => [r.term, ...(r.alternates ?? [])]);
  return `${cfg.companyName}. Hassaniya Arabic, French, English. ${terms.join(', ')}`.slice(0, 900);
}

/** Returns trimmed transcript; empty string means "could not understand". */
export async function transcribe(buf: Buffer, mime: string): Promise<string> {
  if (!cfg.openaiKey) throw new Error('OPENAI_API_KEY not set');
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buf)], { type: mime }), 'voice.ogg');
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
