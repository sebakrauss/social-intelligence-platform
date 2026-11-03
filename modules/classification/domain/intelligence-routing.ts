/**
 * The pure identity and routing contract of the INTELLIGENCE understanding runtime (Steps H7-D1b / H7-D1d; H7-A0 §8–§12,
 * D-H7-1). Domain-pure: shared by MAIN (dispatch, recovery) and INTELLIGENCE (execution) without importing the gateway,
 * a prompt or a provider. The application contract (application/ai/understand-ai-contract.ts) re-exports it.
 *
 *   pipeline    `classification.intelligence.v1` — the runtime only ever continues requests of THIS pipeline;
 *               `classification.deterministic.v1` requests are never continued (0025 refuses AI states for them)
 *   generation  the `a{n}` of the dispatch key; every transport retry or recovery is a NEW generation (≤ 3)
 *   payload     identifiers only (workspace, interaction, source text version, request, correlation); never text
 *   route       deny-by-default: disabled, sampling 0, kill switch active, no model / timeout / budget, no real data,
 *               no backfill; acceptance SHADOW only
 *   data class  (Step H7-D1g-prep) every workspace is EXACTLY one of: a synthetic fixture workspace, a REAL workspace
 *               explicitly authorized for real data, an unauthorized real workspace, or a conflict (named by both
 *               lists). Two separate allowlists, both empty by default; real data needs BOTH the real-data capability
 *               and exact membership in the real allowlist — never a wildcard, never "all real workspaces", and a
 *               fixture workspace never implies real authorization (nor is a real workspace ever labeled synthetic)
 */
import { parseCorrelationId } from "@/domain/correlation";
import { isUuid } from "@/domain/ids";

// ── Topic, plane, pipeline and generation ────────────────────────────────────────────────────────────────────────

/** The outbox topic / task (registered H7-D1d; 0025's outbox_intelligence_routing binds it to the intelligence plane only). */
export const UNDERSTAND_AI_TOPIC = "classification.understand_ai" as const;
/** Its execution plane (platform/jobs DELIVERY_PLANES since 0025). */
export const UNDERSTAND_AI_PLANE = "intelligence" as const;

export const INTELLIGENCE_PIPELINE_VERSION = "classification.intelligence.v1" as const;

/** The `ai.task_kill` operational-switch qualifier of the understanding task (switch qualifiers are identifier-shaped). */
export const UNDERSTAND_AI_KILL_QUALIFIER = "classification_understanding" as const;

/** The only requests the INTELLIGENCE runtime may continue: those created under ITS pipeline version. */
export function isIntelligencePipelineRequest(request: { readonly pipelineVersion: string }): boolean {
  return request.pipelineVersion === INTELLIGENCE_PIPELINE_VERSION;
}

export const MAX_DISPATCH_GENERATION = 1_000;
const isGeneration = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_DISPATCH_GENERATION;

export function understandAiDispatchKey(understandingRequestId: string, generation: number): string {
  if (!isUuid(understandingRequestId)) throw new TypeError("dispatch_key_request_invalid");
  if (!isGeneration(generation)) throw new TypeError("dispatch_key_generation_invalid");
  return `${UNDERSTAND_AI_TOPIC}:${understandingRequestId}:a${String(generation)}`;
}

export function parseUnderstandAiDispatchKey(key: unknown): { readonly understandingRequestId: string; readonly generation: number } | undefined {
  if (typeof key !== "string") return undefined;
  const match = /^classification\.understand_ai:([0-9a-f-]{36}):a([1-9][0-9]{0,3})$/.exec(key);
  const [, requestId, digits] = match ?? [];
  if (requestId === undefined || digits === undefined || !isUuid(requestId)) return undefined;
  const generation = Number(digits);
  return isGeneration(generation) ? Object.freeze({ understandingRequestId: requestId, generation }) : undefined;
}

// ── Job payload (identifiers only) ───────────────────────────────────────────────────────────────────────────────

export const UNDERSTAND_AI_PAYLOAD_FIELDS = ["workspaceId", "interactionId", "sourceTextVersionId", "understandingRequestId", "correlationId"] as const;

export interface UnderstandAiJobPayload {
  readonly workspaceId: string;
  readonly interactionId: string;
  readonly sourceTextVersionId: string;
  readonly understandingRequestId: string;
  readonly correlationId: string;
}

export type UnderstandAiPayloadParse =
  | { readonly ok: true; readonly payload: UnderstandAiJobPayload }
  | { readonly ok: false; readonly field: (typeof UNDERSTAND_AI_PAYLOAD_FIELDS)[number] | "payload" };

const plainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Closed validation: exactly the five identifier fields, every id a UUID, the correlation id a trace id. */
export function parseUnderstandAiJobPayload(raw: unknown): UnderstandAiPayloadParse {
  if (!plainObject(raw)) return { ok: false, field: "payload" };
  const keys = Object.keys(raw);
  if (keys.length !== UNDERSTAND_AI_PAYLOAD_FIELDS.length || !keys.every((key) => (UNDERSTAND_AI_PAYLOAD_FIELDS as readonly string[]).includes(key))) return { ok: false, field: "payload" };
  for (const field of ["workspaceId", "interactionId", "sourceTextVersionId", "understandingRequestId"] as const) {
    if (!isUuid(raw[field])) return { ok: false, field };
  }
  if (parseCorrelationId(raw["correlationId"]) === undefined) return { ok: false, field: "correlationId" };
  return {
    ok: true,
    payload: Object.freeze({
      workspaceId: raw["workspaceId"] as string,
      interactionId: raw["interactionId"] as string,
      sourceTextVersionId: raw["sourceTextVersionId"] as string,
      understandingRequestId: raw["understandingRequestId"] as string,
      correlationId: raw["correlationId"] as string,
    }),
  };
}

/** Subject names of the payload inside the generic tenant job envelope (platform/jobs `subjectIds`). */
export const UNDERSTAND_AI_SUBJECTS = Object.freeze({ interactionId: "interaction", sourceTextVersionId: "source_text_version", understandingRequestId: "understanding_request" });

export function understandAiSubjectIds(payload: UnderstandAiJobPayload): Readonly<Record<string, string>> {
  return Object.freeze({
    [UNDERSTAND_AI_SUBJECTS.interactionId]: payload.interactionId,
    [UNDERSTAND_AI_SUBJECTS.sourceTextVersionId]: payload.sourceTextVersionId,
    [UNDERSTAND_AI_SUBJECTS.understandingRequestId]: payload.understandingRequestId,
  });
}

/** The payload back from a tenant envelope; any other subject (or a missing one) fails closed. */
export function understandAiPayloadFromEnvelope(envelope: { readonly workspaceId: string; readonly subjectIds: Readonly<Record<string, string>>; readonly correlationId: string }): UnderstandAiPayloadParse {
  const names: readonly string[] = Object.values(UNDERSTAND_AI_SUBJECTS);
  const subjects = Object.keys(envelope.subjectIds);
  if (subjects.length !== names.length || !subjects.every((name) => names.includes(name))) return { ok: false, field: "payload" };
  return parseUnderstandAiJobPayload({
    workspaceId: envelope.workspaceId,
    interactionId: envelope.subjectIds[UNDERSTAND_AI_SUBJECTS.interactionId],
    sourceTextVersionId: envelope.subjectIds[UNDERSTAND_AI_SUBJECTS.sourceTextVersionId],
    understandingRequestId: envelope.subjectIds[UNDERSTAND_AI_SUBJECTS.understandingRequestId],
    correlationId: envelope.correlationId,
  });
}

// ── Acceptance mode and route policy ────────────────────────────────────────────────────────────────────────────

export const ACCEPTANCE_MODES = ["shadow", "accepting"] as const;
export type AcceptanceMode = (typeof ACCEPTANCE_MODES)[number];
/** Every H7-D1 result is SHADOW: stored non-accepting (TA §24.2), never read by a product consumer. */
export const H7_D1_ACCEPTANCE_MODE = "shadow" as const satisfies AcceptanceMode;

/** Daily caps per workspace × task (UTC day), reserved atomically by classification.reserve_ai_budget() BEFORE any call. */
export type UnderstandAiBudget = { readonly kind: "deny_all" } | { readonly kind: "caps"; readonly maxCallsPerDay: number; readonly maxInputCharsPerDay: number };

/** A route reference (provider + registry model key) — the gateway's ModelRef shape, declared here to keep the domain pure. */
export interface UnderstandAiModelRef {
  readonly providerKey: string;
  readonly modelKey: string;
}

export interface UnderstandAiRoutePolicy {
  readonly enabled: boolean;
  /** Integer 0–100: share of eligible requests (by a deterministic 0–99 bucket) that may call the model. */
  readonly samplingPercentage: number;
  /** Fail-safe: "active" = no call (combined with the global `ai.task_kill` flag, whose fail-safe is also killed). */
  readonly killSwitch: "active" | "inactive";
  readonly model: UnderstandAiModelRef | null;
  /** Per-call provider timeout; null ⇒ the route cannot call. */
  readonly timeoutMs: number | null;
  readonly budget: UnderstandAiBudget;
  readonly acceptanceMode: typeof H7_D1_ACCEPTANCE_MODE;
  /**
   * The real-data CAPABILITY (H7-D1g-prep): false by default and in every deployed policy until an explicit TL
   * real-data gate (H7-D1a). Alone it admits nothing: a real workspace must ALSO be in `realDataWorkspaceIds`.
   */
  readonly realDataEligible: boolean;
  /** Synthetic fixture workspaces (the only data that is NOT real); none by default. Never implies real authorization. */
  readonly fixtureWorkspaceIds: readonly string[];
  /**
   * REAL workspaces explicitly authorized for real-data shadow (H7-D1g-prep): exact canonical workspace ids only — no
   * wildcard, no pattern; empty by default (an empty list denies every real workspace). Separate from the fixtures:
   * a workspace named by both lists is a conflict and is never routed.
   */
  readonly realDataWorkspaceIds: readonly string[];
  /** Backfill arrivals stay on the batch path and out of the shadow by default (H7-A0 §9; shadow scope is a TL decision). */
  readonly includeBackfill: boolean;
}

export const DEFAULT_UNDERSTAND_AI_ROUTE_POLICY: UnderstandAiRoutePolicy = Object.freeze({
  enabled: false,
  samplingPercentage: 0,
  killSwitch: "active",
  model: null,
  timeoutMs: null,
  budget: Object.freeze({ kind: "deny_all" as const }),
  acceptanceMode: H7_D1_ACCEPTANCE_MODE,
  realDataEligible: false,
  fixtureWorkspaceIds: Object.freeze([]),
  realDataWorkspaceIds: Object.freeze([]),
  includeBackfill: false,
});

export const ROUTE_SKIP_REASONS = [
  "route_disabled", "kill_switch", "no_model", "no_timeout", "no_budget", "not_sampled", "real_data_not_eligible", "real_workspace_not_authorized",
  "workspace_class_conflict", "backfill_excluded",
] as const;
export type RouteSkipReason = (typeof ROUTE_SKIP_REASONS)[number];

export type UnderstandAiRouteDecision =
  | { readonly kind: "call"; readonly model: UnderstandAiModelRef; readonly timeoutMs: number; readonly budget: Extract<UnderstandAiBudget, { kind: "caps" }>; readonly acceptanceMode: typeof H7_D1_ACCEPTANCE_MODE }
  | { readonly kind: "skip"; readonly reason: RouteSkipReason };

/**
 * The data class of a workspace under a policy (H7-D1g-prep), by EXACT membership only:
 *   synthetic_fixture   named by `fixtureWorkspaceIds` only
 *   real_authorized     named by `realDataWorkspaceIds` only (still needs `realDataEligible: true` to route)
 *   real_unauthorized   named by neither (fail safe: unknown ⇒ real, and real is never authorized implicitly)
 *   class_conflict      named by both — a misconfiguration; never routed
 */
export const WORKSPACE_DATA_CLASSES = ["synthetic_fixture", "real_authorized", "real_unauthorized", "class_conflict"] as const;
export type WorkspaceDataClass = (typeof WORKSPACE_DATA_CLASSES)[number];

const named = (ids: unknown, workspaceId: string): boolean => Array.isArray(ids) && isUuid(workspaceId) && ids.some((id) => id === workspaceId);

export function workspaceDataClassOf(policy: Pick<UnderstandAiRoutePolicy, "fixtureWorkspaceIds" | "realDataWorkspaceIds">, workspaceId: string): WorkspaceDataClass {
  const fixture = named(policy.fixtureWorkspaceIds, workspaceId);
  const real = named(policy.realDataWorkspaceIds, workspaceId);
  if (fixture && real) return "class_conflict";
  if (fixture) return "synthetic_fixture";
  return real ? "real_authorized" : "real_unauthorized";
}

/** Pure route decision for one request; every missing piece of configuration skips (no provider call). */
export function decideUnderstandAiRoute(policy: UnderstandAiRoutePolicy, request: { readonly samplingBucket: number; readonly dataClass: WorkspaceDataClass; readonly arrival?: string }): UnderstandAiRouteDecision {
  const skip = (reason: RouteSkipReason): UnderstandAiRouteDecision => Object.freeze({ kind: "skip" as const, reason });
  if (!policy.enabled) return skip("route_disabled");
  if (policy.killSwitch !== "inactive") return skip("kill_switch");
  if (policy.model === null) return skip("no_model");
  if (policy.timeoutMs === null || !Number.isInteger(policy.timeoutMs) || policy.timeoutMs < 1) return skip("no_timeout");
  const { budget } = policy;
  if (budget.kind !== "caps" || !Number.isInteger(budget.maxCallsPerDay) || budget.maxCallsPerDay < 1 || !Number.isInteger(budget.maxInputCharsPerDay) || budget.maxInputCharsPerDay < 1) return skip("no_budget");
  const percentage = Number.isInteger(policy.samplingPercentage) ? Math.min(Math.max(policy.samplingPercentage, 0), 100) : 0;
  if (!Number.isInteger(request.samplingBucket) || request.samplingBucket < 0 || request.samplingBucket > 99 || request.samplingBucket >= percentage) return skip("not_sampled");
  // Read as unknown: a policy or request built outside the type system must still say exactly `true` / a known class.
  const realDataEligible: unknown = policy.realDataEligible;
  const dataClass: unknown = request.dataClass;
  if (dataClass !== "synthetic_fixture") {
    if (dataClass === "class_conflict") return skip("workspace_class_conflict");
    if (realDataEligible !== true) return skip("real_data_not_eligible");
    if (dataClass !== "real_authorized") return skip("real_workspace_not_authorized");
  }
  if (request.arrival === "backfill" && !policy.includeBackfill) return skip("backfill_excluded");
  return Object.freeze({ kind: "call" as const, model: policy.model, timeoutMs: policy.timeoutMs, budget, acceptanceMode: policy.acceptanceMode });
}

/** A deterministic 0–99 sampling bucket from a canonical uuid (its leading 32 random bits); never from text. */
export function samplingBucketOf(uuid: string): number {
  if (!isUuid(uuid)) throw new TypeError("sampling_bucket_uuid_invalid");
  return Number.parseInt(uuid.slice(0, 8), 16) % 100;
}

// ── Retry and recovery bounds ───────────────────────────────────────────────────────────────────────────────────

/** Transport attempts per request (H7-A0 §11.3, ≤ 3): each is one dispatch generation; recovery counts toward it. */
export const MAX_TRANSPORT_GENERATIONS = 3;
/** An in-flight request untouched this long is stale (crashed / lost run): well beyond one run's maximum duration. */
export const STALE_IN_FLIGHT_MS = 15 * 60 * 1000;
/** Stale requests recovered per MAIN consumer run (bounded; the next run continues). */
export const RECOVERY_BATCH = 5;
