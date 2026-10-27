/** conversations module public API (TA §7.1, L1; Step H6-A1: pure domain contracts only — no persistence yet). */
export {
  CONVERSATION_WORKFLOW_STATES,
  INGESTION_INITIAL_WORKFLOW_STATE,
  planConversation,
  type ConversationInitialization,
  type ConversationPlan,
  type ConversationPlanningInput,
  type ConversationWorkflowState,
} from "./domain/conversation";
