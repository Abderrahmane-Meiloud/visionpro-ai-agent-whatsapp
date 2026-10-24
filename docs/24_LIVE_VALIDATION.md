# Live Validation Checklist (owner-operated)

Run this **once**, by the owner, on the Meta **sandbox / test number** before any real customer traffic.
Nothing here can be done by the coding agent (it needs real credentials and sends real messages).
Do each step in order; stop and fix if any check fails. Secrets go into the server `.env` only, never git.

Pre-req: the app is deployed, the schema has been migrated (`npm run migrate`, see `docs/23`), and
`GET /api/health` returns `{"ok":true}`.

## A. Meta WhatsApp Cloud API registration + webhook verification
1. In the server `.env` set `META_GRAPH_API_VERSION`, `META_APP_SECRET`, `META_PHONE_NUMBER_ID`,
   `META_ACCESS_TOKEN`, `META_WEBHOOK_VERIFY_TOKEN`. Restart the app.
2. Validate the access token out-of-band: `npx tsx scripts/check_meta_credentials.ts` → prints valid + scopes.
3. In the Meta dashboard, set the webhook callback to `https://<DOMAIN>/webhooks/meta/whatsapp` with the
   same verify token, and **subscribe the WABA to `messages`**.
   - ✅ Expect: Meta's GET verification succeeds (the app returns the challenge). Server log shows no `webhook.bad_signature`.
4. Send a test message from an added test recipient.
   - ✅ Expect: a signed POST is accepted (HTTP 200); an invalid-signature POST returns 401.

## B. Inbound/outbound text
5. Keep `AGENT_MOCK=true` first. Message the number.
   - ✅ Expect: a canned `[mock] received: …` reply arrives; the conversation appears in the admin inbox.
6. Set `OPENAI_API_KEY`, choose `OPENAI_TEXT_MODEL` (default `gpt-5.6-terra`), set a conservative
   `REPLY_DAILY_CALL_CAP`, then `AGENT_MOCK=false`; restart.
   - ✅ Expect: a real, on-topic reply in the customer's language (Hassaniya/French/Arabic/English).
   - ✅ Expect: after the daily cap is hit, the agent hands off to a human (no crash).

## C. OGG/Opus voice transcription (⚠ highest-risk path)
7. Send a WhatsApp **voice note** (OGG/Opus) with `OPENAI_TRANSCRIBE_MODEL=gpt-transcribe`.
   - ✅ Expect: the transcript appears on the message and the agent answers it.
   - ❌ If the STT call rejects OGG/Opus: do **not** go live on voice. Decide: transcode to m4a/mp3 before
     sending (a P2+ change), or keep voice disabled (`voice_notes_enabled=false` in admin). Record the outcome here.
8. Send a second unintelligible/empty voice note.
   - ✅ Expect: "please repeat / write"; a second failure hands off to a human.

## D. OpenAI tool calling + human handoff
9. Seed a product + price + stock in the admin **Orders** view. Ask the agent for that product's price.
   - ✅ Expect: the agent calls `get_price` (a row appears in `tool_executions`) and quotes the DB price — it
     never invents a price. Ask for an unknown product → the agent says it cannot confirm and offers a human.
10. Ask to speak to a person / make a complaint.
    - ✅ Expect: `request_human_handoff` fires, the conversation flips to `HUMAN_PENDING`, and the AI goes silent.

## E. Approved templates + delivery statuses
11. Register an approved template in Meta; add it in the admin **Orders → Templates** card (matching
    `meta_template_name`, language, variable count).
12. For a conversation whose 24h window is closed, free-form send returns 409; use the composer's template
    picker instead.
    - ✅ Expect: the template is delivered; the OUT message is recorded as type `TEMPLATE`.
13. Watch delivery-status webhooks.
    - ✅ Expect: the message's `delivery_status` advances `sent → delivered → read` (never backwards) and shows
      in the inbox / Analytics delivery summary. A `failed` status surfaces with its reason.

## F. Failure recovery, rollback, safe logging
14. Restart the app mid-conversation.
    - ✅ Expect: `recoverPending()` re-processes any in-flight inbound (no lost messages, no duplicate replies).
15. Take over a conversation while the AI is composing.
    - ✅ Expect: the AI reply is discarded; the human owns the thread.
16. Inspect server logs during the above.
    - ✅ Expect: **no** tokens, phone numbers, or message content in logs (only event names + ids). Confirm
      `ALLOW_TEST_FAULTS` is unset (the app refuses to boot in production if it is set).
17. Rollback drill: stop the app, restore the previous image/commit, restart.
    - ✅ Expect: the service comes back healthy; the DB (additive migrations only) remains compatible with the
      previous version.

## Sign-off
- [ ] A–F all pass on the sandbox number · [ ] voice-note outcome recorded · [ ] spend cap set ·
  [ ] no secrets/PII in logs · [ ] rollback drill done. Only then widen beyond test recipients.
