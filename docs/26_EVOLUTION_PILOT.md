# Evolution API Pilot — Experimental, Owner-Authorized, Non-Production

## What this is, in one sentence
An isolated, zero-cost transport that lets the SAME agent core, catalog tools and safety rules
documented elsewhere in this repo receive and answer WhatsApp messages through the existing
Evolution API instance named `vision`, for internal experimentation only — never for the
medical-care production client, never for a production number, and never for an existing
customer conversation.

## Why this exists despite docs/00, docs/14 and docs/20 saying "never use Evolution API"
Those documents are correct and remain in force for the production, client-facing channel: Meta's
official Cloud API is the only sanctioned transport there, for real ban/ToS/compliance reasons
(Evolution API is a Baileys-based unofficial gateway that impersonates WhatsApp Web). This pilot is
a deliberate, narrow, owner-requested exception for internal testing, not a reversal of that
policy. It was built this way specifically so the exception cannot silently widen:

- **Separate DB channel tag.** Every pilot conversation is stamped `channel='whatsapp_evolution_pilot'`
  (`src/modules/whatsapp-evolution/rules.ts`'s `EVOLUTION_PILOT_CHANNEL`). The Meta path's
  `channel='whatsapp'` default is untouched.
- **Separate customer-id namespace.** Pilot customers are keyed `evo:<digits>` (`toEvolutionWaId`),
  never the bare phone number Meta uses. The same real phone number talking to both transports gets
  two completely separate customer/conversation rows — a pilot conversation can never be mistaken
  for, or merged with, a real Meta-channel customer.
- **Separate network listener.** The pilot webhook is mounted on its own Express app bound to
  `EVOLUTION_WEBHOOK_PORT` (default 3100) — see `src/index.ts`. It serves nothing else: no admin
  routes, no Meta webhook. This is the ONLY port a tunnel should ever point at.
- **Hard production refusal.** `assertProdConfig()` (`src/config.ts`) throws at boot if
  `EVOLUTION_API_BASE_URL` or `EVOLUTION_PILOT_AUTO_REPLY_ENABLED` is set while `NODE_ENV=production`.
  This pilot cannot run in production even by accident.
- **Auto-reply stays off by default, and is allowlist-gated even when on.** Inbound messages are
  received/deduped/persisted the moment `EVOLUTION_API_BASE_URL` is set — so the receiver itself can
  be verified — but no automatic reply is EVER sent unless `EVOLUTION_PILOT_AUTO_REPLY_ENABLED=true`
  AND the sender's number is explicitly listed in `EVOLUTION_PILOT_ALLOWED_TEST_NUMBERS`
  (`isPilotAutoReplyAllowed`). A stranger who happens to message the connected pilot number is never
  auto-answered.

## What is reused, unchanged
- The agent core (`src/modules/agent/index.ts`): same system prompt, same truth/handoff/safety
  rules, same tool-calling loop, same daily reply cap.
- The catalog/business tools (`src/modules/tools/registry.ts`, `provider.ts` / `provider.visionpro.ts`):
  same `get_product`/`get_price`/`check_stock`/`create_order_draft` tools, same "never invent
  stock/price" guarantees, same DRAFT-only order creation (no AI confirm/cancel).
  `BUSINESS_PROVIDER=visionpro` still routes catalog reads to Marketing OS exactly as it does for
  the Meta channel.
- Human takeover, global pause, and the daily AI-reply spend cap (`cfg.replyDailyCallCap`) — all
  apply to pilot conversations exactly as they do to Meta ones, with the pilot's own allowlist gate
  layered on top (strictest-wins).
- Dedup/idempotency pattern: `webhook_events` (provider='evolution') + the unique
  `messages.whatsapp_message_id` constraint, same two-layer protection the Meta webhook already
  relies on.

## What is new, isolated to this pilot
| File | Role |
|---|---|
| `src/modules/whatsapp-evolution/rules.ts` | Pure, unit-tested rules: text extraction, group/broadcast/stale-history filtering, wa_id namespace, auto-reply gate, constant-time secret compare |
| `src/modules/whatsapp-evolution/client.ts` | Outbound `sendEvolutionText` via Evolution's `POST /message/sendText/{instance}` |
| `src/modules/whatsapp-evolution/webhook.ts` | The isolated receiver router (mounted on its own listener in `src/index.ts`) |
| `scripts/check_evolution_instance.ts` | Read-only: confirms the base URL/key work and reports the connected number — run this first |
| `scripts/configure_evolution_webhook.ts` | Mutating, `--confirm`-gated: sets the webhook on the `vision` instance only. Never run automatically. |
| `scripts/smoke_evolution_pilot.ts` | Non-destructive integration test (fake Evolution server, real DB, `AGENT_MOCK=true`) |

## Required env (`.env` — see `.env.example` for the full block)
```
EVOLUTION_API_BASE_URL=            # the API's own base URL, NOT the Manager UI — verify with check:evolution
EVOLUTION_INSTANCE_NAME=vision
EVOLUTION_API_KEY=
EVOLUTION_WEBHOOK_PORT=3100
EVOLUTION_WEBHOOK_PATH_SECRET=     # long random value; full URL = <tunnel>/webhooks/evolution/pilot/<this>
EVOLUTION_WEBHOOK_AUTH_HEADER=     # optional extra header check
EVOLUTION_PILOT_AUTO_REPLY_ENABLED=false
EVOLUTION_PILOT_ALLOWED_TEST_NUMBERS=
EVOLUTION_REAL_OUTBOUND_ENABLED=false  # fail-closed gate on ALL real sends (manual/AI/retry) — see step 9
```

## Step-by-step: from zero to one verified live test message

1. **Verify the instance, not just the key.** `npm run check:evolution` — confirms the base URL +
   API key work and prints the connected phone number. **Owner action: confirm that number is an
   explicitly authorized test number — never a production/client-facing number.** Do not proceed
   until this is confirmed in writing/verbally by the owner.
2. **Set the real-inbound allowlist — fail-closed, mandatory.** `EVOLUTION_REAL_INBOUND_ALLOWLIST`
   must contain EXACTLY that one authorized test number (digits only) before continuing. Left
   empty, the real webhook route rejects every single inbound message before it is ever persisted,
   dedupe-recorded, or logged — by design (see `src/modules/whatsapp-evolution/rules.ts`'s
   `isRealInboundSenderAllowed`). This is independent of `EVOLUTION_PILOT_ALLOWED_TEST_NUMBERS`
   below, which only gates the automatic-reply step on an already-persisted message.
3. **Start the app.** `npm run dev` (or `npm start` against a build) now passes Node's native
   `--env-file=.env` flag — this app has no dotenv dependency and never auto-loads `.env` on its
   own, so a plain `node src/index.ts` or `node dist/index.js` run outside these npm scripts will
   silently boot with an EMPTY Evolution config (feature disabled, not an error). Always launch via
   `npm run dev`/`npm start`/`npm run smoke:evolution` etc., never by invoking `node`/`tsx` directly
   unless you export the env yourself first. With `EVOLUTION_PILOT_SIMULATION_MODE=false`
   and the real `EVOLUTION_API_BASE_URL`/`EVOLUTION_API_KEY` (never the simulation loopback/dummy
   key from the simulator runbook above). Two listeners come up: the main app on `PORT` and the
   isolated pilot receiver on `EVOLUTION_WEBHOOK_PORT` (3100). Confirm
   `http://localhost:3100/webhooks/evolution/pilot/health` returns `{"ok":true,...}` and that
   `http://localhost:3100/api/conversations` is 404 (proves the pilot listener exposes nothing else).
4. **Open the tunnel.** `cloudflared tunnel --url http://localhost:3100` (Quick Tunnel — free, no
   account, no DNS setup; prints a random `https://<random>.trycloudflare.com` URL). This is the
   ONLY port exposed. Confirm `https://<tunnel>/webhooks/evolution/pilot/health` is reachable from
   the public internet.
5. **Show the owner the exact proposed webhook configuration before applying it.**
   `PUBLIC_WEBHOOK_URL="https://<tunnel>/webhooks/evolution/pilot/$EVOLUTION_WEBHOOK_PATH_SECRET" npx tsx scripts/configure_evolution_webhook.ts`
   with NO `--confirm` is a dry run — it prints the exact payload (`enabled:true`, the tunnel URL,
   `webhookByEvents:false`, `webhookBase64:false`, `events:['MESSAGES_UPSERT','CONNECTION_UPDATE']`)
   and sends nothing. **Get the owner's explicit, final approval on this exact printed payload**
   before the next step — this is the live-activation approval boundary; nothing before this point
   touches the real instance's configuration at all.
6. **Apply it, only after that approval.** Re-run the same command with `--confirm`. This instance's
   webhook is now live; `EVOLUTION_PILOT_AUTO_REPLY_ENABLED` is still `false`, so nothing can be
   auto-replied yet regardless.
7. **Send one real message from the authorized test number only.** Confirm in the app logs that
   `evolution_webhook.sender_not_allowlisted` is NOT logged for it (if it is, the allowlist digits
   in step 2 don't match — fix before resending) and that a conversation was created under
   `channel=whatsapp_evolution_pilot`, message persisted and marked `SKIPPED_PILOT_GATE` — proving
   the receiver, auth, dedup, and catalog wiring all work with zero risk of an unreviewed auto-reply.
8. **Verify it appears in the Marketing OS dashboard too**, not just this repo's own admin page:
   open `http://localhost:3000/ar/agent-ai` → Conversations tab → filter to "تجربة Evolution" →
   confirm the same conversation, message, and (if any) linked order are visible there, through the
   live Marketing OS→WhatsApp-Agent proxy — see
   `services/api/app/api/agent.py` in the Marketing OS repo. Requires
   `WHATSAPP_AGENT_BASE_URL` in that repo's `.env` to point at this app's real `PORT`.
9. **Enable REAL outbound, narrowly, before touching auto-reply.** `EVOLUTION_REAL_OUTBOUND_ENABLED`
   (default `false`) is a second, independent gate from `EVOLUTION_PILOT_AUTO_REPLY_ENABLED` —
   enforced centrally inside `sendEvolutionText()` (`src/modules/whatsapp-evolution/client.ts`), the
   one function manual replies, AI auto-replies, and retries all converge on. A loopback
   `EVOLUTION_API_BASE_URL` (the local simulator) is never affected by this flag either way. With it
   `false` (the safe default), every real-send attempt — including a human clicking "Send" in the
   dashboard on a live (non-simulation) pilot conversation — is rejected before any real HTTP call,
   and the dashboard shows "Real WhatsApp sending disabled" with the composer disabled instead of
   failing silently. Only set this `true` once you're ready to actually test a real outbound send.
10. **Enable auto-reply, narrowly.** Set `EVOLUTION_PILOT_AUTO_REPLY_ENABLED=true` and
    `EVOLUTION_PILOT_ALLOWED_TEST_NUMBERS=<that same test number, digits only>`, restart, send another
    message from that number, and confirm exactly one reply arrives.
11. **Tear down / rollback — use the real `--disable` mode, not a guess.** An earlier draft of this
    runbook suggested "just omit `PUBLIC_WEBHOOK_URL`" as a way to disable the webhook — that is
    wrong and was caught before any live use: without `--disable`, a missing `PUBLIC_WEBHOOK_URL`
    makes the script refuse to run at all (it sends nothing, leaving the live webhook exactly as it
    was — a no-op, not a rollback). The real rollback is its own mode:
    `npx tsx scripts/configure_evolution_webhook.ts --disable` (dry run, prints `{"webhook":{"enabled":false}}`,
    no tunnel URL needed, and never touches `EVOLUTION_WEBHOOK_PATH_SECRET` or any other setting)
    then `--disable --confirm`. This only disables the webhook itself — it is a *remote* rollback and
    depends on Evolution's API being reachable.
    **Emergency shutdown (local, zero network dependency, fastest of all):** set
    `EVOLUTION_REAL_OUTBOUND_ENABLED=false` (stops every outbound send immediately on restart,
    regardless of webhook/tunnel state) and/or empty `EVOLUTION_REAL_INBOUND_ALLOWLIST` (rejects
    every inbound message before persistence immediately on restart) — both take effect on the next
    process restart with no API call to Evolution at all, so they work even if Evolution's own API is
    unreachable or the `--disable` call above fails. Stopping `cloudflared` is a good additional step
    (Evolution can no longer reach the receiver at all) but is not itself a substitute for actually
    disabling the webhook on Evolution's side.

## Marketing OS "Agent AI" dashboard integration (2026-11-07)
`services/api/app/api/agent.py` (Marketing OS repo) is a thin, permission-gated (`agent:manage`)
server-side proxy to this repo's own admin API — no second copy of conversation data, no new
storage. Fixed a real, previously-undiscovered defect: `WHATSAPP_AGENT_BASE_URL` was pointed at
Marketing OS's own frontend port (3000), so this agent was never actually reachable — the "Agent
AI unavailable" UI state was real, but its cause was a port misconfiguration, not an actual outage.
Also fixed a second, previously-latent defect this surfaced: the bridge Basic-auth credential this
proxy authenticates with was `view`-only on this repo's own RBAC (`src/modules/auth/rbac.ts`),
so every mutating proxy call (pause/resume, takeover, reply, knowledge/vocabulary writes) silently
failed as a generic "unreachable" — now scoped to exactly what that one proxy needs
(`handle_conversations`, `manage_settings`, `manage_knowledge`; still never `manage_users` or
`confirm_orders`). See that file's and `rbac.ts`'s own docstrings for the full rationale.

## Status update (2026-11-06): the connected number is the owner's personal WhatsApp — simulation mode only
A read-only identity audit (`npm run check:evolution` plus direct `fetchInstances`/`connectionState`
calls) confirmed the `vision` instance's `instanceId` matches the Evolution Manager's own ID, and
that no other instance (`masna3-control`, a name previously associated with this same number) exists
on that server right now. The owner then confirmed: **the number connected to `vision` is their
personal daily-use WhatsApp number.** The live webhook has never been configured, no live message
has ever been sent, and auto-reply has never been enabled against the real instance. Until a
disposable test number (or the official Meta Cloud API, already built in this repo) is confirmed,
treat `EVOLUTION_API_BASE_URL` pointed at the real `https://...` host as **off-limits** — develop
and demo exclusively through `EVOLUTION_PILOT_SIMULATION_MODE=true` below.

### Simulation mode (`EVOLUTION_PILOT_SIMULATION_MODE=true`)
Mounts two extra routes on the same isolated listener (`src/modules/whatsapp-evolution/simulate.ts`):
- `POST /message/sendText/:instance` — a fake sink standing in for the real Evolution API. Point
  `EVOLUTION_API_BASE_URL` at this same process (e.g. `http://localhost:3100`) so outbound sends
  physically cannot reach a real WhatsApp account, even if auto-reply were misconfigured.
- `GET|POST /webhooks/evolution/pilot/simulate/:secret[/message]` — a one-page browser UI (and its
  API) that drives a synthetic inbound message through the *exact* same `ingest()` codepath the
  real webhook uses, under a fixed, digit-only simulation JID (`00000000000@s.whatsapp.net`), so a
  full conversation (debounce, agent turn, mock reply, send) can be exercised with zero external
  dependency. Add that fixed number to `EVOLUTION_PILOT_ALLOWED_TEST_NUMBERS` to also exercise the
  auto-reply gate for real.

Recommended simulation-run overrides (on top of the real `.env`): `EVOLUTION_API_BASE_URL=http://localhost:3100`,
a dummy `EVOLUTION_API_KEY` (the real key is never needed/loaded for simulation), and a disposable
local Postgres instead of whatever `DATABASE_URL` normally points at.

### Catalog/order verification without a paid LLM
`AGENT_MOCK=true` returns a canned reply *before* any tool-calling happens — it cannot exercise
`get_product`/`get_price`/`check_stock`/`create_order_draft`. `scripts/smoke_evolution_catalog_and_orders.ts`
proves that plumbing deterministically instead, by calling the tool-dispatch functions directly
against the real Marketing OS catalog (no LLM, no AI conversation — clearly separate from the
simulator above). It requires the WhatsApp-bridge service account to hold `products:read`, fixed on
the Marketing OS side via `services/api/scripts/ensure_whatsapp_bridge_account.py` (that role is
otherwise `inbox:ingest`-only and scoped to exactly one non-customer workspace — see that script's
docstring), and at least one active test product (e.g. `SIM-TEST-RUG-001`, created via
`POST /api/v1/products` with a super-admin token, clearly labeled `[SIMULATION]` in its name).

## Known limitations (documented, not silently papered over)
- Text-only. Audio/image/document messages on the pilot channel fall through to the existing
  "unsupported type -> human handoff" path, same visible behavior as an unsupported Meta message
  type, but no transcription/voice support has been wired up for Evolution.
- The `POST /message/sendText/{instance}` wire shape in `client.ts` was written from Evolution API
  v2's documented contract, not confirmed against a real outbound send — no live send has been
  authorized yet as of writing this. Verify it against the live instance's own docs before the
  first real send, and expect to adjust the response-shape parsing if it differs.
- Custom webhook `headers` support (`EVOLUTION_WEBHOOK_AUTH_HEADER`) is likewise unconfirmed for
  this specific instance/version — the random path secret is the guaranteed authentication
  mechanism regardless of whether the header is honored.
- History-sync filtering is a timestamp-staleness heuristic (ignore anything reported more than 2
  minutes old), not a structural "this is history" flag — Evolution's webhook payload does not
  cleanly distinguish the two.
- Cloudflare Quick Tunnel URLs are random and ephemeral (change every run) — fine for a pilot,
  not a stable production webhook URL. Its own logs include the full destination URL (including
  our webhook path secret) on any request-failure line — pipe its stdout through a redacting
  `sed` filter before it reaches disk (see the launch command below) rather than logging it raw.
- `tsx --watch` auto-restarts on every source/`.env` change, which closes the port for roughly a
  second each time. If that coincides with an inbound webhook delivery, cloudflared logs "origin
  connection refused" and the delivery is lost with no retry guarantee from Evolution's side
  (unverified whether Evolution retries at all). Run the pilot receiver via the built, non-watch
  path (`npm run build` — on Windows via a POSIX shell, since the build script's `cp`/`mkdir -p`
  are not understood by `cmd.exe` — then `node --env-file=.env dist/index.js`) for any real test
  window, and only use `--watch` while actively iterating on code with no live test pending.
- WhatsApp is migrating contacts to privacy-preserving "LID" JIDs (`<opaque-id>@lid`); the opaque
  id is NOT the phone number. `rules.ts#resolvePhoneBearingJid` resolves it via `key.remoteJidAlt`
  / `participantAlt` / `senderPn` (whichever the connected Evolution/Baileys version populates)
  BEFORE the allowlist check, and fails closed (rejects, never guesses) when none is present. This
  was fixed defensively from evolution-api's own GitHub history (PRs #1955/#2450/#2673), not from
  a real `@lid` payload seen on this instance — confirm against a real payload if one ever arrives
  as `@lid`, since the field name is not fully standardized across versions.
- Per-delivery trace logging (`evolution_webhook.trace`, stages: `arrival`, `auth`, `event_parsing`,
  `stale_filter`, `allowlist`, `persistence`) lets a real delivery's exact failing stage be read
  back from logs alone. It never logs a message body, phone number, JID, path secret, or auth
  header — only stage + reason code + a random per-request correlation id.
- **Operational risk observed 2026-11-07, not caused by this codebase**: the configured Supabase
  pooler (`DATABASE_URL`) can start rejecting ALL new connections with
  `(ENOTFOUND) tenant/user <ref> not found` while the app's already-open pool connections keep
  working — so an already-running process can look healthy for hours after new connections (and
  thus any fresh boot, including a crash/restart) would already fail. `ensureBootstrapAdmin()`
  runs unconditionally at startup, so this blocks boot entirely, not just one query. Confirmed via
  a fresh `pg.Client` against both the session (5432) and transaction (6543) pooler ports with the
  exact same `.env` value that had worked minutes earlier — not a typo, not a code bug. Matches a
  known class of Supabase community reports (pooler tenant-routing lag/staleness on free-tier
  projects). No client-side fix exists; check the Supabase project dashboard (resume if paused) or
  open a support ticket if `node --env-file=.env -e "require('pg').Client" .connect()` keeps
  failing the same way after a few minutes.
