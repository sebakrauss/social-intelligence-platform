/**
 * Tenant signal-mark persistence (Step H6-F4; migration 0022 `ingestion.signal_marks`). Runs inside the caller's
 * workspace-scoped job transaction: RLS binds the workspace, so every statement sees the bound workspace's rows only.
 * The worker holds INSERT, SELECT, DELETE and UPDATE of (last_signal_at, signal_count, deferred_until,
 * requested_run_id, expires_at, updated_at) — nothing here writes any other column, and first_signal_at, the
 * dispatch generation and the expiry are never moved by a later signal.
 *
 * A mark stores canonical Wrenkind ids only (account, content, run): never a provider id, a hint, text or a body.
 * The routed hint is read through the 0022 worker definer, which re-derives the account from the bound workspace.
 *
 * Bookkeeping times (created_at, updated_at) are DATABASE time, like the 0022 due-mark dispatcher's own update: a mark
 * written from an application clock ahead of the database would otherwise make that definer's `updated_at >= created_at`
 * check fail — and with it the whole dispatch batch. Signal, revisit and expiry times stay application times (they are
 * compared with run times written by the same clock).
 */
import { sql } from "drizzle-orm";
import type { DatabaseTransaction } from "@/platform/db";
import type { RoutedHintRead, SignalMarkStore } from "../application/reconciliation-ports";
import { SIGNAL_RUN_CORRELATION_PREFIX, isHintChange } from "../domain/signals";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const date = (value: unknown): Date | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  throw new Error("signal_mark_time_incoherent");
};
const uuidList = (ids: readonly string[]): string => {
  for (const id of ids) if (!UUID.test(id)) throw new Error("signal_mark_id_invalid");
  return `{${ids.join(",")}}`;
};

export function createPostgresSignalMarkStore(tx: DatabaseTransaction): SignalMarkStore {
  return Object.freeze({
    async routedHint(hintId, connectedAccountId): Promise<RoutedHintRead> {
      const result = await tx.execute<{ outcome: unknown; platform: unknown; target_kind: unknown; provider_target_id: unknown; provider_content_id: unknown; provider_parent_id: unknown; change: unknown }>(sql`
        select outcome, platform, target_kind, provider_target_id, provider_content_id, provider_parent_id, change
          from ingestion.provider_event_hint(${hintId}::uuid, ${connectedAccountId}::uuid)`);
      const row = result.rows[0];
      if (row?.outcome === "account_inactive") return { outcome: "account_inactive" };
      if (row?.outcome === "not_found") return { outcome: "not_found" };
      if (row?.outcome !== "ok" || (row.platform !== "facebook" && row.platform !== "instagram") || (row.target_kind !== "content" && row.target_kind !== "interaction")
          || typeof row.provider_target_id !== "string" || !isHintChange(row.change)
          || (row.provider_content_id !== null && typeof row.provider_content_id !== "string") || (row.provider_parent_id !== null && typeof row.provider_parent_id !== "string")) {
        throw new Error("provider_event_hint_unrecognized");
      }
      return {
        outcome: "ok",
        platform: row.platform,
        targetKind: row.target_kind,
        providerTargetId: row.provider_target_id,
        providerContentId: row.provider_content_id,
        providerParentId: row.provider_parent_id,
        change: row.change,
      };
    },

    async upsert(mark) {
      await tx.execute(sql`
        insert into ingestion.signal_marks (id, organization_id, workspace_id, connected_account_id, kind, content_item_id, first_signal_at, last_signal_at,
                                            signal_count, expires_at, created_at, updated_at)
        values (${mark.id}::uuid, ${mark.organizationId}::uuid, ${mark.workspaceId}::uuid, ${mark.connectedAccountId}::uuid, ${mark.kind}, ${mark.contentItemId}::uuid,
                ${mark.signalAt}, ${mark.signalAt}, 1, ${mark.expiresAt}, pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp())
        on conflict on constraint signal_marks_one_pending do update
           set last_signal_at = greatest(ingestion.signal_marks.last_signal_at, excluded.last_signal_at),
               signal_count = least(ingestion.signal_marks.signal_count + 1, 1000000),
               updated_at = greatest(ingestion.signal_marks.updated_at, pg_catalog.statement_timestamp())`);
    },

    async summary(connectedAccountId) {
      const result = await tx.execute<{ n: number; account_id: string | null; account_last: unknown; relist_id: string | null; relist_min: unknown }>(sql`
        select (select count(*)::int from ingestion.signal_marks m where m.connected_account_id = ${connectedAccountId}::uuid) as n,
               (select m.id from ingestion.signal_marks m where m.connected_account_id = ${connectedAccountId}::uuid and m.kind = 'account') as account_id,
               (select m.last_signal_at from ingestion.signal_marks m where m.connected_account_id = ${connectedAccountId}::uuid and m.kind = 'account') as account_last,
               (select m.id from ingestion.signal_marks m where m.connected_account_id = ${connectedAccountId}::uuid and m.kind = 'relist'
                 order by m.first_signal_at, m.id limit 1) as relist_id,
               (select min(m.last_signal_at) from ingestion.signal_marks m where m.connected_account_id = ${connectedAccountId}::uuid and m.kind = 'relist') as relist_min`);
      const row = result.rows[0];
      if (row === undefined) throw new Error("signal_mark_summary_incoherent");
      const accountLast = date(row.account_last);
      return {
        count: row.n,
        accountMark: row.account_id === null || accountLast === null ? null : { id: row.account_id, lastSignalAt: accountLast },
        oldestRelistMark: row.relist_id === null ? null : { id: row.relist_id },
        earliestRelistSignalAt: date(row.relist_min),
      };
    },

    async relistCandidates(connectedAccountId, boundary, limit) {
      const result = await tx.execute<{ id: string; content_item_id: string }>(sql`
        select m.id, m.content_item_id from ingestion.signal_marks m
         where m.connected_account_id = ${connectedAccountId}::uuid and m.kind = 'relist' and m.last_signal_at <= ${boundary}
         order by m.first_signal_at, m.id
         limit ${limit}`);
      return result.rows.map((row) => ({ id: row.id, contentItemId: row.content_item_id }));
    },

    async deferAll(connectedAccountId, until) {
      const result = await tx.execute(sql`
        update ingestion.signal_marks set deferred_until = ${until}, updated_at = greatest(updated_at, pg_catalog.statement_timestamp())
         where connected_account_id = ${connectedAccountId}::uuid`);
      return result.rowCount ?? 0;
    },

    async linkRun(markIds, runId) {
      if (markIds.length === 0) return;
      await tx.execute(sql`
        update ingestion.signal_marks set requested_run_id = ${runId}::uuid, updated_at = greatest(updated_at, pg_catalog.statement_timestamp())
         where id = any(${uuidList(markIds)}::uuid[])`);
    },

    async satisfyRelist(connectedAccountId, contentItemIds, boundary) {
      if (contentItemIds.length === 0) return 0;
      const result = await tx.execute(sql`
        delete from ingestion.signal_marks
         where connected_account_id = ${connectedAccountId}::uuid and kind = 'relist'
           and content_item_id = any(${uuidList(contentItemIds)}::uuid[]) and last_signal_at <= ${boundary}`);
      return result.rowCount ?? 0;
    },

    async satisfyAccount(connectedAccountId, boundary) {
      const result = await tx.execute(sql`
        delete from ingestion.signal_marks where connected_account_id = ${connectedAccountId}::uuid and kind = 'account' and last_signal_at <= ${boundary}`);
      return result.rowCount ?? 0;
    },

    async deleteExpired(connectedAccountId, now) {
      const result = await tx.execute(sql`
        delete from ingestion.signal_marks where connected_account_id = ${connectedAccountId}::uuid and expires_at <= ${now}`);
      return result.rowCount ?? 0;
    },

    async drop(markIds) {
      if (markIds.length === 0) return 0;
      const result = await tx.execute(sql`delete from ingestion.signal_marks where id = any(${uuidList(markIds)}::uuid[])`);
      return result.rowCount ?? 0;
    },

    async signalRunsSince(connectedAccountId, since) {
      // Attribution (design §13.5): only the job runtime's signal requests — initiator system, correlation `sig.{mark}`.
      const result = await tx.execute<{ requested_at: unknown }>(sql`
        select r.requested_at from ingestion.reconciliation_runs r
         where r.connected_account_id = ${connectedAccountId}::uuid and r.initiator_type = 'system'
           and r.correlation_id like ${`${SIGNAL_RUN_CORRELATION_PREFIX}%`} and r.requested_at > ${since}
         order by r.requested_at
         limit 50`);
      return result.rows.map((row) => date(row.requested_at)).filter((value): value is Date => value !== null);
    },
  } satisfies SignalMarkStore);
}
