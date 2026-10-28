/**
 * Reconciliation runtime persistence (Step H6-C3; migration 0018). Runs inside the caller's workspace-scoped job
 * transaction (RLS binds the workspace). Every transition re-reads and conditions on the stored state — a caller never
 * asserts the current state — and the 0018 guards refuse what this code would never ask for (a finished run or slice
 * changing again, a claim without an attempt increment, counters going down, a watermark regressing).
 *
 * The provider cursor is written only to its slice row and never returned to a log; outbox rows carry UUID subjects
 * only (`ingestion.reconcile_slice:{slice}` here; the planner's `ingestion.reconcile_account:{run}` row is written by
 * the 0019 request boundary itself). A run is created ONLY through that boundary (requestRun): authorization, the
 * one-open check, the budget, the audit event and the planner row live in one reviewed SQL function.
 */
import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { appendOutboxOnce, postgresError, type DatabaseTransaction } from "@/platform/db";
import type { OutboxNotice } from "@/platform/outbox";
import type {
  ReconciliationRunRecord,
  ReconciliationSliceRecord,
  ReconciliationStore,
  ReconciliationWatermarkRecord,
} from "../application/reconciliation-ports";
import { RECONCILE_SLICE_TOPIC, SLICE_UNITS, sliceDispatchKey, type SliceUnit } from "../domain/reconciliation-slice";
import { CONFIRM_INTERACTION_TOPIC, confirmationDispatchKey } from "../domain/confirmation";
import { RECONCILIATION_RUN_STATES, RECONCILIATION_SLICE_STATES, type ReconciliationRunState, type ReconciliationSliceState } from "../domain/reconciliation-state";
import type { SignalRunPlan } from "../domain/signals";
import { authorityConflicts, reconciliationRuns, reconciliationSlices, reconciliationWatermarks } from "./reconciliation-tables";

const runState = (value: string): ReconciliationRunState => {
  const state = RECONCILIATION_RUN_STATES.find((known) => known === value);
  if (state === undefined) throw new Error("reconciliation_run_incoherent");
  return state;
};
const sliceState = (value: string): ReconciliationSliceState => {
  const state = RECONCILIATION_SLICE_STATES.find((known) => known === value);
  if (state === undefined) throw new Error("reconciliation_slice_incoherent");
  return state;
};
const unitOf = (value: string): SliceUnit => {
  const unit = SLICE_UNITS.find((known) => known === value);
  if (unit === undefined) throw new Error("reconciliation_slice_incoherent");
  return unit;
};

const planOf = (value: string): SignalRunPlan => {
  if (value === "account" || value === "relist") return value;
  throw new Error("reconciliation_run_incoherent");
};

type RunRow = typeof reconciliationRuns.$inferSelect;
type SliceRow = typeof reconciliationSlices.$inferSelect;

const runRecord = (row: RunRow): ReconciliationRunRecord => ({
  id: row.id,
  organizationId: row.organizationId,
  workspaceId: row.workspaceId,
  connectedAccountId: row.connectedAccountId,
  state: runState(row.state),
  initiatorType: row.initiatorType === "user" ? "user" : "system",
  initiatorUserId: row.initiatorUserId,
  correlationId: row.correlationId,
  plan: planOf(row.plan),
  requestedAt: row.requestedAt,
  startedAt: row.startedAt,
  completedAt: row.completedAt,
  budget: {
    listingPagesPerSlice: row.budgetListingPagesPerSlice,
    interactionPagesPerSlice: row.budgetInteractionPagesPerSlice,
    continuationsPerContent: row.budgetContinuationsPerContent,
    interactionPagesPerContent: row.budgetInteractionPagesPerContent,
    contentItems: row.budgetContentItems,
    overlapSeconds: row.budgetOverlapSeconds,
    maxOperations: row.maxOperations,
  },
  operationsUsed: row.operationsUsed,
  pagesUsed: row.pagesUsed,
  contentItemsUsed: row.contentItemsUsed,
  failureClass: row.failureClass,
});

const sliceRecord = (row: SliceRow): ReconciliationSliceRecord => ({
  id: row.id,
  organizationId: row.organizationId,
  workspaceId: row.workspaceId,
  runId: row.reconciliationRunId,
  connectedAccountId: row.connectedAccountId,
  unit: unitOf(row.unit),
  contentItemId: row.contentItemId,
  sequence: row.sequence,
  state: sliceState(row.state),
  attempt: row.attempt,
  leasedUntil: row.leasedUntil,
  cursor: row.cursor,
  cursorIssuedAt: row.cursorIssuedAt,
  windowStart: row.windowStart,
  windowEnd: row.windowEnd,
  maxPages: row.maxPages,
  pagesRead: row.pagesRead,
  operationsUsed: row.operationsUsed,
  conflictCount: row.conflictCount,
  failureClass: row.failureClass,
  retryNotBefore: row.retryNotBefore,
});

const watermarkRecord = (row: typeof reconciliationWatermarks.$inferSelect): ReconciliationWatermarkRecord => ({
  connectedAccountId: row.connectedAccountId,
  contentItemId: row.contentItemId,
  epochAt: row.epochAt,
  syncedThrough: row.syncedThrough,
  latestCreatedAt: row.latestCreatedAt,
  consecutiveFailures: row.consecutiveFailures,
  retryNotBefore: row.retryNotBefore,
});

/** `noteAppended` reports each appended outbox row for the post-commit relay wake-up (the job scope's `noteOutbox`). */
export function createPostgresReconciliationStore(tx: DatabaseTransaction, noteAppended: (notice: OutboxNotice) => void): ReconciliationStore {
  const OPEN_RUN = inArray(reconciliationRuns.state, ["REQUESTED", "RUNNING"]);
  const append = async (message: Parameters<typeof appendOutboxOnce>[1]): Promise<void> => {
    if ((await appendOutboxOnce(tx, message)) === "appended") noteAppended(message);
  };
  return {
    async requestRun(input) {
      const budget = input.budget === null ? null : JSON.stringify({
        listing_pages_per_slice: input.budget.listingPagesPerSlice,
        interaction_pages_per_slice: input.budget.interactionPagesPerSlice,
        continuations_per_content: input.budget.continuationsPerContent,
        content_items: input.budget.contentItems,
        overlap_seconds: input.budget.overlapSeconds,
        max_operations: input.budget.maxOperations,
        // Step H6-F4 (0022): the worker branch accepts `plan`; an account run sends none (the boundary's default).
        ...(input.plan === undefined || input.plan === "account" ? {} : { plan: input.plan }),
      });
      const result = await tx.execute<{ outcome: string; reconciliation_run_id: string | null; outbox_id: string | null }>(sql`
        select outcome, reconciliation_run_id, outbox_id
          from ingestion.request_reconciliation(${input.connectedAccountId}::uuid, ${input.correlationId}, ${input.requestedAt}::timestamptz, ${budget}::jsonb)`);
      const row = result.rows[0];
      if (row?.outcome === "requested" && row.reconciliation_run_id !== null && row.outbox_id !== null) {
        // The definer inserted the planner row in THIS transaction: same post-commit wake-up as an appended one.
        noteAppended({ id: row.outbox_id, correlationId: input.correlationId });
        return { outcome: "requested", runId: row.reconciliation_run_id, outboxId: row.outbox_id };
      }
      if (row?.outcome === "already_running" && row.reconciliation_run_id !== null) return { outcome: "already_running", runId: row.reconciliation_run_id };
      if (row?.outcome === "not_found") return { outcome: "not_found" };
      throw new Error("reconciliation_request_incoherent");
    },
    async openRun(connectedAccountId) {
      const rows = await tx.select().from(reconciliationRuns).where(and(eq(reconciliationRuns.connectedAccountId, connectedAccountId), OPEN_RUN)).limit(1);
      return rows[0] === undefined ? undefined : runRecord(rows[0]);
    },
    async lockRun(id) {
      const rows = await tx.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, id)).limit(1).for("update");
      return rows[0] === undefined ? undefined : runRecord(rows[0]);
    },
    async startRun(id, now) {
      const rows = await tx.update(reconciliationRuns).set({ state: "RUNNING", startedAt: now, updatedAt: now })
        .where(and(eq(reconciliationRuns.id, id), eq(reconciliationRuns.state, "REQUESTED"))).returning({ id: reconciliationRuns.id });
      return rows.length === 1;
    },
    async finishRun(id, state, failureClass, now) {
      const rows = await tx.update(reconciliationRuns)
        .set({ state, failureClass, completedAt: now, updatedAt: now, ...(state === "SKIPPED_UNAVAILABLE" ? {} : { startedAt: sql`coalesce(${reconciliationRuns.startedAt}, ${now})` }) })
        .where(and(eq(reconciliationRuns.id, id), OPEN_RUN)).returning({ id: reconciliationRuns.id });
      return rows.length === 1;
    },
    async reserveRunOperation(runId, now) {
      // The run's own persisted budget (0019), never a deployment constant.
      const rows = await tx.update(reconciliationRuns)
        .set({ operationsUsed: sql`${reconciliationRuns.operationsUsed} + 1`, updatedAt: now })
        .where(and(eq(reconciliationRuns.id, runId), eq(reconciliationRuns.state, "RUNNING"), lt(reconciliationRuns.operationsUsed, reconciliationRuns.maxOperations)))
        .returning({ id: reconciliationRuns.id });
      return rows.length === 1;
    },
    async addRunUsage(runId, usage, now) {
      await tx.update(reconciliationRuns)
        .set({ pagesUsed: sql`${reconciliationRuns.pagesUsed} + ${usage.pages}`, contentItemsUsed: sql`${reconciliationRuns.contentItemsUsed} + ${usage.contentItems}`, updatedAt: now })
        .where(eq(reconciliationRuns.id, runId));
    },
    async insertSlice(slice) {
      await tx.insert(reconciliationSlices).values({
        id: slice.id,
        organizationId: slice.organizationId,
        workspaceId: slice.workspaceId,
        reconciliationRunId: slice.runId,
        connectedAccountId: slice.connectedAccountId,
        unit: slice.unit,
        contentItemId: slice.contentItemId,
        sequence: slice.sequence,
        state: "PENDING",
        attempt: 0,
        cursor: slice.cursor,
        cursorIssuedAt: slice.cursorIssuedAt,
        windowStart: slice.windowStart,
        windowEnd: slice.windowEnd,
        maxPages: slice.maxPages,
        pagesRead: 0,
        operationsUsed: 0,
        conflictCount: 0,
        createdAt: slice.createdAt,
        updatedAt: slice.createdAt,
      });
    },
    async lockSlice(id) {
      const rows = await tx.select().from(reconciliationSlices).where(eq(reconciliationSlices.id, id)).limit(1).for("update");
      return rows[0] === undefined ? undefined : sliceRecord(rows[0]);
    },
    async claimSlice(id, leaseUntil, now, dropCursorIssuedBefore) {
      try {
        // A savepoint: a refused claim (another RUNNING slice of the account) must not abort the caller's transaction.
        const rows = await tx.transaction((savepoint) =>
          savepoint.update(reconciliationSlices)
            .set({
              state: "RUNNING",
              attempt: sql`${reconciliationSlices.attempt} + 1`,
              leasedUntil: leaseUntil,
              cursor: sql`case when ${reconciliationSlices.cursorIssuedAt} < ${dropCursorIssuedBefore} then null else ${reconciliationSlices.cursor} end`,
              cursorIssuedAt: sql`case when ${reconciliationSlices.cursorIssuedAt} < ${dropCursorIssuedBefore} then null else ${reconciliationSlices.cursorIssuedAt} end`,
              updatedAt: now,
            })
            .where(and(eq(reconciliationSlices.id, id), inArray(reconciliationSlices.state, ["PENDING", "RUNNING"])))
            .returning());
        return rows[0] === undefined ? undefined : sliceRecord(rows[0]);
      } catch (error) {
        const failure = postgresError(error);
        if (failure?.code === "23505" && failure.constraint === "reconciliation_slices_one_running") return "busy";
        throw error;
      }
    },
    async recordSliceOperation(id, attempt, pages, now) {
      const rows = await tx.update(reconciliationSlices)
        .set({ operationsUsed: sql`${reconciliationSlices.operationsUsed} + 1`, pagesRead: sql`${reconciliationSlices.pagesRead} + ${pages}`, updatedAt: now })
        .where(and(eq(reconciliationSlices.id, id), eq(reconciliationSlices.state, "RUNNING"), eq(reconciliationSlices.attempt, attempt)))
        .returning({ id: reconciliationSlices.id });
      return rows.length === 1;
    },
    async dropSliceCursor(id, now) {
      await tx.update(reconciliationSlices).set({ cursor: null, cursorIssuedAt: null, updatedAt: now })
        .where(and(eq(reconciliationSlices.id, id), eq(reconciliationSlices.state, "RUNNING")));
    },
    async finishSlice(id, attempt, finish, conflicts, now) {
      const rows = await tx.update(reconciliationSlices)
        .set({
          state: finish.state,
          failureClass: finish.failureClass,
          retryNotBefore: finish.retryNotBefore,
          completedAt: now,
          leasedUntil: null,
          cursor: null,
          cursorIssuedAt: null,
          conflictCount: sql`${reconciliationSlices.conflictCount} + ${conflicts}`,
          updatedAt: now,
        })
        .where(and(eq(reconciliationSlices.id, id), eq(reconciliationSlices.state, "RUNNING"), eq(reconciliationSlices.attempt, attempt)))
        .returning({ id: reconciliationSlices.id });
      return rows.length === 1;
    },
    async finishPendingSlice(id, finish, now) {
      const rows = await tx.update(reconciliationSlices)
        .set({ state: finish.state, failureClass: finish.failureClass, retryNotBefore: finish.retryNotBefore, completedAt: now, cursor: null, cursorIssuedAt: null, updatedAt: now })
        .where(and(eq(reconciliationSlices.id, id), eq(reconciliationSlices.state, "PENDING")))
        .returning({ id: reconciliationSlices.id });
      return rows.length === 1;
    },
    async nextPendingSlice(runId) {
      const rows = await tx.select().from(reconciliationSlices)
        .where(and(eq(reconciliationSlices.reconciliationRunId, runId), eq(reconciliationSlices.state, "PENDING")))
        .orderBy(asc(reconciliationSlices.createdAt), asc(reconciliationSlices.id)).limit(1);
      return rows[0] === undefined ? undefined : sliceRecord(rows[0]);
    },
    async pendingSlices(runId) {
      const rows = await tx.select().from(reconciliationSlices)
        .where(and(eq(reconciliationSlices.reconciliationRunId, runId), eq(reconciliationSlices.state, "PENDING")))
        .orderBy(asc(reconciliationSlices.createdAt), asc(reconciliationSlices.id));
      return rows.map(sliceRecord);
    },
    async sliceStates(runId) {
      const rows = await tx.select({ unit: reconciliationSlices.unit, state: reconciliationSlices.state }).from(reconciliationSlices)
        .where(eq(reconciliationSlices.reconciliationRunId, runId));
      return rows.map((row) => ({ unit: unitOf(row.unit), state: sliceState(row.state) }));
    },
    async completedContentItems(runId) {
      const rows = await tx.selectDistinct({ contentItemId: reconciliationSlices.contentItemId }).from(reconciliationSlices)
        .where(and(eq(reconciliationSlices.reconciliationRunId, runId), eq(reconciliationSlices.unit, "content_interactions"), eq(reconciliationSlices.state, "COMPLETED")));
      return rows.map((row) => row.contentItemId).filter((id): id is string => id !== null).sort();
    },
    async activeBackoff(connectedAccountId, now) {
      const rows = await tx.select({ retryNotBefore: reconciliationSlices.retryNotBefore }).from(reconciliationSlices)
        .where(and(eq(reconciliationSlices.connectedAccountId, connectedAccountId), gt(reconciliationSlices.retryNotBefore, now)))
        .orderBy(desc(reconciliationSlices.retryNotBefore)).limit(1);
      return rows[0]?.retryNotBefore ?? undefined;
    },
    async watermark(connectedAccountId, contentItemId) {
      const rows = await tx.select().from(reconciliationWatermarks)
        .where(and(eq(reconciliationWatermarks.connectedAccountId, connectedAccountId), eq(reconciliationWatermarks.contentItemId, contentItemId),
          eq(reconciliationWatermarks.capability, "read_interactions"))).limit(1).for("update");
      return rows[0] === undefined ? undefined : watermarkRecord(rows[0]);
    },
    async watermarksWithSync(connectedAccountId) {
      const rows = await tx.select().from(reconciliationWatermarks)
        .where(and(eq(reconciliationWatermarks.connectedAccountId, connectedAccountId), sql`${reconciliationWatermarks.syncedThrough} is not null`))
        .orderBy(asc(reconciliationWatermarks.contentItemId));
      return rows.map(watermarkRecord);
    },
    async recordCompleteTraversal(input) {
      await tx.insert(reconciliationWatermarks)
        .values({
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          connectedAccountId: input.connectedAccountId,
          contentItemId: input.contentItemId,
          capability: "read_interactions",
          contentKind: input.contentKind,
          source: input.source,
          epochAt: input.syncedThrough,
          syncedThrough: input.syncedThrough,
          latestCreatedAt: input.latestCreatedAt,
          lastReconciliationRunId: input.runId,
          consecutiveFailures: 0,
          retryNotBefore: null,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: [reconciliationWatermarks.workspaceId, reconciliationWatermarks.connectedAccountId, reconciliationWatermarks.capability, reconciliationWatermarks.contentItemId],
          set: {
            syncedThrough: sql`greatest(${reconciliationWatermarks.syncedThrough}, excluded.synced_through)`,
            latestCreatedAt: sql`greatest(${reconciliationWatermarks.latestCreatedAt}, excluded.latest_created_at)`,
            lastReconciliationRunId: input.runId,
            consecutiveFailures: 0,
            retryNotBefore: null,
            updatedAt: input.now,
          },
        });
    },
    async recordTraversalFailure(connectedAccountId, contentItemId, retryNotBefore, now) {
      await tx.update(reconciliationWatermarks)
        .set({
          consecutiveFailures: sql`${reconciliationWatermarks.consecutiveFailures} + 1`,
          ...(retryNotBefore === null ? {} : { retryNotBefore }),
          updatedAt: now,
        })
        .where(and(eq(reconciliationWatermarks.connectedAccountId, connectedAccountId), eq(reconciliationWatermarks.contentItemId, contentItemId),
          eq(reconciliationWatermarks.capability, "read_interactions")));
    },
    async appendConflict(conflict) {
      await tx.insert(authorityConflicts).values({
        id: conflict.id,
        organizationId: conflict.organizationId,
        workspaceId: conflict.workspaceId,
        connectedAccountId: conflict.connectedAccountId,
        reconciliationRunId: conflict.runId,
        reconciliationSliceId: conflict.sliceId,
        interactionId: conflict.interactionId,
        conflictClass: conflict.conflictClass,
        observedAt: conflict.observedAt,
        correlationId: conflict.correlationId,
        createdAt: conflict.observedAt,
      });
    },
    async enqueueSlice(slice, correlationId, outboxId, now) {
      await append({
        id: outboxId,
        topic: RECONCILE_SLICE_TOPIC,
        organizationId: slice.organizationId,
        workspaceId: slice.workspaceId,
        subjectIds: { connected_account_id: slice.connectedAccountId, reconciliation_slice_id: slice.id },
        correlationId,
        initiator: { type: "system" },
        dispatchKey: sliceDispatchKey({ sliceId: slice.id }),
        createdAt: now,
      });
    },
    async enqueueConfirmation(target, correlationId, outboxId, now, dispatchKey) {
      const message = {
        id: outboxId,
        topic: CONFIRM_INTERACTION_TOPIC,
        organizationId: target.organizationId,
        workspaceId: target.workspaceId,
        subjectIds: { connected_account_id: target.connectedAccountId, interaction_id: target.interactionId },
        correlationId,
        initiator: { type: "system" },
        dispatchKey: dispatchKey ?? confirmationDispatchKey(outboxId),
        createdAt: now,
      } satisfies Parameters<typeof appendOutboxOnce>[1];
      // A coalescing key already taken (a confirmation of this interaction in this bucket) appends nothing.
      const appended = await appendOutboxOnce(tx, message);
      if (appended === "appended") noteAppended(message);
      return appended;
    },
  };
}
