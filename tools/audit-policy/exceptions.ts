/**
 * Temporary dependency-audit exceptions (Step H7-D1b-sec1; TL decision 2026-10-31). The list is EXACT and short-lived:
 * one entry per advisory identity, each with an expiry after which CI fails closed unless the TL renews it. It is not a
 * general waiver framework — an empty list is the normal state.
 *
 * GHSA-g3hv-75wg-m249 — minimatch "potential denial of service via globparts amplification" (moderate, published
 * 2026-10-30, affected range < 11.0.1, first patched 11.0.1). Evidence (H7-D1b-sec0, isolated analysis at 31d0b0a):
 *   - development / lint tooling only: eslint 9.39.5, @eslint/config-array 0.21.2, @eslint/eslintrc 3.3.7 and
 *     eslint-plugin-react 7.37.5 → minimatch 3.1.5; typescript-eslint 8.71.0 → @typescript-eslint/typescript-estree →
 *     minimatch 10.2.6. Every node is `dev` in the lockfile; `npm audit --omit=dev` reports 0; no runtime exposure;
 *   - minimatch 3.1.5 does not contain the vulnerable preprocessing (`firstPhasePreProcess` / `optimizationLevel`);
 *   - minimatch 10.2.6 contains it, but the branch needs `optimizationLevel >= 2`; no consumer sets it (default 1) and
 *     the patterns are repository configuration, not external input;
 *   - no compatible parent upgrade exists (latest eslint ^10.2.6, eslint-plugin-react ^3.1.2, typescript-estree
 *     ^10.2.2, @eslint/eslintrc ^3.1.5) and no 3.x / 10.x backport exists;
 *   - forcing minimatch 11.0.1 is API-incompatible: eslint-plugin-react calls `require("minimatch")` as a function and
 *     crashes ESLint (`TypeError: minimatch is not a function`, proven by a synthetic lint probe).
 * Removal: as soon as the advisory disappears from the full audit (a 3.x / 10.x backport, a corrected advisory range,
 * or parents adopting a patched minimatch) the policy reports STALE_EXCEPTION_DETECTED and this entry must be deleted.
 */

export const AUDIT_SEVERITIES = ["info", "low", "moderate", "high", "critical"] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

export interface AuditException {
  /** The canonical GitHub advisory identifier — the ONLY key an exception matches on. */
  readonly advisory: string;
  /** The vulnerable package the advisory is reported on (an extra constraint, never a key by itself). */
  readonly package: string;
  /** The highest severity the exception tolerates; a higher reported severity fails. */
  readonly maxSeverity: AuditSeverity;
  /** Only development dependencies are ever covered; production / runtime advisories always fail. */
  readonly scope: "dev";
  readonly authorizedOn: string;
  /** Inclusive last valid day (UTC). */
  readonly expiresOn: string;
  readonly reason: string;
  readonly remediation: string;
}

export const AUDIT_EXCEPTIONS: readonly AuditException[] = Object.freeze([
  Object.freeze({
    advisory: "GHSA-g3hv-75wg-m249",
    package: "minimatch",
    maxSeverity: "moderate",
    scope: "dev",
    authorizedOn: "2026-10-31",
    expiresOn: "2026-11-30",
    reason: "dev/lint-only minimatch; 3.1.5 lacks the vulnerable code; 10.2.6 branch (optimizationLevel >= 2) unused; no compatible patched parent; minimatch 11 breaks eslint-plugin-react",
    remediation: "remove this entry when the advisory leaves the full audit (3.x/10.x backport, corrected advisory range, or parents on a patched minimatch)",
  } satisfies AuditException),
]);
