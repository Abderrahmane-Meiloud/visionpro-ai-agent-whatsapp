# WhatsApp Policy and Compliance

## Non-negotiable
This project must use official Meta WhatsApp Business Platform APIs only — for the production,
client-facing channel. This applies to any real/medical-client account, any production number,
and any existing customer conversation, without exception.

Never implement, for that production channel:
- Evolution API
- Baileys
- WhatsApp Web automation
- QR-session bots
- browser automation pretending to be a user
- undocumented/reverse-engineered endpoints

### Scoped exception: Evolution API pilot (non-production only)
A narrow, owner-authorized, explicitly non-production pilot transport using Evolution API exists
for internal experimentation only — see `docs/26_EVOLUTION_PILOT.md`. It never touches a
medical-client account, a production number, or an existing customer conversation; it is hard-
refused at boot if `NODE_ENV=production`; and automatic replies stay off until the owner enables
them for an explicitly authorized test number. This exception does not relax anything above for
the real client-facing channel, and must not be used as precedent to use Evolution API, Baileys,
or any reverse-engineered WhatsApp library anywhere else in this project.

## Messaging policy
Before production, review the current:
- WhatsApp Business Messaging Policy
- WhatsApp Business Terms / Business Solution Terms
- Commerce Policy if selling products/services
- Template/customer-service-window rules

Policies change. Do not freeze a 2026 policy statement into code as permanent truth.

## Healthcare/medicine warning
If deploying for a medicine wholesaler/pharmacy/healthcare business, verify the exact permitted WhatsApp use case. Do not enable AI-based sale/order facilitation for restricted healthcare products unless current Meta policy clearly permits it for that business/use case. Safer initial scope: support, delivery status, invoices/account queries where allowed, general company info, and human handoff.

## AI/data rule
Do not use one client's WhatsApp conversations to train a general shared model for other clients. Keep client data isolated. Use model APIs as processors under the relevant provider terms and client instructions.

## Consent and disclosure
Where required by applicable law/policy, disclose automated handling, recording/transcription, and data use. Live-call recording/transcription rules must be reviewed before enabling Phase 2.
