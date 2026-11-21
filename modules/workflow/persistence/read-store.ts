/**
 * The queue and work-item reads of the web (WORKFLOW-WF-2B). Runs inside the caller's USER-scoped transaction: the sealed
 * workspace and 0034's member_read policy (one indexed equality, measured in WF-2A) decide what is visible. Read-only.
 *
 * Every statement here carries the bound workspace as an EXPLICIT `workspace_id = $n` predicate (WF-2A Candidate 2): with
 * a known constant the planner sees the tenant's real statistics and keeps each view on its ordered index whatever the
 * number of tenants. It never widens anything — RLS still filters — and it is a required argument, so no caller can omit
 * it (pinned by tests/architecture/workflow-guards.test.ts and the plan test of the database suite).
 */
import { sql } from "drizzle-orm";
import type { DatabaseTransaction } from "@/platform/db";
import { isWorkItemResolution, isWorkItemState, STATE_CHANGE_INITIATORS, stateOfView, type StateChangeInitiator } from "../domain/work-item";
import type { QueueRow, WorkflowReadStore, WorkItemView } from "../application/ports";

/** A queue page never reads more than this many rows (the list asks for a page plus one). */
export const QUEUE_MAX_LIMIT = 100;
/** Canonical UUID shape: anything else never reaches a `::uuid` cast. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const stateOf = (value: string): QueueRow["state"] => {
  if (!isWorkItemState(value)) throw new Error("workflow_row_incoherent");
  return value;
};

export function createPostgresWorkflowReadStore(tx: DatabaseTransaction): WorkflowReadStore {
  return {
    async queue(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > QUEUE_MAX_LIMIT) throw new RangeError("workflow queue: limit out of bounds");
      if (!UUID.test(input.workspaceId)) throw new RangeError("workflow queue: workspace required");
      const state = stateOfView(input.view);
      const before = input.before;
      if (before !== null && !UUID.test(before.id)) throw new RangeError("workflow queue: position invalid");
      const result = await tx.execute<{ id: string; latest_activity_at: Date; state: string; version: number }>(sql`
        select id, latest_activity_at, state, version
          from workflow.work_items
         where workspace_id = ${input.workspaceId}::uuid
           and subject_kind = 'comment_conversation'
           ${state === null ? sql`` : sql`and state = ${state}`}
           ${before === null ? sql`` : sql`and (latest_activity_at, id) < (${before.latestActivityAt}, ${before.id}::uuid)`}
         order by latest_activity_at desc, id desc
         limit ${input.limit}`);
      return result.rows.map((row): QueueRow => ({ id: row.id, latestActivityAt: new Date(row.latest_activity_at), state: stateOf(row.state), version: row.version }));
    },
    async findMany(input) {
      const ids = [...new Set(input.ids)].filter((id) => UUID.test(id)).slice(0, 500);
      if (ids.length === 0 || !UUID.test(input.workspaceId)) return [];
      const result = await tx.execute<{ id: string; state: string; resolution: string | null; version: number; latest_activity_at: Date; state_changed_at: Date; state_changed_by_kind: string }>(sql`
        select id, state, resolution, version, latest_activity_at, state_changed_at, state_changed_by_kind
          from workflow.work_items
         where workspace_id = ${input.workspaceId}::uuid
           and subject_kind = 'comment_conversation'
           and id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`);
      return result.rows.map((row): WorkItemView => {
        const by = STATE_CHANGE_INITIATORS.find((kind) => kind === row.state_changed_by_kind);
        if (by === undefined || (row.resolution !== null && !isWorkItemResolution(row.resolution))) throw new Error("workflow_row_incoherent");
        return {
          id: row.id,
          state: stateOf(row.state),
          resolution: row.resolution,
          version: row.version,
          latestActivityAt: new Date(row.latest_activity_at),
          stateChangedAt: new Date(row.state_changed_at),
          stateChangedBy: by satisfies StateChangeInitiator,
        };
      });
    },
  };
}
