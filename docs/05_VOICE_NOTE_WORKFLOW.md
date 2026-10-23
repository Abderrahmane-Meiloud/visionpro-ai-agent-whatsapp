# Voice Note Workflow

## Goal
A customer sends a WhatsApp voice note in Hassaniya, French, Arabic, English, or a mixture. The system transcribes it and sends the transcript into the same Agent Core used for text.

## Flow
1. Receive audio media ID from Meta webhook.
2. Request media metadata/temporary media URL using official Meta API.
3. Download audio server-side with Meta authorization.
4. Enforce size/type/duration limits.
5. Store only temporarily unless client retention policy explicitly requires audio retention.
6. Send audio to configured STT provider.
7. Supply language hints/context where provider supports them.
8. Persist transcript and STT metadata.
9. Delete temporary raw audio according to retention policy.
10. Send transcript into Agent Core.
11. Reply by text in V1.

## Default STT models
Start by benchmarking two OpenAI options on the same Hassaniya test set:
- `gpt-4o-mini-transcribe` — lower published estimated cost
- `gpt-transcribe` — higher accuracy positioning and supports context/keyword/language hints

Do not choose only by cost. Choose by word-error behavior on real Mauritanian audio, names, French code-switching, product names, and phone numbers.

## Hassaniya transcription context
Maintain client-editable entries:
- company name and variants
- staff names
- product names/SKUs
- pharmacy/customer names
- Nouakchott/Nouadhibou/local place names as relevant
- French terms commonly mixed into Hassaniya
- common Hassaniya words and alternate spellings
- example sentences showing context

Important: this is contextual guidance/keyword biasing where supported, not necessarily model fine-tuning.

## Failure behavior
If transcription is blank/low-confidence/nonsensical:
- do not invent content
- ask the customer to repeat or type the message
- after repeated failure, hand off to a human
