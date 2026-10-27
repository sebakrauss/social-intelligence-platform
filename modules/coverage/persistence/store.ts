/**
 * Coverage persistence (Step H6-B; TL decision 4). Append-only coverage records, written once per identical interval
 * (the coverage_records_once key): a repeated identical write is a no-op. Coverage is never a count; a scope with no
 * record is UNKNOWN, never zero.
 */
import { and, eq } from "drizzle-orm";
import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { DatabaseTransaction } from "@/platform/db";
import type { CoverageStore } from "../application/ports";
import type { CoverageInterval, SliceCoverage } from "../domain/coverage";

const coverage = pgSchema("coverage");
const at = (name: string) => timestamp(name, { withTimezone: true });

/** Drizzle mapping of coverage.coverage_records (db/migrations/0017; the SQL is the source of truth). */
export const coverageRecords = coverage.table("coverage_records", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  connectedAccountId: uuid("connected_account_id").notNull(),
  capability: text("capability").notNull(),
  contentItemId: uuid("content_item_id"),
  interactionKind: text("interaction_kind").notNull(),
  intervalStart: at("interval_start").notNull(),
  intervalEnd: at("interval_end").notNull(),
  state: text("state").notNull(),
  reason: text("reason").notNull(),
  limitationCode: text("limitation_code"),
  sliceOutcome: text("slice_outcome").notNull(),
  correlationId: text("correlation_id").notNull(),
  asOf: at("as_of").notNull(),
  createdAt: at("created_at").notNull(),
});



export function createPostgresCoverageStore(tx: DatabaseTransaction): CoverageStore {
  return {
    async recordSlice(input) {
      const outcome = input.coverage.outcome;
      let written = 0;
      for (const interval of input.coverage.intervals) {
        const inserted = await tx
          .insert(coverageRecords)
          .values(row(interval, input, outcome))
          .onConflictDoNothing()
          .returning({ id: coverageRecords.id });
        written += inserted.length;
      }
      return written;
    },
    async forAccount(connectedAccountId) {
      return tx
        .select({ interactionKind: coverageRecords.interactionKind, state: coverageRecords.state, reason: coverageRecords.reason, limitationCode: coverageRecords.limitationCode,
          sliceOutcome: coverageRecords.sliceOutcome, intervalStart: coverageRecords.intervalStart, intervalEnd: coverageRecords.intervalEnd })
        .from(coverageRecords)
        .where(and(eq(coverageRecords.connectedAccountId, connectedAccountId), eq(coverageRecords.capability, "read_interactions")))
        .orderBy(coverageRecords.intervalStart, coverageRecords.interactionKind);
    },
  };
}

const row = (interval: CoverageInterval, input: { readonly organizationId: string; readonly workspaceId: string; readonly contentItemId: string | null; readonly correlationId: string; readonly newId: () => string }, outcome: SliceCoverage["outcome"]) => ({
  id: input.newId(),
  organizationId: input.organizationId,
  workspaceId: input.workspaceId,
  connectedAccountId: interval.scope.connectedAccountId,
  capability: interval.scope.capability,
  contentItemId: input.contentItemId,
  interactionKind: interval.interactionKind,
  intervalStart: new Date(interval.from),
  intervalEnd: new Date(interval.to),
  state: interval.state,
  reason: interval.reason,
  limitationCode: interval.limitationCode,
  sliceOutcome: outcome,
  correlationId: input.correlationId,
  asOf: new Date(interval.asOf),
  createdAt: new Date(interval.asOf),
});
