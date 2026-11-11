/**
 * Step 7B-14F1 (0028) — the Drizzle mapping and the READ side of one-time LIVE validation authorizations, bound to the
 * caller's scoped transaction (RLS decides: the bound worker reads its workspace's rows; a member reads only the
 * authorization that names them as initiator). There is deliberately no write here: issuance and revocation belong to
 * the operator tooling (a later gate), binding and consumption to the database triggers on the intent.
 *
 * Deliberately NOT re-exported from ./index (nor mapped on `mutationIntents` in ./tables): no runtime entry point — web
 * request, executor, job — reaches this module yet; the integration gate wires it. The intent's binding column
 * (mutation_intents.validation_authorization_id) stays unmapped, so this generation's request and executor neither read
 * nor write it (it is NULL on their inserts).
 */
import { and, eq } from "drizzle-orm";
import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { DatabaseTransaction } from "@/platform/db";
import {
  VALIDATION_AUTHORIZATION_OPERATION,
  isValidationAuthorizationIssueReason,
  isValidationAuthorizationRevocationReason,
  type ValidationAuthorization,
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
