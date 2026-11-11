/**
 * Step 7B-14F1 (0028) — the Drizzle mapping and the READ side of one-time LIVE validation authorizations, bound to the
 * caller's scoped transaction (RLS decides: the bound worker reads its workspace's rows; a member reads only the
 * authorization that names them as initiator). There is deliberately no write here: issuance and revocation belong to
 * the operator tooling (a later gate), binding and consumption to the database triggers on the intent.
 *
 * Step 7B-14G1 wires the reads into the request and the executor (./index re-exports the admission readers; the intent's
 * binding column is mapped in ./tables). Still no write of any kind, and no locking read: the runtimes hold SELECT only,
 * so the authority of every state change stays with the 0028 triggers, which lock the row themselves (intent first,
 * then the authorization — the order every caller here preserves by locking nothing on this table).
 */
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { DatabaseTransaction } from "@/platform/db";
import {
  VALIDATION_AUTHORIZATION_OPERATION,
  isValidationAuthorizationIssueReason,
  isValidationAuthorizationRevocationReason,
  type ValidationAuthorization,
  type ValidationAuthorizationReading,
} from "../domain/validation-authorization";

const mutations = pgSchema("mutations");
const at = (name: string) => timestamp(name, { withTimezone: true });

export const validationAuthorizations = mutations.table("validation_authorizations", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  connectedAccountId: uuid("connected_account_id").notNull(),
  targetInteractionId: uuid("target_interaction_id").notNull(),
  initiatorUserId: uuid("initiator_user_id").notNull(),
  provider: text("provider").notNull(),
  platform: text("platform").notNull(),
  kind: text("kind").notNull(),
  preflightRunReference: text("preflight_run_reference").notNull(),
  preflightCompletedAt: at("preflight_completed_at").notNull(),
  issuedBy: text("issued_by").notNull(),
  issueReason: text("issue_reason").notNull(),
  issuedAt: at("issued_at").notNull(),
  expiresAt: at("expires_at").notNull(),
  revokedAt: at("revoked_at"),
  revokedBy: text("revoked_by"),
  revocationReason: text("revocation_reason"),
  intentId: uuid("intent_id"),
  boundAt: at("bound_at"),
  consumedAt: at("consumed_at"),
});

const corrupt = (what: string): never => {
  throw new Error(`validation authorization persistence: incoherent ${what}`);
};

export function toValidationAuthorization(row: typeof validationAuthorizations.$inferSelect): ValidationAuthorization {
  const { provider, platform, kind } = VALIDATION_AUTHORIZATION_OPERATION;
  if (row.provider !== provider || row.platform !== platform || row.kind !== kind) corrupt("operation");
  const issueReason = isValidationAuthorizationIssueReason(row.issueReason) ? row.issueReason : corrupt("issue_reason");
  const revocationReason = row.revocationReason === null ? null : isValidationAuthorizationRevocationReason(row.revocationReason) ? row.revocationReason : corrupt("revocation_reason");
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    connectedAccountId: row.connectedAccountId,
    targetInteractionId: row.targetInteractionId,
    initiatorUserId: row.initiatorUserId,
    provider,
    platform,
    kind,
    preflightRunReference: row.preflightRunReference,
    preflightCompletedAt: row.preflightCompletedAt,
    issuedBy: row.issuedBy,
    issueReason,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
    revocationReason,
    intentId: row.intentId,
    boundAt: row.boundAt,
    consumedAt: row.consumedAt,
  };
}

/** One authorization of the given workspace, as RLS lets this transaction see it; undefined when absent or invisible. */
export async function readValidationAuthorization(tx: DatabaseTransaction, workspaceId: string, id: string): Promise<ValidationAuthorization | undefined> {
  const row = (await tx.select().from(validationAuthorizations).where(and(eq(validationAuthorizations.workspaceId, workspaceId), eq(validationAuthorizations.id, id))).limit(1))[0];
  return row === undefined ? undefined : toValidationAuthorization(row);
}

/**
 * Step 7B-14G1 — the admission read: the authorization as RLS lets this transaction see it, together with the
 * DATABASE's expiry verdict at that moment (clock_timestamp() >= expires_at — the very comparison the 0028 bind and
 * consume triggers make), so the check and the trigger never disagree by application clock skew. undefined when absent
 * or invisible; an incoherent row throws (never read as admissible).
 */
export async function readValidationAuthorizationForAdmission(tx: DatabaseTransaction, workspaceId: string, id: string): Promise<ValidationAuthorizationReading | undefined> {
  const row = (await tx
    .select({ row: validationAuthorizations, expired: sql<boolean>`pg_catalog.clock_timestamp() >= ${validationAuthorizations.expiresAt}` })
    .from(validationAuthorizations)
    .where(and(eq(validationAuthorizations.workspaceId, workspaceId), eq(validationAuthorizations.id, id)))
    .limit(1))[0];
  if (row === undefined) return undefined;
  if (typeof row.expired !== "boolean") corrupt("expiry");
  return { authorization: toValidationAuthorization(row.row), expired: row.expired };
}

/**
 * Step 7B-14G1 (0028 B, X2) — whether ANOTHER authorization of this workspace for the same target and operation was ever
 * consumed (committed, as this statement sees it). The bound worker reads every row of its workspace; a member reads only
 * their own, so this answer is meaningful in the executor only. A consumption still uncommitted is invisible here: the
 * partial UNIQUE index (one consumed per target) refuses the second consumption, and the executor's recovery re-reads.
 */
export async function anotherValidationConsumedForTarget(tx: DatabaseTransaction, workspaceId: string, targetInteractionId: string, exceptId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: validationAuthorizations.id })
    .from(validationAuthorizations)
    .where(and(
      eq(validationAuthorizations.workspaceId, workspaceId),
      eq(validationAuthorizations.targetInteractionId, targetInteractionId),
      eq(validationAuthorizations.kind, VALIDATION_AUTHORIZATION_OPERATION.kind),
      isNotNull(validationAuthorizations.consumedAt),
      ne(validationAuthorizations.id, exceptId),
    ))
    .limit(1);
  return rows.length > 0;
}
