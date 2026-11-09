/**
 * Coverage persistence (Step H6-B; TL decision 4). Append-only coverage records, written once per identical interval
 * (the coverage_records_once key): a repeated identical write is a no-op. Coverage is never a count; a scope with no
 * record is UNKNOWN, never zero.
 */
import { and, eq, sql } from "drizzle-orm";
import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { DatabaseTransaction } from "@/platform/db";
import type { CoverageReadStore, CoverageStore } from "../application/ports";
import type { CoverageInterval, SliceCoverage } from "../domain/coverage";

const coverage = pgSchema("coverage");
const at = (name: string) => timestamp(name, { withTimezone: true });
/** Accounts summarized in one read (the Inbox asks for far fewer). */
const MAX_ACCOUNTS = 500;
/** Canonical UUID shape: anything else never reaches a `::uuid` cast (RFC 4122 variants, versions 1–8). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

/**
 * Step 7A: read-only; RLS (0017 member_read) admits the bound workspace's non-guest members only. The per-account
 * shape (DISTINCT ON account, kind, scope level) means one account's volume can never push another account's records
 * out of the result: each account contributes at most four rows. The bound is on accounts, not on records.
 */
export function createPostgresCoverageReadStore(tx: DatabaseTransaction): CoverageReadStore {
  return {
    async latestPerAccountAndKind(connectedAccountIds) {
      const ids = [...new Set(connectedAccountIds)].filter((id) => UUID.test(id));
      if (ids.length > MAX_ACCOUNTS) throw new RangeError("coverage read: too many accounts");
      if (ids.length === 0) return [];
      const result = await tx.execute<{
        connected_account_id: string; content_item_id: string | null; interaction_kind: string; state: string; reason: string; limitation_code: string | null;
        slice_outcome: string; interval_start: Date; interval_end: Date; as_of: Date;
      }>(sql`
        select distinct on (${coverageRecords.connectedAccountId}, ${coverageRecords.interactionKind}, (${coverageRecords.contentItemId} is null))
               ${coverageRecords.connectedAccountId} as connected_account_id, ${coverageRecords.contentItemId} as content_item_id, ${coverageRecords.interactionKind} as interaction_kind,
               ${coverageRecords.state} as state, ${coverageRecords.reason} as reason, ${coverageRecords.limitationCode} as limitation_code, ${coverageRecords.sliceOutcome} as slice_outcome,
               ${coverageRecords.intervalStart} as interval_start, ${coverageRecords.intervalEnd} as interval_end, ${coverageRecords.asOf} as as_of
          from ${coverageRecords}
         where ${coverageRecords.capability} = 'read_interactions'
           and ${coverageRecords.connectedAccountId} in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
         order by ${coverageRecords.connectedAccountId}, ${coverageRecords.interactionKind}, (${coverageRecords.contentItemId} is null), ${coverageRecords.asOf} desc, ${coverageRecords.id} desc
         limit ${ids.length * 4}`);
      return result.rows.map((row) => ({
        connectedAccountId: row.connected_account_id,
        contentItemId: row.content_item_id,
        interactionKind: row.interaction_kind,
        state: row.state,
        reason: row.reason,
        limitationCode: row.limitation_code,
        sliceOutcome: row.slice_outcome,
        intervalStart: new Date(row.interval_start),
        intervalEnd: new Date(row.interval_end),
        asOf: new Date(row.as_of),
      }));
    },
  };
}
