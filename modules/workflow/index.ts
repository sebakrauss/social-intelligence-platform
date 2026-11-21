/** workflow module public API (TA §7.1, L3; WORKFLOW-WF-2B: the shared Workflow core, Comments first). */
export {
  QUEUE_VIEWS,
  STATE_CHANGE_INITIATORS,
  WORK_ITEM_RESOLUTIONS,
  WORK_ITEM_STATES,
  WORK_ITEM_SUBJECT_KINDS,
  decideMembersJoined,
  isAudienceMember,
  isWorkItemResolution,
  isWorkItemState,
  stateOfView,
  type JoinedMember,
  type ManualChange,
  type ManualChangeOutcome,
  type ProjectionDecision,
  type QueueView,
  type StateChangeInitiator,
  type WorkItemResolution,
  type WorkItemState,
  type WorkItemSubjectKind,
} from "./domain/work-item";
export type {
  ConversationActivitySource,
  LockedWorkItem,
  QueuePosition,
  QueueRow,
  StateChangeResult,
  WorkflowProjectionStore,
  WorkflowReadStore,
  WorkflowStateChanger,
  WorkItemView,
} from "./application/ports";
export { projectMembersJoined, rebuildWorkItem, type MembersJoinedInput, type ProjectionClock, type ProjectionOutcome } from "./application/project-activity";
export { reconcileWorkItem, type ItemReconciliation, type ItemReport, type ReconciliationAudienceSource } from "./application/reconcile";
