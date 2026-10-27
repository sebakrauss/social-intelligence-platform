/**
 * Conversation persistence (Step H6-B; TL decision 5). Ingestion only CREATES conversations, always OPEN (the INSERT
 * policy refuses anything else), and marks a placeholder anchor observed once its interaction is seen. Workflow
 * transitions belong to the workflow layer and have no grant here.
 */
import { and, eq } from "drizzle-orm";
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
  return {
    async create(input) {
      await tx.insert(conversationRows).values({
        id: input.id,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        anchorInteractionId: input.anchorInteractionId,
        anchorObserved: input.initialization.anchorObserved,
        workflowState: INGESTION_INITIAL_WORKFLOW_STATE,
        createdBy: input.initialization.initiator,
        createdAt: input.now,
        updatedAt: input.now,
      });
    },
    async findByAnchor(anchorInteractionId) {
      return (await tx.select({ id: conversationRows.id, anchorObserved: conversationRows.anchorObserved }).from(conversationRows)
        .where(eq(conversationRows.anchorInteractionId, anchorInteractionId)).limit(1))[0];
    },
    async markAnchorObserved(id, now) {
      await tx.update(conversationRows).set({ anchorObserved: true, updatedAt: now }).where(and(eq(conversationRows.id, id), eq(conversationRows.anchorObserved, false)));
    },
  };
}
