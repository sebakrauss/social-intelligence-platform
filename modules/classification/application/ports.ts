/**
 * Classification runtime ports (Step H7-B; migration 0024). Implemented by ./persistence (classification tables) and by
 * the interactions module's read-only analysis-text reader; composed by server/persistence/classification.ts inside ONE
 * workspace-scoped job transaction. No port reaches a provider, a model, a credential or another workspace.
 */
import type { InteractionTextReader } from "@/modules/interactions";
import type { Assessment } from "../domain/assessment";
import type { SourceSpan } from "../domain/text-segments";

export const REQUEST_STATES = [
  "PENDING",
  "DETERMINISTIC_DONE",
  "AI_PENDING",
  "AI_RUNNING",
  "COMPLETED",
  "AI_FAILED",
  "DETERMINISTIC_ONLY",
  "SKIPPED_OWN_BRAND",
  "SKIPPED_SUPERSEDED",
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const ARRIVALS = ["realtime", "reconciliation", "backfill"] as const;
export type Arrival = (typeof ARRIVALS)[number];

export interface UnderstandingRequestRecord {
  readonly id: string;
  readonly state: RequestState;
  /** True when this call inserted the row (false: an earlier delivery or a concurrent one already did). */
  readonly created: boolean;
}

export interface NewUnderstandingRequest {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly interactionId: string;
  readonly sourceTextVersionId: string;
  readonly pipelineVersion: string;
  readonly arrival: Arrival;
  readonly now: Date;
}

/** One deterministic signal row (0024 `classification.signals`): facts only — no dimension, value or confidence. */
export interface SignalRow {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly interactionId: string;
  readonly sourceTextVersionId: string;
  readonly kind: "link_present" | "text_empty" | "text_emoji_only" | "author_own_brand";
  readonly signalsVersion: string;
  readonly spans: readonly { readonly start: number; readonly end: number }[] | null;
  readonly truncated: boolean;
  readonly now: Date;
}

/** `inserted` new · `equivalent` the same fact already recorded (idempotent) · `conflict` a DIFFERENT fact under the same identity. */
export type SignalWrite = "inserted" | "equivalent" | "conflict";

export interface ClassificationStore {
  /** The one request of (text version, pipeline version): inserted PENDING, or the existing one (row-locked). */
  ensureRequest(request: NewUnderstandingRequest): Promise<UnderstandingRequestRecord>;
  /** Moves a request from `from` to `to` (completed_at set iff `to` is terminal). False when it wasn't in `from`. */
  advanceRequest(id: string, from: RequestState, to: RequestState, now: Date): Promise<boolean>;
  recordSignal(signal: SignalRow): Promise<SignalWrite>;
}

export interface ClassificationScope {
  readonly texts: InteractionTextReader;
  readonly store: ClassificationStore;
}

export interface ClassificationClock {
  readonly newId: () => string;
  readonly now: () => Date;
}

// ── Step H7-D1d: the INTELLIGENCE understanding runtime (migration 0025) ─────────────────────────────────────────

/** An understanding request as the runtime reloads it (row-locked in the caller's transaction). */
export interface IntelligenceRequestRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly interactionId: string;
  readonly sourceTextVersionId: string;
  readonly pipelineVersion: string;
  readonly arrival: Arrival;
  readonly state: RequestState;
  readonly aiGeneration: number | null;
  readonly updatedAt: Date;
}

/** One provider call (classification.ai_attempts, append-only). Ids, versions, counts and outcome classes only. */
export interface AiAttemptRow {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly understandingRequestId: string;
  readonly interactionId: string;
  readonly sourceTextVersionId: string;
  readonly pipelineVersion: string;
  readonly dispatchGeneration: number;
  readonly attemptNumber: 1 | 2;
  readonly attemptKind: "initial" | "reask";
  readonly taskId: string;
  readonly taskVersion: string;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly outputSchemaVersion: string;
  readonly transportSchemaVersion: string;
  readonly taxonomyVersion: string;
  readonly confidencePolicyVersion: string;
  readonly languagePolicyVersion: string;
  readonly inputContractVersion: string;
  readonly provider: string;
  readonly modelRequested: string;
  readonly modelReported: string | null;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly latencyMs: number;
  readonly inputChars: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly costEstimateUsd: number | null;
  readonly pricingTableVersion: string | null;
  readonly outcome: "accepted" | "invalid_output" | "refused" | "unavailable" | "input_too_large";
  readonly failureClass: string | null;
  readonly issueCodes: readonly string[];
  readonly correlationId: string;
  readonly triggerRunId: string;
  readonly createdAt: Date;
}

/**
 * The durable identity of ONE provider egress (classification.ai_call_intents, 0026, append-only), committed BEFORE the
 * call under the request's row lock. Never updated: what happened to the call is derived from its attempt row.
 */
export interface CallIntentRow {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly understandingRequestId: string;
  readonly interactionId: string;
  readonly sourceTextVersionId: string;
  readonly pipelineVersion: string;
  readonly dispatchGeneration: number;
  readonly attemptNumber: 1 | 2;
  readonly attemptKind: "initial" | "reask";
  readonly taskId: string;
  readonly provider: string;
  readonly modelRequested: string;
  readonly routeFingerprint: string;
  readonly inputChars: number;
  readonly correlationId: string;
  readonly triggerRunId: string;
  readonly createdAt: Date;
}

/** One validated output (classification.ai_results, append-only, SHADOW): never the raw response or copied text. */
export interface AiResultRow {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly understandingRequestId: string;
  readonly interactionId: string;
  readonly sourceTextVersionId: string;
  readonly pipelineVersion: string;
  readonly dispatchGeneration: number;
  readonly attemptId: string;
  readonly acceptanceMode: "shadow";
  readonly provider: string;
  readonly modelRequested: string;
  readonly modelReported: string | null;
  readonly routeFingerprint: string;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly outputSchemaVersion: string;
  readonly transportSchemaVersion: string;
  readonly taxonomyVersion: string;
  readonly confidencePolicyVersion: string;
  readonly languagePolicyVersion: string;
  readonly inputContractVersion: string;
  readonly summary: string | null;
  readonly evidence: readonly SourceSpan[];
  readonly correlationId: string;
  readonly triggerRunId: string;
  readonly createdAt: Date;
}

/** One SHADOW AI assessment naming its validated result (classification.assessments, 0025 shadow-only). */
export interface ShadowAssessmentRow {
  readonly assessment: Assessment;
  readonly organizationId: string;
  readonly aiResultId: string;
  readonly pipelineVersion: string;
  readonly languagePolicyVersion: string;
  readonly createdAt: Date;
}

export interface BudgetReservation {
  readonly taskId: string;
  /** UTC day, YYYY-MM-DD. */
  readonly day: string;
  readonly calls: number;
  readonly inputChars: number;
  readonly maxCalls: number;
  readonly maxInputChars: number;
}

/**
 * One request transition, generation-aware: applied only when the row is still in `from` with `fromGeneration` (null =
 * none yet). `to` carries `generation`; AI_FAILED carries its failure class; completed_at follows terminality. The 0025
 * guard trigger and checks are the final authority (monotonic generation, final failure class, terminal is final).
 */
export interface RequestTransition {
  readonly id: string;
  readonly from: RequestState;
  readonly fromGeneration: number | null;
  readonly to: "AI_PENDING" | "AI_RUNNING" | "COMPLETED" | "AI_FAILED";
  readonly generation: number;
  readonly failureClass: string | null;
  readonly now: Date;
}

export interface IntelligenceStore {
  lockRequest(id: string): Promise<IntelligenceRequestRecord | undefined>;
  transition(transition: RequestTransition): Promise<boolean>;
  /** The IDs-only `classification.understand_ai` outbox row of one generation (idempotent per dispatch key). */
  appendDispatch(input: { readonly request: IntelligenceRequestRecord; readonly generation: number; readonly correlationId: string; readonly outboxId: string; readonly now: Date }): Promise<"appended" | "exists">;
  /** 0026: one egress identity; a second one for the same (request, generation, attempt) is refused ("exists"). */
  recordCallIntent(row: CallIntentRow): Promise<"inserted" | "exists">;
  /** Append-only; a row already recorded for the same (request, generation, attempt) is kept (counted as not inserted). */
  recordAttempts(rows: readonly AiAttemptRow[]): Promise<number>;
  recordResult(row: AiResultRow): Promise<"inserted" | "exists">;
  recordShadowAssessments(rows: readonly ShadowAssessmentRow[]): Promise<number>;
  /** The narrow deterministic RULE assessments of one text version (origin `rule` only; M-05 candidates). */
  ruleAssessments(target: { readonly workspaceId: string; readonly interactionId: string; readonly sourceTextVersionId: string }): Promise<readonly Assessment[]>;
  /** In-flight (AI_PENDING / AI_RUNNING) intelligence requests untouched since `before`, oldest first, row-locked (skip locked). */
  staleInFlight(before: Date, limit: number): Promise<readonly IntelligenceRequestRecord[]>;
  /** classification.reserve_ai_budget() for the bound workspace: true = reserved. */
  reserveBudget(reservation: BudgetReservation): Promise<boolean>;
}

/** The content module's reported source of a content item (organic / paid / mixed / unknown), read-only. */
export interface ContentSourceReader {
  reportedSource(contentItemId: string): Promise<string | undefined>;
}

export interface IntelligenceScope {
  readonly texts: InteractionTextReader;
  readonly contents: ContentSourceReader;
  readonly store: ClassificationStore;
  readonly intelligence: IntelligenceStore;
  /**
   * The global `ai.task_kill` operational switch for the understanding task (TA §66.2), resolved by the composition:
   * an invalid or unreadable switch is its fail-safe — killed.
   */
  readonly aiTaskKilled: () => Promise<boolean>;
}
