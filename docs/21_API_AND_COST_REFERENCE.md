# API and Cost Reference — Verify Before Production

**Snapshot date: 26 September 2026. Prices/models can change.**

## Meta
### WhatsApp Business Platform / Cloud API
Needed for:
- receiving messages via webhooks
- sending messages
- retrieving media
- message delivery/status events
- WABA/phone-number management as needed

Official workspace:
https://www.postman.com/meta/whatsapp-business-platform/overview

Cloud API docs collection:
https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api

### WhatsApp Calling API
Phase 2 only. Verify current official Meta docs and account eligibility before implementation. Do not substitute unofficial call automation.

## OpenAI
### Text
Default candidate: GPT-6 Luna
Published standard short-context pricing snapshot:
- input: $0.05 / 1M tokens
- cached input: $0.005 / 1M tokens
- output: $0.25 / 1M tokens

Fallback candidate: GPT-6 Sol
- input: $1.00 / 1M
- output: $5.00 / 1M (short-context standard snapshot)

Pricing reference:
https://developers.openai.com/api/docs/pricing

### Voice-note transcription
- `gpt-4o-mini-transcribe`: estimated $0.003/min
- `gpt-transcribe`: estimated $0.0045/min; supports context/keyword/multiple-language hints per model docs

References:
https://developers.openai.com/api/docs/pricing
https://developers.openai.com/api/docs/models/gpt-transcribe

### Realtime voice candidate
- `gpt-realtime-2.1-mini`: lower-cost realtime model; token-based audio pricing
- GPT-Live sessions are also available as a separate voice-session product with published per-minute session pricing, but architecture/cost must be evaluated against direct Realtime usage.

## Google Gemini
### Realtime voice candidate
`gemini-3.8-live`
Published standard snapshot:
- audio input: $0.005/min
- audio output: $0.018/min

Pricing reference:
https://ai.google.dev/gemini-api/docs/pricing

## Cost guidance
For ordinary WhatsApp text support, model cost should be tiny compared with human labor. Optimize for correctness first, then cost.
For live voice, benchmark the total real cost including both audio directions, tool/model usage, Meta/calling charges, and infrastructure.
