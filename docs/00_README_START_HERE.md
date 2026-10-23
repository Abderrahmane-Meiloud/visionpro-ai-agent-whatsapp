# VisionPro AI Agent — Start Here

**Version:** 1.0 — 26 September 2026

## Objective
Build one production-quality AI agent for one WhatsApp Business number using only official Meta APIs. The first release handles WhatsApp text and voice notes. The code must be designed so official WhatsApp Calling API support can be added later without creating a second agent brain.

This is **not a SaaS build**. It is one client deployment with clean configuration and abstractions so the same repository can later be copied for another client.

## Core principles
1. Official Meta WhatsApp Business Platform / Cloud API only. Never use Evolution API, Baileys, WhatsApp Web automation, QR-session bots, browser emulation, or unofficial reverse-engineered libraries.
2. One agent core for text, voice notes, and later live calls.
3. Hassaniya + French are first-class languages. Arabic and English must also be supported. Code-switching is expected.
4. The model must never invent prices, stock, delivery status, balances, discounts, or completed actions.
5. Dynamic business facts come from tools/database, not prompts or stale files.
6. Human takeover is mandatory and must stop AI replies until explicitly returned to AI mode.
7. Secrets never enter Git. Authentication that requires the owner must pause for the owner to complete it.
8. Build in phases; test each phase before proceeding.

## Recommended technology choices
- Frontend/admin: Next.js + TypeScript
- Backend: Node.js + Express + TypeScript
- Database: PostgreSQL
- ORM: TypeORM (consistent with existing VisionPro AI Agent stack)
- Deployment: Docker Compose + Traefik + HTTPS on Contabo Ubuntu VPS
- WhatsApp messaging: Meta WhatsApp Cloud API + Webhooks
- Text AI default: OpenAI GPT-6 Luna (cheap default); optional GPT-6 Sol fallback for hard cases
- Voice-note STT default: OpenAI `gpt-4o-mini-transcribe` for lowest cost, benchmark against `gpt-transcribe` for Hassaniya accuracy
- Live-call voice default later: Gemini 3.8 Live; provider adapter must also support OpenAI `gpt-realtime-2.1-mini`
- File storage: local private volume initially; object storage optional later

## Build order
1. Repo + database + health checks
2. Meta webhook verification
3. Receive and persist WhatsApp text
4. Send WhatsApp text replies
5. AI text responses with strict tool policy
6. Voice-note media download + transcription
7. Knowledge/vocabulary/admin UI
8. Human takeover
9. Reliability, retries, idempotency, logging, security
10. Production test on one real WhatsApp number
11. Phase 2: official WhatsApp live calling after messaging is stable

Read all numbered files before coding.
