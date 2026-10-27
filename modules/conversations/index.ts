/** conversations module public API (TA §7.1, L1; H6-A1 pure domain contracts; H6-B persistence port). */
export {
  CONVERSATION_WORKFLOW_STATES,
  INGESTION_INITIAL_WORKFLOW_STATE,
  planConversation,
  type ConversationInitialization,
  type ConversationPlan,
  type ConversationPlanningInput,
  type ConversationWorkflowState,
} from "./domain/conversation";
export type { ConversationStore } from "./application/ports";
