/**
 * Reconciliation of work items (WORKFLOW-WF-2C): repairs what a deployment gap, a lost write or an operator mistake can
 * leave behind — a conversation WITHOUT its work item, and a work item whose projected activity no longer matches its
 * members — and REPORTS (never acts on) a Done conversation that may have missed its objective reopen.
 *
 * Guarantees (each proven by tests/db/local/workflow-transition-window.test.ts):
 *   - no state transition, ever: a repair is the rebuild (no member joins, so no reopen and no version change); a
 *     manual Done, its resolution, its attribution and its version are preserved;
 *   - lock, then recompute (the projection's own order): safe beside concurrent ingestion;
 *   - idempotent: a missing item is created once (`created` event once; the insert ignores an existing row), a repaired
 *     item is unchanged on the next pass; no audit event is written (nothing changes state);
 *   - dry run: the same classification from reads only (the caller runs it in a READ ONLY transaction).
 * "Review" — a Done item with an audience member Wrenkind first observed AFTER the Done — is reported for a person to
 * look at. Deciding it would be a transition (reopen), which reconciliation never makes.
 */
import type { CorrelationId } from "@/domain/correlation";
import { rebuildWorkItem, type ProjectionClock } from "./project-activity";
import type { ConversationActivitySource, WorkflowProjectionStore } from "./ports";

/** Reads reconciliation needs from the interactions owner (composed in). */
export interface ReconciliationAudienceSource {
  audienceObservedSince(conversationId: string, since: Date): Promise<boolean>;
}

export type ItemReconciliation = "created" | "repaired" | "unchanged";

export interface ItemReport {
  readonly outcome: ItemReconciliation;
  /** A Done item that may have missed its reopen (reported only). */
  readonly review: boolean;
}

export async function reconcileWorkItem(
  ports: { readonly store: WorkflowProjectionStore; readonly activity: ConversationActivitySource; readonly audience: ReconciliationAudienceSource; readonly clock: ProjectionClock },
  input: { readonly conversationId: string; readonly organizationId: string; readonly workspaceId: string; readonly correlationId: CorrelationId; readonly dryRun: boolean },
): Promise<ItemReport> {
  let outcome: ItemReconciliation;
  if (input.dryRun) {
    const current = await ports.store.find(input.conversationId);
    const latest = await ports.activity.latestActivity(input.conversationId);
    outcome = current === undefined ? "created" : latest !== null && latest.getTime() !== current.latestActivityAt.getTime() ? "repaired" : "unchanged";
  } else {
    const rebuilt = await rebuildWorkItem(ports.store, ports.activity, ports.clock, { conversationId: input.conversationId, organizationId: input.organizationId, workspaceId: input.workspaceId, correlationId: input.correlationId });
    outcome = rebuilt.kind === "unchanged" ? "unchanged" : rebuilt.created ? "created" : "repaired";
  }
  // After the rebuild the item is locked in this transaction: its state is the one reported on.
  const item = await ports.store.find(input.conversationId);
  const review = item !== undefined && item.state === "DONE" && (await ports.audience.audienceObservedSince(input.conversationId, item.stateChangedAt));
  return { outcome, review };
}
