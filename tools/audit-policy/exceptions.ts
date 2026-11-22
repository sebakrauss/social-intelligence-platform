/**
 * Temporary dependency-audit exceptions (Step H7-D1b-sec1; TL decision 2026-10-31). The list is EXACT and short-lived:
 * one entry per advisory identity, each with an expiry after which CI fails closed unless the TL renews it. It is not a
 * general waiver framework — an empty list is the normal state.
 *
 * History (no active entry):
 *   - GHSA-g3hv-75wg-m249 (minimatch, moderate, dev-only) — authorized 2026-10-31 (H7-D1b-sec1), expiry 2026-11-30;
 *     REMEDIATED and REMOVED in DEPS-01. The advisory range was narrowed on 2026-11-04 to >= 7.0.0 < 11.0.1, so
 *     minimatch 3.1.5 (eslint, @eslint/*, eslint-plugin-react) is outside it. The one affected node,
 *     @typescript-eslint/typescript-estree → minimatch 10.2.6, is pinned to 11.0.9 by a package.json override scoped to
 *     typescript-estree only (its single call, minimatch(path, pattern, { dot: true }), is identical in 8.71.0 and in
 *     8.73.0, which itself depends on ^11.0.1). Record: design/security/AUDIT-EXCEPTIONS.md.
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

/** The normal state: no exception. Any reported advisory fails CI until it is fixed or a new entry is authorized. */
export const AUDIT_EXCEPTIONS: readonly AuditException[] = Object.freeze([]);
