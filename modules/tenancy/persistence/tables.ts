/**
 * Drizzle mappings of the tenancy tables (db/migrations/0002_tenancy.sql). The SQL migration is the
 * source of truth for structure, RLS, grants and constraints; these definitions only type the queries.
 * Owned by the tenancy module: no other module reads or writes these tables.
 */
import { pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

const tenancy = pgSchema("tenancy");

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull();

export const organizations = tenancy.table("organizations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const workspaces = tenancy.table("workspaces", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  name: text("name").notNull(),
  mode: text("mode").notNull(),
  createdAt: createdAt(),
});

export const organizationMemberships = tenancy.table(
  "organization_memberships",
  {
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.userId] })],
);

export const workspaceMemberships = tenancy.table(
  "workspace_memberships",
  {
    organizationId: uuid("organization_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").notNull(),
    grants: text("grants").array().notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.userId] })],
);

export const invitations = tenancy.table("invitations", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  targetKind: text("target_kind").notNull(),
  workspaceId: uuid("workspace_id"),
  role: text("role").notNull(),
  grants: text("grants").array().notNull(),
  recipientEmail: text("recipient_email").notNull(),
  tokenDigest: text("token_digest").notNull(),
  invitedBy: uuid("invited_by").notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  status: text("status").notNull(),
  acceptedBy: uuid("accepted_by"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});
