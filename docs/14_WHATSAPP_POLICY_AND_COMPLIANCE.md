# WhatsApp Policy and Compliance

## Non-negotiable
This project must use official Meta WhatsApp Business Platform APIs only.

Never implement:
- Evolution API
- Baileys
- WhatsApp Web automation
- QR-session bots
- browser automation pretending to be a user
- undocumented/reverse-engineered endpoints

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
