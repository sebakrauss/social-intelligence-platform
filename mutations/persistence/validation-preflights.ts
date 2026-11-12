/**
 * Step 7B-14I2 (0029) — the PREFLIGHT evidence and the operator's append-only log: their Drizzle mappings (the migration is
 * the source of truth for structure, RLS and grants; no runtime role holds a privilege on either table), the closed
 * evidence a completed preflight run records, and its ONE write path: the bound worker's definer
 * `mutations.record_validation_preflight`. The database re-checks that the examined account, connection and credential
 * are still the active ones, takes the time from its own clock and derives `passed` itself (a generated column).
 * Nothing here issues, revokes, binds or consumes an authorization; Step 7B-14I3H adds ONE read (the executor's H1 binding).
 */
import { and, eq, sql } from "drizzle-orm";
import { boolean, integer, pgSchema, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { DatabaseTransaction } from "@/platform/db";
import type { ValidationPreflightBinding } from "../domain/validation-authorization";

const mutations = pgSchema("mutations");
const at = (name: string) => timestamp(name, { withTimezone: true });

export const validationPreflights = mutations.table("validation_preflights", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  connectedAccountId: uuid("connected_account_id").notNull(),
  targetInteractionId: uuid("target_interaction_id").notNull(),
  connectionId: uuid("connection_id").notNull(),
  credentialId: uuid("credential_id").notNull(),
  runReference: text("run_reference").notNull(),
  status: text("status").notNull(),
  checksVerified: smallint("checks_verified").notNull(),
  requiredPermissionsGranted: boolean("required_permissions_granted").notNull(),
  repliesComplete: boolean("replies_complete").notNull(),
  repliesByManagedAccount: integer("replies_by_managed_account"),
  repliesUnattributed: integer("replies_unattributed"),
  stoppedEarly: boolean("stopped_early").notNull(),
  tokenType: text("token_type").notNull(),
  passed: boolean("passed").notNull(),
  recordedAt: at("recorded_at").notNull(),
  authorizationId: uuid("authorization_id"),
  usedAt: at("used_at"),
});

export const validationOperatorEvents = mutations.table("validation_operator_events", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  authorizationId: uuid("authorization_id").notNull(),
  event: text("event").notNull(),
  operatorLogin: text("operator_login").notNull(),
  reason: text("reason").notNull(),
  preflightId: uuid("preflight_id"),
  tokenTypeNotVerifiedAccepted: boolean("token_type_not_verified_accepted"),
  recordedAt: at("recorded_at").notNull(),
});

/**
 * Step 7B-14I3H (H1) — the evidence an authorization was issued from, as the bound worker may read it (0030: SELECT for
 * app_worker on USED evidence of the bound workspace only): the ONE row whose write-once authorization_id names it.
 * undefined when none — or, defensively, more than one (the 0029 unique key forbids it) — is visible. Identifiers only.
 */
export async function readValidationPreflightBinding(tx: DatabaseTransaction, workspaceId: string, authorizationId: string): Promise<ValidationPreflightBinding | undefined> {
  const rows = await tx
    .select({
      preflightId: validationPreflights.id,
      authorizationId: validationPreflights.authorizationId,
      workspaceId: validationPreflights.workspaceId,
      connectedAccountId: validationPreflights.connectedAccountId,
      targetInteractionId: validationPreflights.targetInteractionId,
      connectionId: validationPreflights.connectionId,
      credentialId: validationPreflights.credentialId,
      runReference: validationPreflights.runReference,
      recordedAt: validationPreflights.recordedAt,
      passed: validationPreflights.passed,
    })
    .from(validationPreflights)
    .where(and(eq(validationPreflights.workspaceId, workspaceId), eq(validationPreflights.authorizationId, authorizationId)))
    .limit(2);
  const row = rows.length === 1 ? rows[0] : undefined;
  if (row === undefined || row.authorizationId === null) return undefined;
  return { ...row, authorizationId: row.authorizationId };
}

/** What ONE completed preflight run records: identifiers of what it examined and closed counts — never text or a secret. */
export interface ValidationPreflightEvidence {
  readonly id: string;
  readonly connectedAccountId: string;
  readonly targetInteractionId: string;
  /** The credential the run opened (the connection's active one when the run started). */
  readonly credentialId: string;
  /** The run's own reference (from its run context, never the payload). */
  readonly runReference: string;
  readonly status: "VERIFIED" | "NOT_VERIFIED" | "BLOCKED";
  /** VERIFIED checks among the reader's ten. */
  readonly checksVerified: number;
  readonly requiredPermissionsGranted: boolean;
  readonly repliesComplete: boolean;
  readonly repliesByManagedAccount: number | null;
  readonly repliesUnattributed: number | null;
  readonly stoppedEarly: boolean;
}

/**
 * Records the evidence in the caller's transaction (the worker scope bound to the evidence's workspace). Returns the
 * database's recording instant. Throws when the database refuses (the examined credential is no longer active, the
 * account left ACTIVE, an unbound or non-worker caller): no evidence then exists, and no authorization can rest on it.
 */
export async function recordValidationPreflight(tx: DatabaseTransaction, evidence: ValidationPreflightEvidence): Promise<Date> {
  const result = await tx.execute<{ recorded_at: Date | string }>(sql`select mutations.record_validation_preflight(
    ${evidence.id}::uuid, ${evidence.connectedAccountId}::uuid, ${evidence.targetInteractionId}::uuid, ${evidence.credentialId}::uuid,
    ${evidence.runReference}, ${evidence.status}, ${evidence.checksVerified}::integer, ${evidence.requiredPermissionsGranted}::boolean,
    ${evidence.repliesComplete}::boolean, ${evidence.repliesByManagedAccount}::integer, ${evidence.repliesUnattributed}::integer,
    ${evidence.stoppedEarly}::boolean) as recorded_at`);
  const recorded = result.rows[0]?.recorded_at;
  if (recorded === undefined) throw new Error("validation preflight persistence: no recording instant");
  return recorded instanceof Date ? recorded : new Date(recorded);
}
