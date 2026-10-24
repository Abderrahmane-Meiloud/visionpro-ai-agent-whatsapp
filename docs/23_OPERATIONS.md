# Operations: local config, backup/restore, troubleshooting

Companion to `docs/15_DEPLOYMENT_CONTABO.md` (production) and `docs/17_FAILURE_MODES.md`. No secrets here.

## 1. Local configuration (development, no Docker)
Minimal `.env` for local runs (copy `.env.example`, keep it out of git):
```
NODE_ENV=development
DATABASE_URL=postgresql://postgres@localhost:55432/smoke   # a DISPOSABLE local DB only
ADMIN_PASSWORD=dev-only-long-password
META_WEBHOOK_VERIFY_TOKEN=dev-verify
AGENT_MOCK=true          # no OpenAI key needed; canned replies
```
- `AGENT_MOCK=true` means no paid AI calls. Leave `OPENAI_API_KEY` blank locally.
- With no `META_APP_SECRET`, every webhook POST is rejected (401) — expected and safe locally.

### Run checks and tests
```
npm run typecheck        # tsc --noEmit
npm test                 # unit tests, no DB
# Integration/smoke needs a disposable local Postgres (never a prod/app DB):
initdb -D ./.pgtmp -U postgres -A trust
pg_ctl -D ./.pgtmp -o "-p 55432" -l ./.pgtmp.log start
createdb -p 55432 -U postgres smoke
DATABASE_URL=postgresql://postgres@localhost:55432/smoke npm run smoke
pg_ctl -D ./.pgtmp stop   # tear down
```
The smoke test refuses to run unless `DATABASE_URL` points at a **local** host and a database whose
name contains `smoke` or `test` (see `src/db-safety.ts`); this prevents it from ever truncating a
production or application database. `SMOKE_ALLOW_DESTRUCTIVE=1` overrides the guard (avoid).

## 1c. Database migrations (production procedure)
The schema (`src/schema.sql`) is additive and idempotent, but it is **not auto-applied at boot in
production** (`AUTO_MIGRATE` defaults to `false` when `NODE_ENV=production`) so a redeploy never locks a
populated database during startup. Apply migrations **deliberately**, before starting the new app version:

```bash
# build already produced dist/migrate.js + dist/schema.sql
DATABASE_URL=postgresql://… npm run migrate      # applies schema.sql once, then exits
# docker deploy equivalent (run once, before `up`):
docker compose run --rm api node dist/migrate.js
```
Then start the app normally (it boots with `AUTO_MIGRATE` unset → no schema work at startup).
If the app is started before migrating on a fresh DB it will fail loudly (missing `users` table) rather
than silently altering anything. For a **populated** production DB, review the pending DDL first and, for
large tables, create new indexes `CONCURRENTLY` out of band (the in-repo `CREATE INDEX` statements take a
brief lock). Dev/test keep `AUTO_MIGRATE=true` (schema applied at boot) — the local workflow is unchanged.

## 2. Backup and restore (production)
Production runs the `wa` compose stack (Postgres 16 in container `wa-db-1`, volume `wa_pgdata`).
Operate only on this stack (see `HANDOFF.md` §3).

**Backup (logical dump, nightly, to the host's `/opt/backups`):**
```
cd <app-dir>
docker compose exec -T db pg_dump -U agent -d agent --no-owner | gzip > /opt/backups/wa-$(date +%F).sql.gz
```
Keep at least 7 daily copies off the app disk. Backups contain customer messages — treat as sensitive;
restrict permissions and encrypt at rest if the host policy requires it.

**Restore (into a fresh/empty database — verify on a throwaway target first):**
```
gunzip -c /opt/backups/wa-YYYY-MM-DD.sql.gz | docker compose exec -T db psql -U agent -d agent
```
Test a restore end-to-end at least once so the procedure is known to work before it is ever needed.

## 3. Operational troubleshooting
Logs are structured JSON lines with an `event` field and an `x-request-id` per HTTP request; grep by
event. Credentials, message text and phone numbers are redacted (see `src/log.ts`).

| Symptom | Likely cause | Check / fix |
|---|---|---|
| Webhook returns 401 | Missing/incorrect `META_APP_SECRET`, or signature mismatch | Confirm the secret matches the Meta app; look for `webhook.bad_signature`. |
| Webhook returns 429 | One IP flooded bad signatures (abuse guard) | Expected for bad traffic; legitimate signed retries are never throttled. |
| Webhook returns 500 | Processing error (DB, etc.) | Meta will retry; the event is un-marked so the retry re-processes. Look for `webhook.process_error`. |
| No AI replies at all | Global pause, or Meta not configured | Admin shows `AI: PAUSED` / `Meta: not configured`; resume, or set `META_*`. |
| AI silent on one chat | Human took over, or outside 24h window | Conversation mode is `HUMAN`/`HUMAN_PENDING`; or last inbound > 24h (free-form blocked). |
| Voice notes not understood | STT failure (format/model/key) | Look for `stt.failed`. WhatsApp sends Ogg/Opus — verify the configured transcribe model accepts it (see owner decisions in the P1 report). Two failures auto-hand off. |
| Admin returns 429 | Too many failed logins from an IP | Wait for the window to expire; only failed attempts count. |
| Sends fail / conversation goes to a human | Meta send error (token/limits/network) | `conversation.process_failed` / handoff reason `send failed`; the inbound is marked FAILED, never lost. |
| Boot fails | Missing required env in production | `assertProdConfig` throws naming the missing var (`DATABASE_URL`, `META_WEBHOOK_VERIFY_TOKEN`, `ADMIN_PASSWORD`). |

After a restart, `recoverPending()` re-queues any message left mid-processing — no manual action needed.

## 4. Team management (P2-A)
Staff sign in to the dashboard with individual accounts (cookie sessions, `node:crypto` scrypt hashes).

- **Bootstrap:** on first boot (empty `users` table) a DB **admin** account is seeded from
  `ADMIN_USER`/`ADMIN_PASSWORD`. Sign in with it, then create per-person accounts. `ADMIN_*` also stays
  a Basic-auth bootstrap/recovery credential (e.g. for `curl`).
- **Roles / permissions:** `admin` (everything, incl. user management + settings), `agent`
  (handle conversations: take over, reply, notes, self-assign — only on conversations assigned to them
  or unassigned), `viewer` (read-only). The **bridge** is a Basic-auth `service` account: **read-only**,
  and cannot reach any mutating or human-only endpoint.
- **Managing users:** `GET/POST /api/users`, `PATCH /api/users/:id` (admin only). Create:
  `{username, password(>=8), role}`. Deactivate with `PATCH {active:false}` — this **immediately revokes
  all of that user's sessions**. Change role/password via `PATCH` (a password change also revokes sessions).
- **Sessions:** httpOnly + SameSite=Strict cookie (Secure in production); absolute expiry
  `SESSION_TTL_HOURS` (default 168h) and idle timeout `SESSION_IDLE_MINS` (default 720m, 0 disables).
  Expired/invalid sessions are purged on use and hourly. **Logout** (`POST /api/auth/logout`) revokes the session.
- **CSRF:** cookie-authenticated state-changing requests require the `X-CSRF-Token` header (value from
  `/api/me` or the login response). Basic-auth (service/bootstrap) calls are exempt.
- **Login throttling:** repeated failed logins from one IP are throttled (15 / 10 min → HTTP 429);
  correct credentials are never throttled. Login errors are generic ("invalid credentials").
- **Assignment & audit:** `POST /api/conversations/:id/assign` (`{self:true}`, or admin: `{user_id}` /
  `{unassign:true}`). Assignment, takeover, return-to-AI, logins, user changes are all in `audit_logs`.

Bridge compatibility is unchanged: `/api/conversations` and `/api/conversations/:id` keep their shapes
and pagination; the bridge authenticates with Basic exactly as before.

## 5. Inbox & knowledge (P2-B)

### Conversation inbox
- **Search & filters:** `GET /api/conversations?q=&status=&mode=&assignee=` — all optional and additive;
  omitting them returns exactly the list the bridge has always received (plus additive `status` /
  `assigned_user_id` fields). `q` matches customer name, WhatsApp number, or message content;
  `assignee` accepts a user id, `me` (My Conversations), or `unassigned`.
- **Status:** `OPEN` / `CLOSED` / `SNOOZED` via `POST /api/conversations/:id/status` (handler +
  ownership). This is an **inbox workflow state only — it does not gate the AI pipeline** (the AI is
  still governed solely by `mode` AI/HUMAN/PAUSED and the global pause). Closing sets `closed_at`;
  snoozing sets `snoozed_until`.
- **Internal notes:** `GET/POST /api/conversations/:id/notes`. Notes live in the separate
  `conversation_notes` table, so they are **never sent to WhatsApp and never enter the AI
  conversation history** (which reads only from `messages`). Writing a note requires handler +
  ownership; reading requires `view`.
- All status/assignment/note mutations are audited and enforce P2-A RBAC + ownership.

### Company knowledge & Hassaniya
- **Lifecycle:** articles are `draft` / `published` / `archived`. **Only `active` AND `published`**
  articles reach the AI prompt; drafts and archived articles never do. "Delete" archives (never hard-deletes).
- **Volatile-content lint:** on save, prices, percentages, stock, dates and promotions are flagged
  (`warnings` in the response, `volatile_flag` stored) so authors route changeable facts to a
  tool/human instead of stating them as fixed knowledge. `POST /api/knowledge/lint` previews warnings.
- **Bounded, safe retrieval:** the prompt caps Approved Knowledge at `PROMPT_KB_CHAR_BUDGET` chars
  (default 12000) and marks truncation. A final **Precedence** section states that knowledge and
  operator instructions are reference data that can never override the safety/truth/handoff rules —
  so injected text in knowledge cannot subvert them. The agent is instructed to hand off to a human
  when a fact is unknown, volatile, or needs current business data.
- **Vocabulary bulk import:** `POST /api/vocabulary/import` with `{format:'json'|'csv', data}` —
  validated in-process (bad rows reported, not inserted) and written in a single query.
- **Prompt preview:** `GET /api/knowledge/prompt-preview` (manage_knowledge) returns the exact system
  prompt — company knowledge/vocabulary/safety rules only. It contains **no credentials and no
  customer conversation content** (customer messages exist only in the per-turn history, never the
  system prompt).

## 6. Business tools, orders, templates, analytics (P2-C)

### Business tools (local provider)
- The agent has READ tools (`get_product`, `get_price`, `check_stock`) and `create_order_draft`, served
  by a **local Postgres provider** (`products` / `product_prices` / `inventory`). There is **no external
  integration** (no Marketing OS). Catalog is managed at `GET/POST/PUT /api/products` (reads = view,
  writes = manage_settings). Every AI tool call is recorded in `tool_executions`.
- The agent **never invents** prices/stock/order status — it must call a tool; a missing fact or tool
  error returns a safe error, and the agent is instructed to fall back to `request_human_handoff`.

### Order safety (staff-only, transactional)
- The AI may create **DRAFT orders only**; there is deliberately no confirm/cancel tool. Confirmation
  and cancellation are staff actions requiring the **`confirm_orders`** permission (admin by default)
  **plus** conversation ownership.
- `POST /api/orders/:id/confirm` runs in a transaction: it re-locks and **revalidates every item's
  current price and stock**, blocks on any price change or shortfall (order stays DRAFT, no stock
  moved), otherwise decrements stock and flips `DRAFT→CONFIRMED` under a `WHERE status='DRAFT'` guard
  that prevents duplicate/concurrent confirmation.
- `POST /api/orders/:id/cancel` cancels a DRAFT, or a CONFIRMED order (restocking it); double-cancel is
  rejected. Every order mutation is audited. The AI can never charge, refund, confirm or cancel.

### Approved templates & the 24h window
- Registry at `GET/POST /api/templates` (writes = manage_settings). Free-form replies remain restricted
  to the 24h customer-service window (`POST /api/conversations/:id/messages` → 409 outside it).
  **Outside the window, the only way to message is an approved template:**
  `POST /api/conversations/:id/template` (handler + ownership) validates language + variable count and
  sends via the existing Cloud API client. 1:1 only — there is no bulk/broadcast path.

### Operational analytics
- `GET /api/reporting?days=` (view) returns conversation volume/day, handoff count, failed-message and
  failed-STT counts, delivery-status summary, and average first-response time. All queries are
  date-bounded, grouped and parameterized. The **Analytics** dashboard view renders these.

### Conversation reopening
- A genuinely new inbound message reopens a `CLOSED`/`SNOOZED` conversation to `OPEN` (audited as
  `conversation.reopen`). It changes **only the inbox status** — it never alters `mode`, so HUMAN
  ownership, the global AI pause and handoff state are preserved (a reopened HUMAN conversation gets no
  AI reply). Duplicate webhooks are deduped before the reopen check, so they never reopen.
