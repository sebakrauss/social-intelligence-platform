/**
 * The job runtime's side of the work items (WORKFLOW-WF-2B), inside the caller's workspace job transaction (app_worker,
 * sealed workspace). 0034's worker policies and trigger guard bound what it can do: create a work item ONLY OPEN at
 * version 1 with its `created` event; update activity and version; and perform ONLY the objective Done → Open reopen,
 * with its `state_changed` event and its audit event (actor `system`). It never deletes and never marks Done.
 */
import { and, eq, sql } from "drizzle-orm";
import { recordAuditEvent, type AuditLog } from "@/modules/audit";
import type { DatabaseTransaction } from "@/platform/db";
import { isWorkItemResolution, isWorkItemState } from "../domain/work-item";
import type { LockedWorkItem, WorkflowProjectionStore } from "../application/ports";
import { workItems, workflowEvents } from "./tables";

/** `audit`: the SAME transaction's audit log (composed by server/persistence), so the reopen and its event commit together. */
export function createPostgresWorkflowProjectionStore(tx: DatabaseTransaction, audit: AuditLog): WorkflowProjectionStore {
  return {
    async ensureAndLock(input) {
      const inserted = await tx
        .insert(workItems)
        .values({
          id: input.conversationId,
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          subjectKind: "comment_conversation",
          conversationId: input.conversationId,
          state: "OPEN",
          resolution: null,
          stateChangedAt: input.now,
          stateChangedByKind: "system_ingestion",
          stateChangedByUser: null,
          version: 1,
          // Provisional: the caller recomputes the activity after the lock and writes it in the same transaction.
          latestActivityAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing()
        .returning({ id: workItems.id });
      const created = inserted.length > 0;
      if (created) {
        await tx.insert(workflowEvents).values({
          id: input.eventId,
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          workItemId: input.conversationId,
          kind: "created",
          fromState: null,
          toState: "OPEN",
          resolution: null,
          initiatorKind: "system_ingestion",
          initiatorUserId: null,
          causeInteractionId: null,
          versionAfter: 1,
          correlationId: input.correlationId,
          occurredAt: input.now,
        });
      }
      const row = (await tx
        .select({ id: workItems.id, organizationId: workItems.organizationId, workspaceId: workItems.workspaceId, state: workItems.state, resolution: workItems.resolution, version: workItems.version, latestActivityAt: workItems.latestActivityAt })
        .from(workItems)
        .where(and(eq(workItems.workspaceId, input.workspaceId), eq(workItems.id, input.conversationId)))
        .for("update"))[0];
      if (row === undefined || !isWorkItemState(row.state) || (row.resolution !== null && !isWorkItemResolution(row.resolution))) throw new Error("workflow_work_item_missing");
      return { id: row.id, organizationId: row.organizationId, workspaceId: row.workspaceId, state: row.state, resolution: row.resolution, version: row.version, latestActivityAt: row.latestActivityAt, created } satisfies LockedWorkItem;
    },

    async find(conversationId) {
      const row = (await tx
        .select({ state: workItems.state, version: workItems.version, latestActivityAt: workItems.latestActivityAt, stateChangedAt: workItems.stateChangedAt })
        .from(workItems)
        .where(eq(workItems.id, conversationId))
        .limit(1))[0];
      if (row === undefined) return undefined;
      if (!isWorkItemState(row.state)) throw new Error("workflow_row_incoherent");
      return { state: row.state, version: row.version, latestActivityAt: row.latestActivityAt, stateChangedAt: row.stateChangedAt };
    },

    async apply(input) {
      const { item, decision } = input;
      const version = item.version + (decision.audienceJoined ? 1 : 0);
      await tx
        .update(workItems)
        .set({
          latestActivityAt: sql`pg_catalog.date_trunc('milliseconds', ${input.latestActivityAt}::timestamptz)`,
          version,
          updatedAt: input.now,
          ...(decision.reopen ? { state: "OPEN", resolution: null, stateChangedAt: input.now, stateChangedByKind: "system_auto_reopen", stateChangedByUser: null } : {}),
        })
        .where(and(eq(workItems.workspaceId, item.workspaceId), eq(workItems.id, item.id)));
      if (!decision.reopen || decision.cause === null) return;
      await tx.insert(workflowEvents).values({
        id: input.eventId,
        organizationId: item.organizationId,
        workspaceId: item.workspaceId,
        workItemId: item.id,
        kind: "state_changed",
        fromState: "DONE",
        toState: "OPEN",
        resolution: null,
        initiatorKind: "system_auto_reopen",
        initiatorUserId: null,
        causeInteractionId: decision.cause,
        versionAfter: version,
        correlationId: input.correlationId,
        occurredAt: input.now,
      });
      await recordAuditEvent(audit, {
        id: input.eventId,
        occurredAt: input.now,
        action: "work_item.state_changed",
        actorType: "system",
        organizationId: item.organizationId,
        workspaceId: item.workspaceId,
        targetType: "work_item",
        targetId: item.id,
        correlationId: input.correlationId,
        outcome: "succeeded",
        change: { kind: "workflow_state", previous: { state: "DONE", resolution: item.resolution }, current: { state: "OPEN", resolution: null } },
      });
    },
  };
}
