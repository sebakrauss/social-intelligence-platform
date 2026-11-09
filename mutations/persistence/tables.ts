/**
 * Drizzle mappings of the executor's tables (db/migrations/0027). The SQL migration is the source of truth for
 * structure, RLS, grants and constraints. Owned by mutations/ only (TA §7.1: the executor owns intents and outcomes).
 */
import { integer, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const mutations = pgSchema("mutations");
const at = (name: string) => timestamp(name, { withTimezone: true });

export const mutationIntents = mutations.table("mutation_intents", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  kind: text("kind").notNull(),
  requestType: text("request_type").notNull(),
  targetInteractionId: uuid("target_interaction_id").notNull(),
  connectedAccountId: uuid("connected_account_id").notNull(),
  initiatorUserId: uuid("initiator_user_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull(),
  attempt: integer("attempt").notNull(),
  runReference: text("run_reference"),
  outcomeCode: text("outcome_code"),
  capabilityCatalogId: text("capability_catalog_id").notNull(),
  capabilityCatalogRevision: integer("capability_catalog_revision").notNull(),
  correlationId: text("correlation_id").notNull(),
  createdAt: at("created_at").notNull(),
  updatedAt: at("updated_at").notNull(),
});

export const mutationIntentHistory = mutations.table("mutation_intent_history", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  intentId: uuid("intent_id").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  attempt: integer("attempt").notNull(),
  actor: text("actor").notNull(),
  outcomeCode: text("outcome_code"),
  runReference: text("run_reference"),
  correlationId: text("correlation_id").notNull(),
  occurredAt: at("occurred_at").notNull(),
});

export const outboundReplies = mutations.table("outbound_replies", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  intentId: uuid("intent_id").notNull(),
  parentInteractionId: uuid("parent_interaction_id").notNull(),
  connectedAccountId: uuid("connected_account_id").notNull(),
  platform: text("platform").notNull(),
  text: text("text").notNull(),
  providerReplyId: text("provider_reply_id"),
  confirmedAt: at("confirmed_at"),
  createdAt: at("created_at").notNull(),
});
