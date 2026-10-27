import { q, audit } from '../../db';

/** Atomically flip AI -> HUMAN_PENDING. Returns false if the conversation was not in AI mode. */
export async function requestHandoff(conversationId: number, reason: string, actor = 'AI'): Promise<boolean> {
  const r = await q(`UPDATE conversations SET mode='HUMAN_PENDING' WHERE id=$1 AND mode='AI' RETURNING id`, [conversationId]);
  if (!r.length) return false;
  await q(`INSERT INTO handoffs(conversation_id, reason) VALUES($1,$2)`, [conversationId, reason]);
  await audit(actor, 'handoff.request', 'conversation', conversationId, { mode: 'AI' }, { mode: 'HUMAN_PENDING', reason }, 'agent');
  return true;
}

/** Who performed an action. `id` is null for the env bootstrap-admin / bridge (no users row). */
export type Actor = { id: number | null; username: string };

export async function takeover(conversationId: number, actor: Actor) {
  const old = (await q(`SELECT mode, assigned_user FROM conversations WHERE id=$1`, [conversationId]))[0];
  // atomic: claim ownership and flip mode in one statement
  await q(`UPDATE conversations SET mode='HUMAN', assigned_user=$2, assigned_user_id=$3, assigned_at=now() WHERE id=$1`,
    [conversationId, actor.username, actor.id]);
  await q(
    `UPDATE handoffs SET status='ACCEPTED', accepted_by=$2, accepted_at=now()
     WHERE conversation_id=$1 AND status='PENDING'`, [conversationId, actor.username]);
  await audit(actor.username, 'handoff.takeover', 'conversation', conversationId, old, { mode: 'HUMAN', assigned_user: actor.username });
}

export async function returnToAI(conversationId: number, actor: Actor) {
  const old = (await q(`SELECT mode, assigned_user FROM conversations WHERE id=$1`, [conversationId]))[0];
  await q(`UPDATE conversations SET mode='AI', assigned_user=NULL, assigned_user_id=NULL, assigned_at=NULL WHERE id=$1`, [conversationId]);
  await q(`UPDATE handoffs SET status='RETURNED', returned_to_ai_at=now() WHERE conversation_id=$1 AND status IN ('PENDING','ACCEPTED')`, [conversationId]);
  await audit(actor.username, 'handoff.return_to_ai', 'conversation', conversationId, old, { mode: 'AI' });
}

/** Assign (or unassign with userId=null) a conversation to a user, atomically, with audit. */
export async function assignConversation(conversationId: number, userId: number | null, username: string | null, actor: Actor): Promise<boolean> {
  const old = (await q(`SELECT assigned_user, assigned_user_id FROM conversations WHERE id=$1`, [conversationId]))[0];
  if (!old) return false;
  await q(`UPDATE conversations SET assigned_user=$2, assigned_user_id=$3, assigned_at=CASE WHEN $3 IS NULL THEN NULL ELSE now() END WHERE id=$1`,
    [conversationId, username, userId]);
  await audit(actor.username, userId == null ? 'conversation.unassign' : 'conversation.assign', 'conversation', conversationId, old, { assigned_user: username });
  return true;
}
