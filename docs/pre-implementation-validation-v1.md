# Pre-Implementation Validation v1 — TA-Q-29 and TA-Q-04

| Field | Value |
|---|---|
| Document | Pre-Implementation Validation v1 |
| Phase | 0E.2 — Pre-implementation technical validation · 0E.2b — Managed runtime validation |
| Version | 1.0 |
| Date | 2026-10-03 (0E.2) · 2026-10-04 (0E.2b) |
| Status | **Accepted** (Phase 0E.3, 2026-10-04). The Phase 0E.2 and 0E.2b reviews are completed. Its results are recorded in `docs/technical-architecture-v1.md` **v1.1** (§11.6, §11.7, §18.3, §19.3, §71, §72, §73). When this document was produced (0E.2/0E.2b), the Technical Architecture was not modified; the evidence below is kept as written. |
| Sources of truth | PD v1.3 · IA v1.1 · UX v1.1 · Model v1.1 · Technical Architecture v1.0 (Approved) — all committed and unchanged |
| Scope | Experimental validation of TA-Q-29 (RLS context with pooled connections) and TA-Q-04 (durable job runtime + transactional outbox). Disposable spikes only, under `spikes/`. |

Status vocabulary used for every requirement: **PASS** (demonstrated by an executed test) · **FAIL** (demonstrated not to hold) · **BLOCKED** (cannot honestly be tested without a missing prerequisite) · **NOT TESTED** (out of the executed scope). Documentation review is never reported as PASS; it is labeled **DOC-VERIFIED**.

---

## 1. Executive result

| Item | Result | One-line reason |
|---|---|---|
| **TA-Q-29** | **PASS** | **LOCAL:** 29/29 on real PostgreSQL. **MANAGED (0E.2b, run 5, preserved):** 22/22 against Supabase: real Auth (JWKS ES256 + `getClaims`), Supavisor transaction mode, custom runtime roles, default grants inspected, connection reuse across workspaces, fail-closed missing/foreign context, no service-role in runtime (§24). Evidence: `spikes/ta-q-29-rls/evidence/ta-q-29-managed-2026-10-04T14-32-40-076Z.txt`. |
| **RLS pattern validated** | **YES**, locally and on Supabase (managed) | Dedicated non-bypass login roles → fixed `SET LOCAL ROLE` → transaction-local claims driving the real `auth.uid()` → **sealed** workspace context → RLS. Under Supavisor, buggy session-level state **did** reach other clients (15/60, reproduced); the seal leaked 0 rows. |
| **TA-Q-04** | **PASS** · Trigger.dev selected: **YES** | **MANAGED (0E.2b):** 14/14 on the Trigger.dev Development project (idempotency, retries/backoff, abort, `concurrencyKey`, delay, schedules, cancel, IDs-only stored payloads, outbox adapter, unknown-outcome handling). Data residency is **documented** (AWS us-east-1); its acceptability is a legal question (TA-Q-05). Crashed runs aren't retried by Trigger.dev, so outbox recovery (R7) was executed. |
| **Outbox pattern** | **PASS** | LOCAL: 13/13 on Graphile Worker. MANAGED: the same domain code with a Trigger.dev adapter, including crash re-dispatch. |
| **Graphile Worker fallback** | Viable fallback, not selected | Gaps unchanged (§15) |
| **Architecture reconsideration required** | **NO** | R1–R6 supported. New refinements: R7 (run-outcome sweeper) and R8 (role rotation under Supavisor, a **severe operational hazard**, F-S6) (§27). |
| **Ready for implementation** | **NO** | Both blocking spikes have passed. Remaining before implementation: review of Phase 0E.2b, then a Technical Architecture update recording R1–R8, then `CLAUDE.md` (§29). |

Sections 2–21 record Phase 0E.2 (local) and are kept as written. Phase 0E.2b (managed) is §22–§29. Where they differ, §22–§29 and this table are authoritative. The "Ready for implementation" row is kept as written at the end of 0E.2b; its first two remaining steps (review of 0E.2b, TA update recording R1–R8) were completed in Phase 0E.3 (§30).

---

## 2. Environment inspected

| Item | Observed | Consequence |
|---|---|---|
| Repository | Clean at `1b1d1cd` ("Approve Technical Architecture v1"). Five source docs at the expected versions. | Source of truth confirmed. |
| OS / CPU | macOS 15.6, arm64 | — |
| Node / npm | Node v22.23.2, npm 10.9.8 (user-local install) | Spikes run on Node. |
| Bun | Present | Not used. |
| Docker / Colima / Podman / OrbStack | **Not installed** | Local Supabase stack (`supabase start`) and self-hosted Trigger.dev **not possible**. |
| PostgreSQL tooling (`psql`, `postgres`, `initdb`) | **Not installed** | Used a **repo-local** PostgreSQL via the `embedded-postgres` npm package (binaries inside `spikes/*/node_modules`; no global install). |
| Supabase CLI | **Not installed** | No local Supabase Auth or Supavisor. |
| Homebrew | Not installed | No global installs attempted. |
| Network | npm registry and vendor docs reachable | Repo-local installs and documentation review possible. |
| Accounts / credentials | None used or created | Trigger.dev and Supabase cloud legs BLOCKED. |

The embedded PostgreSQL binary reports `PostgreSQL 17.10 on x86_64-apple-darwin24.6.0` (an x86_64 build running on arm64). This doesn't affect the semantics under test. Supabase's current major version is also 17.

---

## 3. Scope and methodology

- **Two disposable spikes**, each with its own `package.json`, repo-local dependencies, synthetic data and a runner that:
  1. starts a throwaway PostgreSQL cluster on `127.0.0.1` and a random port;
  2. generates random per-run passwords, held only in environment variables and never written to disk;
  3. loads the spike fixture;
  4. runs the tests with Node's built-in test runner;
  5. writes the full output to `spikes/*/evidence/`;
  6. stops the cluster and deletes its data directory.
- **Security standard (TA-Q-29):** every property was attacked, not reasoned about. Each test follows the pattern attempt → observed denial or zero rows → repeated on a reused pooled connection → recorded. Pools were configured with `max: 1` so that consecutive transactions for different tenants **share one server backend**, which is checked by `pg_backend_pid()`. A concurrent stress test used 4-connection pools.
- **Oracle:** a separate bootstrap-superuser connection is used **only by the tests** to check database state (for example, "B rows unchanged"). No runtime scope helper uses it.
- **Durability standard (TA-Q-04):** crash windows were injected deterministically (dispatcher crash points, handler faults, a `SIGKILL`ed worker process, provider "timeout after success").
- **Vendor behavior** that can't be executed was taken from current official documentation (accessed 2026-10-03, §12–§13) and labeled **DOC-VERIFIED**.
- **Not in scope:** product schema, production RLS policies, application code, Supabase or Trigger.dev configuration, external accounts.

---

## 4. TA-Q-29 hypothesis

> With Supabase Auth for authentication, Drizzle over pooled PostgreSQL connections, and no service-role credential in the web or job runtime, every web request and every job can run inside a transaction that carries **exactly one** authenticated actor and **exactly one** workspace. RLS then guarantees that missing, stale, foreign or forged context yields no tenant data. This holds even when the next transaction on the same pooled server connection belongs to another tenant.

**Important nuance tested, not assumed:** a direct PostgreSQL connection does **not** get PostgREST's JWT handling automatically. Supabase's `auth.uid()` reads `request.jwt.claims` / `request.jwt.claim.sub` settings, which PostgREST sets per request. With direct connections, the application must set them, and it must do so **transaction-locally**.

---

## 5. TA-Q-29 experimental setup

### 5.1 Fixture (synthetic, `spikes/ta-q-29-rls/sql/`)

```
Organization A ── Workspace A1 ── conversations ×3, interactions ×3, guest insight, attention signal
               └─ Workspace A2 ── conversations ×3, interactions ×3, attention signal
Organization B ── Workspace B1 ── conversations ×3, interactions ×3, guest insight, attention signal
Users: u_a1 (manager A1) · u_a12 (responder A1 + manager A2) · u_b1 (manager B1)
       u_guest (client_guest A1) · u_none (no memberships)
System tables: system.outbox_meta, system.asset_routing (identifiers only)
```

### 5.2 Role model (emulating Supabase's documented roles + TA §11 roles)

| Role | Kind | Attributes | Purpose |
|---|---|---|---|
| `authenticated` | NOLOGIN | no BYPASSRLS | Supabase signed-in user role; RLS applies |
| `anon` | NOLOGIN | — | Present for fidelity; unused |
| `service_role` | NOLOGIN | **BYPASSRLS** | Present for fidelity; **no runtime login can assume it** |
| `app_worker` | NOLOGIN | no BYPASSRLS | TA restricted worker role |
| `app_system` | NOLOGIN | no BYPASSRLS | TA system role (system tables only) |
| `spike_owner` | NOLOGIN | — | Object owner (stands in for the migration role) |
| `web_login` | **LOGIN, NOINHERIT, NOBYPASSRLS** | member of `authenticated` only | Web runtime credential |
| `worker_login` | **LOGIN, NOINHERIT, NOBYPASSRLS** | member of `app_worker` only | Job runtime credential |
| `system_login` | **LOGIN, NOINHERIT, NOBYPASSRLS** | member of `app_system` only | System job credential |

The login roles hold **no table privileges themselves**. They gain privileges only after `SET LOCAL ROLE` inside a transaction.

### 5.3 Context mechanism under test

| Element | Mechanism |
|---|---|
| Actor identity | Server verifies an ES256 JWT shaped like a Supabase access token (`sub`, `role`, `aud`, `exp`, `session_id`) against a JWKS using `jose`. The role claim must be in an allowlist (`authenticated`). |
| Database role | `SET LOCAL ROLE authenticated` (web), `app_worker` (jobs) or `app_system` (system), always as a **fixed literal**, never taken from the token. |
| Claims | `set_config('request.jwt.claims', <json>, true)` and `set_config('request.jwt.claim.sub', <sub>, true)` (transaction-local), which is the same shape Drizzle documents for Supabase RLS. An emulated `auth.uid()` reads them. |
| Workspace | `app.bind_context(workspace)`: a SECURITY DEFINER function that sets `app.workspace_id` plus `app.ctx_seal` transaction-locally. The seal is `sha256(server secret ‖ workspace ‖ current transaction id ‖ session_user)`. It refuses to rebind within the same transaction. |
| Reading context | `app.current_workspace()` returns the workspace **only if** the seal matches the current transaction. Otherwise it returns NULL. Policies use `(select app.current_workspace())`. |
| Policies | Users: row workspace = bound workspace **and** a non-guest membership in it (guest projections allow any member). Workers: row workspace = bound workspace. System role: system tables only. RLS **enabled and forced** on every table. |
| References | Composite foreign keys `(workspace_id, conversation_id)`. |
| Pool | `node-postgres` Pool via `drizzle-orm/node-postgres`, `max: 1` (forced reuse) and `max: 4` (stress). |

---

## 6. TA-Q-29 tests and evidence

Evidence: `spikes/ta-q-29-rls/evidence/ta-q-29-test-output.txt` (29 tests, 29 pass, exit code 0). Each row maps a TA §11.6 requirement to what was executed.

| # | TA §11.6 requirement | Executed evidence | Result |
|---|---|---|---|
| 1a | Server-validated auth session maps to database context | Valid token ⇒ inside the transaction `auth.uid() = sub`, `current_user = authenticated`, `session_user = web_login`, `app.current_workspace() = A1`. Tokens signed with a foreign key, expired, with the wrong audience, with `role: service_role`, or with a non-UUID `sub` are rejected **before** any query runs. | **PASS** (Supabase-shaped token, locally issued) |
| 1b | Same, with a token issued by **real Supabase Auth** (JWKS or `getClaims()`) | Requires a Supabase project or a local Supabase stack | **BLOCKED** |
| 2 | Workspace and actor context is transaction-local | `current_setting('app.workspace_id') = A1` inside the transaction | **PASS** |
| 3 | Context can't survive transaction completion | After commit **and** after rollback, on the **same backend PID**: `current_user = web_login`, claims, workspace and seal settings are empty | **PASS** |
| 4 | Reused pooled connection can't leak the previous tenant | One backend runs A1 → B1 → no context: A1 sees only A1 (3 rows), B1 only B1 (3), no context sees 0. Same for workers. Stress test: 400 interleaved user and worker transactions across 4 tenants on 4-connection pools. Every transaction saw only its own workspace, and backends were demonstrably reused across different tenants. | **PASS** |
| 5 | Missing workspace context returns no tenant rows | User role with valid claims but no bound workspace: 0 rows on conversations, interactions and guest insights; insert rejected (`42501 new row violates row-level security policy`). Worker without context: 0 rows; insert rejected; `bind_context(NULL)` rejected. | **PASS** |
| 6 | Workspace A can't read or reference Workspace B | Explicit filters or IDs for B1/A2 from an A1 context return 0 rows. A user in A1 and A2 bound to A1 sees only A1. Fabricated contexts return 0 rows: binding A2 without membership, B1 (other organization), a random UUID, or any context for a user with no memberships. Composite foreign keys: see rows 6b and 7. | **PASS** |
| 6b | A can't modify B | Update and delete targeting B1 rows affect 0 rows. Inserting into B1 and moving an A1 row to B1 are rejected (`42501`), for both users and workers. The oracle confirms B1 is unchanged. | **PASS** |
| 7 | Restricted worker role obeys RLS | Worker bound to A1 sees exactly 3 of 9 rows (oracle confirms the table holds all three workspaces) | **PASS** |
| 8 | Worker context can't escape its workspace | Querying B1 from A1: 0 rows. Rebinding within the transaction: refused (`42501 tenant context: already bound`). Raw `set_config('app.workspace_id', B1, true)`: context becomes NULL and 0 rows. Replaying a seal captured from an earlier B1 transaction: 0 rows. Session-level (non-local) context written by "buggy code": the value **does persist** on the connection (the hazard was demonstrated), but the seal makes it unusable (0 rows). The worker can't `SET ROLE` to `authenticated`, `app_system`, `service_role` or the owner (`42501`). | **PASS** |
| 9 | System role can access only explicit system tables | Reads `system.outbox_meta`. Conversations and attention signals are rejected (`42P01` via ORM, `42501 permission denied for schema public` when schema-qualified). `app.current_workspace()` is denied (`42501 permission denied for schema app`). It can't `SET ROLE` to `app_worker`, `authenticated` or `service_role`. | **PASS** |
| 10 | Service-role credentials not required in web or job runtime | The whole suite runs with only `web_login`, `worker_login` and `system_login`. The catalog shows all runtime roles have `rolsuper = false`, `rolbypassrls = false`, are not members of `service_role` or the owner, and login roles have `rolinherit = false`. Every table has RLS enabled **and forced**. The web runtime can't `SET ROLE service_role`. | **PASS** (local role model) · Supabase-hosted equivalence **BLOCKED** (§10) |
| 11 | Direct Drizzle queries can't accidentally bypass RLS | Drizzle queries on all three pools without a scope helper are **rejected** (`42P01 relation does not exist`, or `42501 permission denied for schema public` when qualified). A session-level `SET ROLE authenticated` left behind by buggy code yields **0 rows**, not foreign data. | **PASS** |
| 12a | Pooling mode preserves the guarantees: application-side pool | Same-backend reuse across tenants (rows 3–4, 8) with `node-postgres` + Drizzle. No session-level statement is required by the pattern. No named prepared statements are used. Read-only transactions can bind context. | **PASS** |
| 12b | Same, through **Supavisor transaction mode** (web/serverless) and the chosen worker connection mode, with **custom login roles** | Requires Supabase (local stack or project) | **BLOCKED** |
| 13 | Failure behavior is fail-closed | Every failure mode observed returned an error or zero rows: missing, stale, forged, foreign or rebound context; no scope helper; leftover session role. Two fixture misconfigurations during development (§10, items 3–4) also failed **closed** (zero rows), never open. | **PASS** |

**Observed rejections** (verbatim from the evidence file):

```
42501 new row violates row-level security policy for table "conversations"
42501 tenant context: workspace required
23503 insert or update on table "interactions" violates foreign key constraint "interactions_workspace_id_conversation_id_fkey"
42501 tenant context: already bound in this transaction
42501 permission denied to set role "authenticated" | "app_system" | "service_role" | "spike_owner" | "app_worker"
42P01 relation "conversations" | "attention_signals" | "interactions" does not exist
42501 permission denied for schema public
42501 permission denied for schema app
```

Additional properties exercised:

| Property | Evidence | Result |
|---|---|---|
| Client guest isolation (TA §49) | Guest bound to A1: conversations 0, interactions 0, attention signals 0, guest insights = A1 only | **PASS** |
| Attention-only cross-workspace read (TA §50) | u_a1 sees signal A1 only; u_a12 sees A1 and A2; never B1 | **PASS** |
| Cross-tenant FK existence oracle | Referencing a B1 conversation from A1 fails with the **same error shape** as referencing a non-existent ID | **PASS** |

---

## 7. TA-Q-29 adversarial results

| Attack | Attempt | Observed | Repeated on reused pooled connection? | Result |
|---|---|---|---|---|
| No tenant context | Role + claims, no bind; worker role, no bind | 0 rows; inserts `42501` | Yes (`max: 1` pools) | Fail-closed ✔ |
| Wrong workspace context | u_a1 binds A2 / B1 | 0 rows | Yes | Fail-closed ✔ |
| Stale context | Replay a seal from an earlier transaction; session-level leftover context | 0 rows (value present, seal invalid) | Yes, same backend | Fail-closed ✔ |
| Connection reused after Workspace A | A1 → B1 → none on one PID; 400-transaction stress | Each transaction sees only its own workspace | Yes | ✔ |
| Org A user requesting Org B | u_a1 binds B1; filters by B1 IDs | 0 rows; writes rejected; B unchanged | Yes | ✔ |
| Worker scheduled for A querying B | Filter B1; rebind B1; raw `set_config` B1 | 0 rows / `42501` / context NULL | Yes | ✔ |
| Direct Drizzle query without helper | Select/update via each runtime pool | `42P01` / `42501` | Yes | ✔ |
| Fabricated workspace ID | Random UUID bound by user | 0 rows | Yes | ✔ |
| System process reading tenant content | System scope reads conversations / attention / context function | `42P01` / `42501` | Yes | ✔ |
| Role escalation | Any runtime login to `service_role` / owner / other runtime role | `42501 permission denied to set role` | Yes | ✔ |
| Forged token | Foreign key, expired, wrong audience, `role: service_role` claim | Rejected before any query | n/a | ✔ |

---

## 8. TA-Q-29 conclusion

> **Superseded by Phase 0E.2b:** TA-Q-29 is **PASS** with preserved managed Supabase evidence (§24). The text below is the Phase 0E.2 (local) conclusion, kept for the record.

**TA-Q-29 (Phase 0E.2): BLOCKED.**

- **What is proven (PASS):** on real PostgreSQL 17.10, the tenancy mechanism the architecture assumes is safe under pooled-connection reuse, and it fails closed for every adversarial case attempted. It needs no RLS-bypassing credential at runtime and can't be bypassed by an unscoped Drizzle query.
- **What isn't proven (BLOCKED):**
  1. tokens issued by real Supabase Auth and verified via the project JWKS or `getClaims()`;
  2. the same behavior through **Supavisor transaction mode**, connecting as **custom login roles** (`role.project-ref` usernames), with prepared statements off;
  3. Supabase project defaults (default privileges on `public`, the provided `authenticated`/`anon` roles, the real `auth.uid()` implementation) composing safely with the pattern.
- Nothing observed suggests the Supabase leg will fail. But the brief requires evidence, so the item stays **BLOCKED**, not PASS.
- **The architecture is not falsified.** TA §9–§11 stand, with the refinements in §17.

---

## 9. Confirmed safe RLS execution pattern

Validated at the PostgreSQL level. Final confirmation is pending §8's Supabase leg.

```
WEB REQUEST                                           JOB (workspace)                     SYSTEM JOB
──────────────────────────────────────────────        ───────────────────────────────     ─────────────────────────
1. verify access token server-side (JWKS /            1. job payload: workspace id         1. named system task only
   getClaims); role claim ∈ {authenticated}              (from outbox), IDs only
2. connect as web_login (LOGIN NOINHERIT              2. connect as worker_login           2. connect as system_login
   NOBYPASSRLS; member of `authenticated` only)          (member of app_worker only)          (member of app_system only)
3. BEGIN                                              3. BEGIN                             3. BEGIN
4. SET LOCAL ROLE authenticated   (fixed literal)     4. SET LOCAL ROLE app_worker         4. SET LOCAL ROLE app_system
5. set_config('request.jwt.claims', claims, true)
   set_config('request.jwt.claim.sub', sub, true)
6. select app.bind_context(:workspace)  -- sealed,    5. select app.bind_context(:ws)
   transaction-bound, refuses rebinding
7. queries (Drizzle) — RLS: bound workspace           6. queries — RLS: bound workspace    5. system tables only
   AND non-guest membership (guest projections:
   any member)
8. COMMIT / ROLLBACK  → role, claims, workspace and seal all vanish; connection returns to pool clean
```

| Aspect | Answer |
|---|---|
| Actor identity mechanism | Server-side JWT verification, then transaction-local `request.jwt.claims` / `request.jwt.claim.sub`, then `auth.uid()` |
| Workspace context mechanism | `app.bind_context()`: transaction-local GUCs plus a seal bound to transaction id, session user and a server-only secret, read through `app.current_workspace()` |
| PostgreSQL role model | One dedicated login role per runtime (web, worker, system), NOINHERIT and NOBYPASSRLS, each able to `SET ROLE` to exactly one runtime role. The owner and `service_role` are unreachable from runtime logins. |
| Transaction boundary | Every tenant read and write happens inside one transaction opened by a scope helper. Context is set after `BEGIN` and disappears at `COMMIT`/`ROLLBACK`. |
| Pool compatibility | Needs only transaction-scoped state; no session-level statements; no named prepared statements. Compatible in principle with transaction-mode poolers (Supavisor leg BLOCKED). |
| Missing-context failure | Zero rows for reads; `42501` for writes; `42P01`/`42501` for unscoped queries; NULL context for stale or forged values |
| Web vs worker | **Same pattern.** Only the login role, the target role and the source of identity differ (verified token vs outbox job). |
| Supabase-specific | Supabase Auth token issuance and verification (JWKS/`getClaims`), the `authenticated` role and `auth.uid()` conventions, Supavisor connection mode and usernames, project default privileges |
| PostgreSQL-generic | Login/runtime role split, `SET LOCAL ROLE`, transaction-local GUCs, sealed context, RLS (enabled + forced), composite tenant foreign keys, SECURITY DEFINER helpers with `search_path = ''` |

---

## 10. TA-Q-29 remaining limitations

| # | Limitation / finding | Status | Note |
|---|---|---|---|
| 1 | Real Supabase Auth tokens (JWKS/`getClaims`) not exercised | BLOCKED | Needs a Supabase project or local stack (§18). |
| 2 | Supavisor transaction mode with custom login roles not exercised | BLOCKED | DOC-VERIFIED: transaction mode is recommended for serverless; prepared statements are unsupported; session state doesn't survive between transactions. Custom roles connect as `role.project-ref` (taken from a search-result summary of the Supabase psql guide; the page itself wasn't fetched, so confirm in the spike). |
| 3 | **FORCE RLS also applies to the table owner**, so SECURITY DEFINER helpers that read memberships need an explicit owner read policy. Without it, every user saw zero rows. | Observed during development; **failed closed** | Must be part of the production policy review. |
| 4 | A `GRANT … ON SCHEMA public` issued by a non-owner **silently grants nothing**. Roles then can't see tables (`42P01`). | Observed; **failed closed** | In Supabase, `public` grants and default privileges differ from vanilla PostgreSQL. Verify in the Supabase leg. |
| 5 | **The Supabase `postgres` role bypasses RLS** (DOC-VERIFIED, Supabase "Postgres Roles"). Connecting the runtime as `postgres` would defeat isolation. | Design constraint | Runtime must use dedicated non-bypass login roles (§17, R1). |
| 6 | Drizzle's documented Supabase RLS wrapper runs `set local role <token_role>`, taking the role from the token | Design constraint | Use a fixed literal or allowlist; never a role from token data (§17, R3). |
| 7 | Performance of the seal check (`sha256` per statement via initplan; `pg_current_xact_id()` assigns an xid even in read-only transactions) and of per-row `member_role()` in the attention policy | **NOT TESTED** | Measure with realistic volumes before finalizing. A cheaper equivalent (e.g., a backend-pid + transaction-start binding) could be evaluated. |
| 8 | Trusted worker code can still legitimately bind **any** workspace in a **new** transaction (that's how per-workspace jobs work) | By design | The guarantee is "one job transaction = one workspace; it can't drift". The workspace comes from the outbox and is enforced by job wrappers and lint rules. |
| 9 | Driver choice: only `node-postgres` was tested. `postgres.js` needs `prepare: false` behind transaction-mode poolers. | NOT TESTED | Decide the driver at implementation; repeat the suite. |
| 10 | Production policy set (all tables, guest projections, retention role, Monitor-only intent backstop) | NOT TESTED | Out of scope. The spike fixture isn't the product schema. |

---

## 11. TA-Q-04 hypothesis

> A managed durable job runtime (Trigger.dev preferred), fed by a PostgreSQL transactional outbox, meets the architecture's needs:
> - durable, retryable, observable and rate-aware execution;
> - long-running imports and per-account concurrency;
> - IDs-only payloads;
> - no dependency of domain logic on the vendor.
>
> The outbox integration shape survives every crash window without lost or harmful duplicate effects.

---

## 12. Trigger.dev validation methodology

- **Executed:** nothing against Trigger.dev. It requires an account and project (cloud) or Docker (self-hosting), and neither is available (§2). The brief forbids creating accounts.
- **Executed instead:** the **vendor-neutral integration shape**. Domain code calls a `JobRuntime` port (`enqueue(task, idsPayload, { idempotencyKey, queueKey, runAt })`). The executed adapter is Graphile Worker (a real durable queue on PostgreSQL). A Trigger.dev adapter would implement the same port with `tasks.trigger(id, payload, { idempotencyKey, ... })`.
- **Documentation review** of official Trigger.dev pages, accessed 2026-10-03:

| Source | URL |
|---|---|
| Idempotency | https://trigger.dev/docs/idempotency |
| Queues & concurrency | https://trigger.dev/docs/queue-concurrency |
| Errors & retrying | https://trigger.dev/docs/errors-retrying |
| Limits | https://trigger.dev/docs/limits |
| Max duration | https://trigger.dev/docs/runs/max-duration |
| Scheduled tasks | https://trigger.dev/docs/tasks/scheduled |
| Cancel run | https://trigger.dev/docs/management/runs/cancel |
| Pricing | https://trigger.dev/pricing |
| Regions, static IPs (launch post) | https://trigger.dev/launchweek/2/4x-concurrency-static-ips-aws |
| Self-hosting overview (search result) | https://trigger.dev/docs/self-hosting/overview |

---

## 13. Trigger.dev evidence

### 13.1 What was PROVEN (executed)

Nothing Trigger.dev-specific. The **outbox shape it would plug into** was proven (§14).

### 13.2 What was VERIFIED FROM CURRENT OFFICIAL DOCUMENTATION (DOC-VERIFIED, 2026-10-03)

| Requirement | Documented behavior | Fit |
|---|---|---|
| Idempotency | `idempotencyKey` on trigger: "the second request does not create a new run. It returns the original run's handle." Default TTL 30 days (configurable). Scopes `run`/`attempt`/`global`. Failed runs clear the key; successful or canceled runs keep it. "It does not make the code inside a task's run() function idempotent." | ✔ Matches outbox redispatch (window C). Domain idempotency still required (proven in §14). Use `global` scope for outbox keys. |
| Keyed concurrency | Queues with concurrency limits; `concurrencyKey` gives "each unique key value … its own pool" (per tenant/account). Only executing runs count. | ✔ Per-account provider concurrency without serial-only queues. |
| Retries / backoff | `maxAttempts`, `factor`, `minTimeoutInMs`, `maxTimeoutInMs`, `randomize`. `AbortTaskRunError` stops retries. `catchError` for conditional retry. Retrying is disabled by default in dev. | ✔ Supports "never blind-retry replies". |
| Long-running jobs | No timeouts on task duration (pricing page). `maxDuration` counts CPU time and excludes waits. Runs have a 14-day maximum TTL on cloud. | ✔ For the 30-day import, with checkpoints. |
| Scheduling | Declarative and imperative cron, IANA timezones, per-tenant schedules via `externalId` + `deduplicationKey`. Free plan: hourly minimum. | ✔ |
| Delayed execution | Delay doesn't count against TTL (limits page) | ✔ |
| Cancellation | `runs.cancel(runId)` cancels in-progress runs | ✔ (cleanup hooks not documented on that page) |
| Payload size | 3 MB per trigger payload. Payloads over 128 KB are offloaded to object storage. Outputs up to 10 MB. | ✔ IDs-only payloads are tiny |
| Observability | Run dashboard, logs (retention 1/7/30 days by plan), alerts | ✔ (OpenTelemetry export details not reviewed) |
| Concurrency / queue limits | Production concurrency 20 (Free) / 50 (Hobby) / 200+ (Pro). Queue size 10k / 250k / 1M. API 1,500 req/min. | ✔ For MVP; plan sizing needed |
| Pricing | Free $0 (+$5 credit), Hobby $10, Pro $50/month. Compute from $0.0000169/s (Micro). $0.000025 per run invocation. Dev runs not charged. | Cost model needed (TA-Q-23) |
| Regions / data | Worker regions `us-east-1` and `eu-central-1`. The reviewed page doesn't state where payloads, outputs and logs are **stored**. The vendor relies on DPAs/SCCs for GDPR. | ⚠ **Unverified data residency** |
| DB connectivity | Static IPs on paid plans "to connect to production databases that enforce IP restrictions … Supabase" | ✔ Relevant for worker → Supabase |
| Self-hosting | Apache 2.0; Docker and Kubernetes (v4) | ✔ Exit option |

### 13.3 What REMAINS UNPROVEN

| Item | Status |
|---|---|
| Our outbox → Trigger.dev redispatch with `global` idempotency keys, end to end | BLOCKED |
| `concurrencyKey` per connected account under load; interaction with provider rate budgets | BLOCKED |
| Long import with checkpoints surviving worker restart or deploy on Trigger.dev | BLOCKED |
| Worker crash / OOM recovery semantics in practice | BLOCKED |
| Payload, output and **log** privacy: confirm IDs-only payloads, no content in logs, retention per plan | BLOCKED |
| **Where data is stored** (payloads, outputs, logs) and DPA terms | BLOCKED (vendor answer needed; legal TA-Q-05) |
| Connectivity from Trigger.dev compute to Supabase (static IPs, pooler mode, worker login role) | BLOCKED |
| Cost at realistic volumes | NOT TESTED |
| Domain logic independence from the vendor | **PASS** in shape: the `JobRuntime` port was exercised with a non-Trigger adapter |

---

## 14. Transactional outbox failure tests/reasoning

Evidence: `spikes/ta-q-04-jobs/evidence/ta-q-04-test-output.txt` (13 tests, 13 pass, exit code 0). Runtime: Graphile Worker 0.18.0 on PostgreSQL 17.10. The dispatcher enqueues through a **separate** connection, deliberately non-transactional, to mimic an external job API.

```
domain tx: write state + outbox row → COMMIT → dispatcher reads committed 'pending' rows
→ JobRuntime.enqueue(ids only, idempotencyKey = outbox.dispatch_key) → mark 'dispatched'
→ worker receives IDs → reloads authoritative state → idempotent work
```

| Scenario | Executed test | Observed | Result |
|---|---|---|---|
| **A** Transaction rolls back | Domain write + outbox row, then failure before commit | No outbox row, nothing dispatched, no job | **PASS** |
| **B** Commit; dispatcher crashes **before** enqueue | Crash injected; row stays `pending`; sweeper pass (`minAge`) | Sweeper enqueued the job; worker produced exactly one assessment; row `dispatched` | **PASS** |
| **C1** Enqueued; crash **before** marking (job not yet run) | Crash injected after enqueue; redispatch | Same idempotency key ⇒ still **one** job; handler ran once | **PASS** |
| **C2** Same, job **already ran** | First run completes (Graphile deletes completed jobs); redispatch | Second run happened; domain idempotency ⇒ outcomes `assessed`, `skip_duplicate`; one assessment | **PASS** (shows the domain must be idempotent; on Trigger.dev, successful-run keys persist 30 days, DOC-VERIFIED) |
| **D** Same job delivered twice | Two deliveries without a key | One assessment; second run logged `skip_duplicate` | **PASS** |
| **E1** Worker throws after partial work | Import of 6 pages, failure after page 3 | Checkpoint at page 4 persisted. Runtime retried with backoff (attempt 2). Pages 1–6 each processed **exactly once**. | **PASS** |
| **E2** Worker process **hard-killed** (`SIGKILL`) mid-import | Child worker killed after page ≥ 2 | Job **remained locked** by the dead worker. A healthy worker **could not** take it. After `forceUnlockWorkers`, it resumed from the checkpoint; all 8 pages exactly once. | **PASS** (recovery requires crash detection or Worker Pro, or a wait of up to 4 h; DOC-VERIFIED) |
| **F1** Reply times out **after** the platform accepted it | Simulated provider records the reply, then times out | Intent ⇒ `outcome_unknown`; the job was **not** retried; a redelivered job did **not** call the provider again; reconciliation found the reply ⇒ `confirmed`. **Exactly one** platform call and one public reply. | **PASS** |
| **F2** Duplicate user submission | Same request key twice | One intent, one platform reply | **PASS** |
| **F3** Hide times out after success | Provider applies hide, then times out | Retried with backoff (state-setting is idempotent). Final state hidden, intent `confirmed`. | **PASS** |

Runtime properties exercised on the fallback runtime:

| Property | Observed | Result |
|---|---|---|
| Keyed concurrency | Jobs in the same queue never overlapped; different queues ran in parallel (concurrency 4) | **PASS** (Graphile: serial per named queue only) |
| Delayed / scheduled run | `runAt` +1.5 s didn't run early; ran after | **PASS** |
| Payload privacy | Every dispatched payload had exactly `{outboxId, workspaceId, entityId}`. No comment text found in stored job payloads. | **PASS** |
| Retry with exponential backoff | Retries observed after ~e^attempt seconds (formula `exp(least(attempts,10))` in Graphile SQL) | **PASS** (Graphile) |
| Cron schedules, cancellation of a running job | — | **NOT TESTED** |

**Idempotency classification confirmed:** classification writes are uniquely keyed (entity + task version); imports are checkpointed with unique page rows; hide/unhide are state-setting and safely retryable; public replies are **never repeated without verification**; private replies are never auto-retried (same rule, stricter); user submissions are uniquely keyed by request key.

---

## 15. Trigger.dev vs Graphile Worker

| Dimension | Trigger.dev (DOC-VERIFIED unless noted) | Graphile Worker (executed locally unless noted) |
|---|---|---|
| Durability | Managed runs, 14-day TTL | Jobs in our PostgreSQL ✔ |
| Transaction integration | Via outbox (external API) | **Native**: `add_job` can run inside the domain transaction (not executed here; the outbox shape was executed) |
| Concurrency | Queue limits + `concurrencyKey` per tenant/account | Serial per named queue ✔. High-cardinality queue names "degrade performance" (library docs/types). Per-account limits > 1 not native. |
| Scheduling | Cron, timezones, per-tenant schedules | Crontab (not executed) |
| Retries | Configurable exponential + jitter; abort error | Exponential `exp(attempts)` s, up to 25 attempts by default ✔ |
| Crash recovery | Managed (not verified) | Hard crash ⇒ job locked up to 4 h unless force-unlocked (observed lock; 4 h DOC-VERIFIED) or Worker Pro heartbeat (paid) |
| Long-running imports | No duration timeouts; CPU-time `maxDuration` | Needs a long-running worker host; not suitable on Vercel functions |
| Observability | Run dashboard, logs, alerts | Logs only; build our own dashboards |
| Operations burden | Low (managed) | Medium: host, scaling, deploys, monitoring of a worker service |
| Deployment burden | Separate deploy to Trigger.dev | Separate deploy to a container host (e.g., Fly/Render/Railway; adds a vendor) |
| Tenant safety | Payloads leave our infrastructure (IDs only mitigates). Logs must avoid content. **Storage location unverified.** | Everything stays in our database and infrastructure |
| Rate limiting | `concurrencyKey` + our budgets | Queues + our budgets |
| Cost | Per-run + compute; plan tiers | Worker host + DB load |
| Local development | `trigger dev` needs a project login (not executed) | Excellent: proven fully offline |
| Migration cost via the port | Low: `JobRuntime` port proven | Low: same port |

**Conclusion:** no material requirement **fails** for Trigger.dev on documentation evidence. It is stronger on per-account concurrency, crash recovery, long runs and operations burden. Graphile Worker is a **proven, viable fallback** whose gaps are crash-lock recovery, serial-only queues and worker hosting. Data residency for Trigger.dev is the main open question.

---

## 16. TA-Q-04 conclusion

> **Superseded by Phase 0E.2b:** TA-Q-04 is **PASS** and Trigger.dev is selected (§25–§26). The text below is the Phase 0E.2 conclusion, kept for the record.

**TA-Q-04 (Phase 0E.2): BLOCKED — external/account validation still required. Trigger.dev selected: NOT YET.**

- **Outbox pattern (LOCKED in TA): PASS**, executed against a real durable queue across all crash windows.
- **Trigger.dev:** remains the preferred candidate. Nothing disqualifying was found in the documentation. Its runtime behavior and data-storage location must be verified with an account (§18).
- **Graphile Worker:** adequate fallback if Trigger.dev fails on data residency, privacy or cost. It would need crash detection with `forceUnlockWorkers` (or Worker Pro), a worker host, and its own observability.

---

## 17. Architecture implications

**ARCHITECTURE RECONSIDERATION REQUIRED: NO.** No assumption failed. The following **refinements** should be recorded in a future TA update, for a separate decision. They don't change any locked boundary.

| ID | Refinement | Source | Affects |
|---|---|---|---|
| R1 | Runtimes connect with **dedicated login roles** (LOGIN, NOINHERIT, NOBYPASSRLS), one per runtime, each able to `SET ROLE` to exactly one runtime role. **Never as `postgres`** (bypasses RLS in Supabase) and never with service-role credentials. | §9, §10 item 5 | TA §9.3, §10.4, §11.5 |
| R2 | Workspace context is **sealed and transaction-bound** (bind once per transaction; stale, forged or session-level values are ignored), not just a plain `set_config`. Demonstrated necessary: a session-level value **does** persist across pooled transactions. | §6 row 8 | TA §9.3, §11.3 |
| R3 | The role used in `SET LOCAL ROLE` is a **fixed literal** per scope helper. Token role claims are only allowlist-checked, never interpolated. | §10 item 6 | TA §10 |
| R4 | Forced RLS applies to owners: SECURITY DEFINER helpers need explicit owner policies, covered by tests. Schema-level grants must be issued by the schema owner and verified by introspection tests. | §10 items 3–4 | TA §11, §54 |
| R5 | Tenant foreign keys are composite with `workspace_id`, which also removes cross-tenant existence oracles | §6 | TA §9.2 |
| R6 | Outbox consumers must be idempotent even with runtime idempotency keys (keys are cleared on failed runs, and Graphile deletes completed jobs). Replies record `executing` before the provider call, so a crash mid-call becomes `outcome_unknown`, never a resend. | §14 C2, F1 | TA §18, §19.3, §26 |

---

## 18. Remaining validation gates

| Gate | Blocks | Minimal next action for the user | Why |
|---|---|---|---|
| **TA-Q-29 — Supabase leg** | Tenancy/database foundation (TA §73 steps 1–2) | **Either** (a) install a container runtime (Docker Desktop or OrbStack) **and** the Supabase CLI, which allows `supabase start` locally with the pooler enabled and needs **no account**; **or** (b) create a free Supabase development project and provide its connection details through environment variables (never committed). Then authorize me to re-run the spike against it. | Real Supabase Auth tokens, Supavisor transaction mode with custom login roles, and Supabase default privileges can't be emulated faithfully |
| **TA-Q-04 — Trigger.dev leg** | Job foundation (TA §73 step 3) | Create a Trigger.dev account and a **development project** (free plan is enough) and provide a dev-environment secret key via environment variable. **Or** install Docker for a self-hosted v4 instance. Also ask Trigger.dev **where payloads, outputs and logs are stored** for the chosen region, and obtain the DPA. | Runtime behavior and data residency can't be verified from docs alone |
| Seal / policy performance | Before finalizing production policies | None now (runs with either gate above) | §10 item 7 |
| Driver choice (`node-postgres` vs `postgres.js`) | Foundation | Decide at implementation; repeat the TA-Q-29 suite | §10 item 9 |
| Other VALIDATE items (TA §72.2) | Their respective modules | Unchanged | Not part of this phase |

---

## 19. Recommendation before implementation

1. **Do not start the tenancy/database foundation** until the TA-Q-29 Supabase leg passes. The PostgreSQL-level evidence is strong, but it isn't Supabase evidence.
2. **Prefer gate (a) for TA-Q-29** (local Supabase stack: no account, no cloud data), then repeat once against the staging project before production.
3. **Run the Trigger.dev leg with a free development project** and request the data-storage statement. Choose Trigger.dev if it passes and data residency is acceptable (TA-Q-05). Otherwise choose Graphile Worker with crash detection and a worker host.
4. **Record refinements R1–R6** in a TA update after review (no reconsideration needed).
5. **Keep the spikes** as reference until implementation adopts their patterns. Turn the TA-Q-29 suite into the permanent RLS/tenant-isolation regression suite (TA §55, T-01, T-11, T-26).
6. **Don't create `CLAUDE.md` yet.** The tenancy pattern it must encode depends on the Supabase leg.

---

## 20. Artifacts created

| Path | Purpose |
|---|---|
| `docs/pre-implementation-validation-v1.md` | This document |
| `spikes/ta-q-29-rls/package.json`, `package-lock.json`, `.gitignore` | Spike A manifest (private, marked DISPOSABLE) |
| `spikes/ta-q-29-rls/sql/fixture.sql`, `sql/seed.sql` | Synthetic roles, tables, policies and data (spike only) |
| `spikes/ta-q-29-rls/lib/auth.mjs`, `lib/db.mjs` | Test token issuer/verifier; three scope helpers over Drizzle |
| `spikes/ta-q-29-rls/scripts/run.mjs` | Throwaway cluster lifecycle + test run |
| `spikes/ta-q-29-rls/tests/rls.test.mjs` | 29 adversarial tests |
| `spikes/ta-q-29-rls/evidence/ta-q-29-test-output.txt` | Captured run output (29/29) |
| `spikes/ta-q-04-jobs/package.json`, `package-lock.json`, `.gitignore` | Spike B manifest |
| `spikes/ta-q-04-jobs/sql/schema.sql` | Synthetic outbox, intents, simulated provider |
| `spikes/ta-q-04-jobs/lib/outbox.mjs` | `JobRuntime` port, Graphile adapter, dispatcher, idempotent handlers |
| `spikes/ta-q-04-jobs/scripts/run.mjs`, `scripts/crash-worker.mjs` | Cluster lifecycle; worker process killed in E2 |
| `spikes/ta-q-04-jobs/tests/outbox.test.mjs` | 13 durability/idempotency tests |
| `spikes/ta-q-04-jobs/evidence/ta-q-04-test-output.txt` | Captured run output (13/13) |
| `spikes/*/node_modules/` (git-ignored) | Repo-local dependencies (see below) |

**Repo-local dependencies:**
- Spike A: `embedded-postgres@17.10.0-beta.17` (+ `@embedded-postgres/darwin-arm64` PostgreSQL binaries), `pg@8.23.1`, `drizzle-orm@0.45.3`, `jose@6.2.12`.
- Spike B: `embedded-postgres@17.10.0-beta.17`, `pg@8.23.1`, `graphile-worker@0.18.0`.

No global or system software was installed. No `.env` files exist. No secrets are stored; passwords are random per run and held only in memory and environment variables.

---

## 21. Cleanup / reproducibility instructions

**Reproduce** (offline after `npm install`):

```bash
cd spikes/ta-q-29-rls && npm install && npm test   # starts a throwaway cluster, runs 29 tests, writes evidence/, deletes the cluster
cd spikes/ta-q-04-jobs && npm install && npm test  # same lifecycle, 13 tests (~15 s)
```

- Each run binds PostgreSQL to `127.0.0.1` on a random free port only, and stops it at the end. The data directory (`.data/`) is deleted (`persistent: false` plus an explicit removal). No listeners stay open. After this phase's runs, no PostgreSQL processes were left running.
- **Remove the spikes entirely** after review: `rm -rf spikes/` (or keep them; `node_modules/` and `.data/` are git-ignored, and about 300 MB of dependencies can be removed with `rm -rf spikes/*/node_modules`).
- **Evidence** files are overwritten on each run. Commit or archive them as review artifacts if desired. They contain no secrets and only synthetic data.
- **Supabase leg:** set the same tests' connection settings to a local Supabase stack or a development project (login roles created there by the fixture), and add a test that obtains a real Supabase Auth token. The scope helpers are unchanged.
- **Trigger.dev leg:** implement the `JobRuntime` port with the Trigger.dev SDK in `spikes/ta-q-04-jobs/` and re-run scenarios B, C, E and F against a development project.

---

# Phase 0E.2b — Managed Runtime Validation

Date: 2026-10-04 · Projects (DEVELOPMENT / VALIDATION ONLY, created by the product owner): Supabase `social-intelligence-dev` (Free, São Paulo) · Trigger.dev `social-intelligence-dev` / Development (Free).

Evidence classes used below: **LOCAL** (Phase 0E.2, local PostgreSQL) · **MANAGED** (executed against the managed service in this phase) · **DOC-VERIFIED** (official documentation, accessed 2026-10-03/04) · **BLOCKED** (could not be executed).

## 22. Credential handling and privilege separation

| Rule | How it was applied |
|---|---|
| No secrets in output, files or evidence | Credentials live only in git-ignored `spikes/*/.env.local` (ignore verified before creation). Scripts load them with Node's native env loader. Every child-process line is redacted (keys, passwords, connection strings, pooler host, project refs, JWTs, synthetic emails) before reaching the console or evidence. A final scan of all spike files, evidence and this document found **no secret values**. |
| Bootstrap vs runtime privilege | **TEST BOOTSTRAP only:** `SUPABASE_DB_BOOTSTRAP_URL` (`postgres` via the session pooler) creates and drops the disposable `spike29*` objects; `SUPABASE_SECRET_KEY` creates and deletes synthetic Auth users. **RUNTIME:** the test process receives neither (asserted by test M16). It connects only as custom login roles through Supavisor **transaction mode** (port 6543), using real user access tokens obtained with the publishable key. |
| Role passwords never in plaintext | Runtime role passwords are random per run, held in memory, and sent to PostgreSQL as **SCRAM-SHA-256 verifiers** computed client-side, so DDL logs can't contain them. |
| Configuration quirks handled in memory | `SUPABASE_URL` contained `/rest/v1/`, which is normalized to the origin. The bootstrap password was wrapped in the dashboard template's literal `[ ]`, which is stripped **in memory only** (the user's file is untouched). |

## 23. Supabase project facts (bootstrap inspection, MANAGED)

| Fact | Observed | Relevance |
|---|---|---|
| Server | PostgreSQL **17.11** | Same major version as the local spike |
| `postgres` role | `rolsuper = false`, **`rolbypassrls = true`**, `rolcreaterole = true` | Confirms **R1**: a runtime connected as `postgres` would bypass RLS |
| `authenticated` / `anon` | NOLOGIN, NOBYPASSRLS. Members of `authenticated`: `authenticator` (SET, no inherit), `postgres` (admin), `supabase_realtime_admin`. | A custom login role can be granted `authenticated` (done) |
| `auth.uid()` (real definition) | `coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid` | Transaction-local claims set by our helper drive the **real** `auth.uid()` |
| Auth signing keys | JWKS publishes an **ES256** key. Real access tokens carry `alg: ES256` with a `kid`. | Server-side verification uses JWKS, the recommended mechanism |
| Real token claims | `aal, amr, app_metadata, aud, email, exp, iat, is_anonymous, iss, phone, role, session_id, sub, user_metadata` | `role` is allowlist-checked; `email` is never needed in the database context |
| Default privileges in `public` | Tables **created by `postgres`** grant `anon`/`authenticated`/`service_role` only `Dxtm` (no SELECT/INSERT/UPDATE/DELETE). Tables **created by `supabase_admin`** grant them `arwdDxtm`. `public` schema USAGE is granted to `anon`/`authenticated`. | Which role creates a table determines its exposure. Product tables must not rely on defaults (§27). |
| Schema `auth` | A custom owner role has **no USAGE on `auth`**, and `postgres` **cannot grant it** (no grant option) | Affects who can create policies that call `auth.uid()` (§26, F-S2) |

## 24. TA-Q-29 managed results

### 24.1 Run history (honest record)

| Run | Outcome | Evidence artifact |
|---|---|---|
| 1 | Stopped at policy creation: `42501 permission denied for schema auth` (custom owner role can't reference `auth.uid()`). Fixed by creating policies with the bootstrap role, a member of the owner role. | Run log only |
| 2 | 21 of 22 passed. The one failure was a **harness bug** (it asserted "no context" on a value read *after* `bind_context`). | Not preserved (overwritten by run 3) |
| 3 | `42704 invalid role OID`: Supavisor reused pooled server connections of the **previous run's** roles, dropped and recreated under the same names (F-S3) | `spikes/ta-q-29-rls/evidence/ta-q-29-managed-run3-stale-pool-output.txt` |
| 4 | Supavisor began refusing **all** connections mid-bootstrap (`08006 … econnrefused`) for ≥45 minutes (F-S6) | Run log only |
| **5 (clean)** | **22 of 22 passed** with per-run login role names. Teardown: 0 roles, 0 schemas, 5/5 synthetic users deleted. | **`spikes/ta-q-29-rls/evidence/ta-q-29-managed-2026-10-04T14-32-40-076Z.txt`** (write-once) |
| after 5 | Supavisor again refused **all** connections immediately after run 5's teardown, and was **still refusing after ≥30 minutes** of passive polling. PostgreSQL itself was up (Auth Admin API read OK). The R8 rotation script couldn't start and was deliberately **not** retried (F-S6). | `…r8-pooler-outage-2026-10-04T14-34Z.txt` + `…r8-pooler-outage-addendum-2026-10-04T15-05Z.txt` |

**TA-Q-29 managed evidence of record: run 5.** Earlier runs are kept only as findings.

### 24.2 Requirement status (run 5, MANAGED, preserved)

| # | Requirement | Status | Evidence (run 5) |
|---|---|---|---|
| 1 | Real Supabase Auth identity verified server-side | **PASS** | Real access tokens (5 synthetic users) verified against the project JWKS: `alg ES256`, `kid` present. `auth.getClaims()` agreed on `sub`. Tampered payload, a re-signature with a foreign key and the same `kid`, and a corrupted signature were all rejected **before** any query. |
| 2 | Identity → transaction-local context without trusting client claims | **PASS** | Inside the transaction: **real** `auth.uid()` = token `sub`, `current_user = authenticated`, `session_user = spike_web_login_<run>`, workspace bound. Role set from a fixed literal; the token's `role` is only allowlist-checked. |
| 3 | No PostgREST JWT injection on direct connections | **PASS** | `authenticated` without app-set claims: `auth.uid()` NULL, `request.jwt.claims` empty, 0 tenant rows |
| 4–5 | Custom runtime roles safe | **PASS** | Read from the runtime's own catalog view: LOGIN only on the three `*_login_<run>` roles; logins NOINHERIT; all NOBYPASSRLS; none superuser. Every runtime login was denied `SET ROLE` to `service_role`, `postgres`, `supabase_admin`, `authenticator`, `anon`, the owner and the other runtime roles (`42501` each). |
| 6 | Supavisor transaction mode works with the pattern | **PASS** | All runtime traffic went through port 6543 as `<role>.<ref>`, using Drizzle over node-postgres |
| 7 | Prepared statements compatible with transaction pooling | **PASS** | Unnamed statements (the Drizzle/node-postgres default) throughout. A named statement reused across transactions also worked (`reused without error`). Recommendation unchanged: don't depend on named statements. |
| 8–9 | Context vanishes; reused backends serve A → B → none | **PASS** | 45 sequential transactions; 2 server backends, **both** served A1, B1 and no-context transactions in turn (example sequence `A1, none, B1, A1, none, B1, …`). Every transaction started with no claims, workspace or seal. Each saw only its own rows; no-context transactions saw 0. |
| 10–11 | Missing / foreign context fails closed | **PASS** | Missing context: 0 rows, inserts `42501`. Foreign filters/IDs: 0 rows. Bound to another org's or a non-member workspace, a random UUID, or a user with no memberships: 0 rows. Foreign update/delete: 0 rows; insert or move into B: `42501`; B unchanged. Composite FK: `23503`, identical for a foreign and a non-existent reference. Guest and attention-signal rules held with the real `auth.uid()`. |
| 12 | Worker can't escape its workspace | **PASS** | Query B from A: 0 rows. Rebind: `42501`. Raw `set_config`: 0 rows. Replayed seal: 0 rows. |
| 13 | System role: system metadata only | **PASS** | Reads its system table. Tenant tables, context helpers and `auth.users` denied. |
| 14 | Supabase default grants create no unexpected path | **PASS** | Canary table created by `postgres` in `public`: `anon`, `authenticated` and the runtime logins have **no SELECT** (Supabase default ACL grants only `Dxtm`). Data API with the publishable key: 404 before and 401 after enabling RLS (no data either way; the 404 is most likely the API's schema cache). `spike29` isn't exposed through the Data API (406). Runtime logins have no privileges of their own. `authenticated` can't read `auth.users`. All 8 spike tables have RLS enabled **and forced**. |
| 15 | Real `auth.uid()` composes safely | **PASS** | Policies call the real function. Membership, guest and attention rules behaved exactly as in the local spike. |
| 16 | No service-role credential in runtime | **PASS** | The runtime process environment contains no secret key, service-role key or bootstrap URL (asserted). All runtime work used the custom logins and real user tokens. |
| 17 | Direct Drizzle without the wrapper fails closed | **PASS** | Unscoped queries denied. A leftover session-level `SET ROLE authenticated` yields 0 rows. |
| 18 | Pooling stress | **PASS** | 300 concurrent user/worker transactions across 4 tenant contexts: **12 server backends, all 12 served multiple tenants**. Every result was the transaction's own workspace; no foreign row. |
| R2 | Buggy session-level state under Supavisor | **PASS (key finding reproduced)** | A session-level `app.workspace_id` + seal written outside a transaction **surfaced in 15 of 60 other clients' transactions**. The seal made it unusable: **0 rows leaked**. |

### 24.3 Supabase-specific findings

| ID | Finding | Implication |
|---|---|---|
| F-S1 | `postgres` bypasses RLS | Confirms R1: runtimes must use dedicated non-bypass login roles |
| F-S2 | A custom owner role can't reference `auth.uid()`, and `postgres` can't grant USAGE on `auth` | Policies that call `auth.uid()` must be created by a role with `auth` USAGE (migration role / `postgres`, as a member of the owner role). Extends **R4**. |
| F-S3 | Supavisor keeps pooled server connections per `<role>.<ref>`, and re-opens them between backend termination and `DROP ROLE` (3 orphaned backends after run 5's drop). Recreating a dropped role under the same name makes them fail (`invalid role OID`). `DROP OWNED` needs membership. | Part of **R8** |
| F-S4 | Session-level state crosses clients under transaction pooling (15/60, reproduced in run 5) | **Strongly supports R2** |
| F-S5 | Default privileges depend on which role creates objects in `public`: `postgres`-created tables give `anon`/`authenticated` no data access; `supabase_admin`-created ones grant full access | Create product tables outside `public` or with explicit grants; verify by introspection (R4) |
| F-S6 | **Twice**, right after spike login roles that Supavisor was actively pooling were terminated and dropped, Supavisor **refused every pooled connection for the whole project** (all roles, ports 5432 and 6543) for ≥45 minutes the first time. PostgreSQL stayed up (postmaster uptime continuous; Auth Admin API reads worked). The direct host is IPv6-only, so an earlier `ENOTFOUND` was this machine's lack of IPv6, not the project. Causality is strongly suggested (2/2) but not proven. | **Severe operational hazard for R8:** never drop or recreate a runtime login role that the pooler is serving. Rotate credentials with `ALTER ROLE … PASSWORD` or a new role name, drain the old pool, and drop only after Supavisor has released it. Confirm with Supabase support before any production rotation. |

## 25. TA-Q-04 managed results (Trigger.dev Development)

Execution model (DOC-VERIFIED, How it works): with `trigger.dev dev`, task code runs **on this machine**, while scheduling, queues, retries, idempotency and run state live in Trigger.dev's cloud. Authoritative state was a throwaway local PostgreSQL holding synthetic data. Evidence: `spikes/ta-q-04-jobs/evidence/ta-q-04-trigger-managed-output.txt` (**14/14**). An earlier run was 12/13; its one "failure" was the crash finding below.

| # | Property | Status | Evidence |
|---|---|---|---|
| 1 | Durable execution | **MANAGED PASS** | Outbox-dispatched runs completed; state reloaded from PostgreSQL |
| 2 | Run IDs / correlation | **MANAGED PASS** | Stable `run_…` IDs (handle = retrieve = id logged by the task). Outbox tags attached. `attemptCount`, `durationMs`, `startedAt`/`finishedAt` available. `costInCents` 0 in dev. |
| 3–4 | Idempotency key; duplicate dispatch | **MANAGED PASS** | Dispatcher crash after enqueue → redispatch with the same global key returned the **same run**. After success, the key still mapped to the original run. One execution. |
| 5–6 | Retries; backoff | **MANAGED PASS** | Transient failures retried and succeeded on attempt 3. Gaps 2.27 s → 3.10 s (configured `factor: 2`, 1 s minimum; observed gaps include scheduling latency). |
| 7 | Explicit non-retry | **MANAGED PASS** | `AbortTaskRunError` → FAILED after exactly 1 attempt |
| 8–9 | `concurrencyKey` per provider account | **MANAGED PASS** | Task `concurrency: { perKey: 1 }`: same-key runs never overlapped; different keys ran in parallel |
| 10 | Delayed execution | **MANAGED PASS** | `delay: "8s"` → status DELAYED with `delayedUntil`; executed after 9.6 s |
| 11 | Scheduling | **MANAGED PASS** (create/inspect/delete) · firing **NOT TESTED** | Imperative per-tenant schedule with IANA timezone: dedup key returned the same schedule, `nextRun` present, deleted. Firing wasn't awaited: the Free plan's minimum is hourly. |
| 12 | Cancellation | **MANAGED PASS** | Executing run cancelled → CANCELED; the task never reached "completed" |
| 13 | Long-running behavior / limits | **DOC-VERIFIED** (plus a 45 s run that started executing before cancellation) | `maxDuration` counts CPU time with waits excluded; 14-day run TTL; no task-duration timeouts on cloud. A dev-environment run TTL of 10 minutes applies to queued runs (SDK docs). |
| 14 | Failure / recovery | **MANAGED: key finding** | A worker **process crash** (`process.exit`) ends the run **CRASHED and it is NOT retried**, even with retries configured. The docs say the same: "crashed … won't be retried". **Recovery via the outbox was executed:** a run-outcome sweeper re-dispatched the CRASHED run with the same idempotency key, Trigger.dev created a **new** run (the key was released), and the domain effect happened **exactly once**. |
| 15 | Observability in Development | **MANAGED PASS** (API fields) · dashboard **DOC-VERIFIED** | Run retrieval exposes status, attempts, timing, tags and payload. Dashboard log retention on Free is 1 day. |
| 16 | Payload privacy | **MANAGED PASS** | Payloads **as stored by Trigger.dev** (retrieved back for 24 runs) contained exactly `{outboxId, workspaceId, entityId}` and no comment text |
| 17 | Outbox compatibility | **MANAGED PASS** | DB transaction → outbox → dispatcher → `tasks.trigger` by IDs → task reloads PostgreSQL → idempotent operation. The domain code (`lib/outbox.mjs`) is unchanged and uses the `JobRuntime` port; Trigger.dev appears only in the adapter. |
| 18 | Vendor ≠ domain idempotency | **MANAGED PASS** | Two runs without a key both executed; the domain wrote one assessment (`assessed`, `skip_duplicate`) |
| 19 | Unknown outcome → reconciliation, no blind resend | **MANAGED PASS** | Reply accepted by the platform but timed out: `outcome_unknown`, no runtime retry. A redelivered run did not call the provider. Reconciliation confirmed it. **Exactly 1 provider call and 1 reply.** Hide timeout: retried (state-setting), confirmed. |
| 20 | Development plan sufficiency | **DOC-VERIFIED + MANAGED** | Dev runs aren't charged (pricing). Dev concurrency 25 on Free (limits). All tests ran on Free/Development at no cost. **Sufficient for MVP development.** Production will need a paid plan for concurrency, log retention (1 day on Free), static IPs to the database and more frequent schedules (cost model: TA-Q-23). |
| — | Deployed (cloud) worker behavior | **NOT TESTED** | Deploying to a Trigger.dev staging or production environment wasn't authorized in this phase. Validate in staging before production (crash semantics, static IPs to Supabase, worker login role over Supavisor). |

## 26. Data residency and privacy (Trigger.dev)

| Question | Answer | Class |
|---|---|---|
| Where customer data (payloads, run state) is stored | DPA §4.1: "Trigger.dev stores data in a multi-tenant environment in **AWS East-1**", replicated across geographically dispersed data centres | DOC-VERIFIED ([DPA](https://trigger.dev/legal/dpa)) |
| Logs | Sub-processors include Axiom (USA, logging), ClickHouse (USA, real-time analytics database) and AWS (USA) | DOC-VERIFIED ([Sub-processors](https://trigger.dev/legal/subprocessors)) |
| Large payloads / outputs | Payloads over 128 KB are offloaded to object storage; outputs up to 10 MB | DOC-VERIFIED ([Limits](https://trigger.dev/docs/limits)) |
| Regions | Worker execution regions `us-east-1`, `eu-central-1` (launch post). The DPA states storage is in AWS East-1. | DOC-VERIFIED |
| Retention (Free) | Logs 1 day. On termination, personal data is deleted within 90 days (DPA §11.2). | DOC-VERIFIED |
| DPA / transfers | DPA available; SCCs for transfers out of UK/EEA (§13.1); SOC 2 Type II and GDPR stated | DOC-VERIFIED |
| What we send | IDs only: **proven** on stored payloads (§25 #16). Task logs must never include content (code rule). | MANAGED |

**DATA RESIDENCY: VERIFIED** (documented: United States, AWS us-east-1). Whether US storage of job identifiers, run metadata and logs is acceptable for LatAm customers is a **legal decision (TA-Q-05)**. It is not a technical blocker, because payloads carry only identifiers.

## 27. Architecture refinements after managed testing

| ID | Refinement | Managed verdict |
|---|---|---|
| R1 | Dedicated non-bypass runtime login roles | **SUPPORTED**: `postgres` bypasses RLS (F-S1); custom NOINHERIT/NOBYPASSRLS logins worked through Supavisor and couldn't escalate (run 5) |
| R2 | Sealed, transaction-bound workspace context | **SUPPORTED, strongly**: session state crossed clients 15/60 under transaction pooling; the seal leaked 0 rows (F-S4, run 5) |
| R3 | Fixed-literal `SET LOCAL ROLE` | **SUPPORTED**: role never taken from the token; escalation attempts denied (run 5) |
| R4 | Forced RLS + explicit owner/helper policies and grants | **SUPPORTED, with an extension**: also needs policies calling `auth.uid()` to be created by a role with `auth` USAGE (F-S2), and table creation outside default-privilege surprises (F-S5) |
| R5 | Workspace-scoped composite FKs | **SUPPORTED**: `23503` identical for foreign vs non-existent references (run 5) |
| R6 | Domain idempotency + OUTCOME_UNKNOWN | **SUPPORTED**: executed on Trigger.dev (§25 #18–19) |
| **R7 (new)** | The outbox tracks each dispatched run's terminal status; a **run-outcome sweeper** re-dispatches CRASHED / SYSTEM_FAILURE runs | Required because Trigger.dev doesn't retry crashed runs (doc + executed); recovery proven (§25 #14) |
| **R8 (new)** | Database role rotation procedure under Supavisor | **Required, severity raised**: recreating a pooled role name breaks pooled connections (F-S3, run 3), and dropping actively pooled roles was followed twice by project-wide pooler refusal (F-S6). Runtime login roles must be long-lived; rotate passwords in place or move to new role names with a drained pool; confirm with Supabase support before production. |

None contradicts the architecture. **ARCHITECTURE RECONSIDERATION REQUIRED: NO.**

## 28. Cleanup state

| Resource | State |
|---|---|
| Synthetic Supabase Auth users | All deleted. Auth Admin API after run 5 reports **0 users** in the project. |
| Supabase `spike29*` schemas, `spike_*` roles, `public.spike29_canary` | **0 / 0 / 0** after run 5 (teardown report). Run 4 left nothing (checked before run 5). |
| Orphaned Supavisor backends | Run 5 teardown terminated 3 orphaned backends of dropped roles. A final pooler-side check isn't possible while Supavisor refuses connections (F-S6). |
| `r8-rotation.mjs` | Never connected (pooler refusal), so it made no changes. Deliberately not re-run. |
| Trigger.dev Development | Run history remains in the dashboard (synthetic IDs only; Free log retention 1 day). The test schedule was deleted. No deployments. Dev CLI stopped. |
| Local | No PostgreSQL or Trigger.dev processes running. Ephemeral `.data/` directories deleted. |

## 29. Remaining gates after Phase 0E.2b

| Gate | Status | Next action |
|---|---|---|
| TA-Q-29 | **PASS** (local + managed, preserved evidence) | Turn the managed suite into the permanent tenant-isolation regression suite (TA §55) |
| TA-Q-04 | **PASS**, Trigger.dev selected | Legal confirmation of US storage (TA-Q-05). Validate deployed workers in staging before production. Implement R7. |
| R8 / F-S6 | Operational hazard | Ask Supabase support about project-wide pooler refusal after dropping pooled roles. Define the rotation runbook before any production credential rotation. |
| Refinements R1–R8 | Supported | Record in a Technical Architecture update after this review |
| Supavisor availability for the dev project | **Still refusing** pooled connections after ≥30 minutes of passive polling (until 2026-10-04T15:04Z; PostgreSQL up) | User: restart the project or pooler from the dashboard, and report F-S6 to Supabase support |

## 30. Acceptance record (Phase 0E.3)

| Date | Phase | Record |
|---|---|---|
| 2026-10-04 | 0E.3 | The Phase 0E.2b managed validation review is **accepted and completed**. TA-Q-29 **PASS** and TA-Q-04 **PASS** (Trigger.dev selected; Graphile Worker fallback) are recorded in `docs/technical-architecture-v1.md` **v1.1**. Refinements R1–R8 (§27) are adopted there (§9.3, §10.4, §11.6, §11.7, §18.3, §19.3, §26.3, §65; ADR-56–ADR-63). F-S6 is recorded there as an operational pooler incident of the development project (correlation, not proven causation), not a TA-Q-29 failure (TA §11.7). Follow-ups are tracked as TA-Q-05 (legal acceptability of Trigger.dev data in AWS us-east-1), TA-Q-30 (R8 rotation procedure with Supabase), TA-Q-31 (deployed workers in staging) and TA-Q-32 (Trigger.dev production plan sizing and cost). Nothing above this section was re-run or rewritten; all evidence files are preserved unchanged. Remaining before implementation: the architecture checkpoint and the repository `CLAUDE.md`. |
| 2026-10-04 | 0E.3 (checkpoint corrections) | **Clarification:** historical references in this document that tie Trigger.dev pricing or production cost to TA-Q-23 (e.g., §13.2 "Cost model needed (TA-Q-23)", §25 #20) are now tracked as **TA-Q-32** (Trigger.dev production plan sizing and cost) in TA v1.1. TA-Q-23 remains the AI unit-cost model. Also clarified in TA v1.1: TA-Q-29 PASS validates R1–R5; R8 is a separate operational lifecycle principle whose procedure stays VALIDATE under TA-Q-30, and shared Supavisor projects must not routinely create → pool → drop login roles (TA §11.7). The evidence sections above are unchanged. |
