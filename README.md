# VisionPro WhatsApp AI Agent

> **New chat/agent? Read [HANDOFF.md](HANDOFF.md) first** (server, Meta status, what is left). Specs are in [docs/](docs/00_README_START_HERE.md).

**VisionPro Technology** · Official Meta WhatsApp Cloud API only. Specs are in `docs/`. One Express service + PostgreSQL + a small admin page.

```bash
npm install
npm run typecheck             # tsc --noEmit
npm test                      # unit tests (no DB needed)
DATABASE_URL=postgresql://... npm run smoke   # e2e (fake Meta, AGENT_MOCK): dedupe, status order,
                                              # pause/takeover, 24h window, 404, crash recovery
```

### Local integration DB (no Docker)
The smoke test needs a throwaway Postgres — never point it at a production or app database. With a
local PostgreSQL install you can spin up a disposable cluster on a spare port, e.g.:
```bash
initdb -D ./.pgtmp -U postgres -A trust            # once
pg_ctl -D ./.pgtmp -o "-p 55432" -l ./.pgtmp.log start
createdb -p 55432 -U postgres smoke
DATABASE_URL=postgresql://postgres@localhost:55432/smoke npm run smoke
pg_ctl -D ./.pgtmp stop                            # tear down when done
```
CI (`.github/workflows/ci.yml`) runs `typecheck` + `test` on every push/PR, and the smoke test
against the runner's pre-installed Postgres (no Docker).

## Deploy (Ubuntu + Docker)
```bash
cp .env.example .env   # fill in, never commit
docker compose up -d --build
```
Webhook URL for Meta: `https://$DOMAIN/webhooks/meta/whatsapp`, verify token = `META_WEBHOOK_VERIFY_TOKEN`.
Admin: `https://$DOMAIN/` (Basic auth: `ADMIN_USER` / `ADMIN_PASSWORD`).

## Sending rules built in
- Replies only inside the 24h customer-service window (free-form). Outside it, only approved templates are allowed (not implemented in V1).
- No proactive/bulk messaging. Duplicate webhooks are ignored; AI never replies in HUMAN/PAUSED mode.

## Evolution API pilot (experimental, non-production)
An isolated, owner-authorized pilot transport exists alongside the Meta integration above, for
internal experimentation only. See [docs/26_EVOLUTION_PILOT.md](docs/26_EVOLUTION_PILOT.md).

## Known limitations (V1)
- Admin is a single Basic-auth login, not roles; the UI is one static page rather than Next.js.
- No product/price/stock tools yet (no client data): the agent hands off those questions.
- Template messages, images/documents, and Calling API (Phase 2) not implemented.
