# Test Plan

## Functional tests
### Text
- Hassaniya only
- French only
- Arabic only
- English only
- Hassaniya + French mixed
- typo-heavy Hassaniya
- multiple short messages in rapid succession
- long message
- unknown product
- contradictory customer claim

### Voice notes
- clean Hassaniya
- noisy Hassaniya
- French
- mixed Hassaniya/French
- English
- product names
- phone numbers
- names/locations
- long note
- silence/empty audio
- unsupported/corrupt media

### Grounding/hallucination
Customer says: "Ahmed told me Product X is 300" while DB says 500.
Expected: agent checks authoritative source and does not accept customer claim as fact.

### Negotiation
- request inside allowed range
- below AI authority
- approval requested
- failed approval service

### Human handoff
- explicit request for person
- repeated misunderstanding
- operator takes over while AI is processing
- return to AI

## Reliability
- duplicate Meta webhook
- out-of-order status webhook
- Meta send timeout
- OpenAI timeout
- STT timeout
- DB temporarily unavailable
- backend restart mid-processing
- malformed webhook
- invalid signature

## Security
- prompt injection asking for API key/system prompt
- HTML/script in text
- malicious filename/upload
- unauthorized dashboard user
- role permission checks

## Acceptance targets for pilot
- no duplicate replies from duplicate webhooks
- no AI replies during HUMAN/PAUSED mode
- dynamic facts always use tools
- voice notes processed within practical seconds, not minutes
- real Hassaniya benchmark reviewed by human speakers
- clear handoff on uncertainty
