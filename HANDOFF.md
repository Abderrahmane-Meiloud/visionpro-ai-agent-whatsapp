# HANDOFF: VisionPro WhatsApp AI Agent

Product of **VisionPro Technology**. Read this first if you are a new engineer or agent continuing the project.
Contains NO secrets on purpose. Never put passwords, tokens, or API keys in this repo.

## 1. What this project is
**VisionPro WhatsApp AI Agent**: one AI agent on one WhatsApp Business number via the **official Meta WhatsApp Cloud API only** (no Baileys/Evolution/WhatsApp Web).
Handles text + voice notes in Hassaniya, French, Arabic, English. The reference deployment targets a medical-care company (support/info only:
NO medical advice, NO medicine order-taking). It is a build meant to be duplicated per client.
Full specs: `docs/00_README_START_HERE.md` ... `docs/22_*.md`.
Key rules: never invent prices/stock/etc, human takeover must silence the AI, no secrets in git.

## 2. Where things live
| Thing | Location |
|---|---|
| Source repository (private) | https://github.com/Abderrahmane-Meiloud/visionpro-ai-agent-whatsapp, branch `main` |
| Package | `visionpro-whatsapp-agent` |
| Deployment | Docker Compose on an Ubuntu host that already runs Traefik (see section 3); app directory and `.env` live on the host and are never committed |
| Public URL | `https://<DOMAIN>` (Let's Encrypt via the existing Traefik) |
| Webhook URL for Meta | `https://<DOMAIN>/webhooks/meta/whatsapp` (verify token = `META_WEBHOOK_VERIFY_TOKEN` in the host `.env`) |
| Admin panel | `https://<DOMAIN>/` (HTTP Basic auth: `ADMIN_USER` / `ADMIN_PASSWORD` from the host `.env`) |

Access to the host is by SSH key only; never share or commit credentials. Deploy by copying the repository contents (for example `git archive HEAD | ssh <user>@<host> tar -x` into the app directory), then `docker compose up -d --build`.

## 3. Host safety: read before touching the server
The host may already run other production apps. Do not stop, restart or modify anything that is not this stack.
- Reverse proxy is the EXISTING Traefik on ports 80/443: Docker network `proxy`, cert resolver `letsencrypt`, entrypoint `websecure`. Our compose joins it via labels. **Never start a second Traefik / never bind 80/443.**
- Our stack = compose project `wa` (two containers: `wa-api-1`, `wa-db-1`) with its OWN Postgres 16 + volume `wa_pgdata` on a private `internal` network. Do not use any other database on the host.
- The deploy user is in the `docker` group; passwordless sudo is NOT assumed. Avoid needing sudo.
- Operate only on our stack: `cd <app-dir> && docker compose ps|logs api|up -d --build|restart api`.

## 4. What has been built 
Express + TypeScript + PostgreSQL (`pg`, plain SQL migration in `src/schema.sql`, applied at boot).
- `src/modules/whatsapp/`: `webhook.ts` (GET verify; POST with raw-body HMAC-SHA256 `X-Hub-Signature-256` check, dedupe via unique event key + unique `whatsapp_message_id`, persists BEFORE 200, returns 500 so Meta retries on failure, status updates never move backwards), `client.ts` (sendText / markRead / downloadMedia, bounded exponential retry, `META_GRAPH_BASE` override for tests), `rules.ts` (signature, 24h-window, status-rank pure functions).
- `src/modules/conversations/index.ts`: ingest, 1.5s debounce to merge rapid messages, per-conversation single-flight, voice notes (download, STT, transcript), STT failure -> ask to repeat, 2nd failure -> handoff, race check before every send (discard if human took over / AI paused), 24h window check, crash recovery `recoverPending()` at boot.
- `src/modules/agent/`: OpenAI chat-completions call, system prompt built from DB knowledge + vocabulary + safety rules (medical scope, never invent, prompt-injection), ONE tool `request_human_handoff`, max tool calls, fallback model, reply sanitizer. `AGENT_MOCK=true` returns a canned `[mock] received: ...` so the pipe can be tested without an OpenAI key.
- `src/modules/transcription/`: OpenAI `/v1/audio/transcriptions` with vocabulary as `prompt`.
- `src/modules/handoff/`: takeover / return-to-AI / request handoff, all audited.
- `src/modules/admin/`: Basic-auth API + single static page `admin.html` (conversations, takeover, send as human, return to AI, **global PAUSE AI**, knowledge/vocabulary CRUD with archive + audit, stats, logs). `/api/health` is public.
- `audit_logs` is append-only (DB trigger blocks UPDATE/DELETE).
- Tests: `npm test` (unit) and `npm run smoke` (needs `DATABASE_URL`; real Postgres + fake Meta; verifies bad signature 401, duplicate webhook = 1 reply, HUMAN mode = silent, paused = silent, resume works). All passed.
- Deploy: `Dockerfile`, `docker-compose.yml` (api + db, joins external `proxy` network), `.env.example`.

Deliberate deviations from the spec (documented, cheap to upgrade): plain `pg` instead of TypeORM; admin is one static HTML page + single Basic-auth user instead of Next.js + roles; only the handoff tool exists (no price/stock/order tools: no client data yet, so the agent hands those off); knowledge is placed directly in the prompt (no vector DB).

## 5. Deployment state
- `GET /api/health` returns `{"ok":true}` when the stack is up (containers `wa-api-1`, `wa-db-1`).
- Reference `.env`: `DOMAIN=<DOMAIN>`, `AGENT_MOCK=true`, `OPENAI_API_KEY` EMPTY, `META_*` (except verify token) EMPTY, `COMPANY_NAME=<client display name>`.
- The app boots with a warning that Meta creds are missing; with no `META_APP_SECRET` every incoming webhook is rejected (401), so it is safe but not yet functional.
- Knowledge base / vocabulary tables start EMPTY. The agent knows nothing about the client until articles are added in the admin panel.

## 6. DNS
Create an `A` record for the chosen subdomain (for example `wa`) pointing at the host's public IP. Do not change any other existing records.

## 7. Meta status
- Developer pages (developers.facebook.com app console) may render as blank shells in automated browsers; Business Manager pages (business.facebook.com WhatsApp Manager) render text.
- Meta app: `<META_APP_ID>`; business portfolio `<BUSINESS_PORTFOLIO_ID>` (identifiers kept out of the repo).
- WABA: "Test WhatsApp Business Account", ID `<WABA_ID>`. Its only number is Meta's **sandbox test number +1 555-151-1501** ("Test Number", Unverified). It can only message up to 5 recipient numbers the owner adds. It was previously linked to a real number, which must NOT be connected. Owner has no spare real number yet and will not risk their own personal one as the business line. A real number is a LATER step.
- STILL NEEDED FROM META (the owner must supply; secrets should go straight into the server `.env`, not chat):
  1. `META_APP_SECRET` (App settings -> Basic -> Show, needs owner's password)
  2. `META_PHONE_NUMBER_ID` (WhatsApp -> API setup)
  3. `META_ACCESS_TOKEN` (temporary 24h token is fine for the test; production needs a permanent system-user token)
  4. `META_GRAPH_API_VERSION` (copy the current version shown in API setup; do not guess)
  5. Owner's own number added as a test recipient in API setup (this is safe: recipient only, not a business line)
- Then: register the webhook (callback `https://<DOMAIN>/webhooks/meta/whatsapp` + verify token from server .env) and subscribe the WABA to `messages`. Either in the Meta console (Configuration) or via Graph API (`POST /{app-id}/subscriptions` with app token, `POST /{waba-id}/subscribed_apps`). Verify endpoint names/version against current official Meta docs first (spec file 22).

## 8. Remaining TODO (in order)
1. Owner fills Meta values in server `.env` (section 7) -> `docker compose up -d api` -> register webhook + subscribe WABA.
2. Live test from owner's phone (recipient added): text, duplicate handling, voice note (needs OpenAI key), takeover, pause. Watch `docker compose logs -f api`.
3. Owner provides OpenAI key -> set `OPENAI_API_KEY`, `AGENT_MOCK=false`. Verify exact model IDs against OpenAI's current model list (`gpt-6-luna`, `gpt-4o-mini-transcribe` etc. come from the spec and were NOT verified; env-driven: `OPENAI_TEXT_MODEL`, `OPENAI_TRANSCRIBE_MODEL`). Benchmark STT on real Hassaniya audio.
4. Seed knowledge (company info, hours, FAQ, handoff rules) + Hassaniya vocabulary via admin panel or `docs/examples/*.json`.
5. Hardening before real customers: permanent token, backups of `wa_pgdata` (server has `/opt/backups`; test restore), log review for secrets, reboot/restart test, rate limiting on the webhook if needed, roles/users if staff need logins.
6. Before any real/business number: review WhatsApp Business Messaging Policy for the medical-care use case (spec file 14: do not enable AI order facilitation for restricted healthcare products), templates for business-initiated messages (NOT implemented; free-form is only sent inside the 24h window), messaging quality rating. No bulk/cold outreach ever.
7. Later/optional: Next.js admin, price/stock/order tools once client data exists, template messages, images/documents, Phase 2 Calling API (spec file 18; verify eligibility first).

## 9. Ban-safety already enforced in code
Official API only; signature-verified webhook; free-form replies only within 24h of the customer's last message (also enforced for human sends in admin); no proactive/bulk sending code exists; bounded retries with no duplicate customer-visible sends (dedupe); AI never replies in HUMAN/HUMAN_PENDING/PAUSED; unsupported media -> polite handoff.

## 10. Working notes
- Rotate any credential that was ever shared in chat or email. None are stored in this repository.
- Agents cannot enter passwords for authentication; ask the owner to log in or add keys themselves.
- Windows dev machine: use the built-in tools. Local Docker can run a throwaway `postgres:16-alpine` for the smoke test.
