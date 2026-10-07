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

## Known tooling limitation

Next.js-specific lint rules (`eslint-config-next` / `@next/eslint-plugin-next`) are temporarily not used: their dependency chain carries an unresolved high-severity advisory (GHSA-vfj7-8cjw-p6xm, `braces`) with no patched version, and `npm audit` is not suppressed. Linting currently covers TypeScript (strict, type-checked) and React. Revisit when an audit-clean official option exists.
