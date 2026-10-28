/**
 * One content's interactions traversal for a run (Step H6-F4d; TL D-F4B-1/D-F4B-2; migration 0023): the ONE place both
 * planners — the account plan (manual Sync and signal account runs) and the relist plan — create a content_interactions
 * slice. Traversal progress belongs to the content's reconciliation, never to the initiator.
 *
 *   continuation   the content has a parked cursor (a budget-abandoned slice kept its next unread page) that is
 *                  locally eligible (≤ 90 minutes since its DB parking time) and not superseded by a later complete
 *                  traversal: the new slice adopts the cursor AND the ORIGINAL window (window_start, window_end) — never
 *                  the new run's start, so finishing an old traversal can't satisfy a signal newer than its start. It is
 *                  ordered before the run's fresh traversals so the run's first operations go to it.
 *   fresh          otherwise: watermark − overlap (or the floor) → the run's start, exactly as before.
 * Either way the parked cursor is retired in the same transaction (row-locked): it is consumed at most once. A provider
 * that refuses the adopted cursor restarts the window once (readSlice's existing safe restart); nothing is claimed.
 */
import { RECONCILIATION_RUNTIME } from "../domain/reconciliation-state";
import type { ReconciliationRunRecord } from "./reconciliation-ports";
import type { ReconciliationClock, ReconciliationScope } from "./reconciliation-scope";

export type TraversalStart = "continued" | "fresh";

export async function insertContentTraversal(
  scope: ReconciliationScope,
  clock: ReconciliationClock,
  input: { readonly run: ReconciliationRunRecord; readonly contentItemId: string; readonly startedAt: Date; readonly base: Date; readonly order: number },
): Promise<TraversalStart> {
  const { run, contentItemId, startedAt, base, order } = input;
  const watermark = await scope.reconciliation.watermark(run.connectedAccountId, contentItemId);
  const parked = await scope.reconciliation.parkedContinuation(run.connectedAccountId, contentItemId);
  const slice = { id: clock.newId(), organizationId: run.organizationId, workspaceId: run.workspaceId, runId: run.id, connectedAccountId: run.connectedAccountId, unit: "content_interactions" as const, contentItemId, sequence: 0, maxPages: run.budget.interactionPagesPerSlice };
  if (parked !== undefined) {
    // Consumed at most once: adopted below, or stale (local TTL passed) or superseded (a later traversal completed).
    await scope.reconciliation.retireParkedCursor(parked.sliceId);
    const superseded = watermark?.syncedThrough !== null && watermark?.syncedThrough !== undefined && watermark.syncedThrough >= parked.windowEnd;
    if (parked.locallyEligible && !superseded) {
      await scope.reconciliation.insertSlice({
        ...slice,
        cursor: parked.cursor,
        cursorIssuedAt: parked.cursorIssuedAt,
        windowStart: parked.windowStart,
        windowEnd: parked.windowEnd,
        createdAt: new Date(base.getTime() - 1000 + order),
      });
      return "continued";
    }
  }
  const overlapMs = run.budget.overlapSeconds * 1000;
  const floor = new Date(RECONCILIATION_RUNTIME.windowFloor).getTime();
  const windowStart = watermark?.syncedThrough === null || watermark?.syncedThrough === undefined
    ? new Date(floor)
    : new Date(Math.max(floor, watermark.syncedThrough.getTime() - overlapMs));
  await scope.reconciliation.insertSlice({
    ...slice,
    cursor: null,
    cursorIssuedAt: null,
    windowStart,
    // Every content of a run is read as of the run's start: an interaction created later belongs to the next run.
    windowEnd: startedAt,
    // Strictly increasing creation times keep the serial chain in planning order (continuations first).
    createdAt: new Date(base.getTime() + order + 1),
  });
  return "fresh";
}
