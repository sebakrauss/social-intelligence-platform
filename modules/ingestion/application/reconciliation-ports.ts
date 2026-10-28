/**
 * What the reconciliation runtime needs from its transactions (Step H6-C3; design H6-C0; migration 0018). Every store
 * is bound to ONE workspace-scoped job transaction (RLS binds the workspace); composed by
 * server/persistence/ingestion.ts. The reconciliation tables are this module's; the account, connection, credential
 * and capability reads are the owners' published ports, never their tables.
 */
import type { CapabilityReadStore } from "@/modules/capability";
import type { ConnectedAccount, Connection } from "@/modules/connections";
import type { WorkspaceId } from "@/domain/ids";
import type { StoredInteractionAuthority } from "@/modules/interactions";
import type { SliceUnit } from "../domain/reconciliation-slice";
import type { IngestionConflictClass, ReconciliationRunState, ReconciliationSliceState } from "../domain/reconciliation-state";
import type { HintChange, PendingMarksSummary, SignalMarkKind, SignalRunPlan } from "../domain/signals";

export interface ReconciliationRunRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly connectedAccountId: string;
  readonly state: ReconciliationRunState;
  readonly initiatorType: "user" | "system";
  readonly initiatorUserId: string | null;
  readonly correlationId: string;
  /** 0022: `account` (listing + newest content) or `relist` (signal marks' canonical content only). Immutable. */
  readonly plan: SignalRunPlan;
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

/** The web's ONLY reach into reconciliation (Step H6-C4): the 0019 request boundary, nothing else of the store. */
export type ReconciliationRequestPort = Pick<ReconciliationStore, "requestRun">;

export interface ReconciliationStore {
  // ── runs ─────────────────────────────────────────────────────────────────────────────────────────────
  /**
   * The ONE creation path of a run (0019 ingestion.request_reconciliation, atomic: authorization, one-open check, the
   * REQUESTED run with its budget, its audit event and its planner outbox row). `requestedAt`/`budget` are honored only
   * for the job runtime; a web caller must pass null for both (the boundary refuses anything else).
   */
  requestRun(input: {
    readonly connectedAccountId: string;
    readonly correlationId: string;
    readonly requestedAt: Date | null;
    readonly budget: ReconciliationRunRecord["budget"] | null;
    /** Step H6-F4: the job runtime's plan (sent inside the 0022 budget JSON); omitted = `account`. */
    readonly plan?: SignalRunPlan;
  }): Promise<ReconciliationRequestResult>;
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
  /** Step H6-F4: the contents whose interactions this run traversed to the provider's end (a COMPLETED content slice). */
  completedContentItems(runId: string): Promise<readonly string[]>;
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
  /** Step H6-E: the IDs-only `ingestion.confirm_interaction` row of one confirmation request (system initiator). */
  enqueueConfirmation(
    target: { readonly organizationId: string; readonly workspaceId: string; readonly connectedAccountId: string; readonly interactionId: string },
    correlationId: string,
    outboxId: string,
    now: Date,
    /** Step H6-F4: a deterministic dispatch key (one per routed signal); omitted = the request's own key. */
    dispatchKey?: string,
  ): Promise<"appended" | "exists">;
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
  /**
   * Step H6-E: the STORED provenance of a canonical observed interaction of the bound workspace, issued by the
   * interactions persistence layer (the only issuer, H6-A1 TL decision 1) — or undefined (unknown, placeholder, or
   * another workspace's: RLS hides it).
   */
  storedInteraction(workspaceId: WorkspaceId, platform: string, providerInteractionId: string): Promise<StoredInteractionAuthority | undefined>;
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

// ── Step H6-F4: webhook-signal marks (0022 ingestion.signal_marks) ──────────────────────────────────────────────
/** A routed hint's identifiers as the 0022 worker boundary re-derives them for the bound workspace's account. */
export type RoutedHintRead =
  | {
    readonly outcome: "ok";
    readonly platform: "facebook" | "instagram";
    readonly targetKind: "content" | "interaction";
    readonly providerTargetId: string;
    readonly providerContentId: string | null;
    readonly providerParentId: string | null;
    readonly change: HintChange;
  }
  | { readonly outcome: "account_inactive" }
  | { readonly outcome: "not_found" };

export interface NewSignalMark {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly connectedAccountId: string;
  readonly kind: SignalMarkKind;
  readonly contentItemId: string | null;
  readonly signalAt: Date;
  readonly expiresAt: Date;
}

/**
 * The tenant signal-mark store (bound workspace; RLS). A mark exists only while pending: satisfied, expired or dropped
 * marks are deleted. `requested_run_id` is traceability only, never satisfaction. No provider id or text is stored.
 */
export interface SignalMarkStore {
  /** ingestion.provider_event_hint: the hint only if ROUTED and its (platform, asset) is this workspace's ACTIVE account. */
  routedHint(hintId: string, connectedAccountId: string): Promise<RoutedHintRead>;
  /** Coalescing upsert: one pending row per (account, kind, content); count + 1, last signal = greatest, first and expiry kept. */
  upsert(mark: NewSignalMark, now: Date): Promise<void>;
  summary(connectedAccountId: string): Promise<PendingMarksSummary>;
  /** Pending relist marks a traversal starting now satisfies (last signal ≤ boundary), oldest first, bounded. */
  relistCandidates(connectedAccountId: string, boundary: Date, limit: number): Promise<readonly { readonly id: string; readonly contentItemId: string }[]>;
  /** Sets every pending mark's next revisit (the due-mark sweep re-dispatches it then). */
  deferAll(connectedAccountId: string, until: Date, now: Date): Promise<number>;
  linkRun(markIds: readonly string[], runId: string, now: Date): Promise<void>;
  satisfyRelist(connectedAccountId: string, contentItemIds: readonly string[], boundary: Date): Promise<number>;
  satisfyAccount(connectedAccountId: string, boundary: Date): Promise<number>;
  deleteExpired(connectedAccountId: string, now: Date): Promise<number>;
  drop(markIds: readonly string[]): Promise<number>;
  /** Request times of this account's signal-initiated runs (initiator system, correlation `sig.*`) after `since`. */
  signalRunsSince(connectedAccountId: string, since: Date): Promise<readonly Date[]>;
}
