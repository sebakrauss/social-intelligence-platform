/**
 * Step H7-D0v2g — offline REPLAY of recorded stability evidence under the current stability policy (no model call).
 * Historical results are never rewritten: the replay is a new artifact (`classification-stability-policy-replay.v1`).
 *
 *   inputs       the pass-1 parent (verified by `verifyParentEvidence`) and the stability evidence; each must match the
 *                SHA-256 the operator passes. The stability evidence must name that parent's SHA-256, be a known
 *                version, be COMPLETE, and record the same prompt, corpus, transport schemas and candidate
 *                configuration fingerprints as the current stack
 *   replay       per critical case: pass-1 observation (stored conclusions + severity recomputed by `classifySeverity`)
 *                + the recorded repeat signatures and severities ⇒ `classifyStabilityCase`; qualification =
 *                promotion v3 (`qualifiesForPromotion`): 0 pass-1 blocking, 0 blocking stability, no systemic
 *                reliability failure
 */
import type { EvalCorpus } from "../corpus";
import { EVALUATOR_VERSION } from "../evaluate";
import { PROMOTION_POLICY, qualifiesForPromotion } from "../promotion";
import { classifySeverity, type CaseSeverity } from "../severity";
import { candidateConfigFingerprint } from "./evidence";
import { DISQUALIFYING_FAILURES } from "./bakeoff";
import { reclassifyParent, verifyParentEvidence, type CurrentStack, type ParentCase, type ParentEvidence } from "./stability-only";
import { STABILITY_POLICY_VERSION, classifyStabilityCase, summarizeStability, type StabilityObservation } from "./stability-policy";

export const STABILITY_REPLAY_VERSION = "classification-stability-policy-replay.v1" as const;
export const ACCEPTED_STABILITY_EVIDENCE_VERSIONS: readonly string[] = ["classification-stability-evidence.v1", "classification-stability-evidence.v2"];

interface StoredStabilityCase {
  readonly id: string;
  readonly signatures: readonly (string | null)[];
  readonly severities: readonly (Pick<CaseSeverity, "blocking" | "reviewable"> | null)[];
}
interface StoredStabilityResult {
  readonly candidate: string;
  readonly status: string;
  readonly cases: readonly StoredStabilityCase[];
  readonly modelsReported: readonly string[];
}
interface StabilityEvidence {
  readonly stabilityEvidenceVersion: string;
  readonly parent: { readonly sha256: string };
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly corpusVersion: string;
  readonly corpusSha256: string;
  readonly transportSchemas: Readonly<Record<string, string>>;
  readonly candidateConfig: Readonly<Record<string, string>>;
  readonly results: readonly StoredStabilityResult[];
}

export type StabilityVerification = { readonly ok: true; readonly evidence: StabilityEvidence } | { readonly ok: false; readonly reasons: readonly string[] };

export function verifyStabilityEvidence(raw: unknown, actualSha256: string, expectedSha256: string, parentSha256: string, current: CurrentStack): StabilityVerification {
  if (actualSha256 !== expectedSha256) return { ok: false, reasons: ["stability_sha256_mismatch"] };
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Record<string, unknown>)["results"])) return { ok: false, reasons: ["stability_malformed"] };
  const e = raw as StabilityEvidence;
  const reasons: string[] = [];
  if (!ACCEPTED_STABILITY_EVIDENCE_VERSIONS.includes(e.stabilityEvidenceVersion)) reasons.push(`stability_evidence_version:${e.stabilityEvidenceVersion}`);
  if (e.parent.sha256 !== parentSha256) reasons.push("stability_parent_mismatch");
  if (e.promptVersion !== current.promptVersion || e.promptHash !== current.promptHash) reasons.push("prompt_changed");
  if (e.corpusVersion !== current.corpusVersion || e.corpusSha256 !== current.corpusSha256) reasons.push("corpus_changed");
  if (JSON.stringify(e.transportSchemas) !== JSON.stringify(current.transportSchemas)) reasons.push("transport_schema_changed");
  for (const result of e.results) {
    const candidate = current.candidates.find((c) => c.id === result.candidate);
    if (candidate === undefined) { reasons.push(`candidate_unknown:${result.candidate}`); continue; }
    if (e.candidateConfig[candidate.id] !== candidateConfigFingerprint(candidate)) reasons.push(`model_config_changed:${candidate.id}`);
    if (result.status !== "COMPLETE") reasons.push(`stability_not_complete:${candidate.id}`);
    if (result.modelsReported.length !== 1 || result.modelsReported[0] !== candidate.settings.model) reasons.push(`model_changed:${candidate.id}`);
  }
  return reasons.length > 0 ? { ok: false, reasons: Object.freeze(reasons) } : { ok: true, evidence: e };
}

/** A recorded signature (JSON) back to the observation fields the stability policy reads. */
export function observationFromSignature(signature: string, severity: Pick<CaseSeverity, "blocking" | "reviewable"> | null): StabilityObservation {
  const s = JSON.parse(signature) as { dimensions: Record<string, string[]>; protection: string; needsReview: boolean; failure: string | null; languageSupport: string; effectiveCapViolation: boolean };
  return { labels: s.dimensions, protection: { actual: s.protection }, needsReview: { actual: s.needsReview }, failureClass: s.failure, languageSupport: { outcome: s.languageSupport }, effectiveCapViolation: s.effectiveCapViolation, severity };
}

export interface ReplayInputs {
  readonly corpus: EvalCorpus;
  readonly current: CurrentStack;
  readonly parent: { readonly raw: unknown; readonly sha256: string; readonly expectedSha256: string };
  readonly stability: { readonly raw: unknown; readonly sha256: string; readonly expectedSha256: string };
}

export function replayStability(input: ReplayInputs) {
  const parent = verifyParentEvidence(input.parent.raw, input.parent.sha256, input.parent.expectedSha256, input.current);
  if (!parent.ok) return { ok: false as const, reasons: parent.reasons.map((r) => `parent:${r}`) };
  const stability = verifyStabilityEvidence(input.stability.raw, input.stability.sha256, input.stability.expectedSha256, parent.parentSha256, input.current);
  if (!stability.ok) return { ok: false as const, reasons: stability.reasons.map((r) => `stability:${r}`) };
  const tags = new Map(input.corpus.cases.map((c) => [c.id, c.tags]));
  const p: ParentEvidence = parent.parent;
  const candidates = input.current.candidates.map((candidate) => {
    const pass1Cases = p.cases[candidate.id] ?? [];
    const pass1 = reclassifyParent(pass1Cases);
    const systemic = pass1Cases.filter((c) => c.failureClass !== null && DISQUALIFYING_FAILURES.includes(c.failureClass)).length;
    const result = stability.evidence.results.find((r) => r.candidate === candidate.id);
    if (result === undefined) {
      const q = qualifiesForPromotion({ pass1BlockingCriticalFailures: pass1.blockingCriticalFailures.length, stabilityBlockingDisagreements: null, systemicReliabilityFailures: systemic });
      return { candidate: candidate.id, pass1Blocking: pass1.blockingCriticalFailures.map((f) => f.id), pass1Reviewable: pass1.reviewableDegradations.length, stability: null, ...q };
    }
    const stored = new Map(pass1Cases.map((c: ParentCase) => [c.id, c]));
    const cases = result.cases.map((c) => {
      const first = stored.get(c.id);
      const repeats = c.signatures.slice(1).map((sig, i) => (sig === null ? null : observationFromSignature(sig, c.severities[i] ?? null)));
      const complete = first !== undefined && repeats.every((r) => r !== null);
      const observations: StabilityObservation[] = complete ? [{ ...first, severity: classifySeverity(first) }, ...repeats] : [];
      return classifyStabilityCase(c.id, tags.get(c.id) ?? [], observations);
    });
    const summary = summarizeStability(cases);
    const repeatFailures = cases.filter((c) => c.reasons.includes("no_usable_output")).length;
    const q = qualifiesForPromotion({ pass1BlockingCriticalFailures: pass1.blockingCriticalFailures.length, stabilityBlockingDisagreements: summary.blocking.length, systemicReliabilityFailures: systemic + repeatFailures });
    return { candidate: candidate.id, pass1Blocking: pass1.blockingCriticalFailures.map((f) => f.id), pass1Reviewable: pass1.reviewableDegradations.length, stability: { ...summary, cases: cases.filter((c) => c.class !== null) }, ...q };
  });
  return {
    ok: true as const,
    replayVersion: STABILITY_REPLAY_VERSION,
    evaluatorVersion: EVALUATOR_VERSION,
    promotionVersion: PROMOTION_POLICY.version,
    stabilityPolicyVersion: STABILITY_POLICY_VERSION,
    parent: { id: parent.parentId, sha256: parent.parentSha256 },
    stabilityEvidence: { sha256: input.stability.sha256, version: stability.evidence.stabilityEvidenceVersion },
    candidates,
    qualified: candidates.filter((c) => c.qualified).map((c) => c.candidate),
  };
}
