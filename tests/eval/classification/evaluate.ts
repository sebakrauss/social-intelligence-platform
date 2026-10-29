/**
 * Step H7-C — the offline evaluation runner of task A. Provider-agnostic: it evaluates ANY `ModelProvider` through the
 * real gateway, the real task binding and the real A1 policies (language cap → M-05 precedence → protection → needs
 * review), against the same corpus. Deterministic; no network of its own; nothing is persisted (the report is output).
 *
 * Metrics are multi-label and per dimension (never one scalar that could hide a protected-meaning miss):
 *   per value P / R / F1, micro + macro per dimension, exact-set rate, abstention rate · protection accuracy ·
 *   PROTECTED-MEANING RECALL (protected interactions evaluated protected OR uncertain — H7-A0 §16 primary safety
 *   metric) · strict protected recall · safety recall (review safety values) · safety false-positive rate · language
 *   cap violations in raw outputs · unsupported-language behavior · per-language pass rates · failure classes ·
 *   configuration invariance (route, model, prompt and schema identical for every case — prompt injection cannot move
 *   them) · critical failures (protected_critical / safety_critical cases that failed a critical check).
 */
import { createAiGateway, createModelRegistry, type AiGateway, type AttemptRecord, type BudgetPort, type ModelDescriptor, type ModelProvider } from "@/ai/gateway";
import { parseInstant } from "@/domain/instant";
import {
  CLOSED_DIMENSIONS,
  REVIEW_SAFETY_VALUES,
  acceptInterpretation,
  buildUnderstandingInput,
  deriveNeedsReview,
  evaluateProtection,
  languageResultOf,
  languageSupport,
  parseAnalysisTarget,
  protectedMeaningOf,
  toAiAssessments,
  type AcceptedInterpretation,
  type ClosedDimension,
  type ProtectionResult,
  type UnderstandingFailureClass,
} from "@/modules/classification";
import { understandInteraction } from "@/modules/classification/application/ai/understand-interaction";
import { UNDERSTANDING_TASK_ID } from "@/modules/classification/application/ai/understanding-task";
import type { EvalCase, EvalCorpus, LanguageGroup } from "./corpus";

const TARGET = parseAnalysisTarget({ workspaceId: "e7a10000-0000-4000-8000-000000000001", interactionId: "e7a10000-0000-4000-8000-000000000002", sourceTextVersionId: "e7a10000-0000-4000-8000-000000000003" });
const ASSESSED_AT = parseInstant("2026-10-29T12:00:00.000Z");
const NOW = new Date("2026-10-29T12:00:00.000Z");
const SEMANTIC = CLOSED_DIMENSIONS;

export interface EvaluationSubject {
  readonly provider: ModelProvider;
  readonly model: ModelDescriptor;
  /** True only for a real model; the simulator is never a benchmark. */
  readonly realModel: boolean;
  /** Test seam: the gateway used for one case (default: one gateway for every case). */
  readonly gatewayFor?: (testCase: EvalCase, standard: AiGateway) => AiGateway;
  /** H7-D0 live runs: the spend ledger's budget port (default: allow), a real clock (latency), a case subset, a hook. */
  readonly budget?: BudgetPort;
  readonly now?: () => Date;
  readonly include?: (testCase: EvalCase) => boolean;
  readonly onCase?: (result: CaseResult) => void;
}

export interface DimensionCaseResult {
  readonly pass: boolean;
  readonly predicted: readonly string[];
  readonly abstained: boolean;
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  readonly forbiddenHits: readonly string[];
}

export interface CaseResult {
  readonly id: string;
  readonly group: LanguageGroup;
  readonly tags: readonly string[];
  readonly weight: number;
  readonly outcome: "assessed" | "failed";
  readonly failureClass: UnderstandingFailureClass | null;
  readonly failureCause: string | null;
  /** The case's provider calls (ids, versions, usage, timing, outcomes — never text). */
  readonly attempts: readonly AttemptRecord[];
  readonly dimensions: Readonly<Partial<Record<ClosedDimension, DimensionCaseResult>>>;
  readonly protection: { readonly expected: string; readonly actual: ProtectionResult; readonly pass: boolean };
  readonly needsReview: { readonly expected: boolean | null; readonly actual: boolean; readonly pass: boolean };
  readonly failurePass: boolean;
  readonly languageCapRawViolation: boolean;
  readonly fingerprint: string;
  readonly criticalFailures: readonly string[];
  readonly pass: boolean;
}

interface Ratio {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number | null;
}
const ratio = (numerator: number, denominator: number): Ratio => ({ numerator, denominator, value: denominator === 0 ? null : numerator / denominator });
const f1 = (p: number | null, r: number | null): number | null => (p === null || r === null || p + r === 0 ? (p === 0 || r === 0 ? 0 : null) : (2 * p * r) / (p + r));

export interface EvaluationReport {
  readonly notice: string;
  readonly providerKey: string;
  readonly modelKey: string;
  readonly realModelBenchmark: boolean;
  readonly corpus: { readonly id: string; readonly version: string; readonly cases: number };
  readonly passRate: Ratio;
  readonly weightedPassRate: Ratio;
  readonly perDimension: Readonly<Record<string, {
    readonly perValue: Readonly<Record<string, { readonly tp: number; readonly fp: number; readonly fn: number; readonly precision: number | null; readonly recall: number | null; readonly f1: number | null }>>;
    readonly micro: { readonly precision: number | null; readonly recall: number | null; readonly f1: number | null };
    readonly macro: { readonly precision: number | null; readonly recall: number | null; readonly f1: number | null };
    readonly exactSetRate: Ratio;
    readonly passRate: Ratio;
    readonly abstentionRate: Ratio;
  }>>;
  readonly protectionAccuracy: Ratio;
  readonly protectedMeaningRecall: Ratio;
  readonly protectedStrictRecall: Ratio;
  readonly safetyRecall: Ratio;
  readonly safetyFalsePositiveRate: Ratio;
  readonly languageCapRawViolations: number;
  readonly unsupportedLanguage: { readonly cases: number; readonly protectionUncertainRate: Ratio };
  readonly byLanguage: Readonly<Record<string, { readonly passRate: Ratio; readonly protectionAccuracy: Ratio }>>;
  readonly failures: Readonly<Record<string, number>>;
  readonly schemaFailureRate: Ratio;
  readonly configurationInvariant: boolean;
  readonly criticalFailures: readonly { readonly id: string; readonly checks: readonly string[] }[];
  readonly cases: readonly CaseResult[];
}

const PROTECTION_PASS: Readonly<Record<string, readonly ProtectionResult[]>> = { protected: ["protected"], not_protected: ["not_protected"], uncertain: ["uncertain"], protected_or_uncertain: ["protected", "uncertain"] };

const fingerprintOf = (attempts: readonly AttemptRecord[], fallback: string): string => {
  const [first] = attempts;
  return first === undefined ? fallback : [first.taskId, first.taskVersion, first.providerKey, first.modelKey, first.promptVersion, first.promptHash, first.outputSchemaVersion].join("|");
};

async function evaluateCase(testCase: EvalCase, gateway: AiGateway, routeFingerprint: string): Promise<CaseResult> {
  if (TARGET === undefined || ASSESSED_AT === undefined) throw new Error("eval_constants_invalid");
  // Absent optional context is omitted (the A1 builder treats a present key — even null — as given, fail closed).
  const params = Object.fromEntries(Object.entries(testCase.input).filter(([key, value]) => value !== null && key !== "textRepeat"));
  const built = buildUnderstandingInput({ ...params, interactionKind: params["interactionKind"], platform: params["platform"], source: params["source"], linkPresent: params["linkPresent"], text: testCase.text });
  let accepted: Partial<Record<ClosedDimension, AcceptedInterpretation>> = {};
  let failureClass: UnderstandingFailureClass | null = null;
  let failureCause: string | null = null;
  let attempts: readonly AttemptRecord[] = [];
  let language = languageSupport({ kind: "unknown" });
  let capViolation = false;
  if (!built.ok) {
    if (!built.violations.includes("TEXT_TOO_LARGE")) throw new Error(`corpus_input_invalid:${testCase.id}:${built.violations.join(",")}`);
    failureClass = "AI_INPUT_TOO_LARGE";
    failureCause = "input_limit";
  } else {
    const result = await understandInteraction(gateway, built.input, { workspaceId: TARGET.workspaceId, interactionId: TARGET.interactionId, sourceTextVersionId: TARGET.sourceTextVersionId, pipelineVersion: "classification.ai.eval", reference: testCase.id });
    attempts = result.attempts;
    if (result.kind === "failed") {
      failureClass = result.failure.class;
      failureCause = result.failure.cause;
    }
    else {
      const support = languageSupport(languageResultOf(result.output));
      language = support;
      if (support !== "validated" && support !== "validated_mixed") {
        capViolation = Object.values(result.output.dimensions).some((d) => d.status === "assessed" && d.values.some((v) => v.confidence.level === "high"));
      }
      const refs = Object.fromEntries(["language", ...SEMANTIC].map((d) => [d, `${testCase.id}:${d}`]));
      const assessments = toAiAssessments(result.output, { target: TARGET, method: result.method, assessedAt: ASSESSED_AT, refs });
      accepted = Object.fromEntries(SEMANTIC.map((d) => [d, acceptInterpretation(d, assessments.filter((a) => a.dimension === d), TARGET)]));
    }
  }
  const intent = accepted.intent ?? acceptInterpretation("intent", [], TARGET);
  const protection = evaluateProtection({ intent, language, understandingFailed: failureClass !== null });
  const review = deriveNeedsReview({ protection, accepted: Object.values(accepted) });

  const dimensions: Partial<Record<ClosedDimension, DimensionCaseResult>> = {};
  const critical: string[] = [];
  for (const [dimension, expectation] of Object.entries(testCase.expected) as [ClosedDimension, EvalCase["expected"][ClosedDimension]][]) {
    if (expectation === undefined) continue;
    const interpretation = accepted[dimension];
    const predicted = interpretation?.status === "accepted" ? interpretation.values.map((v) => v.key) : [];
    const abstained = interpretation === undefined || interpretation.status !== "accepted";
    if (expectation.kind === "abstain") {
      dimensions[dimension] = { pass: abstained, predicted, abstained, missing: [], unexpected: predicted, forbiddenHits: [] };
      continue;
    }
    const missing = expectation.values.filter((v) => !predicted.includes(v));
    const unexpected = predicted.filter((v) => !expectation.values.includes(v) && !expectation.allowed.includes(v));
    const forbiddenHits = predicted.filter((v) => expectation.forbidden.includes(v));
    const pass = missing.length === 0 && unexpected.length === 0;
    dimensions[dimension] = { pass, predicted, abstained, missing, unexpected, forbiddenHits };
    if (forbiddenHits.length > 0) critical.push(`${dimension}:forbidden:${forbiddenHits.join("+")}`);
    if (dimension === "safety" && testCase.tags.includes("safety_critical") && missing.some((v) => (REVIEW_SAFETY_VALUES as readonly string[]).includes(v))) critical.push(`safety:missed:${missing.join("+")}`);
    if (dimension === "intent" && testCase.tags.includes("protected_critical") && missing.some((v) => protectedMeaningOf(v) !== undefined)) critical.push(`intent:missed_protected:${missing.join("+")}`);
  }
  const protectionPass = (PROTECTION_PASS[testCase.expectedProtection] ?? []).includes(protection.result);
  if (!protectionPass && testCase.tags.includes("protected_critical")) critical.push(`protection:${protection.result}`);
  const needsReviewPass = testCase.expectedNeedsReview === null || testCase.expectedNeedsReview === review.needsReview;
  if (!needsReviewPass && testCase.tags.includes("safety_critical")) critical.push(`needs_review:${String(review.needsReview)}`);
  const failurePass = failureClass === testCase.expectedFailure;
  if (capViolation) critical.push("language_cap:raw_high_confidence");
  const pass = Object.values(dimensions).every((d) => d.pass) && protectionPass && needsReviewPass && failurePass && !capViolation;
  return Object.freeze({
    id: testCase.id,
    group: testCase.language.group,
    tags: testCase.tags,
    weight: testCase.weight,
    outcome: failureClass === null ? "assessed" as const : "failed" as const,
    failureClass,
    failureCause,
    attempts,
    dimensions,
    protection: { expected: testCase.expectedProtection, actual: protection.result, pass: protectionPass },
    needsReview: { expected: testCase.expectedNeedsReview, actual: review.needsReview, pass: needsReviewPass },
    failurePass,
    languageCapRawViolation: capViolation,
    fingerprint: fingerprintOf(attempts, routeFingerprint),
    criticalFailures: Object.freeze(critical),
    pass,
  });
}

export async function evaluateCorpus(corpus: EvalCorpus, subject: EvaluationSubject): Promise<EvaluationReport> {
  const route = { providerKey: subject.model.providerKey, modelKey: subject.model.modelKey };
  const standard = createAiGateway({
    registry: createModelRegistry([subject.model]),
    routes: { [UNDERSTANDING_TASK_ID]: { kind: "model", model: route } },
    providers: [subject.provider],
    budget: subject.budget ?? { reserve: () => Promise.resolve("allowed" as const) },
    killed: () => false,
    now: subject.now ?? (() => NOW),
  });
  const cases = corpus.cases.filter((testCase) => subject.include?.(testCase) ?? true);
  const results: CaseResult[] = [];
  for (const testCase of cases) {
    const result = await evaluateCase(testCase, subject.gatewayFor?.(testCase, standard) ?? standard, "no-attempt");
    results.push(result);
    subject.onCase?.(result);
  }

  const scored = cases.map((testCase, index) => ({ testCase, result: results[index] as CaseResult }));
  const perDimension: Record<string, EvaluationReport["perDimension"][string]> = {};
  for (const dimension of SEMANTIC) {
    const counts = new Map<string, { tp: number; fp: number; fn: number }>();
    const bump = (key: string, field: "tp" | "fp" | "fn"): void => {
      const entry = counts.get(key) ?? { tp: 0, fp: 0, fn: 0 };
      entry[field] += 1;
      counts.set(key, entry);
    };
    let exact = 0, passed = 0, abstained = 0, total = 0;
    for (const { testCase, result } of scored) {
      const expectation = testCase.expected[dimension];
      const got = result.dimensions[dimension];
      if (expectation === undefined || got === undefined) continue;
      total += 1;
      if (got.pass) passed += 1;
      if (got.abstained) abstained += 1;
      if (expectation.kind === "abstain") {
        if (got.abstained) exact += 1;
        for (const value of got.predicted) bump(value, "fp");
        continue;
      }
      if (got.predicted.length === expectation.values.length && expectation.values.every((v) => got.predicted.includes(v))) exact += 1;
      for (const value of expectation.values) bump(value, got.predicted.includes(value) ? "tp" : "fn");
      for (const value of got.unexpected) bump(value, "fp");
    }
    if (total === 0) continue;
    const perValue: Record<string, { tp: number; fp: number; fn: number; precision: number | null; recall: number | null; f1: number | null }> = {};
    let tp = 0, fp = 0, fn = 0;
    const precisions: number[] = [], recalls: number[] = [];
    for (const [key, c] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
      const precision = ratio(c.tp, c.tp + c.fp).value;
      const recall = ratio(c.tp, c.tp + c.fn).value;
      perValue[key] = { ...c, precision, recall, f1: f1(precision, recall) };
      tp += c.tp; fp += c.fp; fn += c.fn;
      if (precision !== null) precisions.push(precision);
      if (recall !== null) recalls.push(recall);
    }
    const microP = ratio(tp, tp + fp).value, microR = ratio(tp, tp + fn).value;
    const macroP = precisions.length === 0 ? null : precisions.reduce((a, b) => a + b, 0) / precisions.length;
    const macroR = recalls.length === 0 ? null : recalls.reduce((a, b) => a + b, 0) / recalls.length;
    perDimension[dimension] = { perValue, micro: { precision: microP, recall: microR, f1: f1(microP, microR) }, macro: { precision: macroP, recall: macroR, f1: f1(macroP, macroR) },
      exactSetRate: ratio(exact, total), passRate: ratio(passed, total), abstentionRate: ratio(abstained, total) };
  }

  const protectedCases = scored.filter(({ testCase }) => testCase.expectedProtection === "protected" || testCase.expectedProtection === "protected_or_uncertain"
    || (testCase.expected.intent?.kind === "values" && testCase.expected.intent.values.some((v) => protectedMeaningOf(v) !== undefined)));
  const strictProtected = scored.filter(({ testCase }) => testCase.expectedProtection === "protected");
  let safetyTp = 0, safetyFn = 0;
  const noneCases = scored.filter(({ testCase }) => testCase.expected.safety?.kind === "values" && testCase.expected.safety.values.includes("none"));
  for (const { testCase, result } of scored) {
    const expectation = testCase.expected.safety;
    if (expectation?.kind !== "values") continue;
    for (const value of expectation.values.filter((v) => (REVIEW_SAFETY_VALUES as readonly string[]).includes(v))) {
      if (result.dimensions.safety?.predicted.includes(value) === true) safetyTp += 1;
      else safetyFn += 1;
    }
  }
  const unsupported = scored.filter(({ testCase }) => testCase.language.group === "unsupported" || testCase.language.group === "uncertain");
  const byLanguage: Record<string, { passRate: Ratio; protectionAccuracy: Ratio }> = {};
  for (const group of [...new Set(scored.map(({ testCase }) => testCase.language.group))]) {
    const inGroup = scored.filter(({ testCase }) => testCase.language.group === group);
    byLanguage[group] = { passRate: ratio(inGroup.filter(({ result }) => result.pass).length, inGroup.length), protectionAccuracy: ratio(inGroup.filter(({ result }) => result.protection.pass).length, inGroup.length) };
  }
  const failures: Record<string, number> = {};
  for (const result of results) if (result.failureClass !== null) failures[result.failureClass] = (failures[result.failureClass] ?? 0) + 1;
  const attempted = results.filter((r) => r.fingerprint !== "no-attempt");
  const weight = scored.reduce((sum, { testCase }) => sum + testCase.weight, 0);
  return Object.freeze({
    notice: subject.realModel ? "real model evaluation (offline corpus)" : "provider = simulator — NOT a real model benchmark: a golden or scripted simulator measures the evaluation machinery only",
    providerKey: subject.model.providerKey,
    modelKey: subject.model.modelKey,
    realModelBenchmark: subject.realModel,
    corpus: { id: corpus.corpusId, version: corpus.corpusVersion, cases: cases.length },
    passRate: ratio(results.filter((r) => r.pass).length, results.length),
    weightedPassRate: ratio(scored.filter(({ result }) => result.pass).reduce((sum, { testCase }) => sum + testCase.weight, 0), weight),
    perDimension,
    protectionAccuracy: ratio(results.filter((r) => r.protection.pass).length, results.length),
    protectedMeaningRecall: ratio(protectedCases.filter(({ result }) => result.protection.actual === "protected" || result.protection.actual === "uncertain").length, protectedCases.length),
    protectedStrictRecall: ratio(strictProtected.filter(({ result }) => result.protection.actual === "protected").length, strictProtected.length),
    safetyRecall: ratio(safetyTp, safetyTp + safetyFn),
    safetyFalsePositiveRate: ratio(noneCases.filter(({ result }) => (result.dimensions.safety?.predicted ?? []).some((v) => v !== "none")).length, noneCases.length),
    languageCapRawViolations: results.filter((r) => r.languageCapRawViolation).length,
    unsupportedLanguage: { cases: unsupported.length, protectionUncertainRate: ratio(unsupported.filter(({ result }) => result.protection.actual === "uncertain").length, unsupported.length) },
    byLanguage,
    failures,
    schemaFailureRate: ratio(results.filter((r) => r.failureClass === "AI_INVALID_OUTPUT").length, attempted.length),
    configurationInvariant: new Set(results.filter((r) => r.fingerprint !== "no-attempt").map((r) => r.fingerprint)).size <= 1,
    criticalFailures: Object.freeze(results.filter((r) => r.criticalFailures.length > 0).map((r) => ({ id: r.id, checks: r.criticalFailures }))),
    cases: Object.freeze(results),
  });
}
