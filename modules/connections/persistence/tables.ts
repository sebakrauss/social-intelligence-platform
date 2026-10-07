/**
 * Drizzle mappings of the connections tables (db/migrations/0007, 0008; 0010 adds definer functions, no columns).
 * The SQL migrations are the source of truth for structure, RLS, grants and constraints; these definitions only
 * type the queries. Owned by the connections module: no other module reads or writes these tables. The credentials
 * schema has no mapping at all: it is reached only through the reviewed definer functions.
 */
import { integer, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const connections = pgSchema("connections");
const at = (name: string) => timestamp(name, { withTimezone: true });

export const connectionsTable = connections.table("connections", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  provider: text("provider").notNull(),
  status: text("status").notNull(),
  activeCredentialId: uuid("active_credential_id"),
  authorizedBy: uuid("authorized_by").notNull(),
  authorizedAt: at("authorized_at").notNull(),
  lastSuccessAt: at("last_success_at"),
  lastProblemCode: text("last_problem_code"),
  lastProblemAt: at("last_problem_at"),
  version: integer("version").notNull(),
  createdAt: at("created_at").notNull(),
  updatedAt: at("updated_at").notNull(),
});

export const connectionEvents = connections.table("connection_events", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  connectionId: uuid("connection_id").notNull(),
  previousStatus: text("previous_status"),
  newStatus: text("new_status").notNull(),
  reasonCode: text("reason_code").notNull(),
  actorType: text("actor_type").notNull(),
  actorUserId: uuid("actor_user_id"),
  occurredAt: at("occurred_at").notNull(),
});

export const connectAttempts = connections.table("connect_attempts", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  provider: text("provider").notNull(),
  createdBy: uuid("created_by").notNull(),
  stateDigest: text("state_digest").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  reconnectConnectionId: uuid("reconnect_connection_id"),
  status: text("status").notNull(),
  expiresAt: at("expires_at").notNull(),
  createdAt: at("created_at").notNull(),
  closedAt: at("closed_at"),
  exchangeStartedAt: at("exchange_started_at"),
  failureCode: text("failure_code"),
});

export const discoveredAssets = connections.table("discovered_assets", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  connectionId: uuid("connection_id").notNull(),
  platform: text("platform").notNull(),
  providerAssetId: text("provider_asset_id").notNull(),
  assetClass: text("asset_class").notNull(),
  displayName: text("display_name").notNull(),
  lastSeenAt: at("last_seen_at").notNull(),
  createdAt: at("created_at").notNull(),
  updatedAt: at("updated_at").notNull(),
});

export const connectedAccounts = connections.table("connected_accounts", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  connectionId: uuid("connection_id").notNull(),
  platform: text("platform").notNull(),
  providerAssetId: text("provider_asset_id").notNull(),
  assetClass: text("asset_class").notNull(),
  status: text("status").notNull(),
  activatedAt: at("activated_at").notNull(),
  deactivatedAt: at("deactivated_at"),
  deactivationReason: text("deactivation_reason"),
  moveId: uuid("move_id"),
  createdAt: at("created_at").notNull(),
  updatedAt: at("updated_at").notNull(),
});

export const connectedAccountEvents = connections.table("connected_account_events", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  connectedAccountId: uuid("connected_account_id").notNull(),
  eventType: text("event_type").notNull(),
  moveId: uuid("move_id"),
  reasonCode: text("reason_code").notNull(),
  actorType: text("actor_type").notNull(),
  actorUserId: uuid("actor_user_id"),
  occurredAt: at("occurred_at").notNull(),
});

export const assetMoves = connections.table("asset_moves", {
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  moveId: uuid("move_id").notNull(),
  side: text("side").notNull(),
  counterpartWorkspaceId: uuid("counterpart_workspace_id").notNull(),
  connectionId: uuid("connection_id"),
  connectedAccountId: uuid("connected_account_id"),
  platform: text("platform").notNull(),
  providerAssetId: text("provider_asset_id"),
  initiatorUserId: uuid("initiator_user_id").notNull(),
  status: text("status").notNull(),
  reasonCode: text("reason_code"),
  createdAt: at("created_at").notNull(),
  updatedAt: at("updated_at").notNull(),
});
