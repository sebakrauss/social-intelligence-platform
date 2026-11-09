/**
 * Conversation persistence port (Step H6-B; corrected in H6-C1): ingestion creates OPEN conversations only, each
 * anchored permanently on an observed top-level audience comment. Implemented by ./persistence; composed by
 * server/persistence/ingestion.ts.
 */
import type { ConversationInitialization } from "../domain/conversation";

export interface ConversationStore {
  /**
   * The conversation anchored on `anchorInteractionId` (the canonical row of the initialization's anchor): created OPEN
   * if absent, otherwise the existing one (the anchor is unique, so one root never has two conversations).
   */
  ensureForAnchor(input: { readonly id: string; readonly organizationId: string; readonly workspaceId: string; readonly anchorInteractionId: string; readonly initialization: ConversationInitialization; readonly now: Date }): Promise<{ readonly id: string; readonly created: boolean }>;
  findByAnchor(anchorInteractionId: string): Promise<{ readonly id: string } | undefined>;
}

/** One conversation as the Inbox reads it (Step 7A): identity, anchor and workflow state. */
export interface ConversationRow {
  readonly id: string;
  readonly anchorInteractionId: string;
  readonly workflowState: string;
  readonly createdAt: Date;
}

/** Read-only Inbox access (Step 7A); runs in the caller's user-scoped transaction (0017 member_read decides). */
export interface ConversationReadStore {
  findMany(ids: readonly string[]): Promise<readonly ConversationRow[]>;
  get(id: string): Promise<ConversationRow | undefined>;
}
