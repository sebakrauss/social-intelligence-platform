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
 * Clock authority (0023, frozen; H6-F4d):
 *   DB time      created_at / updated_at, every revisit time (deferred_until: DB now + a delay the application chose),
 *                every expiry (expires_at: DB now + 7 days; compared with DB now here and by system.expire_signal_marks),
 *                and a confirm mark's signal times (compared with the DB-stamped read starts by the 0023 definers);
 *   run clock    an account/relist mark's first/last signal (compared with traversal window ends, the run clock).
 * A confirm mark's read start travels as LOSSLESS text (`::text` → `::timestamptz`): a JS Date drops microseconds and
 * would confirm a read a few microseconds before the one the database recorded.
 */
import { sql } from "drizzle-orm";
import type { DatabaseTransaction } from "@/platform/db";
import type { ConfirmationClaim, RoutedHintRead, SignalMarkStore } from "../application/reconciliation-ports";
import { SIGNAL_RUNTIME, SIGNAL_RUN_CORRELATION_PREFIX, isHintChange } from "../domain/signals";

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
                ${mark.signalAt}, ${mark.signalAt}, 1, pg_catalog.statement_timestamp() + ${SIGNAL_RUNTIME.markTtlMs} * interval '1 millisecond',
                pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp())
        on conflict on constraint signal_marks_one_pending do update
           set last_signal_at = greatest(ingestion.signal_marks.last_signal_at, excluded.last_signal_at),
               signal_count = least(ingestion.signal_marks.signal_count + 1, 1000000),
               updated_at = greatest(ingestion.signal_marks.updated_at, pg_catalog.statement_timestamp())`);
    },

    async summary(connectedAccountId) {
      const result = await tx.execute<{ n: number; account_id: string | null; account_last: unknown; relist_id: string | null; relist_min: unknown }>(sql`
        select (select count(*)::int from ingestion.signal_marks m where m.connected_account_id = ${connectedAccountId}::uuid and m.kind in ('account', 'relist')) as n,
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

    async deferAll(connectedAccountId, delayMs) {
      const result = await tx.execute(sql`
        update ingestion.signal_marks
           set deferred_until = pg_catalog.statement_timestamp() + ${Math.max(0, Math.round(delayMs))} * interval '1 millisecond',
               updated_at = greatest(updated_at, pg_catalog.statement_timestamp())
         where connected_account_id = ${connectedAccountId}::uuid and kind in ('account', 'relist')`);
      return result.rowCount ?? 0;
    },

    async linkRun(markIds, runId) {
      if (markIds.length === 0) return;
      await tx.execute(sql`
        update ingestion.signal_marks set requested_run_id = ${runId}::uuid, updated_at = greatest(updated_at, pg_catalog.statement_timestamp())
         where id = any(${uuidList(markIds)}::uuid[])`);
    },

    async satisfyRelist(connectedAccountId, traversals) {
      let satisfied = 0;
      for (const traversal of traversals) {
        if (!UUID.test(traversal.contentItemId)) throw new Error("signal_mark_id_invalid");
        const result = await tx.execute(sql`
          delete from ingestion.signal_marks
           where connected_account_id = ${connectedAccountId}::uuid and kind = 'relist'
             and content_item_id = ${traversal.contentItemId}::uuid and last_signal_at <= ${traversal.boundary}`);
        satisfied += result.rowCount ?? 0;
      }
      return satisfied;
    },

    async satisfyAccount(connectedAccountId, boundary) {
      const result = await tx.execute(sql`
        delete from ingestion.signal_marks where connected_account_id = ${connectedAccountId}::uuid and kind = 'account' and last_signal_at <= ${boundary}`);
      return result.rowCount ?? 0;
    },

    async deleteExpired(connectedAccountId) {
      const result = await tx.execute(sql`
        delete from ingestion.signal_marks where connected_account_id = ${connectedAccountId}::uuid and expires_at <= pg_catalog.statement_timestamp()`);
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

    // ── confirm marks (0023) ───────────────────────────────────────────────────────────────────────────────────
    async upsertConfirm(mark) {
      await tx.execute(sql`
        insert into ingestion.signal_marks (id, organization_id, workspace_id, connected_account_id, kind, content_item_id, interaction_id, first_signal_at, last_signal_at,
                                            signal_count, expires_at, created_at, updated_at)
        values (${mark.id}::uuid, ${mark.organizationId}::uuid, ${mark.workspaceId}::uuid, ${mark.connectedAccountId}::uuid, 'confirm', ${mark.contentItemId}::uuid,
                ${mark.interactionId}::uuid, pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(), 1,
                pg_catalog.statement_timestamp() + ${SIGNAL_RUNTIME.markTtlMs} * interval '1 millisecond', pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp())
        on conflict on constraint signal_marks_one_pending do update
           set last_signal_at = greatest(ingestion.signal_marks.last_signal_at, excluded.last_signal_at),
               signal_count = least(ingestion.signal_marks.signal_count + 1, 1000000),
               updated_at = greatest(ingestion.signal_marks.updated_at, pg_catalog.statement_timestamp())`);
    },

    async claimConfirmation(connectedAccountId, interactionId): Promise<ConfirmationClaim> {
      const result = await tx.execute<{ outcome: unknown; signal_mark_id: unknown; claimed_generation: unknown }>(sql`
        select outcome, signal_mark_id, claimed_generation from ingestion.claim_signal_confirmation(${connectedAccountId}::uuid, ${interactionId}::uuid)`);
      const row = result.rows[0];
      const markId = typeof row?.signal_mark_id === "string" && UUID.test(row.signal_mark_id) ? row.signal_mark_id : null;
      if (row?.outcome === "not_found") return { outcome: "not_found" };
      if (row?.outcome === "claimed" && markId !== null && typeof row.claimed_generation === "number" && row.claimed_generation >= 1) return { outcome: "claimed", markId, generation: row.claimed_generation };
      if ((row?.outcome === "cooling_down" || row?.outcome === "caught_up" || row?.outcome === "expired") && markId !== null) return { outcome: row.outcome, markId };
      throw new Error("signal_confirmation_claim_unrecognized");
    },

    async beginConfirmationRead(connectedAccountId, interactionId) {
      // ::text keeps the microseconds the definer stamped; the caller passes this exact text back.
      const result = await tx.execute<{ outcome: unknown; started_at: unknown }>(sql`
        select outcome, started_at::text as started_at from ingestion.begin_signal_confirmation_read(${connectedAccountId}::uuid, ${interactionId}::uuid)`);
      const row = result.rows[0];
      if (row?.outcome === "not_found") return { outcome: "not_found", startedAt: null };
      if (row?.outcome === "started" && typeof row.started_at === "string" && row.started_at.length > 0) return { outcome: "started", startedAt: row.started_at };
      throw new Error("signal_confirmation_read_unrecognized");
    },

    async completeConfirmationRead(connectedAccountId, interactionId, startedAt) {
      const result = await tx.execute<{ outcome: unknown }>(sql`
        select outcome from ingestion.complete_signal_confirmation_read(${connectedAccountId}::uuid, ${interactionId}::uuid, ${startedAt}::timestamptz)`);
      const outcome = result.rows[0]?.outcome;
      if (outcome === "confirmed" || outcome === "not_found" || outcome === "invalid") return outcome;
      throw new Error("signal_confirmation_completion_unrecognized");
    },

    async backoffConfirmation(connectedAccountId, interactionId) {
      // 5 min × 2^(generation − 1), capped: a non-authoritative read is retried less and less often (DB time).
      await tx.execute(sql`
        update ingestion.signal_marks
           set deferred_until = greatest(coalesce(deferred_until, pg_catalog.statement_timestamp()), pg_catalog.statement_timestamp()
                 + least(${SIGNAL_RUNTIME.confirmationBackoffCapMs}::double precision,
                         ${SIGNAL_RUNTIME.confirmationCooldownMs}::double precision * pg_catalog.power(2, greatest(dispatch_generation - 1, 0))) * interval '1 millisecond'),
               updated_at = greatest(updated_at, pg_catalog.statement_timestamp())
         where connected_account_id = ${connectedAccountId}::uuid and kind = 'confirm' and interaction_id = ${interactionId}::uuid`);
    },

    async dueConfirmations(connectedAccountId, limit) {
      const result = await tx.execute<{ id: string; interaction_id: string }>(sql`
        select m.id, m.interaction_id from ingestion.signal_marks m
         where m.connected_account_id = ${connectedAccountId}::uuid and m.kind = 'confirm'
           and (m.deferred_until is null or m.deferred_until <= pg_catalog.statement_timestamp())
         order by m.last_signal_at, m.id
         limit ${limit}`);
      return result.rows.map((row) => ({ id: row.id, interactionId: row.interaction_id }));
    },

    async deferConfirmations(markIds, delayMs) {
      if (markIds.length === 0) return;
      await tx.execute(sql`
        update ingestion.signal_marks
           set deferred_until = pg_catalog.statement_timestamp() + ${Math.max(0, Math.round(delayMs))} * interval '1 millisecond',
               updated_at = greatest(updated_at, pg_catalog.statement_timestamp())
         where id = any(${uuidList(markIds)}::uuid[]) and kind = 'confirm'`);
    },
  } satisfies SignalMarkStore);
}
