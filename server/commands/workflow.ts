/**
 * Workflow commands (WORKFLOW-WF-2B): Mark Done and Reopen a Comments conversation. Internal workflow only — no platform
 * action follows from either (nothing is hidden, replied or sent at Meta), so both run in Monitor-only too (PD UC-18,
 * D-49: `requiresStandardMode: false`).
 *
 *   permission   `workflow.internal` (OWNER, ADMIN, MANAGER, RESPONDER; not grantable) — checked by the pipeline from the
 *                live membership, then again by the database boundary (two layers).
 *   concurrency  the caller sends the version it saw; a newer state (another person's change, or a new audience comment
 *                that advanced the version) is CONFLICT and nothing is written. The same state is accepted as unchanged.
 *   audit        written by the reviewed boundary workflow.change_state in the same statement as the change and its
 *                workflow event (`work_item.state_changed`, actor = the verified user, previous/current state).
 *   not found    an unknown conversation and another workspace's are the same NOT_FOUND.
 */
import { AppError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { object, oneOf, optional, parsed } from "@/domain/validation";
import { WORK_ITEM_RESOLUTIONS, type StateChangeResult, type WorkItemResolution } from "@/modules/workflow";
import type { DatabaseBoundaryAudit, Transaction, WorkspaceCommand } from "@/server/pipeline";
import type { CommandEnvironment } from "@/server/pipeline";

/** The boundary that writes these commands' audit events (0034). */
export const WORKFLOW_CHANGE_AUDIT: DatabaseBoundaryAudit = { kind: "database_boundary", function: "workflow.change_state", actions: ["work_item.state_changed"] };

const uuid = parsed((value) => (typeof value === "string" && isUuid(value) ? value : undefined));
const version = parsed((value) => (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 2_147_483_647 ? value : undefined));

export interface WorkflowChangeOutput {
  readonly conversationId: string;
  readonly outcome: "changed" | "unchanged";
  readonly state: StateChangeResult["state"];
  readonly resolution: WorkItemResolution | null;
  readonly version: number;
}

async function change(tx: Transaction, env: CommandEnvironment, conversationId: string, expectedVersion: number, to: { readonly to: "DONE"; readonly resolution: WorkItemResolution | null } | { readonly to: "OPEN" }): Promise<WorkflowChangeOutput> {
  const result = await tx.workflow.changes.changeState({ workItemId: conversationId, change: to, expectedVersion, correlationId: env.correlationId, requestId: env.requestId });
  // Someone (or a new audience comment) changed it after the caller looked: nothing was written.
  if (result.outcome === "stale") throw new AppError("CONFLICT", {});
  return { conversationId, outcome: result.outcome, state: result.state, resolution: result.resolution, version: result.version };
}

const markDoneInput = object({ conversationId: uuid, expectedVersion: version, resolution: optional(oneOf(WORK_ITEM_RESOLUTIONS)) });

export const markDoneCommand: WorkspaceCommand<{ readonly conversationId: string; readonly expectedVersion: number; readonly resolution: WorkItemResolution | undefined }, WorkflowChangeOutput, WorkflowChangeOutput> = {
  scope: "workspace",
  name: "workflow.conversation.mark_done",
  permission: "workflow.internal",
  requiresStandardMode: false,
  validate: markDoneInput,
  execute: (_context, input, tx, env) => change(tx, env, input.conversationId, input.expectedVersion, { to: "DONE", resolution: input.resolution ?? null }),
  audit: () => undefined,
  auditedBy: WORKFLOW_CHANGE_AUDIT,
  respond: (output) => output,
};

const reopenInput = object({ conversationId: uuid, expectedVersion: version });

export const reopenCommand: WorkspaceCommand<{ readonly conversationId: string; readonly expectedVersion: number }, WorkflowChangeOutput, WorkflowChangeOutput> = {
  scope: "workspace",
  name: "workflow.conversation.reopen",
  permission: "workflow.internal",
  requiresStandardMode: false,
  validate: reopenInput,
  execute: (_context, input, tx, env) => change(tx, env, input.conversationId, input.expectedVersion, { to: "OPEN" }),
  audit: () => undefined,
  auditedBy: WORKFLOW_CHANGE_AUDIT,
  respond: (output) => output,
};
