import { q, audit } from '../../db';

/** Atomically flip AI -> HUMAN_PENDING. Returns false if the conversation was not in AI mode. */
export async function requestHandoff(conversationId: number, reason: string, actor = 'AI'): Promise<boolean> {
  const r = await q(`UPDATE conversations SET mode='HUMAN_PENDING' WHERE id=$1 AND mode='AI' RETURNING id`, [conversationId]);
  if (!r.length) return false;
  await q(`INSERT INTO handoffs(conversation_id, reason) VALUES($1,$2)`, [conversationId, reason]);
  await audit(actor, 'handoff.request', 'conversation', conversationId, { mode: 'AI' }, { mode: 'HUMAN_PENDING', reason }, 'agent');
  return true;
}

export async function takeover(conversationId: number, user: string) {
  const old = (await q(`SELECT mode FROM conversations WHERE id=$1`, [conversationId]))[0];
  await q(`UPDATE conversations SET mode='HUMAN', assigned_user=$2 WHERE id=$1`, [conversationId, user]);
  await q(
    `UPDATE handoffs SET status='ACCEPTED', accepted_by=$2, accepted_at=now()
     WHERE conversation_id=$1 AND status='PENDING'`, [conversationId, user]);
  await audit(user, 'handoff.takeover', 'conversation', conversationId, old, { mode: 'HUMAN' });
}

export async function returnToAI(conversationId: number, user: string) {
  const old = (await q(`SELECT mode FROM conversations WHERE id=$1`, [conversationId]))[0];
  await q(`UPDATE conversations SET mode='AI', assigned_user=NULL WHERE id=$1`, [conversationId]);
  await q(`UPDATE handoffs SET status='RETURNED', returned_to_ai_at=now() WHERE conversation_id=$1 AND status IN ('PENDING','ACCEPTED')`, [conversationId]);
  await audit(user, 'handoff.return_to_ai', 'conversation', conversationId, old, { mode: 'AI' });
}
