/**
 * Reconciliation runtime vocabularies (Step H6-C2; design H6-C0; migration 0018). Pure. The closed sets the database
 * CHECKs admit, pinned to the migration by test, plus the budget snapshot a run persists so its limits stay explainable
 * after the defaults change. Transitions are the application's (H6-C3); the database only refuses impossible states.
 *
 *   run      REQUESTED → RUNNING → COMPLETED | PARTIAL | FAILED, or REQUESTED → SKIPPED_UNAVAILABLE (gate refused).
 *            At most one open (REQUESTED / RUNNING) run per connected account.
 *   slice    PENDING → RUNNING (claimed by incrementing its attempt) → COMPLETED | CONTINUED | FAILED_TRANSIENT |
 *            FAILED_RATE_LIMITED | FAILED_PERMANENT | ABANDONED_BUDGET. At most one RUNNING slice per account. Only a
 *            PENDING or RUNNING slice may hold a provider cursor.
 *   conflict the canonical refusal classes of ingestion: the identity conflicts (interactions module) and the ingestion
 *            scope and ancestry conflicts. THREAD_ANCHOR_CONFLICT is gone (H6-C1).
 */
import { RECONCILIATION_DEFAULTS } from "./reconciliation-slice";

export const RECONCILIATION_RUN_STATES = ["REQUESTED", "RUNNING", "COMPLETED", "PARTIAL", "SKIPPED_UNAVAILABLE", "FAILED"] as const;
export type ReconciliationRunState = (typeof RECONCILIATION_RUN_STATES)[number];
export const OPEN_RUN_STATES = ["REQUESTED", "RUNNING"] as const satisfies readonly ReconciliationRunState[];

export const RECONCILIATION_SLICE_STATES = [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "CONTINUED",
  "FAILED_TRANSIENT",
  "FAILED_RATE_LIMITED",
  "FAILED_PERMANENT",
  "ABANDONED_BUDGET",
] as const;
export type ReconciliationSliceState = (typeof RECONCILIATION_SLICE_STATES)[number];
/** The only states in which a slice may hold a provider cursor (and has not finished). */
export const OPEN_SLICE_STATES = ["PENDING", "RUNNING"] as const satisfies readonly ReconciliationSliceState[];

export const INGESTION_CONFLICT_CLASSES = [
  "KEY_MISMATCH",
  "ACCOUNT_CHANGED",
  "ASSET_CHANGED",
  "CONTENT_CHANGED",
  "PARENT_CHANGED",
  "KIND_CHANGED",
  "CONTENT_SCOPE_CONFLICT",
  "PLACEHOLDER_SCOPE_CONFLICT",
  "PARENT_SCOPE_CONFLICT",
  "ANCESTRY_CYCLE",
  "ANCESTRY_DEPTH_EXCEEDED",
  "DESCENDANT_CONVERSATION_CONFLICT",
] as const;
export type IngestionConflictClass = (typeof INGESTION_CONFLICT_CLASSES)[number];

/** The limits that governed one run, persisted on it (TL D-C3, D-C4). */
export interface ReconciliationBudgetSnapshot {
  readonly listingPagesPerSlice: number;
  readonly interactionPagesPerSlice: number;
  readonly continuationsPerContent: number;
  readonly interactionPagesPerContent: number;
  readonly contentItems: number;
  readonly overlapSeconds: number;
}

/** The snapshot of the approved defaults (what a run requested today persists). */
export function defaultBudgetSnapshot(defaults: typeof RECONCILIATION_DEFAULTS = RECONCILIATION_DEFAULTS): ReconciliationBudgetSnapshot {
  return Object.freeze({
    listingPagesPerSlice: defaults.listingPagesPerSlice,
    interactionPagesPerSlice: defaults.interactionPagesPerSlice,
    continuationsPerContent: defaults.continuationsPerContent,
    interactionPagesPerContent: defaults.interactionPagesPerSlice * (1 + defaults.continuationsPerContent),
    contentItems: defaults.contentItemsPerRun,
    overlapSeconds: defaults.overlapMs / 1000,
  });
}
