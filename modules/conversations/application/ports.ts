/**
 * Conversation persistence port (Step H6-B): ingestion creates OPEN conversations only. Implemented by ./persistence;
 * composed by server/persistence/ingestion.ts.
 */
import type { ConversationInitialization } from "../domain/conversation";

export interface ConversationStore {
  /** Creates the OPEN conversation anchored on `anchorInteractionId` (the canonical row of the initialization's anchor). */
  create(input: { readonly id: string; readonly organizationId: string; readonly workspaceId: string; readonly anchorInteractionId: string; readonly initialization: ConversationInitialization; readonly now: Date }): Promise<void>;
  findByAnchor(anchorInteractionId: string): Promise<{ readonly id: string; readonly anchorObserved: boolean } | undefined>;
  markAnchorObserved(id: string, now: Date): Promise<void>;
}
