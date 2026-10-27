/**
 * Conversation identity and the ingestion-time initialization (Step H6-A1, TL decision 5; Model §10; corrected in
 * Step H6-C1 by TL decisions 1 and D-C2). Pure.
 *
 * A Conversation is the Inbox work item: one top-level AUDIENCE comment and every reply beneath it. Ingestion creates
 * it in its initial workflow state OPEN, anchored permanently on that observed top-level audience comment. That is all
 * ingestion decides: Done, reopen, assignment, SLA outcomes, automation and protocol execution belong to the workflow
 * layer (L3) and later steps. The initialization type admits only OPEN, so ingestion cannot express anything else.
 *
 * Invariant (H6-C1): an interaction has a conversation only if its ancestry has resolved to an observed top-level
 * audience comment. A placeholder never anchors a conversation; no conversation is provisional or ever re-anchored.
 *
 *   top-level comment, author user or unknown      → create, anchored on it, OPEN
 *   top-level comment by the account itself         → none (BRAND_TOP_LEVEL_COMMENT, TL D-C2: a brand-rooted thread is
 *                                                     not an audience work item; its replies stay without conversation)
 *   reply whose parent belongs to a conversation    → join it
 *   reply whose parent has none                     → none (PARENT_WITHOUT_CONVERSATION: the ancestry is unresolved —
 *                                                     the parent is a placeholder or its own parent is — or the thread
 *                                                     is brand-rooted). A reply NEVER creates a conversation.
 *
 * Superseded (H6-B): a reply before its parent used to create a provisional conversation anchored on the parent's
 * placeholder. When the root arrives later, ingestion now creates the conversation then and attaches the root's already
 * known descendants (decideSubtreeAttachment; the interactions persistence does the bounded attachment).
 */
import type { ProviderId } from "@/domain/provider-identity";

/** Model §10.1: no Waiting or Snoozed (UX-05). */
export const CONVERSATION_WORKFLOW_STATES = ["OPEN", "DONE"] as const;
export type ConversationWorkflowState = (typeof CONVERSATION_WORKFLOW_STATES)[number];

/** The only state ingestion ever sets. */
export const INGESTION_INITIAL_WORKFLOW_STATE = "OPEN" as const satisfies ConversationWorkflowState;

export interface ConversationInitialization {
  /** The provider id of the anchoring top-level audience interaction (always observed). */
  readonly anchorInteractionId: ProviderId;
  readonly workflowState: typeof INGESTION_INITIAL_WORKFLOW_STATE;
  /** Attributable automatic transition (Model §10.1): the system, on ingestion. */
  readonly initiator: "system_ingestion";
}

export interface ConversationPlanningInput {
  readonly interactionId: ProviderId;
  readonly parentId: ProviderId | null;
  readonly authorRole: "account_identity" | "user" | "unknown";
  /** For a reply: the conversation its parent belongs to (null: none, or the parent is not known yet). */
  readonly parentConversation: { readonly conversationId: string } | null;
}

export type ConversationPlan =
  | { readonly kind: "create"; readonly initialization: ConversationInitialization }
  | { readonly kind: "join"; readonly conversationId: string }
  | { readonly kind: "none"; readonly reason: "BRAND_TOP_LEVEL_COMMENT" | "PARENT_WITHOUT_CONVERSATION" };

export function planConversation(input: ConversationPlanningInput): ConversationPlan {
  if (input.parentId === null) {
    if (input.authorRole === "account_identity") return { kind: "none", reason: "BRAND_TOP_LEVEL_COMMENT" };
    return { kind: "create", initialization: Object.freeze({ anchorInteractionId: input.interactionId, workflowState: INGESTION_INITIAL_WORKFLOW_STATE, initiator: "system_ingestion" as const }) };
  }
  if (input.parentConversation !== null) return { kind: "join", conversationId: input.parentConversation.conversationId };
  return { kind: "none", reason: "PARENT_WITHOUT_CONVERSATION" };
}

/**
 * Whether a resolved subtree (a node and every canonical descendant) may take `target` as its conversation (null: the
 * ancestry resolved to no conversation, e.g. a brand root). A member already in `target` stays unchanged; a member in
 * any OTHER conversation — or in any conversation when the target is none — contradicts the resolved ancestry: the
 * caller fails closed and reassigns nothing.
 */
export function decideSubtreeAttachment(input: { readonly target: string | null; readonly memberConversations: readonly (string | null)[] }): "attach" | "DESCENDANT_CONVERSATION_CONFLICT" {
  return input.memberConversations.every((current) => current === null || current === input.target) ? "attach" : "DESCENDANT_CONVERSATION_CONFLICT";
}
