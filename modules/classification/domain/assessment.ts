/**
 * Assessments: identity, provenance and validated construction (Step H7-A1; Model §15.1, §41, §44; TA §24, §57;
 * H7-A0 §3). Pure. No ids are generated here: `ref` is the caller's opaque reference (the future persisted id).
 *
 * The analysis TARGET is one immutable source text version of one interaction in one workspace — never the
 * interaction's mutable "current text". An edit is a new source text version and therefore a different target.
 *
 * Origins (Model §15.1, M-05):
 *   rule           a deterministic product rule, ONLY for the narrow dimension/value it establishes (RULE_ESTABLISHES)
 *   ai             a model assessment (task, prompt, schema, taxonomy and model identity)
 *   platform_hint  an interpretive hint a platform provides
 *   human          a human-authored interpretation or correction (always appended, never edited)
 * Derived policy results (accepted interpretation, protection, needs review, value inputs) are NOT assessments: they
 * carry their own policy versions and point at the assessments they used.
 *
 * Assessments are immutable once made: a newer model, rule set or taxonomy, or a human correction, adds a NEW
 * assessment; nothing here edits one. A workspace watch term is not a rule origin: it establishes only "the text
 * contains this term" and is a signal (signals.ts), never an assessment of any dimension (D-H7-3, S19).
 */
import { isUuid, type WorkspaceId } from "@/domain/ids";
import { parseInstant, type Instant } from "@/domain/instant";
import { isAbstention, isConfidenceLevel, isConfidenceScore, type Abstention, type ValueConfidence } from "./confidence";
import { MAX_LANGUAGE_TAGS, parseLanguageTag } from "./language";
import { TAXONOMY, TAXONOMY_VERSION, isClosedDimension, isDimension, isReasonCode, isTaxonomyValue, type ClosedDimensionDefinition, type Dimension } from "./taxonomy";

export interface AnalysisTarget {
  readonly workspaceId: WorkspaceId;
  readonly interactionId: string;
  readonly sourceTextVersionId: string;
}

export function parseAnalysisTarget(value: { readonly workspaceId: unknown; readonly interactionId: unknown; readonly sourceTextVersionId: unknown }): AnalysisTarget | undefined {
  if (!isUuid(value.workspaceId) || !isUuid(value.interactionId) || !isUuid(value.sourceTextVersionId)) return undefined;
  return Object.freeze({ workspaceId: value.workspaceId as WorkspaceId, interactionId: value.interactionId, sourceTextVersionId: value.sourceTextVersionId });
}

export const sameInteraction = (a: AnalysisTarget, b: AnalysisTarget): boolean => a.workspaceId === b.workspaceId && a.interactionId === b.interactionId;
export const sameTarget = (a: AnalysisTarget, b: AnalysisTarget): boolean => sameInteraction(a, b) && a.sourceTextVersionId === b.sourceTextVersionId;

// ── provenance ─────────────────────────────────────────────────────────────────────────────────────────────

export const PROVENANCE_CLASSES = ["deterministic_rule", "ai_model", "platform_hint", "human", "derived_policy"] as const;
export type ProvenanceClass = (typeof PROVENANCE_CLASSES)[number];

/**
 * The deterministic rules that may assert a dimension value, and the one value each establishes (Model §15.2, §46 C).
 * `link_reputation_malicious` establishes "this URL is known malicious" = safety.malicious_link — never "spam".
 * The reputation source itself is a later, VALIDATE decision; nothing here looks a URL up.
 */
export const RULE_ESTABLISHES = Object.freeze({
  link_reputation_malicious: Object.freeze({ dimension: "safety" as const, value: "malicious_link" }),
});
export type EstablishingRule = keyof typeof RULE_ESTABLISHES;
export const isEstablishingRule = (value: unknown): value is EstablishingRule => typeof value === "string" && Object.hasOwn(RULE_ESTABLISHES, value);

export interface RuleMethod {
  readonly kind: "rule";
  readonly rule: EstablishingRule;
  readonly ruleVersion: string;
}

export interface AiMethod {
  readonly kind: "ai";
  readonly provider: string;
  readonly model: string;
  /** As reported by the provider; null when it reports none. */
  readonly modelVersion: string | null;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly schemaVersion: string;
  readonly taxonomyVersion: string;
  readonly confidencePolicyVersion: string;
}

export interface PlatformHintMethod {
  readonly kind: "platform_hint";
  readonly hint: string;
  readonly adapterVersion: string;
}

/** The authoring authority, abstract (the action pipeline resolves who may correct; nothing here authorizes). */
export interface HumanActor {
  readonly kind: "workspace_member";
  readonly ref: string;
}

export interface HumanMethod {
  readonly kind: "human";
  readonly actor: HumanActor;
}

export type AssessmentMethod = RuleMethod | AiMethod | PlatformHintMethod | HumanMethod;

export const provenanceOf = (method: AssessmentMethod): ProvenanceClass =>
  method.kind === "rule" ? "deterministic_rule" : method.kind === "ai" ? "ai_model" : method.kind === "platform_hint" ? "platform_hint" : "human";

// ── content ────────────────────────────────────────────────────────────────────────────────────────────────

export interface AssessedValue {
  readonly key: string;
  readonly confidence: ValueConfidence;
}

export type AssessmentContent =
  | { readonly kind: "values"; readonly values: readonly AssessedValue[]; readonly reasonCodes: readonly string[] }
  | { readonly kind: "abstained"; readonly abstention: Abstention };

export interface Assessment {
  /** The caller's opaque reference (future persisted id); never generated here. */
  readonly ref: string;
  readonly target: AnalysisTarget;
  readonly dimension: Dimension;
  readonly method: AssessmentMethod;
  readonly content: AssessmentContent;
  readonly assessedAt: Instant;
  readonly taxonomyVersion: string;
  /** Human only: the `ref` of the assessment this one corrects (display lineage; nothing is mutated). */
  readonly corrects: string | null;
}

export const ASSESSMENT_VIOLATIONS = [
  "TARGET_INVALID",
  "REF_INVALID",
  "DIMENSION_INVALID",
  "TIME_INVALID",
  "TAXONOMY_VERSION_UNSUPPORTED",
  "METHOD_INVALID",
  "RULE_SCOPE_VIOLATION",
  "VALUE_UNKNOWN",
  "VALUE_DUPLICATE",
  "CARDINALITY_VIOLATION",
  "EXCLUSIVE_VALUE_COMBINED",
  "CONFIDENCE_INVALID",
  "HUMAN_CONFIDENCE_NOT_HIGH",
  "REASON_CODE_INVALID",
  "ABSTENTION_INVALID",
  "CORRECTION_LINK_INVALID",
] as const;
export type AssessmentViolation = (typeof ASSESSMENT_VIOLATIONS)[number];

export interface AssessmentInput {
  readonly ref: unknown;
  readonly target: AnalysisTarget;
  readonly dimension: unknown;
  readonly method: AssessmentMethod;
  readonly content: AssessmentContent;
  readonly assessedAt: unknown;
  readonly taxonomyVersion?: string;
  readonly corrects?: string | null;
  /** Required for a topics assessment: the workspace topic catalog keys it may use (owned by `topics`). */
  readonly topicCatalog?: ReadonlySet<string>;
}

const nonEmpty = (value: unknown, max = 200): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : undefined;

function isContent(value: unknown): value is AssessmentContent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { readonly kind?: unknown; readonly values?: unknown; readonly reasonCodes?: unknown };
  return (record.kind === "values" && Array.isArray(record.values) && Array.isArray(record.reasonCodes)) || record.kind === "abstained";
}

function methodViolations(method: AssessmentMethod): AssessmentViolation[] {
  switch (method.kind) {
    case "rule":
      return isEstablishingRule(method.rule) && nonEmpty(method.ruleVersion) ? [] : ["METHOD_INVALID"];
    case "ai":
      return [method.provider, method.model, method.taskId, method.taskVersion, method.promptVersion, method.promptHash, method.schemaVersion, method.taxonomyVersion, method.confidencePolicyVersion].every((v) => nonEmpty(v))
        && (method.modelVersion === null || nonEmpty(method.modelVersion))
        ? []
        : ["METHOD_INVALID"];
    case "platform_hint":
      return nonEmpty(method.hint) && nonEmpty(method.adapterVersion) ? [] : ["METHOD_INVALID"];
    case "human": {
      // Read through an untyped view: the contract is also parsed from persisted data later.
      const actor = asRecord(method.actor);
      return actor?.["kind"] === "workspace_member" && nonEmpty(actor["ref"]) ? [] : ["METHOD_INVALID"];
    }
    default:
      return ["METHOD_INVALID"];
  }
}

function valueViolations(input: AssessmentInput, dimension: Dimension, values: readonly AssessedValue[]): AssessmentViolation[] {
  const out: AssessmentViolation[] = [];
  const definition = TAXONOMY[dimension];
  if (values.length === 0 || (definition.cardinality === "single" && values.length !== 1)) out.push("CARDINALITY_VIOLATION");
  if (dimension === "language" && values.length > MAX_LANGUAGE_TAGS) out.push("CARDINALITY_VIOLATION");
  const keys = values.map((v) => v.key);
  if (new Set(keys).size !== keys.length) out.push("VALUE_DUPLICATE");
  for (const value of values) {
    const known = isClosedDimension(dimension)
      ? isTaxonomyValue(dimension, value.key)
      : dimension === "language"
        ? parseLanguageTag(value.key) === value.key
        : input.topicCatalog?.has(value.key) === true;
    if (!known) out.push("VALUE_UNKNOWN");
    const confidence = asRecord(value.confidence);
    const level = confidence === undefined ? undefined : confidence["level"];
    const score = confidence === undefined ? undefined : confidence["score"];
    if (!isConfidenceLevel(level) || !(score === null || isConfidenceScore(score))) out.push("CONFIDENCE_INVALID");
    if (input.method.kind === "human" && level !== "high") out.push("HUMAN_CONFIDENCE_NOT_HIGH");
  }
  if (isClosedDimension(dimension) && values.length > 1) {
    const exclusive = (definition as ClosedDimensionDefinition).exclusive;
    if (keys.some((key) => exclusive.includes(key))) out.push("EXCLUSIVE_VALUE_COMBINED");
  }
  return out;
}

/** Validates and freezes an assessment, or names every violation (fail closed). */
export function createAssessment(input: AssessmentInput): { readonly ok: true; readonly assessment: Assessment } | { readonly ok: false; readonly violations: readonly AssessmentViolation[] } {
  const out: AssessmentViolation[] = [];
  const target = parseAnalysisTarget(input.target);
  if (target === undefined) out.push("TARGET_INVALID");
  if (!nonEmpty(input.ref, 128)) out.push("REF_INVALID");
  const assessedAt = parseInstant(input.assessedAt);
  if (assessedAt === undefined) out.push("TIME_INVALID");
  const taxonomyVersion = input.taxonomyVersion ?? TAXONOMY_VERSION;
  if (taxonomyVersion !== TAXONOMY_VERSION) out.push("TAXONOMY_VERSION_UNSUPPORTED");
  out.push(...methodViolations(input.method));
  const dimension = isDimension(input.dimension) ? input.dimension : undefined;
  if (dimension === undefined) out.push("DIMENSION_INVALID");
  const corrects = input.corrects ?? null;
  if (corrects !== null && (input.method.kind !== "human" || !nonEmpty(corrects, 128))) out.push("CORRECTION_LINK_INVALID");

  const content: AssessmentContent | { readonly kind: "unknown" } = isContent(input.content) ? input.content : { kind: "unknown" };
  if (dimension !== undefined) {
    if (content.kind === "values") {
      out.push(...valueViolations(input, dimension, content.values));
      if (!content.reasonCodes.every((code) => isClosedDimension(dimension) && isReasonCode(dimension, code))) out.push("REASON_CODE_INVALID");
      if (input.method.kind === "rule") {
        const established: { readonly dimension: string; readonly value: string } | undefined = isEstablishingRule(input.method.rule) ? RULE_ESTABLISHES[input.method.rule] : undefined;
        // A rule asserts exactly the one value it establishes, in that dimension — nothing broader.
        if (established === undefined || established.dimension !== dimension || content.values.length !== 1 || content.values[0]?.key !== established.value) out.push("RULE_SCOPE_VIOLATION");
      }
    } else if (content.kind === "abstained") {
      if (!isAbstention(content.abstention)) out.push("ABSTENTION_INVALID");
      if (input.method.kind === "rule") out.push("RULE_SCOPE_VIOLATION");
    } else {
      out.push("ABSTENTION_INVALID");
    }
  }

  if (out.length > 0 || target === undefined || dimension === undefined || assessedAt === undefined || content.kind === "unknown") return { ok: false, violations: [...new Set(out)] };
  const frozen: AssessmentContent = content.kind === "values"
    ? Object.freeze({ kind: "values" as const, values: Object.freeze(content.values.map((v) => Object.freeze({ key: v.key, confidence: Object.freeze({ level: v.confidence.level, score: v.confidence.score }) }))), reasonCodes: Object.freeze([...content.reasonCodes]) })
    : Object.freeze({ kind: "abstained" as const, abstention: content.abstention });
  return {
    ok: true,
    assessment: Object.freeze({ ref: input.ref as string, target, dimension, method: Object.freeze({ ...input.method }), content: frozen, assessedAt, taxonomyVersion, corrects }),
  };
}


// ── deterministic identity keys (no content, no hashing of text) ─────────────────────────────────────────────

const methodKey = (method: AssessmentMethod): string => {
  switch (method.kind) {
    case "rule":
      return `rule:${method.rule}:${method.ruleVersion}`;
    case "ai":
      return `ai:${method.taskId}:${method.taskVersion}:${method.promptVersion}:${method.promptHash}:${method.schemaVersion}:${method.taxonomyVersion}:${method.provider}:${method.model}:${method.modelVersion ?? "-"}`;
    case "platform_hint":
      return `hint:${method.hint}:${method.adapterVersion}`;
    case "human":
      return "human";
  }
};

/**
 * A machine assessment is unique per (source text version, dimension, method identity): a retried or re-delivered
 * computation can't add a duplicate. Human assessments are appended — each is identified by its own ref.
 */
export function assessmentIdentityKey(assessment: Pick<Assessment, "ref" | "target" | "dimension" | "method">): string {
  if (assessment.method.kind === "human") return `human|${assessment.ref}`;
  return `${assessment.target.sourceTextVersionId}|${assessment.dimension}|${methodKey(assessment.method)}`;
}

/** One understanding request per (source text version, pipeline version) — derived from identities only, never text. */
export function understandingRequestKey(target: AnalysisTarget, pipelineVersion: string): string {
  if (!nonEmpty(pipelineVersion)) throw new TypeError("pipeline_version_invalid");
  return `${target.sourceTextVersionId}|${pipelineVersion}`;
}
