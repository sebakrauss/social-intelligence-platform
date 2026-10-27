/**
 * What the reconciliation runtime needs from its transactions (Step H6-C3; design H6-C0; migration 0018). Every store
 * is bound to ONE workspace-scoped job transaction (RLS binds the workspace); composed by
 * server/persistence/ingestion.ts. The reconciliation tables are this module's; the account, connection, credential
 * and capability reads are the owners' published ports, never their tables.
 */
import type { CapabilityReadStore } from "@/modules/capability";
import type { ConnectedAccount, Connection } from "@/modules/connections";
import type { SliceUnit } from "../domain/reconciliation-slice";
import type { IngestionConflictClass, ReconciliationRunState, ReconciliationSliceState } from "../domain/reconciliation-state";

export interface ReconciliationRunRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly connectedAccountId: string;
  readonly state: ReconciliationRunState;
  readonly initiatorType: "user" | "system";
  readonly initiatorUserId: string | null;
  readonly correlationId: string;
  readonly requestedAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly budget: {
    readonly listingPagesPerSlice: number;
    readonly interactionPagesPerSlice: number;
    readonly continuationsPerContent: number;
    readonly interactionPagesPerContent: number;
    readonly contentItems: number;
    readonly overlapSeconds: number;
    readonly maxOperations: number;
  };
  readonly operationsUsed: number;
  readonly pagesUsed: number;
  readonly contentItemsUsed: number;
  readonly failureClass: string | null;
}

export interface ReconciliationSliceRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly connectedAccountId: string;
  readonly unit: SliceUnit;
  readonly contentItemId: string | null;
  readonly sequence: number;
  readonly state: ReconciliationSliceState;
  readonly attempt: number;
  readonly leasedUntil: Date | null;
  /** Opaque provider continuation: short-lived slice state only (never logged, never in a payload). */
  readonly cursor: string | null;
  readonly cursorIssuedAt: Date | null;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly maxPages: number;
  readonly pagesRead: number;
  readonly operationsUsed: number;
  readonly conflictCount: number;
  readonly failureClass: string | null;
  readonly retryNotBefore: Date | null;
}

export interface ReconciliationWatermarkRecord {
  readonly connectedAccountId: string;
  readonly contentItemId: string;
  readonly epochAt: Date;
  readonly syncedThrough: Date | null;
  readonly latestCreatedAt: Date | null;
  readonly consecutiveFailures: number;
  readonly retryNotBefore: Date | null;
}

/** The request boundary's answer (ingestion.request_reconciliation, 0019). */
export type ReconciliationRequestResult =
  | { readonly outcome: "requested"; readonly runId: string; readonly outboxId: string }
  | { readonly outcome: "already_running"; readonly runId: string }
  | { readonly outcome: "not_found" };

export interface NewReconciliationSlice {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly connectedAccountId: string;
  readonly unit: SliceUnit;
  readonly contentItemId: string | null;
  readonly sequence: number;
  readonly cursor: string | null;
  readonly cursorIssuedAt: Date | null;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly maxPages: number;
  /** Creation time: the serial chain's order (strictly increasing within one run). */
  readonly createdAt: Date;
}

/** A slice's terminal (or CONTINUED) state, written once with what it consumed. */
export interface SliceFinish {
  readonly state: Exclude<ReconciliationSliceState, "PENDING" | "RUNNING">;
  readonly failureClass: string | null;
  readonly retryNotBefore: Date | null;
}

export interface ReconciliationStore {
  // ── runs ─────────────────────────────────────────────────────────────────────────────────────────────
  /**
   * The ONE creation path of a run (0019 ingestion.request_reconciliation, atomic: authorization, one-open check, the
   * REQUESTED run with its budget, its audit event and its planner outbox row). `requestedAt`/`budget` are honored only
   * for the job runtime; a web caller must pass null for both (the boundary refuses anything else).
   */
  requestRun(input: { readonly connectedAccountId: string; readonly correlationId: string; readonly requestedAt: Date | null; readonly budget: ReconciliationRunRecord["budget"] | null }): Promise<ReconciliationRequestResult>;
  openRun(connectedAccountId: string): Promise<ReconciliationRunRecord | undefined>;
  /** Row-locked authoritative read. */
  lockRun(id: string): Promise<ReconciliationRunRecord | undefined>;
  /** REQUESTED → RUNNING; false when the run is no longer REQUESTED. */
  startRun(id: string, now: Date): Promise<boolean>;
  /** Open → terminal; false when it already finished. */
  finishRun(id: string, state: "COMPLETED" | "PARTIAL" | "SKIPPED_UNAVAILABLE" | "FAILED", failureClass: string | null, now: Date): Promise<boolean>;
  /** Reserves ONE provider operation for a RUNNING run iff fewer than its persisted max_operations were used (atomic). */
  reserveRunOperation(runId: string, now: Date): Promise<boolean>;
  addRunUsage(runId: string, usage: { readonly pages: number; readonly contentItems: number }, now: Date): Promise<void>;
  // ── slices ───────────────────────────────────────────────────────────────────────────────────────────
  insertSlice(slice: NewReconciliationSlice): Promise<void>;
  lockSlice(id: string): Promise<ReconciliationSliceRecord | undefined>;
  /**
   * PENDING (or an earlier attempt's RUNNING) → RUNNING with attempt + 1 and a lease; `busy` when another slice of the
   * account is RUNNING (the one-running index). A cursor older than its maximum age is dropped in the same statement.
   */
  claimSlice(id: string, leaseUntil: Date, now: Date, dropCursorIssuedBefore: Date): Promise<ReconciliationSliceRecord | "busy" | undefined>;
  /** One provider operation (and page) on a RUNNING slice of this attempt; false when the slice moved on. */
  recordSliceOperation(id: string, attempt: number, pages: number, now: Date): Promise<boolean>;
  /** Clears a RUNNING slice's cursor (restart its window). */
  dropSliceCursor(id: string, now: Date): Promise<void>;
  /** RUNNING → terminal/CONTINUED (cursor cleared, lease released); false when not RUNNING at `attempt`. */
  finishSlice(id: string, attempt: number, finish: SliceFinish, conflicts: number, now: Date): Promise<boolean>;
  /** PENDING → terminal without running (the run stopped before it). */
  finishPendingSlice(id: string, finish: SliceFinish, now: Date): Promise<boolean>;
  /** The run's next PENDING slice in chain order (creation time, then id). */
  nextPendingSlice(runId: string): Promise<ReconciliationSliceRecord | undefined>;
  pendingSlices(runId: string): Promise<readonly ReconciliationSliceRecord[]>;
  sliceStates(runId: string): Promise<readonly { readonly unit: SliceUnit; readonly state: ReconciliationSliceState }[]>;
  /** The latest rate-limit back-off still in force for the account (`retry_not_before` > now), if any. */
  activeBackoff(connectedAccountId: string, now: Date): Promise<Date | undefined>;
  // ── watermarks ───────────────────────────────────────────────────────────────────────────────────────
  watermark(connectedAccountId: string, contentItemId: string): Promise<ReconciliationWatermarkRecord | undefined>;
  watermarksWithSync(connectedAccountId: string): Promise<readonly ReconciliationWatermarkRecord[]>;
  /**
   * A traversal reached the provider's end: creates the watermark (epoch = `syncedThrough`) or advances it. Never
   * regresses: synced-through and the latest creation time only move forward (GREATEST), failures reset.
   */
  recordCompleteTraversal(input: {
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly connectedAccountId: string;
    readonly contentItemId: string;
    readonly contentKind: string;
    readonly source: string;
    readonly syncedThrough: Date;
    readonly latestCreatedAt: Date | null;
    readonly runId: string;
    readonly now: Date;
  }): Promise<void>;
  /** A traversal of a content with a watermark failed: one more consecutive failure, and an optional back-off. */
  recordTraversalFailure(connectedAccountId: string, contentItemId: string, retryNotBefore: Date | null, now: Date): Promise<void>;
  // ── conflicts ────────────────────────────────────────────────────────────────────────────────────────
  appendConflict(conflict: {
    readonly id: string;
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly connectedAccountId: string;
    readonly runId: string;
    readonly sliceId: string;
    readonly interactionId: string | null;
    readonly conflictClass: IngestionConflictClass;
    readonly observedAt: Date;
    readonly correlationId: string;
  }): Promise<void>;
  // ── dispatch (IDs-only outbox rows, in this transaction) ─────────────────────────────────────────────
  enqueueSlice(slice: Pick<ReconciliationSliceRecord, "id" | "organizationId" | "workspaceId" | "connectedAccountId">, correlationId: string, outboxId: string, now: Date): Promise<void>;
}

/** The account, connection, credential, capability and switch reads reconciliation re-checks before every operation. */
export interface ReconciliationAuthorityStore {
  account(id: string): Promise<ConnectedAccount | undefined>;
  connection(id: string): Promise<Connection | undefined>;
  /** Share-locked: serializes with a concurrent connection removal (the commit step's re-check). */
  connectionForShare(id: string): Promise<Connection | undefined>;
  credential(id: string): Promise<{ readonly connectionId: string; readonly envelope: Uint8Array } | undefined>;
  readonly capability: CapabilityReadStore;
  /** Every operational switch row visible to the job scope. */
  switches(): Promise<readonly { readonly switchKey: string; readonly qualifier: string; readonly scope: string; readonly organizationId: string | null; readonly workspaceId: string | null; readonly value: unknown }[]>;
}

/** The ingestion-owned event reads the terminal consumer needs: identifiers only, never text. */
export interface ObservedEventAuthority {
  readonly id: string;
  readonly interactionId: string;
  readonly conversationId: string | null;
  readonly sourceTextVersionId: string | null;
  readonly change: string;
  readonly arrival: string;
}
