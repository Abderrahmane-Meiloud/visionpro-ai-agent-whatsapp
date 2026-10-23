# VisionPro WhatsApp AI Agent

> **New chat/agent? Read [HANDOFF.md](HANDOFF.md) first** (server, Meta status, what is left). Specs are in [docs/](docs/00_README_START_HERE.md).

**VisionPro Technology** · Official Meta WhatsApp Cloud API only. Specs are in `docs/`. One Express service + PostgreSQL + a small admin page.

```bash
npm install
npm test                      # unit tests
DATABASE_URL=postgresql://... npm run smoke   # e2e: dedupe, pause, takeover (fake Meta)
```

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

## Known limitations (V1)
- Admin is a single Basic-auth login, not roles; the UI is one static page rather than Next.js.
- No product/price/stock tools yet (no client data): the agent hands off those questions.
- Template messages, images/documents, and Calling API (Phase 2) not implemented.
