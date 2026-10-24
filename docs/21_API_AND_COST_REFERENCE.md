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
**Default: `gpt-5.6-terra`** — verified (Oct 2026) as a Chat Completions model that supports tool
calling, matching the agent's architecture. Set via `OPENAI_TEXT_MODEL`.

GPT-6 tiers remain available as overrides: `gpt-6-luna` (cheaper cost tier) and `gpt-6-sol` (stronger,
coding/agentic). Caveat: GPT-6 tool calling on **Chat Completions** is not confirmed (GPT-6 Astra /
6.1 Sol require the Responses API for tools); validate one live tool call before adopting. Confirm
current prices on the pricing page below — do not hard-code.

Pricing reference:
https://developers.openai.com/api/docs/pricing

### Voice-note transcription
- **`gpt-transcribe`** (current default): recommended file-transcription model; supports the `prompt`
  context field plus `keywords`/`languages` hints. Set via `OPENAI_TRANSCRIBE_MODEL`.
- `gpt-4o-mini-transcribe` / `gpt-4o-transcribe` / `whisper-1`: **deprecated, shut down 2027-02-26** — do not use for new work.

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
