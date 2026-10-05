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

## Known tooling limitation

Next.js-specific lint rules (`eslint-config-next` / `@next/eslint-plugin-next`) are temporarily not used: their dependency chain carries an unresolved high-severity advisory (GHSA-vfj7-8cjw-p6xm, `braces`) with no patched version, and `npm audit` is not suppressed. Linting currently covers TypeScript (strict, type-checked) and React. Revisit when an audit-clean official option exists.
