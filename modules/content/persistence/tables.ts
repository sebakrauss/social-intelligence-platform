/**
 * Drizzle mapping of content.content_items (db/migrations/0017). The SQL migration is the source of truth for structure,
 * RLS, grants and constraints. Owned by the content module only.
 */
import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const content = pgSchema("content");
const at = (name: string) => timestamp(name, { withTimezone: true });

export const contentItems = content.table("content_items", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  platform: text("platform").notNull(),
  connectedAccountId: uuid("connected_account_id").notNull(),
  providerAssetId: text("provider_asset_id").notNull(),
  providerContentId: text("provider_content_id").notNull(),
  contentKind: text("content_kind").notNull(),
  reportedSource: text("reported_source").notNull(),
  sourceState: text("source_state").notNull(),
  firstObservedAt: at("first_observed_at").notNull(),
  latestObservedAt: at("latest_observed_at").notNull(),
  createdAt: at("created_at").notNull(),
  updatedAt: at("updated_at").notNull(),
});
