/**
 * Classification runtime ports (Step H7-B; migration 0024). Implemented by ./persistence (classification tables) and by
 * the interactions module's read-only analysis-text reader; composed by server/persistence/classification.ts inside ONE
 * workspace-scoped job transaction. No port reaches a provider, a model, a credential or another workspace.
 */
import type { InteractionTextReader } from "@/modules/interactions";

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
