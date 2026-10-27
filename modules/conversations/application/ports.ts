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
