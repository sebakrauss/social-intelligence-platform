/**
 * Step H7-D0 — stability analysis: the same critical cases observed several times per candidate. A case is UNSTABLE
 * when its validated labels (per dimension), protection result, needs-review, failure class — or (H7-D0v2a) its
 * evaluator-v2 language-support outcome or effective-cap status — differ between any two observations. Variance
 * detection only — never a majority vote.
 */
import type { CaseResult } from "../evaluate";

/** The observation a signature is built from: a live CaseResult or a stored (sanitized) case carry the same values. */
export interface SignatureFields {
  readonly labels: Readonly<Record<string, readonly string[]>>;
  readonly protection: { readonly actual: string };
  readonly needsReview: { readonly actual: boolean };
  readonly failureClass: string | null;
  readonly languageSupport: { readonly outcome: string };
  readonly effectiveCapViolation: boolean;
}

/** H7-D0v2d: one signature for live and stored observations (a protected ↔ uncertain flip changes `protection`). */
export const signatureOf = (fields: SignatureFields): string =>
  JSON.stringify({
    dimensions: Object.fromEntries(Object.entries(fields.labels).map(([dimension, values]) => [dimension, [...values].sort()])),
    protection: fields.protection.actual,
    needsReview: fields.needsReview.actual,
    failure: fields.failureClass,
    languageSupport: fields.languageSupport.outcome,
    effectiveCapViolation: fields.effectiveCapViolation,
  });

export const caseSignature = (result: CaseResult): string =>
  signatureOf({ ...result, labels: Object.fromEntries(Object.entries(result.dimensions).map(([dimension, value]) => [dimension, value.predicted])) });

export interface StabilityFinding {
  readonly id: string;
  readonly observations: number;
  readonly distinct: number;
  readonly passes: readonly boolean[];
}

/** Cases whose signature differs across observations (runs = one CaseResult[] per observation). */
export function stabilityDisagreements(runs: readonly (readonly CaseResult[])[]): readonly StabilityFinding[] {
  const byId = new Map<string, CaseResult[]>();
  for (const run of runs) for (const result of run) byId.set(result.id, [...(byId.get(result.id) ?? []), result]);
  const out: StabilityFinding[] = [];
  for (const [id, results] of byId) {
    const distinct = new Set(results.map(caseSignature)).size;
    if (results.length > 1 && distinct > 1) out.push({ id, observations: results.length, distinct, passes: results.map((r) => r.pass) });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}
