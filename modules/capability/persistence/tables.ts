/**
 * Drizzle mappings of the capability tables (db/migrations/0009). The SQL migration is the source of truth for
 * structure, RLS, grants and constraints. Owned by the capability module only.
 */
import { boolean, integer, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const capability = pgSchema("capability");
const at = (name: string) => timestamp(name, { withTimezone: true });

export const accountProfiles = capability.table("account_profiles", {
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  connectedAccountId: uuid("connected_account_id").notNull(),
  catalogId: text("catalog_id").notNull(),
  catalogRevision: integer("catalog_revision").notNull(),
  factsAvailable: boolean("facts_available").notNull(),
  factsAssetClass: text("facts_asset_class"),
  factsGrantedPermissions: text("facts_granted_permissions").array().notNull(),
  factsLinkedAdAccountIds: text("facts_linked_ad_account_ids").array().notNull(),
  factsAccountIdentityKnown: boolean("facts_account_identity_known"),
  factsObservedAt: at("facts_observed_at").notNull(),
  observations: jsonb("observations").$type<unknown>().notNull(),
  inputsAsOf: at("inputs_as_of").notNull(),
  inputDigest: text("input_digest").notNull(),
  evaluatedAt: at("evaluated_at").notNull(),
  lastVerifiedAt: at("last_verified_at").notNull(),
  revision: integer("revision").notNull(),
  createdAt: at("created_at").notNull(),
  updatedAt: at("updated_at").notNull(),
});

export const profileEntries = capability.table("profile_entries", {
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  connectedAccountId: uuid("connected_account_id").notNull(),
  capability: text("capability").notNull(),
  contentKind: text("content_kind").notNull(),
  source: text("source").notNull(),
  state: text("state").notNull(),
  reasonCodes: text("reason_codes").array().notNull(),
  limitationCode: text("limitation_code"),
  limitationValue: integer("limitation_value"),
  catalogValidation: text("catalog_validation").notNull(),
  evidenceRef: text("evidence_ref"),
  observationRefs: text("observation_refs").array().notNull(),
  revision: integer("revision").notNull(),
  evaluatedAt: at("evaluated_at").notNull(),
});
