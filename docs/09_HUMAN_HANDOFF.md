# Human Handoff

## Conversation modes
- `AI` — AI may answer
- `HUMAN_PENDING` — AI has requested intervention; no autonomous replies except optional acknowledgement
- `HUMAN` — human controls conversation; AI does not reply
- `PAUSED` — disabled by admin/system

## Trigger behavior
When handoff is required:
1. Change mode atomically.
2. Persist reason.
3. Create operator notification/task.
4. Optionally send one short customer acknowledgement.
5. Stop all AI auto-replies for that conversation.

## Operator UI
Show:
- customer name/number
- last messages
- transcript for voice notes
- AI summary
- handoff reason
- buttons: Take Over / Send Message / Return to AI

## Race prevention
Before every AI send, re-check conversation mode. If a human took over during AI processing, discard the AI response.

## Return to AI
Human explicitly clicks "Return to AI". Record audit event.
