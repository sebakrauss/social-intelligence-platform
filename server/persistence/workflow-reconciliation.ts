/**
 * Workflow reconciliation entry point (WORKFLOW-WF-2C): one workspace's work items checked against its conversations,
 * in bounded batches, each batch its OWN workspace job transaction (worker login → app_worker → sealed workspace: the
 * job runtime's existing scope and RLS; no new role, grant or service). Composed here, like the ingestion stores, so the
 * workflow module never imports another module's persistence.
 *
 *   batches      conversation ids in ascending order, `batchSize` at a time; the report of each batch carries the
 *                position to resume from (`next`), so an interrupted run continues where it stopped and a finished run
 *                can simply be run again (it is idempotent);
 *   isolation    each item runs in its own savepoint: one failing item is rolled back alone and counted as failed;
 *   dry run      the batch transaction is made READ ONLY after the scope is bound: the classification is computed from
 *                reads and the database refuses any write;
 *   identity     the run's correlation id (`workflow-reconcile.<run>`) is written on every `created` event it causes.
 *
 * Nothing here decides a state: see modules/workflow/application/reconcile.ts.
 */
import { randomUUID } from "node:crypto";
import { parseCorrelationId, type CorrelationId } from "@/domain/correlation";
import { createPostgresAuditLog } from "@/modules/audit/persistence";
import { createPostgresConversationStore } from "@/modules/conversations/persistence";
import { createPostgresInteractionStore } from "@/modules/interactions/persistence";
import { boundWorkspaceOrganization } from "@/modules/tenancy/persistence";
import { reconcileWorkItem, type ItemReconciliation } from "@/modules/workflow";
import { createPostgresWorkflowProjectionStore } from "@/modules/workflow/persistence";
import { makeTransactionReadOnly, withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";

export const RECONCILIATION_MAX_BATCH = 500;
/** Ids listed per category in a report (counts are always complete). */
export const RECONCILIATION_LISTED_IDS = 100;

export interface ReconciliationCounts {
  readonly inspected: number;
  readonly created: number;
  readonly repaired: number;
  readonly unchanged: number;
  readonly failed: number;
  /** Done items with an audience member first observed after the Done: reported for a person, never reopened here. */
  readonly review: number;
}

export interface ReconciliationBatchReport {
  readonly after: string | null;
  /** Where the next batch starts; null when the workspace has no more conversations. */
  readonly next: string | null;
  readonly counts: ReconciliationCounts;
  readonly failedIds: readonly string[];
  readonly reviewIds: readonly string[];
}

export interface ReconciliationReport extends ReconciliationBatchReport {
  readonly runCorrelationId: string;
  readonly dryRun: boolean;
  readonly batches: number;
  /** True when the run stopped at `maxBatches` before the end (resume from `next`). */
  readonly stoppedEarly: boolean;
}

export interface ReconciliationInput {
  readonly workspaceId: string;
  readonly dryRun: boolean;
  readonly batchSize: number;
  /** Resume position (a conversation id from a previous report's `next`), or null for the start. */
  readonly after: string | null;
  /** At most this many batches in this run (undefined: until the end). */
  readonly maxBatches?: number;
  /** For a resumed run: the original run's correlation id (so its events stay one run). */
  readonly runCorrelationId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ZERO: ReconciliationCounts = { inspected: 0, created: 0, repaired: 0, unchanged: 0, failed: 0, review: 0 };
const add = (a: ReconciliationCounts, b: ReconciliationCounts): ReconciliationCounts => ({
  inspected: a.inspected + b.inspected, created: a.created + b.created, repaired: a.repaired + b.repaired,
  unchanged: a.unchanged + b.unchanged, failed: a.failed + b.failed, review: a.review + b.review,
});

async function reconcileBatch(tx: DatabaseTransaction, workspaceId: string, after: string | null, batchSize: number, dryRun: boolean, correlationId: CorrelationId): Promise<ReconciliationBatchReport> {
  // A dry run cannot write, whatever the code below does: the database refuses it.
  if (dryRun) await makeTransactionReadOnly(tx);
  const organizationId = await boundWorkspaceOrganization(tx);
  if (organizationId === undefined) throw new Error("reconciliation_workspace_unbound");
  const ids = await createPostgresConversationStore(tx).pageIds({ after, limit: batchSize });
  const tally: Record<ItemReconciliation | "failed" | "review", number> = { created: 0, repaired: 0, unchanged: 0, failed: 0, review: 0 };
  const failedIds: string[] = [];
  const reviewIds: string[] = [];
  for (const conversationId of ids) {
    try {
      const report = await tx.transaction(async (savepoint) =>
        reconcileWorkItem(
          {
            store: createPostgresWorkflowProjectionStore(savepoint, createPostgresAuditLog(savepoint)),
            activity: { latestActivity: (id) => createPostgresInteractionStore(savepoint).latestConversationActivity(id) },
            audience: { audienceObservedSince: (id, since) => createPostgresInteractionStore(savepoint).audienceObservedSince(id, since) },
            clock: { newId: randomUUID, now: () => new Date() },
          },
          { conversationId, organizationId, workspaceId, correlationId, dryRun },
        ));
      tally[report.outcome] += 1;
      if (report.review) {
        tally.review += 1;
        if (reviewIds.length < RECONCILIATION_LISTED_IDS) reviewIds.push(conversationId);
      }
    } catch {
      // The savepoint rolled this item back alone; nothing about the error (it may name values) is reported.
      tally.failed += 1;
      if (failedIds.length < RECONCILIATION_LISTED_IDS) failedIds.push(conversationId);
    }
  }
  return {
    after,
    next: ids.length === batchSize ? (ids.at(-1) ?? null) : null,
    counts: { inspected: ids.length, created: tally.created, repaired: tally.repaired, unchanged: tally.unchanged, failed: tally.failed, review: tally.review },
    failedIds,
    reviewIds,
  };
}

/** Reconciles one workspace's work items, batch by batch, reporting each batch as it commits. */
export async function reconcileWorkspaceWorkItems(worker: RuntimeDatabase<"worker">, input: ReconciliationInput, onBatch?: (report: ReconciliationBatchReport) => void): Promise<ReconciliationReport> {
  if (!UUID.test(input.workspaceId)) throw new RangeError("reconciliation: workspace id required");
  if (!Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > RECONCILIATION_MAX_BATCH) throw new RangeError("reconciliation: batch size out of bounds");
  if (input.after !== null && !UUID.test(input.after)) throw new RangeError("reconciliation: resume position invalid");
  const runCorrelationId = input.runCorrelationId ?? `workflow-reconcile.${randomUUID()}`;
  const correlationId = parseCorrelationId(runCorrelationId);
  if (correlationId === undefined || !runCorrelationId.startsWith("workflow-reconcile.")) throw new RangeError("reconciliation: run correlation id invalid");
  let counts = ZERO;
  const failedIds: string[] = [];
  const reviewIds: string[] = [];
  let after = input.after;
  let batches = 0;
  for (;;) {
    const report = await withWorkspaceJobScope(worker, input.workspaceId, (tx) => reconcileBatch(tx, input.workspaceId, after, input.batchSize, input.dryRun, correlationId));
    batches += 1;
    onBatch?.(report);
    counts = add(counts, report.counts);
    failedIds.push(...report.failedIds.slice(0, RECONCILIATION_LISTED_IDS - failedIds.length));
    reviewIds.push(...report.reviewIds.slice(0, RECONCILIATION_LISTED_IDS - reviewIds.length));
    after = report.next;
    const stoppedEarly = after !== null && input.maxBatches !== undefined && batches >= input.maxBatches;
    if (after === null || stoppedEarly) return { runCorrelationId, dryRun: input.dryRun, batches, stoppedEarly, after: input.after, next: after, counts, failedIds, reviewIds };
  }
}
