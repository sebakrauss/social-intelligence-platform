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
| `npm run test` | Unit and architecture tests (Vitest) |
| `npm run secret-scan` | Scans files git would track for credential-shaped values (prints locations only) |
| `npm run audit` | `npm audit` over all dependencies |
| `npm run build` | Next.js production build |
| `npm run verify` | All of the above, in CI order |

CI (`.github/workflows/ci.yml`) runs the same checks on every push to `main` and on pull requests.

## Known tooling limitation

Next.js-specific lint rules (`eslint-config-next` / `@next/eslint-plugin-next`) are temporarily not used: their dependency chain carries an unresolved high-severity advisory (GHSA-vfj7-8cjw-p6xm, `braces`) with no patched version, and `npm audit` is not suppressed. Linting currently covers TypeScript (strict, type-checked) and React. Revisit when an audit-clean official option exists.
