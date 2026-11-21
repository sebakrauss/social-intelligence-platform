/**
 * Drizzle mappings of the workflow tables (db/migrations/0034). The SQL migration is the source of truth for structure,
 * RLS, grants, the trigger guard and the definer. Owned by the workflow module only.
 */
import { integer, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const workflow = pgSchema("workflow");
const at = (name: string) => timestamp(name, { withTimezone: true });

export const workItems = workflow.table("work_items", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  subjectKind: text("subject_kind").notNull(),
  conversationId: uuid("conversation_id"),
  state: text("state").notNull(),
  resolution: text("resolution"),
  stateChangedAt: at("state_changed_at").notNull(),
  stateChangedByKind: text("state_changed_by_kind").notNull(),
  stateChangedByUser: uuid("state_changed_by_user"),
  version: integer("version").notNull(),
  latestActivityAt: at("latest_activity_at").notNull(),
  createdAt: at("created_at").notNull(),
  updatedAt: at("updated_at").notNull(),
});

export const workflowEvents = workflow.table("workflow_events", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  workItemId: uuid("work_item_id").notNull(),
  kind: text("kind").notNull(),
  fromState: text("from_state"),
  toState: text("to_state").notNull(),
  resolution: text("resolution"),
  initiatorKind: text("initiator_kind").notNull(),
  initiatorUserId: uuid("initiator_user_id"),
  causeInteractionId: uuid("cause_interaction_id"),
  versionAfter: integer("version_after").notNull(),
  correlationId: text("correlation_id").notNull(),
  occurredAt: at("occurred_at").notNull(),
});
