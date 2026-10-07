# Social Conversation Intelligence Platform

Implementation rules live in [`CLAUDE.md`](CLAUDE.md); the approved design documents live in [`docs/`](docs/).
`spikes/` holds disposable validation spikes with their own isolated dependencies; they are not part of the application.

## Requirements

- Node.js 22 (see `.nvmrc`), npm

## Install

```sh
npm ci
```

## Local authentication (optional)

Sign-in uses Supabase Auth. To try it locally, copy `.env.example` to `.env.local` (git-ignored) and fill in the public project URL, the publishable key and `APP_BASE_URL`. Never add a service-role or secret key: the application doesn't use one. Without configuration the app builds and runs, and sign-in reports that it isn't available.

## Foundation commands

| Command | What it checks |
|---|---|
| `npm run lint` | ESLint (TypeScript strict type-checked rules, React) |
| `npm run typecheck` | Generates Next.js route types, then `tsc --noEmit` |
| `npm run boundaries` | Architectural dependency boundaries (dependency-cruiser, `.dependency-cruiser.cjs`) |
| `npm run test` | Unit and architecture tests (Vitest), including static migration lint and credential/role-lifecycle guards |
| `npm run test:db` | Database suites on a disposable local PostgreSQL 17 (embedded; no Docker, no secrets) |
| `npm run secret-scan` | Scans files git would track for credential-shaped values (prints locations only) |
| `npm run audit` | `npm audit` over all dependencies |
| `npm run build` | Next.js production build |
| `npm run verify` | All of the above, in CI order |

CI (`.github/workflows/ci.yml`) runs the same checks on every push to `main` and on pull requests.

## Database

PostgreSQL with Drizzle over node-postgres. Structure, RLS, grants and constraints live in version-controlled
SQL migrations (`db/migrations/`); Drizzle mappings only type queries. Every table is classified in
`db/schema/classification.ts`, and CI compares that registry with the live catalog.

- **Runtime** connects only as a dedicated long-lived login role per process (`web_login`, `worker_login`,
  `system_login`) through the Supavisor **transaction** pooler, and reaches data only through the scope helpers
  in `platform/db` (fixed-literal `SET LOCAL ROLE`, transaction-local claims, sealed workspace binding).
  It never holds the migration credential or a service-role key.
- **Migrations and role provisioning** are tooling, run deliberately with the privileged credential:

| Command | What it does |
|---|---|
| `npm run db:preflight [-- --connect]` | Checks `.env.local` points at the expected project (and not the frozen validation project); with `--connect`, reports connectivity and role names. Read-only. |
| `npm run db:migrate [-- --apply]` | Prints a secret-free plan; applies pending migrations only with `--apply`. Never drops anything. |
| `npm run db:provision-roles [-- --apply [--rotate]]` | Creates the three login roles if absent (passwords taken from the runtime URLs, sent as SCRAM verifiers) or validates them; `--rotate` changes passwords in place. Never drops or recreates a role (R8). |
| `npm run test:db:managed` | The same isolation, concurrency, persistence and introspection suites against the managed development project. Reports **NOT RUN** (exit 2) when its configuration is absent. |

**Database CA.** TLS to a managed endpoint always verifies the server certificate and host name. A runtime gets
the CA either as a path (`DATABASE_SSL_ROOT_CERT`, local development) or as PEM content
(`DATABASE_SSL_ROOT_CERT_PEM`, deployed workers; `\n` escapes accepted). PEM content wins when both are set. With
neither, managed connections are refused. The content is never logged, written to disk or put in an error.

Configuration names are listed in `.env.example`; values go only in `.env.local`. Runtime login roles are
long-lived: no script, test or migration may drop, rename or recreate them (enforced by a repository guard).

## Jobs

Background work runs on Trigger.dev (selected, TA-Q-04) behind the vendor-neutral `JobRuntime` port in
`platform/jobs`. Product code never enqueues directly: a command appends an IDs-only row to the transactional
outbox in its own transaction; after commit the web nudges the **system relay**, which dispatches the row under
its stable dispatch key. Scheduled sweepers re-dispatch lost rows (`outbox.dispatch_sweep`) and observe run
outcomes (`outbox.outcome_sweep`, R7: CRASHED/SYSTEM_FAILURE re-dispatched within a bound; FAILED/CANCELED
recorded and surfaced, never blindly re-dispatched). Effects are protected by domain idempotency
(`idempotency.effect_keys`, R6), claimed in the same transaction as the effect.

- Tenant jobs run as `worker_login` bound to exactly one workspace; the named system jobs run as `system_login`.
- Five priority lanes, each its own bounded queue (`platform/jobs/lanes.ts`), plus a system delivery queue.
- Operational switches and kill switches (TA §66) live in `system.operational_switches`; runtimes only read
  them. Changes go through `npm run ops:switch` (dry run unless `--apply`), which records who and why.

| Command | What it does |
|---|---|
| `npm run ops:switch -- set\|clear --key … --scope … [--qualifier …] [--value '{…}'] --operator <id> --reason <code> [--apply]` | Audited operator change to one switch on the configured development project. |
| `npm run test:jobs:managed` | T-27 managed leg on the Trigger.dev **DEVELOPMENT** environment (crash → R7 → new run → one effect). Reports **NOT RUN** (exit 2) without `TRIGGER_SECRET_KEY` / `TRIGGER_PROJECT_REF`; refuses non-`tr_dev_` keys. |

The Trigger.dev **CLI is not a repository dependency**. Run it only as a pinned, ephemeral tool
(`npx trigger.dev@4.7.2 …`), e.g. `npx trigger.dev@4.7.2 login` once for your own CLI session. The repository
itself must stay `npm audit` clean; a guard fails CI if the CLI enters the dependency tree or if any resolved
`ws` is below 8.21.0 (pinned through `overrides`).

## Providers

Social platforms are reached only through the provider adapter contract in `integrations/providers/contract`
(TA §15): a READ port (discovery, listing, re-fetch, current state, paid context, webhook parsing, subscriptions,
credential refresh) and a separate MUTATION port (public reply, private reply, hide, unhide, delete, block) that
only the Platform Mutation Executor may obtain. DTOs carry provider identity, provider timestamps and an opaque
raw reference; errors are normalized (`RateLimited`, `Transient`, `PermissionMissing`, `TargetNotFound`,
`TargetNotEligible`, `CredentialInvalid`, `PermanentRejected`, `OutcomeUnknown`). There is no direct-message
read surface.

No real Meta or TikTok adapter exists yet. `integrations/providers/simulator` implements both ports from
synthetic scenarios in `fixtures/providers/simulator/` (deterministic, resettable, with explicit fault
injection and no network). **Simulator support means the architecture can represent a behavior, not that a real
platform supports it**: every platform capability stays VALIDATE until official API validation (PD OQ-18,
OQ-19, OQ-26, OQ-27).

- The reusable contract suite (`tests/providers/contract`) runs against the simulator in `npm run test`; real
  adapters will run the same suite from recorded, sanitized fixtures.
- Golden files in `fixtures/providers/golden/` pin the normalized output. After an intended change, regenerate
  them with `UPDATE_GOLDEN=1 npx vitest run tests/providers/golden.test.ts` and review the diff. CI never
  regenerates them.

**Authorization port** (`contract/authorization-port.ts`, Step 5C). An authorization-code grant has three
parts: build the authorization URL from a caller-supplied state, an exact redirect URI (a query is allowed and
matched exactly) and an optional S256 PKCE challenge; parse the callback into a closed outcome (`code`,
`denied` or `malformed`); and exchange the code for a `ProviderCredential`, its expiry and opaque granted scopes. The authorization code, the PKCE verifier
and the issued credential are `SecretValue`s.

The port does no state/CSRF matching, persistence, sealing or retries. Those belong to the caller (Step 5D).
The simulator implements it in all three PKCE modes (`required`, `supported`, `not_supported`) and has a
simulated consent screen (`simulateConsent`). Its codes are single-use and are consumed only when a credential
is issued. A response lost after the exchange is `OutcomeUnknown`: the code may already be redeemed, so it is never
replayed blindly. This is simulator contract behavior, not evidence about Meta or TikTok OAuth: PD OQ-18, OQ-19,
OQ-26 and OQ-27 stay VALIDATE.

## Credential crypto

Provider credentials are protected by envelope encryption (TA §39; TA-Q-07 PASS, ADR-64), in
`platform/crypto/credentials`. Each record gets a fresh 256-bit data key and AES-256-GCM encryption, and the
data key is wrapped by a key-encryption key. Both the wrapped key and the payload are bound to the
authenticated context `app · purpose · env · v · workspace_id · credential_id`.

- **`CredentialSealer` seals only.** It is what the web deployment may hold.
- **`CredentialOpener` opens.** Boundary rules allow it only in the job runtime.
- **The local keyring is for development and tests only.** `LOCAL_KEYRING_KEY` must be exactly 32 bytes in
  unpadded base64url, and the keyring is refused unless `NODE_ENV` is `development` or `test`. The AWS KMS
  adapter (slice 5I) is not added yet.

## Connections (Step 5D)

`modules/connections` owns the authorization round trip, the Connection lifecycle and discovered assets
(migrations 0007, 0008). Only the **provider simulator** can be connected; real Meta/TikTok OAuth stays VALIDATE.

- **Start** (Owner/Admin, `connections.manage`; allowed in Monitor-only, it is configuration): the OAuth state
  is `v1.<workspace>.<256-bit nonce>`. Only its SHA-256 is stored. The workspace prefix is routing, never
  authentication.
- **PKCE without storage** (decision B1): the verifier is derived with HMAC-SHA256 from the state and the
  web-only `OAUTH_PKCE_DERIVATION_KEY` (exactly 32 bytes, 43-char unpadded base64url; no default). It is
  derived again at the callback and never persisted.
- **Callback**: the adapter parses the query, then the application matches the digest to the caller's own
  pending attempt and claims it (`PENDING → EXCHANGING`) before the single code exchange. A replayed or
  concurrent callback can't exchange again. Failures close the attempt as `EXCHANGE_FAILED` with a closed
  code, or `OUTCOME_UNKNOWN`, and the code is never replayed.
- **Credentials**: the issued credential becomes bytes, is sealed at once (web: sealer only) and is stored
  as an envelope with the Connection in one transaction. Discovery runs in the job runtime
  (`connections.discover_assets`), which alone opens envelopes.
- **Removal** marks the Connection `REMOVED`, clears the pointer and crypto-shreds the envelope.

The web callback route is `app/api/oauth/[provider]/callback`. Both runtimes refuse `LOCAL_KEYRING_KEY`
outside development/test. The simulator world is process-local, so a cross-process local run (web + jobs)
does not share issued credentials; that end-to-end path is Step 5J.

## Capability (Step 5E)

`modules/capability` answers "for this Connected Account, content type, source and capability, can the product do it
right now, and why?" in three separate layers (TA §16). Migration 0009 stores the profiles.

1. **Platform Capability Catalog** is code-versioned reference data. The **platform** catalog (Facebook,
   Instagram, TikTok through real adapters) has **no entries**: everything is `UNKNOWN_NOT_VALIDATED` until
   real-provider API validation produces evidence-backed entries (PD OQ-18, OQ-19, OQ-27 stay VALIDATE). The
   **simulator** catalog is simulator contract behavior only. It is selected only for the simulator provider and
   refused outside development/test.
2. **Account Capability Profile** is computed by a pure function: catalog + normalized `describeAccount` facts +
   explicit observations → profile. It is stored per Connected Account with the integer catalog revision, the
   inputs, the reasons and the as-of time. Freshness: a higher catalog revision wins; within a revision, newer
   inputs win; same revision and same time with different content is a **conflict** and is rejected. The digest
   is used only for equality, never for ordering.
3. **Runtime overlay**: connection health turns a usable capability into `TEMPORARILY_UNAVAILABLE` without
   rewriting the stored profile.

The evaluation never reads data volume. Only `PermissionMissing` and `TargetNotEligible(unsupported_for_target)` are
observations; transient and rate-limited outcomes never change a profile. After every activation (Step 5F) the job
`capability.evaluate_account` calls `refreshAccountCapabilities` for the new account.

## Connected Accounts and Moves (Step 5F)

`modules/connections` also links, unlinks and moves Connected Accounts (migration 0010). This is configuration, so
it is allowed in Monitor-only. No provider is called in these transactions.

- **Link** (Owner/Admin): the asset must have been discovered by one of the workspace's own ACTIVE Connections. An
  INACTIVE row is reactivated; otherwise a row is inserted. Linking again is a no-op. Capability evaluation is
  enqueued after activation.
- **Unlink**: ACTIVE → INACTIVE (`UNLINKED`). No credential is shredded and no data is deleted. The slot is freed.
- **M-01** (content assets) and the **TEMPORARY TA-Q-02** rule (ad accounts) are two separately named unique indexes.
  The database decides. Each has its own closed reason (`ASSET_ACTIVE_ELSEWHERE` vs
  `AD_ACCOUNT_SINGLE_WORKSPACE_PENDING_VALIDATION`). A refusal names the other workspace only to a user who can read
  it; anyone else sees "active in another workspace in your organization". Other organizations are never visible.
- **Move** (decision D4) is a saga with one transaction per workspace: request in the destination → release in the
  source → activation (or rejection) in the destination. Each workspace keeps its own `asset_moves` row. Saga audit is
  attributed to the human initiator through `connections.record_move_audit`. The initiator's Owner/Admin authority is
  re-checked live in each workspace. A failed activation never restores the source.
- **Routing**: every saga outbox row is created by `connections.route_move_step`. Web and worker can't append the saga
  topics themselves (a restrictive policy). A human retry is routed too, as a new activation attempt with its own
  idempotency key. Correlation ids passed to the definers are trace metadata only.
- **Rejections**: the source keeps its exact reason (`AUTHORITY_REVOKED`, `SOURCE_NOT_ACTIVE`). The destination only
  records `SOURCE_RELEASE_REJECTED`: the source could not be released and the move did not proceed.
- **Delivery**: after a transaction commits, any rows it appended or routed wake the system relay (web and job runtime
  alike). The dispatch sweeper only recovers a lost wake-up.
- **Already active in the destination**: the move completes on that account and its completion is audited once
  (`moved_in`). No second account, `MOVED_IN` event or capability evaluation is created.
- `connections.account.list` (read-only, `workspace.read_operational`) lists the workspace's Connected Accounts:
  identifiers, dimensions and status only.

## Hosted web (TA-11A)

The web runtime is prepared for hosting (Vercel recommended, TA-11) without changing the architecture.

- **Environment contract.**
  - Required secret: `DATABASE_WEB_URL` (`web_login` through the transaction pooler).
  - Required config: `DATABASE_SSL_ROOT_CERT_PEM`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
    `APP_BASE_URL` (the deployment's stable HTTPS origin; its `/auth/callback` must be in Supabase Auth's redirect
    allowlist exactly, never as a wildcard).
  - Not needed for TA-11A: `TRIGGER_SECRET_KEY` / `TRIGGER_PREVIEW_BRANCH` (only the post-commit wake-up uses them;
    it stays best effort), `OAUTH_PKCE_DERIVATION_KEY`, `LOCAL_KEYRING_KEY`, any provider or AWS/KMS credential.
  - **Refused**: a production-built web instance answers 503 to every request if any of `DATABASE_WORKER_URL`,
    `DATABASE_SYSTEM_URL`, `DATABASE_MIGRATION_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEY`,
    `TRIGGER_PREVIEW_SECRET_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`,
    `SUPABASE_PROJECT_REF`, `TRIGGER_PROJECT_REF`, `APP_DEPLOYMENT_ENV` or `CAPABILITY_PROVIDER_MODE` is set (even
    empty). The log names the variable, never its value. Development and test runtimes are exempt.
- **Security headers** on every response: `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`,
  `object-src 'none'`, `X-Frame-Options`, `nosniff`, `Referrer-Policy: no-referrer`, a deny-all
  `Permissions-Policy`, and HSTS. A full script/style CSP needs per-request nonces and is **not** claimed yet.
- **Cookies**: Supabase session cookies carry `Secure` outside development/test; `SameSite=Lax` is unchanged.
- **Pool**: one connection per hosted web instance; local development keeps 4.
- **Health**: `GET /api/health` answers `200 {"status":"ok"}` after one round trip through the real web pool
  (guards, `web_login`, pooler, verified TLS), or a generic `503 {"status":"unavailable"}`. It is never cached.
- **Provider connections** stay unavailable in any hosted runtime: the simulator and the local keyring are refused
  outside development/test. They arrive with real OAuth adapters and KMS (5I).

**TA-11A will validate** the hosted Next.js build and runtime, HTTPS, Supabase Auth sign-in and session, Secure
cookies, `web_login` over verified TLS through the transaction pooler, tenant/workspace RLS with the read operations
the product has today, the refusal of privileged credentials, the headers, the health endpoint, and the absence of
provider and production credentials. It does **not** claim a hosted domain-command commit, the hosted web → Trigger.dev
post-commit wake-up, provider OAuth or API calls, or KMS. Those are **TA-11B** (the first real product surface that
runs a domain command through the pipeline) and later gates. **TA-11 stays OPEN until TA-11B is done.**

**Deferred: schema-version marker (TA §63.2).** Web and jobs don't yet check that the database schema matches the
code they were built from. Until they do, deploying web or jobs against a database at a different migration level
isn't refused up front: it fails later, at the first query that touches a missing or changed object. The mitigation
until then: expand-only migrations, apply migrations before deploying, and deploy web and jobs from the same commit.

## Deployed non-production validation (TA-Q-31)

A deployed job worker is a production build (`NODE_ENV=production`), so the explicit tier `APP_DEPLOYMENT_ENV`
(`preview` or `staging`) decides what may run in it, never `NODE_ENV`.

- **Providers**: `CAPABILITY_PROVIDER_MODE=staging_stub` composes a synthetic, I/O-free adapter
  (`integrations/providers/staging-stub`). It makes no provider call and needs no provider credential. It never
  opens a credential envelope. It describes accounts with no permissions, so every capability stays
  `UNKNOWN_NOT_VALIDATED`. The task handlers are the production ones; only the adapter composition differs. It is
  refused for any other tier, including `production` and unset. The simulator stays development/test only.
- **Database CA**: supplied as `DATABASE_SSL_ROOT_CERT_PEM`. The worker gets only the worker and system database
  URLs, never the web or migration URL.

**Validation-window rules** (TA-Q-31). The deployed validation uses an **ephemeral Trigger.dev Preview branch** that
points temporarily at `social-intelligence-dev-v2`, with `APP_DEPLOYMENT_ENV=preview` and
`CAPABILITY_PROVIDER_MODE=staging_stub`. While it is live:

- no `test:db:managed` suite runs, and nothing else seeds pending outbox work into dev-v2 (the Preview worker's real
  schedules, including the sweepers, would deliver it);
- only synthetic validation entities are used and no provider credential is configured;
- the branch is archived after validation and cleanup.

These are operating rules for a short window, not a product feature: there is no lock or schema support for them.

**CLI** (pinned `trigger.dev@4.7.2`, operator login profile, never a repository dependency):
- deploy: `deploy --env preview --branch <name>` (build from the local checkout; no git push);
- variables: `env list --env preview --branch <name>` lists names only unless `--show-values` is passed;
- archive: `preview archive --branch <name>`.

Every `env` and `deploy` command defaults to **prod**, so pass `--env` and `--branch` explicitly. Set secret values
in the dashboard, not as CLI arguments.

## Known tooling limitation

Next.js-specific lint rules (`eslint-config-next` / `@next/eslint-plugin-next`) are temporarily not used: their dependency chain carries an unresolved high-severity advisory (GHSA-vfj7-8cjw-p6xm, `braces`) with no patched version, and `npm audit` is not suppressed. Linting currently covers TypeScript (strict, type-checked) and React. Revisit when an audit-clean official option exists.
