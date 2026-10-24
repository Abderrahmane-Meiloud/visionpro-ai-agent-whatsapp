# Release Readiness — Controlled Pilot

Status of the VisionPro WhatsApp AI Agent for a **controlled, owner-supervised pilot** on the Meta
sandbox/test number. Scope is frozen (P0–P2-C); this document tracks the gates between "locally green"
and "safe to take limited real traffic".

## What is DONE (local, verified)
- Full feature scope P0 → P2-C implemented; architecture preserved (Express + `pg` + boot/`migrate`-applied SQL).
- Local checks green: TypeScript, unit, smoke (fake Meta + mock AI + disposable Postgres), Playwright browser, `npm audit` = 0.
- Security: individual staff accounts (scrypt), server-side sessions + CSRF, RBAC + conversation ownership,
  read-only bridge service account, append-only audit, redacting logs, no secrets in the repo.
- Order safety: AI creates DRAFTs only; staff-only transactional confirm/cancel with price+stock revalidation
  and duplicate/concurrent protection.
- Messaging policy: free-form limited to the 24h window; approved templates are the only outside-window path; no bulk.
- Release-prep hardening: Playwright wired into CI; non-zero AI daily cap enforced when `AGENT_MOCK=false`;
  production refuses `ALLOW_TEST_FAULTS`; production does not auto-migrate (explicit `npm run migrate`).

## Readiness gates (must be GREEN before the pilot)
| Gate | How to verify | Owner/Agent |
|---|---|---|
| G1 CI green incl. Playwright | push a branch; `check` + `smoke` + `browser` jobs pass on GitHub | owner (push) |
| G2 Live sandbox validation | complete `docs/24_LIVE_VALIDATION.md` A–F on the test number | owner |
| G3 Spend cap set | `REPLY_DAILY_CALL_CAP` set to a conservative value; `AGENT_MOCK=false` only after G2 | owner |
| G4 Migrations applied deliberately | `npm run migrate` run against the server DB (see `docs/23` §1c); app boots with `AUTO_MIGRATE` unset | owner |
| G5 Secrets/token | permanent Meta system-user token + real `ADMIN_PASSWORD` (≥16) in server `.env`; nothing in git | owner |
| G6 Bridge compatibility | confirm the VisionPro bridge tolerates additive list fields (`status`, `assigned_user_id`); auth + pagination unchanged (smoke-verified) | owner + bridge team |
| G7 Backups | `wa_pgdata` backup + a tested restore (see `docs/23` §2) | owner |
| G8 Voice decision | record the OGG/Opus transcription outcome from `docs/24` C; disable voice if unsupported | owner |

## Remaining owner actions (not code)
1. Provide Meta creds + register webhook + subscribe the WABA (`docs/24` A; HANDOFF §7–8).
2. Provide the OpenAI key; set the spend cap; flip `AGENT_MOCK=false` after sandbox validation.
3. Run `npm run migrate` on the server; keep `AUTO_MIGRATE` unset in production.
4. Push to run CI (incl. the Playwright job) and confirm green.
5. Review the WhatsApp Business Messaging Policy for the client's use case before real traffic (spec file 14).

## GO / NO-GO
- **GO** for a controlled pilot on the test number **once G1–G8 are green.**
- **NO-GO** for real customer traffic until G2 (live sandbox validation, especially voice + tool-calling) passes.
- No code BLOCKER remains; the outstanding gates are operational/owner steps plus live-path verification that
  cannot be done without real credentials.
