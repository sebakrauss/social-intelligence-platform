/**
 * Mark Done / Reopen through the reviewed database boundary workflow.change_state (0034). The web holds no write grant
 * on the workflow tables: the boundary re-checks the caller and its role in the bound workspace, locks the item, compares
 * the expected version and writes the change, its workflow event and its audit event in one call. This adapter only maps
 * the boundary's closed answers; it decides nothing.
 *
 *   P0002 (unknown, another workspace's, another kind) → NOT_FOUND       (indistinguishable: no existence oracle)
 *   42501 (not a web caller, no workflow role)          → PERMISSION_DENIED
 *   22023 (input outside the closed vocabulary)         → INVALID_INPUT
 */
import { sql } from "drizzle-orm";
import { AppError } from "@/domain/errors";
import { postgresError, type DatabaseTransaction } from "@/platform/db";
import { isWorkItemResolution, isWorkItemState } from "../domain/work-item";
import type { StateChangeResult, WorkflowStateChanger } from "../application/ports";

const OUTCOMES = ["changed", "unchanged", "stale"] as const;

export function createPostgresWorkflowStateChanger(tx: DatabaseTransaction): WorkflowStateChanger {
  return {
    async changeState(input) {
      const resolution = input.change.to === "DONE" ? input.change.resolution : null;
      let rows: readonly { outcome: string; item_state: string; item_resolution: string | null; item_version: number }[];
      try {
        rows = (await tx.execute<{ outcome: string; item_state: string; item_resolution: string | null; item_version: number }>(sql`
          select outcome, item_state, item_resolution, item_version
            from workflow.change_state(${input.workItemId}::uuid, ${input.change.to}, ${resolution}, ${input.expectedVersion}::integer, ${input.correlationId}, ${input.requestId})`)).rows;
      } catch (error) {
        const code = postgresError(error)?.code;
        // No driver cause is attached: the web unit of work re-classifies errors by their SQLSTATE cause, and these closed
        // answers are already final (a 42501 cause would otherwise read as NOT_FOUND).
        if (code === "P0002") throw new AppError("NOT_FOUND", {});
        if (code === "42501") throw new AppError("PERMISSION_DENIED", {});
        if (code === "22023" || code === "22P02") throw new AppError("INVALID_INPUT", { field: "state" });
        throw error;
      }
      const row = rows[0];
      const outcome = OUTCOMES.find((known) => known === row?.outcome);
      if (row === undefined || outcome === undefined || !isWorkItemState(row.item_state) || (row.item_resolution !== null && !isWorkItemResolution(row.item_resolution))) {
        throw new Error("workflow_boundary_answer_incoherent");
      }
      return { outcome, state: row.item_state, resolution: row.item_resolution, version: row.item_version } satisfies StateChangeResult;
    },
  };
}
