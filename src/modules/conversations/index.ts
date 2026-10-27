import { cfg } from '../../config';
import { q, getSetting, audit } from '../../db';
import { log } from '../../log';
import { runAgent, HANDOFF_TEXT } from '../agent';
import { requestHandoff } from '../handoff';
import { transcribe } from '../transcription';
import { downloadMedia, markRead, sendText } from '../whatsapp/client';
import { canSendFreeForm } from '../whatsapp/rules';

export type Inbound = {
  waId: string; name?: string; messageId: string; type: string;
  text?: string; mediaId?: string; mime?: string;
};

const timers = new Map<number, NodeJS.Timeout>();
const running = new Set<number>();

/** Persist an inbound message (idempotent on the WhatsApp message id) and schedule the AI turn. */
export async function ingest(m: Inbound): Promise<void> {
  const cust = (await q(
    `INSERT INTO customers(wa_id, display_name) VALUES($1,$2)
     ON CONFLICT (wa_id) DO UPDATE SET display_name=COALESCE(EXCLUDED.display_name, customers.display_name), updated_at=now()
     RETURNING id`, [m.waId, m.name ?? null]))[0];
  const conv = (await q(
    `INSERT INTO conversations(customer_id, last_inbound_at) VALUES($1, now())
     ON CONFLICT (customer_id) DO UPDATE SET last_message_at=now(), last_inbound_at=now()
     RETURNING id, status`, [cust.id]))[0];

  const type = m.type === 'text' ? 'TEXT' : m.type === 'audio' ? 'AUDIO' : m.type === 'image' ? 'IMAGE' : m.type === 'document' ? 'DOCUMENT' : 'SYSTEM';
  const ins = await q(
    `INSERT INTO messages(conversation_id, whatsapp_message_id, direction, sender_type, message_type, text, media_meta, processing_status)
     VALUES($1,$2,'IN','CUSTOMER',$3,$4,$5,'PENDING') ON CONFLICT (whatsapp_message_id) DO NOTHING RETURNING id`,
    [conv.id, m.messageId, type, m.text ?? null, JSON.stringify({ mediaId: m.mediaId, mime: m.mime, rawType: m.type })]);
  if (!ins.length) return; // duplicate webhook: already handled (also means no spurious reopen)
  // Reopen policy: a genuinely new inbound reopens a CLOSED/SNOOZED conversation to OPEN. This only
  // changes the inbox status — it never alters `mode` (HUMAN/PAUSED ownership + handoff are preserved)
  // and the global AI pause is untouched. Audited.
  if (conv.status && conv.status !== 'OPEN') {
    await q(`UPDATE conversations SET status='OPEN', closed_at=NULL, snoozed_until=NULL WHERE id=$1`, [conv.id]);
    await audit('SYSTEM', 'conversation.reopen', 'conversation', conv.id, { status: conv.status }, { status: 'OPEN' }, 'webhook');
  }
  markRead(m.messageId);
  schedule(conv.id);
}

export function schedule(conversationId: number, delay = cfg.debounceMs) {
  clearTimeout(timers.get(conversationId));
  timers.set(conversationId, setTimeout(() => {
    timers.delete(conversationId);
    processConversation(conversationId).catch((e) => log.error('conversation.process_failed', { conversationId, err: e.message }));
  }, delay));
}

/** After a crash/restart, re-run anything left mid-flight. */
export async function recoverPending() {
  await q(`UPDATE messages SET processing_status='PENDING' WHERE processing_status='PROCESSING' AND direction='IN'`);
  for (const r of await q(`SELECT DISTINCT conversation_id FROM messages WHERE processing_status='PENDING' AND direction='IN'`)) schedule(r.conversation_id, 500);
}

async function fail(ids: number[], err: string) {
  await q(`UPDATE messages SET processing_status='FAILED', error=$2 WHERE id = ANY($1)`, [ids, err.slice(0, 500)]);
}

async function processConversation(convId: number) {
  if (running.has(convId)) { schedule(convId, 1000); return; } // one turn per conversation at a time
  running.add(convId);
  try {
    const batch = await q(
      `UPDATE messages SET processing_status='PROCESSING' WHERE conversation_id=$1 AND direction='IN' AND processing_status='PENDING'
       RETURNING id, message_type, text, media_meta`, [convId]);
    if (!batch.length) return;
    const ids = batch.map((b) => b.id);
    const conv = (await q(`SELECT c.mode, c.last_inbound_at, c.stt_failures, cu.wa_id FROM conversations c JOIN customers cu ON cu.id=c.customer_id WHERE c.id=$1`, [convId]))[0];

    const paused = !(await getSetting<boolean>('ai_enabled', true));
    if (conv.mode !== 'AI' || paused) {
      await q(`UPDATE messages SET processing_status=$2 WHERE id = ANY($1)`, [ids, paused ? 'SKIPPED_PAUSED' : 'SKIPPED_HUMAN']);
      return;
    }

    // build the customer's turn: text + voice-note transcripts
    const parts: string[] = [];
    let sttFailed = false;
    let unsupported = false;
    for (const b of batch.sort((x, y) => x.id - y.id)) {
      if (b.message_type === 'TEXT' && b.text) parts.push(b.text);
      else if (b.message_type === 'AUDIO') {
        try {
          if (!(await getSetting<boolean>('voice_notes_enabled', true))) throw new Error('voice notes disabled');
          const { buf, mime } = await downloadMedia(b.media_meta.mediaId);
          const t = await transcribe(buf, mime);
          if (!t) throw new Error('empty transcript');
          await q(`UPDATE messages SET transcription=$2 WHERE id=$1`, [b.id, t]);
          parts.push(t);
        } catch (e: any) {
          log.warn('stt.failed', { conversationId: convId, messageId: b.id, err: e.message });
          await q(`UPDATE messages SET error=$2 WHERE id=$1`, [b.id, e.message.slice(0, 300)]);
          sttFailed = true;
        }
      } else unsupported = true; // image/document/etc: log only, hand off politely
    }

    let reply = '';
    let model: string | null = null;
    let handedOff = false;
    if (!parts.length) {
      if (sttFailed) {
        const n = (await q(`UPDATE conversations SET stt_failures=stt_failures+1 WHERE id=$1 RETURNING stt_failures`, [convId]))[0].stt_failures;
        if (n >= 2) { handedOff = await requestHandoff(convId, 'voice note not understood twice'); reply = HANDOFF_TEXT.fr; }
        else reply = "Désolé, je n'ai pas bien compris votre message vocal. Pouvez-vous le répéter ou l'écrire ?\nما فهمت الرسالة الصوتية زين، عاود أو اكتب لي.";
      } else if (unsupported) {
        handedOff = await requestHandoff(convId, 'unsupported message type (image/document)');
        reply = "Merci, je transmets votre message à un membre de l'équipe.\nشكرا، نحوّل رسالتك لواحد من الفريق.";
      }
    } else {
      await q(`UPDATE conversations SET stt_failures=0 WHERE id=$1`, [convId]);
      const r = await runAgent(convId, parts.join('\n'));
      reply = r.reply; model = r.model; handedOff = r.handedOff;
    }
    if (!reply) { await q(`UPDATE messages SET processing_status='DONE' WHERE id = ANY($1)`, [ids]); return; }

    // race check: a human may have taken over, or AI been paused, while we were thinking
    const now = (await q(`SELECT mode, last_inbound_at FROM conversations WHERE id=$1`, [convId]))[0];
    const stillAllowed = (now.mode === 'AI' || (handedOff && now.mode === 'HUMAN_PENDING')) && (await getSetting<boolean>('ai_enabled', true));
    if (!stillAllowed) { await q(`UPDATE messages SET processing_status='DISCARDED' WHERE id = ANY($1)`, [ids]); return; }
    if (!canSendFreeForm(now.last_inbound_at)) { await fail(ids, 'outside 24h window'); return; }

    try {
      const waId = await sendText(conv.wa_id, reply);
      await q(`INSERT INTO messages(conversation_id, whatsapp_message_id, direction, sender_type, message_type, text, model_name, delivery_status)
               VALUES($1,$2,'OUT','AI','TEXT',$3,$4,'sent')`, [convId, waId, reply, model]);
      await q(`UPDATE conversations SET last_message_at=now() WHERE id=$1`, [convId]);
      await q(`UPDATE messages SET processing_status='DONE' WHERE id = ANY($1)`, [ids]);
    } catch (e: any) {
      await fail(ids, e.message);
      await requestHandoff(convId, 'send failed: ' + e.message.slice(0, 120), 'system');
    }
  } catch (e: any) {
    // AI/DB failure: mark and surface to a human instead of leaving the customer unanswered silently
    await q(`UPDATE messages SET processing_status='FAILED', error=$2 WHERE conversation_id=$1 AND processing_status='PROCESSING'`, [convId, String(e.message).slice(0, 500)]);
    await requestHandoff(convId, 'agent error: ' + String(e.message).slice(0, 120), 'system');
    throw e;
  } finally {
    running.delete(convId);
  }
}
