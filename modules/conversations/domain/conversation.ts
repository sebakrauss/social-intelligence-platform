/**
 * Conversation identity and the ingestion-time initialization (Step H6-A1, TL decision 5; Model §10). Pure.
 *
 * A Conversation is the Inbox work item: one top-level AUDIENCE comment and every reply beneath it. Ingestion creates
 * it, atomically with the canonical interaction that anchors it, in its initial workflow state OPEN. That is all
 * ingestion decides: Done, reopen, assignment, SLA outcomes, automation and protocol execution belong to the workflow
 * layer (L3) and later steps. The initialization type admits only OPEN, so ingestion cannot express anything else.
 *
 *   top-level comment, author user or unknown      → create, anchored on it (anchorObserved = true), OPEN
 *   top-level comment by the account itself         → no conversation (a brand post-level comment is not an
 *                                                     audience work item; it is kept as an interaction)
 *   reply whose thread already has a conversation   → join it
 *   reply whose parent was never observed           → create, anchored on the parent's PLACEHOLDER identity
 *                                                     (anchorObserved = false), OPEN; when the parent is observed it
 *                                                     fills the same anchor (identity unchanged)
 */
import type { ProviderId } from "@/domain/provider-identity";

/** Model §10.1: no Waiting or Snoozed (UX-05). */
export const CONVERSATION_WORKFLOW_STATES = ["OPEN", "DONE"] as const;
export type ConversationWorkflowState = (typeof CONVERSATION_WORKFLOW_STATES)[number];

/** The only state ingestion ever sets. */
export const INGESTION_INITIAL_WORKFLOW_STATE = "OPEN" as const satisfies ConversationWorkflowState;

export interface ConversationInitialization {
  /** The provider id of the anchoring top-level interaction (observed, or a never-observed placeholder). */
  readonly anchorInteractionId: ProviderId;
  readonly anchorObserved: boolean;
  readonly workflowState: typeof INGESTION_INITIAL_WORKFLOW_STATE;
  /** Attributable automatic transition (Model §10.1): the system, on ingestion. */
  readonly initiator: "system_ingestion";
}

export interface ConversationPlanningInput {
  readonly interactionId: ProviderId;
  readonly parentId: ProviderId | null;
  readonly authorRole: "account_identity" | "user" | "unknown";
  /** The conversation of the reply's thread, when one exists already. */
  readonly existingThreadConversation: { readonly conversationId: string } | null;
  /** Whether the reply's parent has been observed (false = it is, or becomes, a placeholder). */
  readonly parentObserved: boolean;
}

export type ConversationPlan =
  | { readonly kind: "create"; readonly initialization: ConversationInitialization }
  | { readonly kind: "join"; readonly conversationId: string }
  | { readonly kind: "none"; readonly reason: "BRAND_TOP_LEVEL_COMMENT" };

const initialize = (anchorInteractionId: ProviderId, anchorObserved: boolean): ConversationInitialization =>
  Object.freeze({ anchorInteractionId, anchorObserved, workflowState: INGESTION_INITIAL_WORKFLOW_STATE, initiator: "system_ingestion" as const });

export function planConversation(input: ConversationPlanningInput): ConversationPlan {
  if (input.parentId === null) {
    return input.authorRole === "account_identity" ? { kind: "none", reason: "BRAND_TOP_LEVEL_COMMENT" } : { kind: "create", initialization: initialize(input.interactionId, true) };
  }
  if (input.existingThreadConversation !== null) return { kind: "join", conversationId: input.existingThreadConversation.conversationId };
  return { kind: "create", initialization: initialize(input.parentId, input.parentObserved) };
}
