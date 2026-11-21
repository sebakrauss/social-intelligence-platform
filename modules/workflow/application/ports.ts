/**
 * Workflow persistence ports (WORKFLOW-WF-2B). Implemented by ./persistence; composed by server/persistence.
 *
 *   WorkflowReadStore       web, user scope: the queue page and one work item, under forced RLS (member_read).
 *   WorkflowStateChanger    web, user scope: Mark Done / Reopen through the reviewed database boundary
 *                           workflow.change_state (it writes the change, its workflow event and its audit event).
 *   WorkflowProjectionStore job runtime, workspace job scope: create a work item with its conversation, lock it, apply
 *                           the projected activity and the objective auto-reopen (with its event and audit event).
 */
import type { CorrelationId, RequestId } from "@/domain/correlation";
import type { WorkspaceId } from "@/domain/ids";
import type { ManualChange, ManualChangeOutcome, ProjectionDecision, QueueView, StateChangeInitiator, WorkItemResolution, WorkItemState } from "../domain/work-item";

/** A keyset position in the queue: newest activity first, then id (descending). */
export interface QueuePosition {
  readonly latestActivityAt: Date;
  readonly id: string;
}

export interface QueueRow {
  readonly id: string;
  readonly latestActivityAt: Date;
  readonly state: WorkItemState;
  readonly version: number;
}

export interface WorkItemView {
  readonly id: string;
  readonly state: WorkItemState;
  readonly resolution: WorkItemResolution | null;
  readonly version: number;
  readonly latestActivityAt: Date;
  readonly stateChangedAt: Date;
  readonly stateChangedBy: StateChangeInitiator;
}

export interface WorkflowReadStore {
  /**
   * One queue page of the BOUND workspace, newest activity first. `workspaceId` MUST be the transaction's bound workspace:
   * it is passed as an explicit `workspace_id = $n` predicate (measured in WF-2A: it gives the planner the tenant's real
   * statistics and keeps every view on its ordered index). Forced RLS stays authoritative: another workspace's id here
   * reads nothing.
   */
  queue(input: { readonly workspaceId: WorkspaceId; readonly view: QueueView; readonly before: QueuePosition | null; readonly limit: number }): Promise<readonly QueueRow[]>;
  /** The work items of these ids in the bound workspace (the conversation view, and a list page's states). */
  findMany(input: { readonly workspaceId: WorkspaceId; readonly ids: readonly string[] }): Promise<readonly WorkItemView[]>;
}

export interface StateChangeResult {
  readonly outcome: ManualChangeOutcome;
  readonly state: WorkItemState;
  readonly resolution: WorkItemResolution | null;
  readonly version: number;
}

export interface WorkflowStateChanger {
  /**
   * The boundary re-checks the caller and its role in the bound workspace, locks the item, compares `expectedVersion`
   * (stale: nothing written) and writes the change, its workflow event and its audit event together. An unknown id and
   * another workspace's id are the same NOT_FOUND.
   */
  changeState(input: { readonly workItemId: string; readonly change: ManualChange; readonly expectedVersion: number; readonly correlationId: CorrelationId; readonly requestId: RequestId }): Promise<StateChangeResult>;
}

/** A work item locked FOR UPDATE in the caller's job transaction. */
export interface LockedWorkItem {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly state: WorkItemState;
  readonly resolution: WorkItemResolution | null;
  readonly version: number;
  readonly latestActivityAt: Date;
  readonly created: boolean;
}

export interface WorkflowProjectionStore {
  /**
   * The conversation's work item, created OPEN (version 1, system_ingestion, with its `created` event) if it does not
   * exist yet, then LOCKED for the rest of the transaction. Lock first, recompute after: a concurrent member is never lost.
   */
  ensureAndLock(input: { readonly conversationId: string; readonly organizationId: string; readonly workspaceId: string; readonly now: Date; readonly correlationId: CorrelationId; readonly eventId: string }): Promise<LockedWorkItem>;
  /** WORKFLOW-WF-2C: the work item as it is, WITHOUT a lock (reconciliation's dry run and its review report). */
  find(conversationId: string): Promise<{ readonly state: WorkItemState; readonly version: number; readonly latestActivityAt: Date; readonly stateChangedAt: Date } | undefined>;
  /** Writes the recomputed activity and the decision (version bump, auto-reopen with its event and system audit event). */
  apply(input: { readonly item: LockedWorkItem; readonly latestActivityAt: Date; readonly decision: ProjectionDecision; readonly now: Date; readonly correlationId: CorrelationId; readonly eventId: string }): Promise<void>;
}

/**
 * The projected activity's source, owned by the interactions module (composed in, never read here): the list's own
 * definition over the conversation's members, ms-truncated. Read AFTER the work item is locked.
 */
export interface ConversationActivitySource {
  latestActivity(conversationId: string): Promise<Date | null>;
}
