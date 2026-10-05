/**
 * Operational switch rows (system.operational_switches, TA §66). Runtimes read them through their own
 * scope (RLS returns global rows plus overrides the caller may see); only operator tooling writes them,
 * and every write is audited by a database trigger. Validation and resolution live in platform/flags.
 */
import { sql } from "drizzle-orm";
import { jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { DatabaseTransaction } from "./scopes";

const system = pgSchema("system");

export const operationalSwitches = system.table("operational_switches", {
  id: uuid("id").primaryKey(),
  switchKey: text("switch_key").notNull(),
  qualifier: text("qualifier").notNull(),
  scope: text("scope").notNull(),
  organizationId: uuid("organization_id"),
  workspaceId: uuid("workspace_id"),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export interface SwitchRow {
  readonly switchKey: string;
  readonly qualifier: string;
  readonly scope: string;
  readonly organizationId: string | null;
  readonly workspaceId: string | null;
  readonly value: unknown;
}

/** Reads every switch row visible to the current scope. */
export async function readSwitchRows(tx: DatabaseTransaction): Promise<readonly SwitchRow[]> {
  const result = await tx.execute<{
    switch_key: string; qualifier: string; scope: string; organization_id: string | null; workspace_id: string | null; value: unknown;
  }>(sql`select switch_key, qualifier, scope, organization_id, workspace_id, value from system.operational_switches`);
  return result.rows.map((row) => ({
    switchKey: row.switch_key,
    qualifier: row.qualifier,
    scope: row.scope,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    value: row.value,
  }));
}
