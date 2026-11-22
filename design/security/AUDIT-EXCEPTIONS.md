# Dependency-audit exceptions

CI runs the FULL `npm audit` through `tools/audit-policy/cli.ts` (Step H7-D1b-sec1): every advisory fails unless it is
listed EXACTLY in `tools/audit-policy/exceptions.ts` (GHSA id, package, maximum severity, dev-only scope, expiry), and a
production finding (`npm audit --omit=dev`) always fails. An expired exception fails; an exception whose advisory no
longer appears fails as `STALE_EXCEPTION_DETECTED` and must be deleted. The normal state is an empty list.

**Active exceptions: none** (since DEPS-01).

## GHSA-g3hv-75wg-m249 — minimatch (moderate) · authorized 2026-10-31 · expires 2026-11-30 · **CLOSED (DEPS-01)**

- **Closed:** remediated; the exception was removed, not renewed.
  - The advisory range was narrowed on 2026-11-04 to `>= 7.0.0, < 11.0.1`, so minimatch 3.1.5 (eslint, @eslint/config-array, @eslint/eslintrc, eslint-plugin-react) is not affected and is unchanged.
  - The only affected node (typescript-eslint 8.71.0 → @typescript-eslint/typescript-estree → minimatch 10.2.6) is pinned to **11.0.9** by a `package.json` override **scoped to `@typescript-eslint/typescript-estree`**. No top-level minimatch override exists: that would break eslint-plugin-react.
  - typescript-estree calls minimatch once, `minimatch(filePath, pattern, { dot: true })`, only for `parserOptions.projectService.allowDefaultProject`, which this repository does not set. The call is identical in 8.71.0, 8.72.2 and 8.73.0, and 8.73.0 itself depends on `^11.0.1`.
  - Remove the override when typescript-eslint is upgraded to ≥ 8.73.0 (a separate lint-remediation gate: 8.73.0's `strictTypeChecked` reports 14 new findings in tracked product code).

*Original record (kept as history):*

- **Why:** reported on 2026-10-30 for every minimatch below 11.0.1; no compatible remediation exists (H7-D1b-sec0).
- **Evidence:** dev/lint tooling only (eslint, @eslint/config-array, @eslint/eslintrc, eslint-plugin-react → 3.1.5;
  typescript-eslint → typescript-estree → 10.2.6); every node `dev` in the lockfile; `--omit=dev` = 0; no runtime
  exposure. minimatch 3.1.5 does not contain the vulnerable preprocessing; in 10.2.6 the vulnerable branch needs
  `optimizationLevel >= 2`, which no consumer sets. Forcing minimatch 11.0.1 is API-incompatible: eslint-plugin-react
  calls `require("minimatch")` as a function and ESLint crashes.
- **Removal:** delete the entry as soon as the advisory leaves the full audit (the policy flags it as stale).
- **Watch:** a 3.x / 10.x backport; a corrected advisory range (3.x lacks the code); eslint, @eslint/eslintrc,
  eslint-plugin-react and typescript-estree adopting a compatible patched minimatch. Renewal after 2026-11-30 needs an
  explicit TL decision.
