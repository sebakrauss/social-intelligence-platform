/**
 * Step H6-F4b — migration 0023 on the real database, through the runtime logins (persistence only; no runtime code uses
 * these objects yet, no provider is called):
 *   A. a budget-abandoned interactions slice parks its cursor (DB-stamped, one per account+content, retire-only);
 *   B. confirm marks (canonical interaction + content), the claim / read-start / read-success definers, the cooldown;
 *   C. system-wide expiry of signal marks, whatever the account's status;
 *   and the 0022/0019 behaviors that must not move.
 * Elapsed time is simulated only by the privileged test login (never by a runtime role).
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserScope, withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { withSystemScope } from "@/platform/db/system-scope";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";
import { sqlState } from "./helpers";

interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly owner: string;
  readonly account: string;
  readonly asset: string;
  readonly content: string;
  readonly interaction: string;
}

const CURSOR = "meta1.c3ludGhldGljLWN1cnNvcg";
/** Raw driver rows carry timestamps as text: normalize to Date (null stays null). */
const at = (value: unknown): Date | null => (value === null || value === undefined ? null : new Date(value as string));

export function defineSignalProgressPersistenceSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let system: RuntimeDatabase<"system">;
  const organizations: string[] = [];

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const one = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T> => {
    const rows = await oracle<T>(query, values);
    if (rows[0] === undefined) throw new Error("no row");
    return rows[0];
  };
  const count = async (query: string, values: readonly unknown[] = []): Promise<number> => (await oracle<{ n: number }>(query, values))[0]?.n ?? -1;
  const asWorker = <T>(t: Pick<Tenant, "workspaceId">, work: (tx: DatabaseTransaction) => Promise<T>) => withWorkspaceJobScope(worker, t.workspaceId, work);
  /** Organization, workspace, OWNER member, ACTIVE connection + content-bearing account, one canonical content and one canonical interaction. */
  const tenant = async (asset = `f4b_${randomUUID().slice(0, 8)}`): Promise<Tenant> => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const owner = randomUUID();
    organizations.push(organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'F4b', now())", [organizationId]);
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'MONITOR_ONLY', now())", [workspaceId, organizationId]);
    await privileged.query("insert into tenancy.organization_memberships values ($1, $2, 'OWNER', now())", [organizationId, owner]);
    await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, 'OWNER', '{}', now())", [organizationId, workspaceId, owner]);
    const connection = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`, [connection, organizationId, workspaceId, owner]);
    const discovered = randomUUID();
    await privileged.query(
      `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'facebook', $5, 'content_bearing', 'Synthetic', now(), now(), now())`, [discovered, organizationId, workspaceId, connection, asset]);
    const account = randomUUID();
    await privileged.query(
      `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
       select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`,
      [account, discovered]);
    const content = await contentOf({ organizationId, workspaceId, account, asset });
    const interaction = await interactionOf({ organizationId, workspaceId, account, asset }, content);
    return { organizationId, workspaceId, owner, account, asset, content, interaction };
  };
  const contentOf = async (t: Pick<Tenant, "organizationId" | "workspaceId" | "account" | "asset">): Promise<string> => {
    const id = randomUUID();
    await privileged.query(
      `insert into content.content_items (id, organization_id, workspace_id, platform, connected_account_id, provider_asset_id, provider_content_id, content_kind, reported_source,
                                          source_state, first_observed_at, latest_observed_at, created_at, updated_at)
       values ($1, $2, $3, 'facebook', $4, $5, $6, 'post', 'unknown', 'available', now(), now(), now(), now())`,
      [id, t.organizationId, t.workspaceId, t.account, t.asset, `${t.asset}_p_${id.slice(0, 6)}`]);
    return id;
  };
  /** A canonical (placeholder) interaction of the content: identity only — no text, no author. */
  const interactionOf = async (t: Pick<Tenant, "organizationId" | "workspaceId" | "account" | "asset">, content: string): Promise<string> => {
    const id = randomUUID();
    const providerContentId = (await one<{ p: string }>("select provider_content_id as p from content.content_items where workspace_id = $1 and id = $2", [t.workspaceId, content])).p;
    await privileged.query(
      `insert into interactions.interactions (id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id,
                                              provider_content_id, observed, created_at, updated_at)
       values ($1, $2, $3, 'facebook', $4, $5, $6, $7, $8, false, now(), now())`,
      [id, t.organizationId, t.workspaceId, `${t.asset}_c_${id.slice(0, 6)}`, t.account, t.asset, content, providerContentId]);
    return id;
  };
  /** A worker-requested run, marked RUNNING by the worker (its own grants). */
  const runOf = async (t: Tenant, plan: "account" | "relist" = "relist"): Promise<string> => {
    const requested = await asWorker(t, (tx) => tx.execute<{ outcome: string; reconciliation_run_id: string }>(sql`
      select outcome, reconciliation_run_id from ingestion.request_reconciliation(${t.account}::uuid, ${`f4b-${randomUUID()}`}, now(),
        ${JSON.stringify({ max_operations: 10, plan })}::jsonb)`));
    const run = requested.rows[0];
    if (run?.outcome !== "requested") throw new Error(`run not requested: ${String(run?.outcome)}`);
    await asWorker(t, (tx) => tx.execute(sql`update ingestion.reconciliation_runs set state = 'RUNNING', started_at = now(), updated_at = now() where id = ${run.reconciliation_run_id}::uuid`));
    return run.reconciliation_run_id;
  };
  const closeRun = (t: Tenant, run: string) =>
    asWorker(t, (tx) => tx.execute(sql`update ingestion.reconciliation_runs set state = 'PARTIAL', completed_at = now(), updated_at = now() where id = ${run}::uuid`));
  /** A PENDING interactions slice inserted by the worker, then claimed RUNNING with a cursor (the existing semantics). */
  const runningSlice = async (t: Tenant, run: string, content = t.content, unit: "content_interactions" | "content_listing" = "content_interactions"): Promise<string> => {
    const id = randomUUID();
    await asWorker(t, (tx) => tx.execute(sql`
      insert into ingestion.reconciliation_slices (id, organization_id, workspace_id, reconciliation_run_id, connected_account_id, unit, content_item_id, sequence, state,
                                                   attempt, window_start, window_end, max_pages, created_at, updated_at)
      values (${id}::uuid, ${t.organizationId}::uuid, ${t.workspaceId}::uuid, ${run}::uuid, ${t.account}::uuid, ${unit}, ${unit === "content_listing" ? null : content}::uuid, 0, 'PENDING',
              0, now() - interval '1 day', now(), 5, now(), now())`));
    await asWorker(t, (tx) => tx.execute(sql`
      update ingestion.reconciliation_slices set state = 'RUNNING', attempt = attempt + 1, leased_until = now() + interval '10 minutes',
             cursor = ${CURSOR}, cursor_issued_at = now(), pages_read = 1, operations_used = 1, updated_at = now() where id = ${id}::uuid`));
    return id;
  };
  /** The runtime's finishing statement, but KEEPING the cursor (what H6-F4d will do for a budget-abandoned slice). */
  const finishKeepingCursor = (t: Tenant, slice: string, state: string, failureClass: string | null = null) =>
    asWorker(t, (tx) => tx.execute(sql`
      update ingestion.reconciliation_slices set state = ${state}, failure_class = ${failureClass}, retry_not_before = ${state === "FAILED_RATE_LIMITED" ? new Date(Date.now() + 60_000) : null},
             completed_at = now(), leased_until = null, updated_at = now() where id = ${slice}::uuid`));
  const sliceRow = (id: string) => one<{ state: string; cursor: string | null; cursor_parked_at: Date | null; window_start: Date; window_end: Date }>(
    "select state, cursor, cursor_parked_at, window_start, window_end from ingestion.reconciliation_slices where id = $1", [id]);

  // Marks — through the worker's own 0022 grants (the shape F4d will write).
  const insertMark = (t: Tenant, kind: string, content: string | null, interaction: string | null, options: { readonly expires?: string; readonly first?: string } = {}) =>
    asWorker(t, (tx) => tx.execute<{ id: string }>(sql`
      insert into ingestion.signal_marks (id, organization_id, workspace_id, connected_account_id, kind, content_item_id, interaction_id, first_signal_at, last_signal_at,
                                          signal_count, expires_at, created_at, updated_at)
      values (${randomUUID()}::uuid, ${t.organizationId}::uuid, ${t.workspaceId}::uuid, ${t.account}::uuid, ${kind}, ${content}::uuid, ${interaction}::uuid,
              statement_timestamp() - ${options.first ?? "0 seconds"}::interval, statement_timestamp() - ${options.first ?? "0 seconds"}::interval, 1,
              statement_timestamp() + ${options.expires ?? "7 days"}::interval, statement_timestamp(), statement_timestamp())
      on conflict on constraint signal_marks_one_pending do update
         set last_signal_at = greatest(ingestion.signal_marks.last_signal_at, excluded.last_signal_at),
             signal_count = ingestion.signal_marks.signal_count + 1, updated_at = greatest(ingestion.signal_marks.updated_at, statement_timestamp())
      returning id`).then((r) => r.rows[0]?.id ?? ""));
  const confirmSignal = (t: Tenant, interaction = t.interaction, content = t.content) => insertMark(t, "confirm", content, interaction);
  const claim = (t: Tenant, interaction = t.interaction) =>
    asWorker(t, (tx) => tx.execute<{ outcome: string; signal_mark_id: string | null; claimed_generation: number | null; due_at: Date | null }>(sql`
      select outcome, signal_mark_id, claimed_generation, due_at from ingestion.claim_signal_confirmation(${t.account}::uuid, ${interaction}::uuid)`))
      .then((r) => (r.rows[0] === undefined ? undefined : { ...r.rows[0], due_at: at(r.rows[0].due_at) }));
  const begin = (t: Tenant, interaction = t.interaction) =>
    asWorker(t, (tx) => tx.execute<{ outcome: string; started_at: Date | null }>(sql`
      select outcome, started_at from ingestion.begin_signal_confirmation_read(${t.account}::uuid, ${interaction}::uuid)`))
      .then((r) => (r.rows[0] === undefined ? undefined : { ...r.rows[0], started_at: at(r.rows[0].started_at) }));
  const complete = (t: Tenant, readStartedAt: Date | null, interaction = t.interaction) =>
    asWorker(t, (tx) => tx.execute<{ outcome: string; confirmed_through: Date | null }>(sql`
      select outcome, confirmed_through from ingestion.complete_signal_confirmation_read(${t.account}::uuid, ${interaction}::uuid, ${readStartedAt}::timestamptz)`))
      .then((r) => (r.rows[0] === undefined ? undefined : { ...r.rows[0], confirmed_through: at(r.rows[0].confirmed_through) }));
  const markOf = (t: Tenant, kind = "confirm", interaction: string | null = t.interaction) => oracle<{ id: string; signal_count: number; first_signal_at: Date; last_signal_at: Date; deferred_until: Date | null;
    dispatch_generation: number; read_started_at: Date | null; confirmed_through_at: Date | null; expires_at: Date }>(
    `select id, signal_count, first_signal_at, last_signal_at, deferred_until, dispatch_generation, read_started_at, confirmed_through_at, expires_at
       from ingestion.signal_marks where workspace_id = $1 and kind = $2 and interaction_id is not distinct from $3`, [t.workspaceId, kind, interaction]).then((rows) => rows[0]);
  /** Simulated end of the cooldown (privileged test login only; deferred_until carries no monotonic guard). */
  const cooldownElapsed = (markId: string) => privileged.query("update ingestion.signal_marks set deferred_until = now() - interval '1 second' where id = $1", [markId]);
  const expire = (limit: number) =>
    withSystemScope(system, (tx) => tx.execute<{ expired: number; account_marks: number; relist_marks: number; confirm_marks: number }>(sql`
      select expired, account_marks, relist_marks, confirm_marks from system.expire_signal_marks(${limit})`)).then((r) => r.rows[0]);
  const canonical = async (orgs: readonly string[]) => ({
    content: await count("select count(*)::int as n from content.content_items where organization_id = any($1::uuid[])", [orgs]),
    interactions: await count("select count(*)::int as n from interactions.interactions where organization_id = any($1::uuid[])", [orgs]),
    conversations: await count("select count(*)::int as n from conversations.conversations where organization_id = any($1::uuid[])", [orgs]),
    coverage: await count("select count(*)::int as n from coverage.coverage_records where organization_id = any($1::uuid[])", [orgs]),
    watermarks: await count("select count(*)::int as n from ingestion.reconciliation_watermarks where organization_id = any($1::uuid[])", [orgs]),
  });

  beforeAll(() => {
    const target = getTarget();
    privileged = privilegedPool(target, 3);
    web = runtimeDatabase(target, "web", 1);
    worker = runtimeDatabase(target, "worker", 3);
    system = runtimeDatabase(target, "system", 2);
  });
  afterAll(async () => {
    await Promise.all([web.end(), worker.end(), system.end()]);
    await cleanupWorld(privileged, organizations);
    await privileged.end();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("A. parked reconciliation cursor", () => {
    it("1–3. a RUNNING slice carries its cursor; ABANDONED_BUDGET parks it with a DB-stamped time; the runtime cannot set that time", async () => {
      const t = await tenant();
      const run = await runOf(t);
      const slice = await runningSlice(t, run);
      expect(await sliceRow(slice)).toMatchObject({ state: "RUNNING", cursor: CURSOR, cursor_parked_at: null });
      const before = (await one<{ now: Date }>("select now() as now")).now;
      await finishKeepingCursor(t, slice, "ABANDONED_BUDGET");
      const parked = await sliceRow(slice);
      const after = (await one<{ now: Date }>("select now() as now")).now;
      expect(parked).toMatchObject({ state: "ABANDONED_BUDGET", cursor: CURSOR });
      expect(parked.cursor_parked_at?.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(parked.cursor_parked_at?.getTime()).toBeLessThanOrEqual(after.getTime());
      // No runtime grant on the parking time (the trigger owns it), and a supplied value is ignored on insert.
      expect(await sqlState(asWorker(t, (tx) => tx.execute(sql`update ingestion.reconciliation_slices set cursor_parked_at = now() - interval '1 day' where id = ${slice}::uuid`)))).toMatchObject({ code: "42501" });
      const forged = randomUUID();
      await privileged.query(
        `insert into ingestion.reconciliation_slices (id, organization_id, workspace_id, reconciliation_run_id, connected_account_id, unit, content_item_id, sequence, state, attempt,
                                                      window_start, window_end, max_pages, cursor_parked_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, 'content_interactions', $6, 9, 'PENDING', 0, now() - interval '1 day', now(), 5, '2000-01-01T00:00:00Z', now(), now())`,
        [forged, t.organizationId, t.workspaceId, run, t.account, t.content]);
      expect((await sliceRow(forged)).cursor_parked_at).toBeNull();
      await closeRunPendingSlice(t, forged);
      await closeRun(t, run);
    });

    it("4–5. every other terminal state still holds no cursor (COMPLETED, CONTINUED, failures)", async () => {
      const t = await tenant();
      for (const [state, failure] of [["COMPLETED", null], ["CONTINUED", null], ["FAILED_TRANSIENT", "x"], ["FAILED_PERMANENT", "x"], ["FAILED_RATE_LIMITED", "x"]] as const) {
        const run = await runOf(t);
        const slice = await runningSlice(t, run);
        expect(await sqlState(finishKeepingCursor(t, slice, state, failure)), state).toMatchObject({ code: "23514", constraint: "reconciliation_slices_cursor_open" });
        await asWorker(t, (tx) => tx.execute(sql`update ingestion.reconciliation_slices set state = 'ABANDONED_BUDGET', cursor = null, cursor_issued_at = null, completed_at = now(), leased_until = null, updated_at = now() where id = ${slice}::uuid`));
        await closeRun(t, run);
      }
    });

    it("6–9. one continuation authority per (account, content): found by exact key only; another content, account or unit has none; a second park is refused", async () => {
      const t = await tenant();
      const other = await contentOf(t);
      const run = await runOf(t);
      const slice = await runningSlice(t, run);
      await finishKeepingCursor(t, slice, "ABANDONED_BUDGET");
      const lookup = (account: string, content: string) => asWorker(t, (tx) => tx.execute<{ id: string; window_start: Date; window_end: Date }>(sql`
        select id, window_start, window_end from ingestion.reconciliation_slices
         where connected_account_id = ${account}::uuid and content_item_id = ${content}::uuid and unit = 'content_interactions'
           and state = 'ABANDONED_BUDGET' and cursor is not null`)).then((r) => r.rows.map((row) => ({ id: row.id, window_start: at(row.window_start), window_end: at(row.window_end) })));
      const found = await lookup(t.account, t.content);
      expect(found.map((r) => r.id)).toEqual([slice]);
      // The continuation adopts ITS window (the original traversal), not a later run's start.
      const parked = await sliceRow(slice);
      expect([found[0]?.window_start?.getTime(), found[0]?.window_end?.getTime()]).toEqual([parked.window_start.getTime(), parked.window_end.getTime()]);
      expect(await lookup(t.account, other)).toEqual([]);
      const stranger = await tenant();
      expect(await lookup(stranger.account, t.content)).toEqual([]);
      // Another tenant's worker sees nothing of it at all (RLS).
      expect(await asWorker(stranger, (tx) => tx.execute(sql`select 1 from ingestion.reconciliation_slices where id = ${slice}::uuid`)).then((r) => r.rows)).toEqual([]);
      // A listing slice can never park a cursor (a new run: one open run per account).
      await closeRun(t, run);
      const run2 = await runOf(t, "account");
      const listing = await runningSlice(t, run2, t.content, "content_listing");
      expect(await sqlState(finishKeepingCursor(t, listing, "ABANDONED_BUDGET"))).toMatchObject({ code: "23514", constraint: "reconciliation_slices_parked" });
      await asWorker(t, (tx) => tx.execute(sql`update ingestion.reconciliation_slices set state = 'ABANDONED_BUDGET', cursor = null, cursor_issued_at = null, completed_at = now(), leased_until = null, updated_at = now() where id = ${listing}::uuid`));
      // A second parked cursor for the same content: refused (one authority), until the first is retired.
      const second = await runningSlice(t, run2);
      expect(await sqlState(finishKeepingCursor(t, second, "ABANDONED_BUDGET"))).toMatchObject({ code: "23505", constraint: "reconciliation_slices_one_parked" });
      await asWorker(t, (tx) => tx.execute(sql`update ingestion.reconciliation_slices set cursor = null, cursor_issued_at = null, updated_at = now() where id = ${slice}::uuid`));
      expect(await sliceRow(slice)).toMatchObject({ state: "ABANDONED_BUDGET", cursor: null, cursor_parked_at: null });
      await finishKeepingCursor(t, second, "ABANDONED_BUDGET");
      expect((await sliceRow(second)).cursor_parked_at).not.toBeNull();
      // A cross-account slice can't even exist (the 0018 composite FKs).
      expect(await sqlState(privileged.query(
        `insert into ingestion.reconciliation_slices (id, organization_id, workspace_id, reconciliation_run_id, connected_account_id, unit, content_item_id, sequence, state, attempt,
                                                      window_start, window_end, max_pages, created_at, updated_at)
         values ($1, $2, $3, $4, $5, 'content_interactions', $6, 0, 'PENDING', 0, now() - interval '1 day', now(), 5, now(), now())`,
        [randomUUID(), t.organizationId, t.workspaceId, run2, t.account, (await contentOf(stranger))]))).toMatchObject({ code: "23503" });
      await closeRun(t, run2);
    });

    it("parked cursors are retire-only: never replaced, never parked afresh on an already terminal slice", async () => {
      const t = await tenant();
      const run = await runOf(t);
      const slice = await runningSlice(t, run);
      await finishKeepingCursor(t, slice, "ABANDONED_BUDGET");
      expect(await sqlState(asWorker(t, (tx) => tx.execute(sql`update ingestion.reconciliation_slices set cursor = 'meta1.b3RoZXI', cursor_issued_at = now(), updated_at = now() where id = ${slice}::uuid`)))).toMatchObject({ code: "23514" });
      await asWorker(t, (tx) => tx.execute(sql`update ingestion.reconciliation_slices set cursor = null, cursor_issued_at = null, updated_at = now() where id = ${slice}::uuid`));
      expect(await sqlState(asWorker(t, (tx) => tx.execute(sql`update ingestion.reconciliation_slices set cursor = ${CURSOR}, cursor_issued_at = now(), updated_at = now() where id = ${slice}::uuid`)))).toMatchObject({ code: "23514" });
      await closeRun(t, run);
    });

    it("10. a parked cursor past the 90-minute local TTL is identifiable from its stored DB time (no wall-clock CHECK; the stamp can't be rewritten)", async () => {
      const t = await tenant();
      const run = await runOf(t);
      const slice = await runningSlice(t, run);
      await finishKeepingCursor(t, slice, "ABANDONED_BUDGET");
      const parkedAt = (await sliceRow(slice)).cursor_parked_at;
      // Even the privileged login can't rewrite the stamp of a parked cursor (the trigger keeps it).
      await privileged.query("update ingestion.reconciliation_slices set cursor_parked_at = '2000-01-01T00:00:00Z' where id = $1", [slice]);
      expect((await sliceRow(slice)).cursor_parked_at?.getTime()).toBe(parkedAt?.getTime());
      const staleAt = (reference: Date) => asWorker(t, (tx) => tx.execute<{ id: string }>(sql`
        select id from ingestion.reconciliation_slices where connected_account_id = ${t.account}::uuid and state = 'ABANDONED_BUDGET' and cursor is not null
           and cursor_parked_at <= ${reference}::timestamptz - interval '90 minutes'`)).then((r) => r.rows.map((row) => row.id));
      expect(await staleAt(new Date((parkedAt?.getTime() ?? 0) + 89 * 60_000))).toEqual([]);
      expect(await staleAt(new Date((parkedAt?.getTime() ?? 0) + 91 * 60_000))).toEqual([slice]);
      await closeRun(t, run);
    });

    it("11–12. no cursor reaches the outbox, a task table or a mark; existing slices stayed valid (constraints validated)", async () => {
      const cursorColumns = await oracle<{ table: string; column: string }>(
        `select table_schema || '.' || table_name as table, column_name as column from information_schema.columns
          where column_name like '%cursor%' and table_schema not in ('pg_catalog', 'information_schema') order by 1, 2`);
      expect(cursorColumns).toEqual([
        { table: "ingestion.reconciliation_slices", column: "cursor" },
        { table: "ingestion.reconciliation_slices", column: "cursor_issued_at" },
        { table: "ingestion.reconciliation_slices", column: "cursor_parked_at" },
      ]);
      expect(await count("select count(*)::int as n from system.outbox where subject_ids::text like '%meta1.%' or dispatch_key like '%meta1.%' or correlation_id like '%meta1.%'")).toBe(0);
      const validated = await oracle<{ conname: string; convalidated: boolean }>(
        "select conname, convalidated from pg_constraint where conname in ('reconciliation_slices_cursor_open', 'reconciliation_slices_parked', 'signal_marks_kind_check', 'signal_marks_target', 'signal_marks_confirmation') order by 1");
      expect(validated).toEqual([
        { conname: "reconciliation_slices_cursor_open", convalidated: true },
        { conname: "reconciliation_slices_parked", convalidated: true },
        { conname: "signal_marks_confirmation", convalidated: true },
        { conname: "signal_marks_kind_check", convalidated: true },
        { conname: "signal_marks_target", convalidated: true },
      ]);
      expect(await oracle("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'reconciliation_slices_cursor_open'"))
        .toEqual([{ def: "CHECK (((cursor IS NULL) OR (state = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'ABANDONED_BUDGET'::text]))))" }]);
      const index = await one<{ def: string }>("select pg_get_indexdef(indexrelid) as def from pg_index where indexrelid = 'ingestion.reconciliation_slices_one_parked'::regclass");
      expect(index.def).toMatch(/UNIQUE INDEX reconciliation_slices_one_parked ON ingestion\.reconciliation_slices USING btree \(workspace_id, connected_account_id, content_item_id\) WHERE \(\(state = 'ABANDONED_BUDGET'::text\) AND \(cursor IS NOT NULL\)\)/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("B. confirm marks", () => {
    it("13–15, 33. one confirm mark per canonical interaction: repeated (100) signals coalesce, last signal monotonic, first kept", async () => {
      const t = await tenant();
      const id = await confirmSignal(t);
      const first = await markOf(t);
      for (let i = 0; i < 99; i += 1) expect(await confirmSignal(t)).toBe(id);
      const after = await markOf(t);
      expect(after).toMatchObject({ id, signal_count: 100, dispatch_generation: 0, read_started_at: null, confirmed_through_at: null });
      expect(after?.first_signal_at.getTime()).toBe(first?.first_signal_at.getTime());
      expect(after?.last_signal_at.getTime()).toBeGreaterThanOrEqual(first?.last_signal_at.getTime() ?? 0);
      expect(await count("select count(*)::int as n from ingestion.signal_marks where workspace_id = $1 and kind = 'confirm'", [t.workspaceId])).toBe(1);
      // A second interaction of the SAME content has its own mark (the pending key includes the interaction).
      const sibling = await interactionOf(t, t.content);
      expect(await confirmSignal(t, sibling)).not.toBe(id);
      expect(await count("select count(*)::int as n from ingestion.signal_marks where workspace_id = $1 and kind = 'confirm'", [t.workspaceId])).toBe(2);
    });

    it("16–19. the target is canonical and of this account; shapes are closed; account and relist keep their 0022 shapes", async () => {
      const t = await tenant();
      const stranger = await tenant();
      // Another account's interaction (its content belongs to that account): the content FK refuses.
      expect(await sqlState(confirmSignal(t, stranger.interaction, stranger.content))).toMatchObject({ code: "23503" });
      // An interaction of a different content than the one named: the interaction FK refuses.
      const otherContent = await contentOf(t);
      expect(await sqlState(confirmSignal(t, t.interaction, otherContent))).toMatchObject({ code: "23503", constraint: "signal_marks_confirm_interaction" });
      // Another workspace: the bound worker cannot write it (RLS) — and the FK would not find it anyway.
      expect(await sqlState(asWorker(t, (tx) => tx.execute(sql`
        insert into ingestion.signal_marks (id, organization_id, workspace_id, connected_account_id, kind, content_item_id, interaction_id, first_signal_at, last_signal_at, signal_count, expires_at, created_at, updated_at)
        values (${randomUUID()}::uuid, ${stranger.organizationId}::uuid, ${stranger.workspaceId}::uuid, ${stranger.account}::uuid, 'confirm', ${stranger.content}::uuid, ${stranger.interaction}::uuid,
                now(), now(), 1, now() + interval '7 days', now(), now())`)))).toMatchObject({ code: "42501" });
      for (const [kind, content, interaction] of [["confirm", t.content, null], ["confirm", null, t.interaction], ["relist", t.content, t.interaction], ["account", t.content, null], ["account", null, t.interaction], ["unknown", null, null]] as const) {
        expect(await sqlState(insertMark(t, kind, content, interaction)), `${kind}/${String(content)}/${String(interaction)}`).toMatchObject({ code: "23514" });
      }
      await insertMark(t, "account", null, null);
      await insertMark(t, "relist", t.content, null);
      expect((await oracle<{ kind: string }>("select kind from ingestion.signal_marks where workspace_id = $1 order by kind", [t.workspaceId])).map((r) => r.kind)).toEqual(["account", "relist"]);
      // Their uniqueness is exactly 0022's: a second account or relist mark coalesces.
      await insertMark(t, "account", null, null);
      await insertMark(t, "relist", t.content, null);
      expect(await count("select count(*)::int as n from ingestion.signal_marks where workspace_id = $1", [t.workspaceId])).toBe(2);
    });

    it("20–22, 31–32, 36. the claim is immediate the first time, starts a 5-minute DB cooldown, and has one winner under concurrency", async () => {
      const t = await tenant();
      await confirmSignal(t);
      const results = await Promise.all([claim(t), claim(t), claim(t)]);
      const winners = results.filter((r) => r?.outcome === "claimed");
      expect(winners).toHaveLength(1);
      expect(results.filter((r) => r?.outcome === "cooling_down")).toHaveLength(2);
      expect(winners[0]?.claimed_generation).toBe(1);
      const mark = await markOf(t);
      expect(mark?.dispatch_generation).toBe(1);
      const now = (await one<{ now: Date }>("select now() as now")).now;
      // deferred_until = the claim's DB time + 5 minutes (within this test's DB clock window).
      expect(Math.abs((mark?.deferred_until?.getTime() ?? 0) - (now.getTime() + 5 * 60_000))).toBeLessThan(5_000);
      expect(winners[0]?.due_at?.getTime()).toBe(mark?.deferred_until?.getTime());
      expect(await claim(t)).toMatchObject({ outcome: "cooling_down" });
      expect((await markOf(t))?.dispatch_generation).toBe(1);
    });

    it("22–27, 34–35. read start is DB time; only a completed read confirms; caught-up vs trailing are distinguishable after the cooldown", async () => {
      const t = await tenant();
      await confirmSignal(t);
      expect(await claim(t)).toMatchObject({ outcome: "claimed", claimed_generation: 1 });
      const before = (await one<{ now: Date }>("select now() as now")).now;
      const started = await begin(t);
      expect(started?.outcome).toBe("started");
      expect(started?.started_at?.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect((await markOf(t))?.read_started_at?.getTime()).toBe(started?.started_at?.getTime());
      // 24: a read that never completes (failure, ambiguity, crash) leaves confirmed_through_at unchanged.
      expect((await markOf(t))?.confirmed_through_at).toBeNull();
      // 25: a signal after the read began stays distinguishable.
      await confirmSignal(t);
      const mid = await markOf(t);
      expect((mid?.last_signal_at.getTime() ?? 0)).toBeGreaterThanOrEqual(started?.started_at?.getTime() ?? Infinity);
      // 23: success confirms through the read's start.
      expect(await complete(t, started?.started_at ?? null)).toMatchObject({ outcome: "confirmed" });
      expect((await markOf(t))?.confirmed_through_at?.getTime()).toBe(started?.started_at?.getTime());
      // 35: inside the cooldown, the same mark keeps coalescing and nothing is claimed.
      await confirmSignal(t);
      expect(await claim(t)).toMatchObject({ outcome: "cooling_down" });
      // 27: after the cooldown, the newer signal needs exactly one trailing read.
      await cooldownElapsed(mid?.id ?? "");
      expect(await claim(t)).toMatchObject({ outcome: "claimed", claimed_generation: 2 });
      const second = await begin(t);
      expect(await complete(t, second?.started_at ?? null)).toMatchObject({ outcome: "confirmed" });
      // 26, 34: no newer signal → after the cooldown the mark is caught up (no provider call; the caller deletes it).
      await cooldownElapsed(mid?.id ?? "");
      expect(await claim(t)).toMatchObject({ outcome: "caught_up", signal_mark_id: mid?.id });
      expect((await markOf(t))?.dispatch_generation).toBe(2);
    });

    it("28. confirmation columns move only through the definers; a forged or out-of-order completion is refused", async () => {
      const t = await tenant();
      const id = await confirmSignal(t);
      for (const column of ["read_started_at", "confirmed_through_at", "dispatch_generation", "interaction_id", "kind", "content_item_id"]) {
        const value = column === "dispatch_generation" ? sql`9` : column === "kind" ? sql`'relist'` : column.endsWith("_id") ? sql`${randomUUID()}::uuid` : sql`now()`;
        expect(await sqlState(asWorker(t, (tx) => tx.execute(sql`update ingestion.signal_marks set ${sql.raw(column)} = ${value} where id = ${id}::uuid`))), column).toMatchObject({ code: "42501" });
      }
      // A mark cannot be inserted already claimed or confirmed.
      const stranger = await tenant();
      expect(await sqlState(asWorker(stranger, (tx) => tx.execute(sql`
        insert into ingestion.signal_marks (id, organization_id, workspace_id, connected_account_id, kind, content_item_id, interaction_id, first_signal_at, last_signal_at, signal_count,
                                            read_started_at, confirmed_through_at, expires_at, created_at, updated_at)
        values (${randomUUID()}::uuid, ${stranger.organizationId}::uuid, ${stranger.workspaceId}::uuid, ${stranger.account}::uuid, 'confirm', ${stranger.content}::uuid, ${stranger.interaction}::uuid,
                now(), now(), 1, now(), now(), now() + interval '7 days', now(), now())`)))).toMatchObject({ code: "23514" });
      // Completion without a read, or claiming beyond the recorded read start: invalid, nothing confirmed.
      expect(await complete(t, new Date())).toMatchObject({ outcome: "invalid" });
      await claim(t);
      const started = await begin(t);
      expect(await complete(t, new Date((started?.started_at?.getTime() ?? 0) + 60_000))).toMatchObject({ outcome: "invalid" });
      expect((await markOf(t))?.confirmed_through_at).toBeNull();
      // An earlier read start is only more conservative; confirmed_through never regresses.
      expect(await complete(t, started?.started_at ?? null)).toMatchObject({ outcome: "confirmed" });
      expect(await complete(t, new Date((started?.started_at?.getTime() ?? 0) - 60_000))).toMatchObject({ outcome: "confirmed" });
      expect((await markOf(t))?.confirmed_through_at?.getTime()).toBe(started?.started_at?.getTime());
      // Nothing for an interaction without a pending confirm mark.
      const quiet = await interactionOf(t, t.content);
      expect(await claim(t, quiet)).toMatchObject({ outcome: "not_found" });
      expect(await begin(t, quiet)).toMatchObject({ outcome: "not_found" });
      expect(await complete(t, new Date(), quiet)).toMatchObject({ outcome: "not_found" });
      // The bound workspace only: another tenant's worker sees no such mark.
      expect(await claim(stranger, t.interaction)).toMatchObject({ outcome: "not_found" });
    });

    it("29–30. members neither read nor write marks nor call the definers; marks hold canonical ids and times only", async () => {
      const t = await tenant();
      await confirmSignal(t);
      const member = <T>(work: (tx: DatabaseTransaction) => Promise<T>) => withUserScope(web, { sub: t.owner, role: "authenticated" }, t.workspaceId, work);
      expect(await sqlState(member((tx) => tx.execute(sql`select 1 from ingestion.signal_marks`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(member((tx) => tx.execute(sql`select * from ingestion.claim_signal_confirmation(${t.account}::uuid, ${t.interaction}::uuid)`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(member((tx) => tx.execute(sql`select * from ingestion.begin_signal_confirmation_read(${t.account}::uuid, ${t.interaction}::uuid)`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(member((tx) => tx.execute(sql`select * from ingestion.complete_signal_confirmation_read(${t.account}::uuid, ${t.interaction}::uuid, now())`)))).toMatchObject({ code: "42501" });
      // The system login can't call the worker definers either.
      expect(await sqlState(withSystemScope(system, (tx) => tx.execute(sql`select * from ingestion.claim_signal_confirmation(${t.account}::uuid, ${t.interaction}::uuid)`)))).toMatchObject({ code: "42501" });
      const columns = (await oracle<{ column_name: string; data_type: string }>(
        "select column_name, data_type from information_schema.columns where table_schema = 'ingestion' and table_name = 'signal_marks' order by ordinal_position")).map((c) => `${c.column_name}:${c.data_type}`);
      expect(columns).toEqual([
        "id:uuid", "organization_id:uuid", "workspace_id:uuid", "connected_account_id:uuid", "kind:text", "content_item_id:uuid", "first_signal_at:timestamp with time zone",
        "last_signal_at:timestamp with time zone", "signal_count:integer", "deferred_until:timestamp with time zone", "dispatch_generation:integer", "requested_run_id:uuid",
        "expires_at:timestamp with time zone", "created_at:timestamp with time zone", "updated_at:timestamp with time zone", "interaction_id:uuid",
        "read_started_at:timestamp with time zone", "confirmed_through_at:timestamp with time zone",
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("C. system-wide expiry", () => {
    it("38–42, 48–52. every expired mark goes — ACTIVE, INACTIVE, removed or unlinked account, any kind — fresh ones stay; nothing canonical moves", async () => {
      const active = await tenant();
      const inactive = await tenant();
      const removed = await tenant();
      const unlinked = await tenant();
      for (const t of [active, inactive, removed, unlinked]) {
        await insertMark(t, "account", null, null, { expires: "-1 minute", first: "8 days" });
        await insertMark(t, "relist", t.content, null, { expires: "-1 minute", first: "8 days" });
        await insertMark(t, "confirm", t.content, t.interaction, { expires: "-1 minute", first: "8 days" });
      }
      // A fresh mark of an inactive account is retained until its own expiry.
      const fresh = await interactionOf(inactive, inactive.content);
      await insertMark(inactive, "confirm", inactive.content, fresh);
      for (const [t, reason] of [[inactive, "UNLINKED"], [removed, "REMOVED"], [unlinked, "DISCONNECTED"]] as const) {
        await privileged.query("update connections.connected_accounts set status = 'INACTIVE', deactivated_at = now(), deactivation_reason = $2, updated_at = now() where id = $1", [t.account, reason]);
      }
      const orgs = [active, inactive, removed, unlinked].map((t) => t.organizationId);
      const before = await canonical(orgs);
      let totals = { expired: 0, account_marks: 0, relist_marks: 0, confirm_marks: 0 };
      for (let i = 0; i < 20; i += 1) {
        const result = await expire(5000);
        if (result === undefined || result.expired === 0) break;
        totals = { expired: totals.expired + result.expired, account_marks: totals.account_marks + result.account_marks, relist_marks: totals.relist_marks + result.relist_marks, confirm_marks: totals.confirm_marks + result.confirm_marks };
      }
      expect(await count("select count(*)::int as n from ingestion.signal_marks where organization_id = any($1::uuid[]) and expires_at <= now()", [orgs])).toBe(0);
      expect(totals.expired).toBeGreaterThanOrEqual(12);
      expect(Math.min(totals.account_marks, totals.relist_marks, totals.confirm_marks)).toBeGreaterThanOrEqual(4);
      expect((await oracle<{ interaction_id: string }>("select interaction_id from ingestion.signal_marks where organization_id = any($1::uuid[])", [orgs])).map((r) => r.interaction_id)).toEqual([fresh]);
      expect(await canonical(orgs)).toEqual(before);
    });

    it("43–44. bounded batches (1..5000), and concurrent calls never process a row twice", async () => {
      const t = await tenant();
      const interactions = await Promise.all(Array.from({ length: 8 }, () => interactionOf(t, t.content)));
      for (const id of interactions) await insertMark(t, "confirm", t.content, id, { expires: "-1 minute", first: "8 days" });
      for (const limit of [0, 5001]) expect(await sqlState(expire(limit)), String(limit)).toMatchObject({ code: "22023" });
      const first = await expire(3);
      expect(first?.expired).toBeLessThanOrEqual(3);
      const [a, b] = await Promise.all([expire(4), expire(4)]);
      let rest = 0;
      for (let i = 0; i < 10; i += 1) {
        const more = await expire(4);
        rest += more?.expired ?? 0;
        if ((more?.expired ?? 0) === 0) break;
      }
      expect(await count("select count(*)::int as n from ingestion.signal_marks where workspace_id = $1", [t.workspaceId])).toBe(0);
      // Every deleted row was counted once (other suites' expired rows may share the batches: ≥ 8, never a double).
      expect((first?.expired ?? 0) + (a?.expired ?? 0) + (b?.expired ?? 0) + rest).toBeGreaterThanOrEqual(8);
    });

    it("45–47. members and workers cannot invoke the expiry; app_system cannot DELETE directly; an unexpired row is out of the policy's reach", async () => {
      const t = await tenant();
      const id = await insertMark(t, "account", null, null);
      expect(await sqlState(withUserScope(web, { sub: t.owner, role: "authenticated" }, t.workspaceId, (tx) => tx.execute(sql`select * from system.expire_signal_marks(${10})`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(asWorker(t, (tx) => tx.execute(sql`select * from system.expire_signal_marks(${10})`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(withSystemScope(system, (tx) => tx.execute(sql`delete from ingestion.signal_marks where id = ${id}::uuid`)))).toMatchObject({ code: "42501" });
      await expire(5000);
      expect(await count("select count(*)::int as n from ingestion.signal_marks where id = $1", [id])).toBe(1);
      const policy = await one<{ roles: string[]; qual: string }>(
        "select array(select pg_get_userbyid(r)::text from unnest(polroles) r) as roles, pg_get_expr(polqual, polrelid) as qual from pg_policy where polname = 'owner_expiry_delete' and polrelid = 'ingestion.signal_marks'::regclass");
      expect(policy.roles).toEqual(["app_owner"]);
      expect(policy.qual).toMatch(/current_workspace\(\) AS current_workspace\) IS NULL/);
      expect(policy.qual).toMatch(/pg_has_role\(SESSION_USER, 'app_system'::name, 'MEMBER'::text\)/);
      expect(policy.qual).toMatch(/expires_at <= statement_timestamp\(\)/);
      expect((await oracle<{ polname: string }>("select polname from pg_policy where polrelid = 'ingestion.signal_marks'::regclass and polcmd = 'd' order by 1")).map((p) => p.polname))
        .toEqual(["owner_expiry_delete", "worker_delete"]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("0022 / 0019 behavior that must not move", () => {
    it("53–55. the due-mark dispatcher stays bounded and dispatches account, relist and confirm marks the same way (no provider work)", async () => {
      const t = await tenant();
      for (const limit of [0, 501]) expect(await sqlState(withSystemScope(system, (tx) => tx.execute(sql`select * from system.dispatch_due_signal_marks(${limit})`))), String(limit)).toMatchObject({ code: "22023" });
      const marks = [await insertMark(t, "account", null, null), await insertMark(t, "relist", t.content, null), await confirmSignal(t)];
      await privileged.query("update ingestion.signal_marks set deferred_until = now() - interval '1 second' where id = any($1::uuid[])", [marks]);
      for (let i = 0; i < 10 && (await count("select count(*)::int as n from ingestion.signal_marks where id = any($1::uuid[]) and deferred_until is not null", [marks])) > 0; i += 1) {
        await withSystemScope(system, (tx) => tx.execute(sql`select * from system.dispatch_due_signal_marks(${500})`));
      }
      const rows = await oracle<{ topic: string; subject_ids: Record<string, string> }>("select topic, subject_ids from system.outbox where workspace_id = $1 order by created_at", [t.workspaceId]);
      const signals = rows.filter((r) => r.topic === "ingestion.process_signals");
      expect(signals).toHaveLength(3);
      for (const row of signals) expect(Object.keys(row.subject_ids)).toEqual(["connected_account_id"]);
      // No confirmation is requested by the system itself: the tenant task decides.
      expect(rows.filter((r) => r.topic === "ingestion.confirm_interaction")).toEqual([]);
    });

    it("56–59. direct process_signals appends stay 42501; the request boundary admits account and relist only; web Sync is account/40; signal 10 valid", async () => {
      const t = await tenant();
      const append = (tx: DatabaseTransaction) => tx.execute(sql`
        insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type, initiator_user_id, dispatch_key, status, created_at)
        values (${randomUUID()}::uuid, 'ingestion.process_signals', ${t.organizationId}::uuid, ${t.workspaceId}::uuid, jsonb_build_object('connected_account_id', ${t.account}::text),
                'f4b-direct-append', 'system', null, ${`ingestion.process_signals:direct:${randomUUID()}`}, 'PENDING', now())`);
      expect(await sqlState(asWorker(t, append))).toMatchObject({ code: "42501" });
      expect(await sqlState(withUserScope(web, { sub: t.owner, role: "authenticated" }, t.workspaceId, append))).toMatchObject({ code: "42501" });
      expect(await sqlState(asWorker(t, (tx) => tx.execute(sql`select * from ingestion.request_reconciliation(${t.account}::uuid, ${"f4b-confirm-plan"}, now(), ${JSON.stringify({ plan: "confirm" })}::jsonb)`)))).toMatchObject({ code: "22023" });
      const member = await withUserScope(web, { sub: t.owner, role: "authenticated" }, t.workspaceId, (tx) => tx.execute<{ outcome: string; reconciliation_run_id: string }>(sql`
        select outcome, reconciliation_run_id from ingestion.request_reconciliation(${t.account}::uuid, ${`f4b-web-${randomUUID()}`}, null, null)`));
      expect(member.rows[0]?.outcome).toBe("requested");
      expect(await one("select plan, max_operations, initiator_type from ingestion.reconciliation_runs where id = $1", [member.rows[0]?.reconciliation_run_id]))
        .toEqual({ plan: "account", max_operations: 40, initiator_type: "user" });
      await privileged.query("update ingestion.reconciliation_runs set state = 'SKIPPED_UNAVAILABLE', failure_class = 'test', completed_at = now(), updated_at = now() where id = $1", [member.rows[0]?.reconciliation_run_id]);
      const signal = await runOf(t, "relist");
      expect(await one("select plan, max_operations, initiator_type from ingestion.reconciliation_runs where id = $1", [signal])).toEqual({ plan: "relist", max_operations: 10, initiator_type: "system" });
      await closeRun(t, signal);
    });
  });

  /** A PENDING slice left by a test is closed the runtime's way (cursor-free). */
  async function closeRunPendingSlice(t: Tenant, slice: string): Promise<void> {
    await asWorker(t, (tx) => tx.execute(sql`update ingestion.reconciliation_slices set state = 'ABANDONED_BUDGET', completed_at = now(), updated_at = now() where id = ${slice}::uuid`));
  }
}
