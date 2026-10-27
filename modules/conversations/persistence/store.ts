/**
 * Conversation persistence (Step H6-B; TL decision 5; corrected in H6-C1). Ingestion only CREATES conversations, always
 * OPEN (the INSERT policy refuses anything else), each anchored on an observed top-level audience comment, so
 * `anchor_observed` is always written true (the 0017 column stays; no provisional anchor exists any more). Workflow
 * transitions belong to the workflow layer and have no grant here.
 */
import { eq } from "drizzle-orm";
import { boolean, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { DatabaseTransaction } from "@/platform/db";
import type { ConversationStore } from "../application/ports";
import { INGESTION_INITIAL_WORKFLOW_STATE } from "../domain/conversation";

const conversations = pgSchema("conversations");
const at = (name: string) => timestamp(name, { withTimezone: true });

/** Drizzle mapping of conversations.conversations (db/migrations/0017; the SQL is the source of truth). */
export const conversationRows = conversations.table("conversations", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  anchorInteractionId: uuid("anchor_interaction_id").notNull(),
  anchorObserved: boolean("anchor_observed").notNull(),
  workflowState: text("workflow_state").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: at("created_at").notNull(),
  updatedAt: at("updated_at").notNull(),
});


export function createPostgresConversationStore(tx: DatabaseTransaction): ConversationStore {
  const findByAnchor = async (anchorInteractionId: string) =>
    (await tx.select({ id: conversationRows.id }).from(conversationRows).where(eq(conversationRows.anchorInteractionId, anchorInteractionId)).limit(1))[0];
  return {
    async ensureForAnchor(input) {
      const inserted = await tx
        .insert(conversationRows)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          anchorInteractionId: input.anchorInteractionId,
          // H6-C1: an anchor is always an observed top-level audience comment (no provisional conversation).
          anchorObserved: true,
          workflowState: INGESTION_INITIAL_WORKFLOW_STATE,
          createdBy: input.initialization.initiator,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing({ target: [conversationRows.workspaceId, conversationRows.anchorInteractionId] })
        .returning({ id: conversationRows.id });
      if (inserted[0] !== undefined) return { id: inserted[0].id, created: true };
      const existing = await findByAnchor(input.anchorInteractionId);
      if (existing === undefined) throw new Error("ingestion_conversation_missing");
      return { id: existing.id, created: false };
    },
    findByAnchor,
  };
}
