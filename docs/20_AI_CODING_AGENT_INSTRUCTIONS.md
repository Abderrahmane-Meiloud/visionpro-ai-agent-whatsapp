# Instructions for Claude Code / Codex / Coding Agent

## Mission
Implement this project exactly as specified. Do not broaden scope into a SaaS, CRM, or unrelated product.

## Before coding
1. Read every numbered Markdown file.
2. Produce `IMPLEMENTATION_PLAN.md` with phases, files/modules, migrations, external setup, and test plan.
3. Identify credentials/owner actions required.
4. Stop for owner authentication/approval when Meta login, 2FA, business verification, phone verification, or consent is required. Never request that credentials be pasted into source files.
5. Confirm current official API documentation before using versioned Meta endpoints or Phase 2 calling endpoints.

## External access rule
When browser/computer access is available, you may navigate Meta Developer/Business setup, OpenAI, and Google AI pages as instructed. The owner completes passwords/2FA/consent. Store resulting API credentials only in secure environment configuration.

## Implementation loop
For every phase:
1. Plan
2. Implement
3. Unit/integration test
4. Manually verify critical flow
5. Fix failures
6. Update documentation/status
7. Continue only when phase passes

## Never
- use Evolution API
- use Baileys
- automate WhatsApp Web
- generate QR-session WhatsApp bots
- commit `.env`
- log bearer tokens/secrets
- invent Meta API endpoints
- fake successful tool/business actions
- allow AI replies after human takeover
- hard-code mutable prices/stock in prompt

## Required code organization
```text
src/
  modules/
    whatsapp/
    agent/
    transcription/
    voice/          # interface + placeholders now; implementation Phase 2
    knowledge/
    conversations/
    customers/
    handoff/
    tools/
    audit/
    admin/
```

## Required provider adapters
- Meta WhatsApp provider
- OpenAI text provider
- OpenAI transcription provider
- Realtime voice interface
- Gemini live adapter placeholder/documentation
- OpenAI realtime adapter placeholder/documentation

## Model config must be environment-driven
Do not assume a model name forever. Defaults as of 26 Sep 2026:
- text: `gpt-6-luna`
- optional text fallback: `gpt-6-sol`
- STT: benchmark `gpt-4o-mini-transcribe` vs `gpt-transcribe`
- future live voice: `gemini-3.8-live` vs `gpt-realtime-2.1-mini`

If an exact model ID differs in the provider API, verify the current official ID rather than guessing.

## Deliverables
- working source
- migrations
- Docker Compose
- Traefik labels/config example
- `.env.example`
- setup README
- Meta onboarding checklist
- test suite
- seed/demo company data
- operator/admin UI
- deployment instructions
- known limitations
- final acceptance checklist
