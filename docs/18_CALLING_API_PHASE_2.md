# Phase 2 — Official WhatsApp Live Calling

## Goal
Answer user-initiated WhatsApp calls with a real-time AI voice using the same Agent Core, company tools, customer history, and policies as messaging.

## Important implementation rule
Do not invent Calling API endpoints or assume every WABA/region is eligible. At implementation time, verify the latest official Meta WhatsApp Calling API documentation, account eligibility, onboarding requirements, supported media transport, and any calling terms/pricing.

## Target architecture
```text
WhatsApp user starts call
  -> Meta WhatsApp Calling API / realtime media
  -> our realtime gateway
  -> RealtimeVoiceProvider
       default candidate: Gemini 3.8 Live
       fallback candidate: OpenAI gpt-realtime-2.1-mini
  -> same business tool layer
  -> same authority/handoff rules
  -> streaming audio response
```

## Latency goal
Conversation should feel live. There will always be network/model latency, but the implementation must stream audio and support interruption/barge-in rather than waiting for a full recorded message.

Tool calls (price/stock/order checks) may add latency to an individual turn; the agent should use short conversational fillers only if natural and permitted, never invent a result while waiting.

## Provider abstraction
Environment/config:
- `VOICE_PROVIDER=gemini`
- alternative `VOICE_PROVIDER=openai`

## Benchmark before choosing
Use 30-50 real Hassaniya scenarios and compare:
- dialect comprehension
- French/Hassaniya code-switching
- pronunciation
- naturalness
- interruption handling
- latency
- cost
- stability over long calls

## Voice behavior
- Hassaniya primary when caller speaks Hassaniya
- natural French when caller speaks French
- tolerate switching mid-sentence
- Arabic/English supported
- do not force one language

## Human transfer
Exact transfer capabilities depend on Meta's calling functionality/account setup. Implement only supported official mechanisms. If live transfer is unavailable, collect details and trigger an immediate human callback/WhatsApp handoff.
