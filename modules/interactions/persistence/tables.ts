/**
 * Drizzle mappings of the interactions tables (db/migrations/0017). The SQL migration is the source of truth for
 * structure, RLS, grants, constraints and the scope guard. Owned by the interactions module only.
 */
import { boolean, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const interactions = pgSchema("interactions");
const at = (name: string) => timestamp(name, { withTimezone: true });

export const authors = interactions.table("authors", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  platform: text("platform").notNull(),
  providerAuthorId: text("provider_author_id").notNull(),
  role: text("role").notNull(),
  label: text("label"),
  createdAt: at("created_at").notNull(),
  updatedAt: at("updated_at").notNull(),
});

export const interactionRows = interactions.table("interactions", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  platform: text("platform").notNull(),
  providerInteractionId: text("provider_interaction_id").notNull(),
  connectedAccountId: uuid("connected_account_id").notNull(),
  providerAssetId: text("provider_asset_id").notNull(),
  contentItemId: uuid("content_item_id").notNull(),
  providerContentId: text("provider_content_id").notNull(),
  observed: boolean("observed").notNull(),
  parentInteractionId: uuid("parent_interaction_id"),
  kind: text("kind"),
  authorId: uuid("author_id"),
  authorRole: text("author_role"),
  conversationId: uuid("conversation_id"),
  currentSourceTextVersionId: uuid("current_source_text_version_id"),
  textObservedAt: at("text_observed_at"),
  currentVisibility: text("current_visibility"),
  currentAvailability: text("current_availability"),
  currentRemovalBasis: text("current_removal_basis"),
  providerCreatedAt: at("provider_created_at"),
  providerEditedAt: at("provider_edited_at"),
  stateObservedAt: at("state_observed_at"),
  firstObservedAt: at("first_observed_at"),
  latestObservedAt: at("latest_observed_at"),
  createdAt: at("created_at").notNull(),
  updatedAt: at("updated_at").notNull(),
});

export const sourceTextVersions = interactions.table("source_text_versions", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  interactionId: uuid("interaction_id").notNull(),
  textHash: text("text_hash").notNull(),
  sourceText: text("source_text").notNull(),
  providerEditedAt: at("provider_edited_at"),
  observedAt: at("observed_at").notNull(),
  createdAt: at("created_at").notNull(),
});

export const stateObservations = interactions.table("state_observations", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  interactionId: uuid("interaction_id").notNull(),
  visibility: text("visibility").notNull(),
  availability: text("availability").notNull(),
  removalBasis: text("removal_basis"),
  observedAt: at("observed_at").notNull(),
  mechanism: text("mechanism").notNull(),
  operation: text("operation").notNull(),
  provenance: text("provenance").notNull(),
  createdAt: at("created_at").notNull(),
});
