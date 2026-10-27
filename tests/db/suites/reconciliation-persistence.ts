/**
 * Step H6-C2 — the reconciliation runtime persistence of migration 0018 on the real database, through the runtime roles:
 * the job runtime (worker login → app_worker, one sealed workspace) and members (web login → authenticated). Only
 * tenants, connections, accounts and content rows are bootstrapped (privileged or worker); no job runs, no provider is
 * called. Synthetic data only.
 *
 *   runs        closed states, lifecycle/time/budget CHECKs, one open run per account, terminal is final, counters
 *   slices      closed states, unit ↔ content, cursor (≤ 2048, paired with its time, only while open), lease ↔ attempt,
 *               uniqueness, one RUNNING slice per account, terminal is final, counters never decrease
 *   watermarks  one per scope, epoch fixed, synced-through never regresses, composite integrity
 *   conflicts   append-only, ids and closed classes only (no THREAD_ANCHOR_CONFLICT)
 *   widenings   coverage admits TRAVERSAL_INCOMPLETE; audit admits connected_account.reconciliation_requested
 *   tenancy     RLS by workspace and role (runs member-readable, the rest worker-only), cross-workspace FKs refused
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCorrelationId, type CorrelationId } from "@/domain/correlation";
import { parseInstant } from "@/domain/instant";
import { createPostgresCoverageStore } from "@/modules/coverage/persistence";
import { coverageForSlice } from "@/modules/coverage";
import { AUDIT_ACTIONS } from "@/modules/audit";
import { INGESTION_CONFLICT_CLASSES, RECONCILIATION_RUN_STATES, RECONCILIATION_SLICE_STATES, defaultBudgetSnapshot } from "@/modules/ingestion";
import { withUserScope, withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";
import { sqlState } from "./helpers";

interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly owner: string;
  readonly guest: string;
  readonly account: string;
  readonly otherAccount: string;
  readonly content: string;
  readonly otherContent: string;
}

const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(what);
  return value;
};
const correlation = (): CorrelationId => must(parseCorrelationId(`h6c2-${randomUUID()}`), "correlation");

export function defineReconciliationPersistenceSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  const organizations: string[] = [];
  const budget = defaultBudgetSnapshot();

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const asWorker = <T>(t: Tenant, work: (tx: DatabaseTransaction) => Promise<T>) => withWorkspaceJobScope(worker, t.workspaceId, work);
  const asUser = <T>(t: Tenant, user: string, work: (tx: DatabaseTransaction) => Promise<T>) => withUserScope(web, { sub: user, role: "authenticated" }, t.workspaceId, work);
  const code = async (promise: Promise<unknown>): Promise<string> => (await sqlState(promise)).code;

  /** An organization + workspace with an owner and a guest, an ACTIVE Meta connection, two accounts and one content row each. */
  const tenant = async (): Promise<Tenant> => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const owner = randomUUID();
    const guest = randomUUID();
    organizations.push(organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Reconciliation', now())", [organizationId]);
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'MONITOR_ONLY', now())", [workspaceId, organizationId]);
    for (const [user, orgRole, role] of [[owner, "OWNER", "OWNER"], [guest, "MEMBER", "CLIENT_GUEST"]] as const) {
      await privileged.query("insert into tenancy.organization_memberships values ($1, $2, $3, now())", [organizationId, user, orgRole]);
      await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, $4, '{}', now())", [organizationId, workspaceId, user, role]);
    }
    const connection = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`, [connection, organizationId, workspaceId, owner]);
    const accounts: string[] = [];
    const contents: string[] = [];
    for (const [asset, platform] of [["fb_page_aurora", "facebook"], ["ig_acct_aurora", "instagram"]] as const) {
      const discovered = randomUUID();
      await privileged.query(
        `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, 'content_bearing', 'Synthetic', now(), now(), now())`, [discovered, organizationId, workspaceId, connection, platform, asset]);
      const account = randomUUID();
      await privileged.query(
        `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
         select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`,
        [account, discovered]);
      const content = randomUUID();
      await privileged.query(
        `insert into content.content_items (id, organization_id, workspace_id, platform, connected_account_id, provider_asset_id, provider_content_id, content_kind, reported_source,
           source_state, first_observed_at, latest_observed_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, 'post', 'unknown', 'available', now(), now(), now(), now())`,
        [content, organizationId, workspaceId, platform, account, asset, `${asset}_post_${randomUUID().slice(0, 8)}`]);
      accounts.push(account);
      contents.push(content);
    }
    return { organizationId, workspaceId, owner, guest, account: must(accounts[0], "a"), otherAccount: must(accounts[1], "b"), content: must(contents[0], "c"), otherContent: must(contents[1], "d") };
  };

  // ── row builders (through the worker) ─────────────────────────────────────────────────────────────────────
  type RunPatch = Partial<Record<"state" | "started_at" | "completed_at" | "failure_class" | "initiator_type" | "initiator_user_id" | "budget_listing_pages_per_slice"
    | "budget_interaction_pages_per_content" | "budget_overlap_seconds" | "operations_used" | "connected_account_id" | "max_operations", string | number | null>>;
  const insertRun = (t: Tenant, patch: RunPatch = {}, id = randomUUID()) => {
    const v = {
      state: "REQUESTED", started_at: null, completed_at: null, failure_class: null, initiator_type: "user", initiator_user_id: t.owner,
      budget_listing_pages_per_slice: budget.listingPagesPerSlice, budget_interaction_pages_per_content: budget.interactionPagesPerContent,
      budget_overlap_seconds: budget.overlapSeconds, operations_used: 0, connected_account_id: t.account, max_operations: budget.maxOperations, ...patch,
    };
    return asWorker(t, (tx) => tx.execute(sql`insert into ingestion.reconciliation_runs (id, organization_id, workspace_id, connected_account_id, state, initiator_type, initiator_user_id,
        correlation_id, requested_at, started_at, completed_at, budget_listing_pages_per_slice, budget_interaction_pages_per_slice, budget_continuations_per_content,
        budget_interaction_pages_per_content, budget_content_items, budget_overlap_seconds, max_operations, operations_used, failure_class, created_at, updated_at)
      values (${id}, ${t.organizationId}, ${t.workspaceId}, ${v.connected_account_id}, ${v.state}, ${v.initiator_type}, ${v.initiator_user_id}, ${correlation()},
        now() - interval '1 hour', ${v.started_at}::timestamptz, ${v.completed_at}::timestamptz, ${v.budget_listing_pages_per_slice}, ${budget.interactionPagesPerSlice},
        ${budget.continuationsPerContent}, ${v.budget_interaction_pages_per_content}, ${budget.contentItems}, ${v.budget_overlap_seconds}, ${v.max_operations}, ${v.operations_used},
        ${v.failure_class}, now(), now())`)).then(() => id);
  };
  type SlicePatch = Partial<Record<"unit" | "content_item_id" | "sequence" | "state" | "attempt" | "leased_until" | "cursor" | "cursor_issued_at" | "pages_read" | "max_pages"
    | "operations_used" | "conflict_count" | "failure_class" | "retry_not_before" | "completed_at" | "window_end" | "connected_account_id", string | number | null>>;
  const insertSlice = (t: Tenant, run: string, patch: SlicePatch = {}, id = randomUUID()) => {
    const v = {
      unit: "content_listing", content_item_id: null, sequence: 0, state: "PENDING", attempt: 0, leased_until: null, cursor: null, cursor_issued_at: null, pages_read: 0,
      max_pages: 1, operations_used: 0, conflict_count: 0, failure_class: null, retry_not_before: null, completed_at: null, window_end: "now()", connected_account_id: t.account, ...patch,
    };
    return asWorker(t, (tx) => tx.execute(sql`insert into ingestion.reconciliation_slices (id, organization_id, workspace_id, reconciliation_run_id, connected_account_id, unit,
        content_item_id, sequence, state, attempt, leased_until, cursor, cursor_issued_at, window_start, window_end, max_pages, pages_read, operations_used, conflict_count,
        failure_class, retry_not_before, completed_at, created_at, updated_at)
      values (${id}, ${t.organizationId}, ${t.workspaceId}, ${run}, ${v.connected_account_id}, ${v.unit}, ${v.content_item_id}, ${v.sequence}, ${v.state}, ${v.attempt},
        ${v.leased_until}::timestamptz, ${v.cursor}, ${v.cursor_issued_at}::timestamptz, now() - interval '1 day',
        coalesce(${v.window_end === "now()" ? null : v.window_end}::timestamptz, now()), ${v.max_pages}, ${v.pages_read}, ${v.operations_used}, ${v.conflict_count},
        ${v.failure_class}, ${v.retry_not_before}::timestamptz, ${v.completed_at}::timestamptz, now() - interval '1 hour', now())`)).then(() => id);
  };
  const updateSlice = (t: Tenant, id: string, set: ReturnType<typeof sql>) => asWorker(t, (tx) => tx.execute(sql`update ingestion.reconciliation_slices set ${set} where id = ${id}`));
  const updateRun = (t: Tenant, id: string, set: ReturnType<typeof sql>) => asWorker(t, (tx) => tx.execute(sql`update ingestion.reconciliation_runs set ${set} where id = ${id}`));
  const insertWatermark = (t: Tenant, patch: Partial<Record<"content_item_id" | "connected_account_id" | "synced_through" | "last_reconciliation_run_id" | "consecutive_failures", string | number | null>> = {}) => {
    const v = { content_item_id: t.content, connected_account_id: t.account, synced_through: null, last_reconciliation_run_id: null, consecutive_failures: 0, ...patch };
    return asWorker(t, (tx) => tx.execute(sql`insert into ingestion.reconciliation_watermarks (organization_id, workspace_id, connected_account_id, content_item_id, capability, content_kind,
        source, epoch_at, synced_through, latest_created_at, last_reconciliation_run_id, consecutive_failures, retry_not_before, created_at, updated_at)
      values (${t.organizationId}, ${t.workspaceId}, ${v.connected_account_id}, ${v.content_item_id}, 'read_interactions', 'post', 'unknown', now() - interval '2 days',
        ${v.synced_through}::timestamptz, null, ${v.last_reconciliation_run_id}, ${v.consecutive_failures}, null, now(), now())`));
  };

  beforeAll(() => {
    const target = getTarget();
    privileged = privilegedPool(target);
    web = runtimeDatabase(target, "web");
    worker = runtimeDatabase(target, "worker");
  });
  afterAll(async () => {
    await Promise.all([web.end(), worker.end()]);
    await cleanupWorld(privileged, organizations);
    await privileged.end();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("reconciliation runs", () => {
    let t: Tenant;
    beforeAll(async () => {
      t = await tenant();
    });

    it("1. the closed states and the lifecycle, time, initiator, failure and budget checks hold; the approved default snapshot fits", async () => {
      const states = await oracle<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'reconciliation_runs_state_check'");
      expect([...(states[0]?.def ?? "").matchAll(/'([^']+)'::text/g)].map((m) => m[1])).toEqual([...RECONCILIATION_RUN_STATES]);
      const ok = await insertRun(t);
      await updateRun(t, ok, sql`state = 'COMPLETED', started_at = now() - interval '30 minutes', completed_at = now(), updated_at = now()`);
      for (const patch of [
        { state: "WAITING" },
        { state: "REQUESTED", started_at: new Date().toISOString() },
        { state: "RUNNING" },
        { state: "COMPLETED", started_at: new Date().toISOString() },
        { state: "FAILED", started_at: new Date().toISOString(), completed_at: new Date().toISOString() },
        { state: "COMPLETED", started_at: new Date().toISOString(), completed_at: new Date().toISOString(), failure_class: "provider_failure" },
        { state: "SKIPPED_UNAVAILABLE", completed_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), failure_class: "profile_stale" },
        { initiator_type: "user", initiator_user_id: null },
        { initiator_type: "system", initiator_user_id: t.owner },
        { budget_listing_pages_per_slice: 11 },
        { budget_interaction_pages_per_content: 14 },
        { budget_overlap_seconds: 604_801 },
        { operations_used: -1 },
      ] as const) {
        expect(await code(insertRun(t, patch)), JSON.stringify(patch)).toBe("23514");
      }
      expect(await code(insertRun(t, { state: "COMPLETED", started_at: "not-a-time" }))).toBe("22007");
      // The stored snapshot is the approved defaults (D-C3, D-C4).
      expect(await oracle("select budget_listing_pages_per_slice, budget_interaction_pages_per_slice, budget_continuations_per_content, budget_interaction_pages_per_content, budget_content_items, budget_overlap_seconds from ingestion.reconciliation_runs where id = $1", [ok]))
        .toEqual([{ budget_listing_pages_per_slice: 1, budget_interaction_pages_per_slice: 5, budget_continuations_per_content: 2, budget_interaction_pages_per_content: 15, budget_content_items: 10, budget_overlap_seconds: 86_400 }]);
    });

    it("2. at most one open (REQUESTED / RUNNING) run per account; a finished run never reopens and its counters never decrease", async () => {
      const first = await insertRun(t, {}, randomUUID());
      expect(await sqlState(insertRun(t))).toMatchObject({ code: "23505", constraint: "reconciliation_runs_one_open" });
      // Another account is independent.
      await insertRun(t, { connected_account_id: t.otherAccount });
      await updateRun(t, first, sql`state = 'RUNNING', started_at = now(), updated_at = now()`);
      expect(await sqlState(insertRun(t))).toMatchObject({ code: "23505", constraint: "reconciliation_runs_one_open" });
      await updateRun(t, first, sql`operations_used = 3, pages_used = 2, updated_at = now()`);
      expect(await code(updateRun(t, first, sql`operations_used = 2`))).toBe("23514");
      await updateRun(t, first, sql`state = 'PARTIAL', completed_at = now(), updated_at = now()`);
      const next = await insertRun(t);
      expect(next).toBeDefined();
      expect(await code(updateRun(t, first, sql`state = 'RUNNING', completed_at = null`))).toBe("23514");
      expect(await code(updateRun(t, first, sql`state = 'COMPLETED'`))).toBe("23514");
      // Identity, budget and request columns are not updatable at all.
      for (const set of [sql`connected_account_id = ${t.otherAccount}`, sql`budget_content_items = 99`, sql`requested_at = now()`, sql`correlation_id = 'h6c2-rewritten-0001'`]) {
        expect(await code(updateRun(t, next, set))).toBe("42501");
      }
      expect(await code(asWorker(t, (tx) => tx.execute(sql`delete from ingestion.reconciliation_runs where id = ${next}`)))).toBe("42501");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("reconciliation slices", () => {
    let t: Tenant;
    let run: string;
    beforeAll(async () => {
      t = await tenant();
      run = await insertRun(t, { state: "RUNNING", started_at: new Date().toISOString() });
    });

    it("3. the closed states, lease ↔ attempt, terminal ↔ completion, failure, pages and window checks hold", async () => {
      const states = await oracle<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'reconciliation_slices_state_check'");
      expect([...(states[0]?.def ?? "").matchAll(/'([^']+)'::text/g)].map((m) => m[1])).toEqual([...RECONCILIATION_SLICE_STATES]);
      const now = new Date().toISOString();
      for (const [label, patch] of [
        ["unknown state", { state: "WAITING" }],
        ["RUNNING without lease", { state: "RUNNING", attempt: 1 }],
        ["RUNNING at attempt 0", { state: "RUNNING", attempt: 0, leased_until: now }],
        ["lease outside RUNNING", { leased_until: now }],
        ["PENDING with completion", { completed_at: now }],
        ["COMPLETED without completion", { state: "COMPLETED" }],
        ["FAILED_TRANSIENT without class", { state: "FAILED_TRANSIENT", completed_at: now }],
        ["class outside a failure", { state: "COMPLETED", completed_at: now, failure_class: "provider_failure" }],
        ["rate limited without retry time", { state: "FAILED_RATE_LIMITED", completed_at: now, failure_class: "rate_limited" }],
        ["pages over the slice budget", { pages_read: 2, max_pages: 1 }],
        ["slice budget over the ceiling", { max_pages: 11 }],
        ["window not after its start", { window_end: new Date(Date.now() - 2 * 86_400_000).toISOString() }],
      ] as const) {
        expect(await code(insertSlice(t, run, { ...patch, sequence: 100 })), label).toBe("23514");
      }
      // A slice is claimed only by incrementing its attempt; a finished slice never changes state again.
      const slice = await insertSlice(t, run, { sequence: 1 });
      expect(await code(updateSlice(t, slice, sql`state = 'RUNNING', leased_until = now() + interval '5 minutes', attempt = 0`))).toBe("23514");
      expect(await code(updateSlice(t, slice, sql`state = 'RUNNING', leased_until = now() + interval '5 minutes', attempt = 2`))).toBe("23514");
      await updateSlice(t, slice, sql`state = 'RUNNING', leased_until = now() + interval '5 minutes', attempt = 1, updated_at = now()`);
      await updateSlice(t, slice, sql`state = 'COMPLETED', leased_until = null, completed_at = now(), pages_read = 1, operations_used = 1, updated_at = now()`);
      expect(await code(updateSlice(t, slice, sql`state = 'PENDING', completed_at = null`))).toBe("23514");
      expect(await code(updateSlice(t, slice, sql`state = 'FAILED_PERMANENT', failure_class = 'late'`))).toBe("23514");
      // Identity and scope are not updatable; nothing is ever deleted.
      for (const set of [sql`unit = 'content_interactions'`, sql`content_item_id = ${t.content}`, sql`sequence = 7`, sql`reconciliation_run_id = ${run}`, sql`window_start = now()`, sql`max_pages = 10`]) {
        expect(await code(updateSlice(t, slice, set))).toBe("42501");
      }
      expect(await code(asWorker(t, (tx) => tx.execute(sql`delete from ingestion.reconciliation_slices where id = ${slice}`)))).toBe("42501");
    });

    it("4. at most one RUNNING slice per account; 5. one slice per (run, unit, content, sequence), NULL content included", async () => {
      const lease = new Date(Date.now() + 300_000).toISOString();
      const a = await insertSlice(t, run, { sequence: 10, state: "RUNNING", attempt: 1, leased_until: lease });
      expect(await sqlState(insertSlice(t, run, { sequence: 11, state: "RUNNING", attempt: 1, leased_until: lease }))).toMatchObject({ code: "23505", constraint: "reconciliation_slices_one_running" });
      // Another account of the same workspace may run at the same time.
      const other = await insertRun(t, { connected_account_id: t.otherAccount, state: "RUNNING", started_at: new Date().toISOString() });
      await insertSlice(t, other, { connected_account_id: t.otherAccount, state: "RUNNING", attempt: 1, leased_until: lease });
      await updateSlice(t, a, sql`state = 'ABANDONED_BUDGET', leased_until = null, completed_at = now(), updated_at = now()`);
      const c = await insertSlice(t, run, { sequence: 12, state: "RUNNING", attempt: 1, leased_until: lease });
      // Leave the account with no RUNNING slice for the next cases.
      await updateSlice(t, c, sql`state = 'COMPLETED', leased_until = null, completed_at = now(), updated_at = now()`);
      // Uniqueness: two content-listing slices with NULL content and the same sequence collide (NULLS NOT DISTINCT).
      await insertSlice(t, run, { sequence: 20 });
      expect(await sqlState(insertSlice(t, run, { sequence: 20 }))).toMatchObject({ code: "23505", constraint: "reconciliation_slices_once" });
      await insertSlice(t, run, { sequence: 20, unit: "content_interactions", content_item_id: t.content });
      expect(await sqlState(insertSlice(t, run, { sequence: 20, unit: "content_interactions", content_item_id: t.content }))).toMatchObject({ code: "23505", constraint: "reconciliation_slices_once" });
    });

    it("6. a listing slice names no content; an interactions slice names a content row of its own account", async () => {
      expect(await code(insertSlice(t, run, { sequence: 30, content_item_id: t.content }))).toBe("23514");
      expect(await code(insertSlice(t, run, { sequence: 30, unit: "content_interactions" }))).toBe("23514");
      // The other account's content: the composite (content, account) key refuses it.
      expect(await code(insertSlice(t, run, { sequence: 30, unit: "content_interactions", content_item_id: t.otherContent }))).toBe("23503");
      // The slice's account must be its run's.
      expect(await code(insertSlice(t, run, { sequence: 31, connected_account_id: t.otherAccount }))).toBe("23503");
      await insertSlice(t, run, { sequence: 30, unit: "content_interactions", content_item_id: t.content });
    });

    it("7. the cursor is 1–2048 characters; 8. it is paired with its issue time; 9. only an open slice may hold one", async () => {
      const issued = new Date().toISOString();
      await insertSlice(t, run, { sequence: 40, cursor: "c".repeat(2048), cursor_issued_at: issued });
      expect(await code(insertSlice(t, run, { sequence: 41, cursor: "c".repeat(2049), cursor_issued_at: issued }))).toBe("23514");
      expect(await code(insertSlice(t, run, { sequence: 41, cursor: "", cursor_issued_at: issued }))).toBe("23514");
      expect(await code(insertSlice(t, run, { sequence: 41, cursor: "meta1.c3ludGhldGlj" }))).toBe("23514");
      expect(await code(insertSlice(t, run, { sequence: 41, cursor_issued_at: issued }))).toBe("23514");
      const now = new Date().toISOString();
      for (const state of ["COMPLETED", "CONTINUED", "ABANDONED_BUDGET"] as const) {
        expect(await code(insertSlice(t, run, { sequence: 42, state, completed_at: now, cursor: "meta1.c3ludGhldGlj", cursor_issued_at: issued })), state).toBe("23514");
      }
      // Finishing a slice clears its cursor in the same statement, or is refused.
      const live = await insertSlice(t, run, { sequence: 43, cursor: "meta1.c3ludGhldGlj", cursor_issued_at: issued });
      await updateSlice(t, live, sql`state = 'RUNNING', attempt = 1, leased_until = now() + interval '5 minutes', updated_at = now()`);
      expect(await code(updateSlice(t, live, sql`state = 'CONTINUED', leased_until = null, completed_at = now()`))).toBe("23514");
      await updateSlice(t, live, sql`state = 'CONTINUED', leased_until = null, completed_at = now(), cursor = null, cursor_issued_at = null, updated_at = now()`);
    });

    it("10. counters are non-negative and never decrease", async () => {
      for (const field of ["pages_read", "operations_used", "conflict_count", "attempt"] as const) {
        expect(await code(insertSlice(t, run, { sequence: 50, [field]: -1 })), field).toBe("23514");
      }
      const slice = await insertSlice(t, run, { sequence: 51, max_pages: 5 });
      await updateSlice(t, slice, sql`pages_read = 2, operations_used = 2, conflict_count = 1, updated_at = now()`);
      for (const set of [sql`pages_read = 1`, sql`operations_used = 1`, sql`conflict_count = 0`]) expect(await code(updateSlice(t, slice, set))).toBe("23514");
      expect(await code(insertWatermark(t, { consecutive_failures: -1 }))).toBe("23514");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("reconciliation watermarks", () => {
    it("11. one per (account, capability, content); 12. the epoch is fixed and synced-through never regresses; 13. composite integrity", async () => {
      const t = await tenant();
      const other = await tenant();
      await insertWatermark(t);
      expect(await code(insertWatermark(t))).toBe("23505");
      const where = sql`connected_account_id = ${t.account} and content_item_id = ${t.content}`;
      const update = (set: ReturnType<typeof sql>) => asWorker(t, (tx) => tx.execute(sql`update ingestion.reconciliation_watermarks set ${set} where ${where}`));
      await update(sql`synced_through = now() - interval '1 hour', latest_created_at = now() - interval '2 hours', updated_at = now()`);
      await update(sql`synced_through = now(), updated_at = now()`);
      expect(await code(update(sql`synced_through = now() - interval '3 hours'`))).toBe("23514");
      expect(await code(update(sql`synced_through = null`))).toBe("23514");
      expect(await code(update(sql`latest_created_at = now() - interval '1 day'`))).toBe("23514");
      // The epoch, scope and identity are not updatable at all; synced-through never precedes the epoch.
      for (const set of [sql`epoch_at = now()`, sql`content_kind = 'reel'`, sql`capability = 'read_interactions'`, sql`content_item_id = ${t.otherContent}`]) {
        expect(await code(update(set))).toBe("42501");
      }
      expect(await code(insertWatermark(t, { content_item_id: t.otherContent, connected_account_id: t.otherAccount, synced_through: new Date(Date.now() - 5 * 86_400_000).toISOString() }))).toBe("23514");
      // Integrity: another account's content, another workspace's content, another account's run.
      expect(await code(insertWatermark(t, { content_item_id: t.otherContent }))).toBe("23503");
      expect(await code(insertWatermark(t, { content_item_id: other.content, connected_account_id: t.account }))).toBe("23503");
      const otherRun = await insertRun(t, { connected_account_id: t.otherAccount });
      await insertWatermark(t, { content_item_id: t.otherContent, connected_account_id: t.otherAccount });
      expect(await code(asWorker(t, (tx) => tx.execute(sql`update ingestion.reconciliation_watermarks set last_reconciliation_run_id = ${otherRun} where ${where}`)))).toBe("23503");
      expect(await code(asWorker(t, (tx) => tx.execute(sql`delete from ingestion.reconciliation_watermarks where ${where}`)))).toBe("42501");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("authority conflicts", () => {
    it("14. append-only; 15. identifiers and closed classes only; 16. the canonical classes, no THREAD_ANCHOR_CONFLICT", async () => {
      const t = await tenant();
      const run = await insertRun(t, { state: "RUNNING", started_at: new Date().toISOString() });
      const slice = await insertSlice(t, run);
      const insert = (conflictClass: string, refs: { run?: string | null; slice?: string | null; interaction?: string | null } = {}) =>
        asWorker(t, (tx) => tx.execute(sql`insert into ingestion.authority_conflicts (id, organization_id, workspace_id, connected_account_id, reconciliation_run_id,
            reconciliation_slice_id, interaction_id, conflict_class, observed_at, correlation_id, created_at)
          values (${randomUUID()}, ${t.organizationId}, ${t.workspaceId}, ${t.account}, ${refs.run === undefined ? run : refs.run}, ${refs.slice === undefined ? slice : refs.slice},
            ${refs.interaction ?? null}, ${conflictClass}, now(), ${correlation()}, now())`));
      for (const conflictClass of INGESTION_CONFLICT_CLASSES) await insert(conflictClass);
      expect(await code(insert("THREAD_ANCHOR_CONFLICT"))).toBe("23514");
      expect(await code(insert("SOMETHING_NEW"))).toBe("23514");
      // A slice without its run is refused; the slice must belong to the named run.
      expect(await code(insert("KIND_CHANGED", { run: null }))).toBe("23514");
      const otherRun = await insertRun(t, { connected_account_id: t.otherAccount });
      expect(await code(asWorker(t, (tx) => tx.execute(sql`insert into ingestion.authority_conflicts (id, organization_id, workspace_id, connected_account_id, reconciliation_run_id,
          reconciliation_slice_id, interaction_id, conflict_class, observed_at, correlation_id, created_at)
        values (${randomUUID()}, ${t.organizationId}, ${t.workspaceId}, ${t.otherAccount}, ${otherRun}, ${slice}, null, 'KIND_CHANGED', now(), ${correlation()}, now())`)))).toBe("23503");
      for (const statement of [sql`update ingestion.authority_conflicts set conflict_class = 'KIND_CHANGED'`, sql`delete from ingestion.authority_conflicts`]) {
        expect(await code(asWorker(t, (tx) => tx.execute(statement)))).toBe("42501");
      }
      const columns = await oracle<{ column_name: string; data_type: string }>(
        "select column_name, data_type from information_schema.columns where table_schema = 'ingestion' and table_name = 'authority_conflicts' order by ordinal_position");
      expect(columns.map((c) => c.column_name)).toEqual(["id", "organization_id", "workspace_id", "connected_account_id", "reconciliation_run_id", "reconciliation_slice_id",
        "interaction_id", "conflict_class", "observed_at", "correlation_id", "created_at"]);
      // Every column is an id, a closed class, a time or the correlation: no free text, JSON or payload column.
      expect(columns.filter((c) => !["uuid", "timestamp with time zone"].includes(c.data_type)).map((c) => c.column_name)).toEqual(["conflict_class", "correlation_id"]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("vocabulary widenings", () => {
    it("17. coverage admits TRAVERSAL_INCOMPLETE — persisted from the domain's budget-exhausted result — and still refuses unknown reasons", async () => {
      const t = await tenant();
      const at = (iso: string) => must(parseInstant(iso), "instant");
      const coverage = coverageForSlice({
        scope: { connectedAccountId: t.account, capability: "read_interactions", contentId: t.content },
        from: at("2026-10-26T00:00:00.000Z"), to: at("2026-10-27T00:00:00.000Z"), asOf: at("2026-10-27T00:05:00.000Z"),
        availability: { state: "AVAILABLE", reason: "CAPABILITY_SUPPORTED", limitationCode: null }, result: "budget_exhausted",
      });
      const written = await asWorker(t, (tx) => createPostgresCoverageStore(tx).recordSlice({ organizationId: t.organizationId, workspaceId: t.workspaceId, contentItemId: t.content, coverage, correlationId: correlation(), newId: randomUUID }));
      expect(written).toBe(2);
      expect(await oracle("select interaction_kind, state, reason, slice_outcome from coverage.coverage_records where workspace_id = $1 order by interaction_kind", [t.workspaceId]))
        .toEqual([{ interaction_kind: "comment", state: "UNKNOWN", reason: "TRAVERSAL_INCOMPLETE", slice_outcome: "TEMPORARILY_FAILED" }, { interaction_kind: "reply", state: "UNKNOWN", reason: "TRAVERSAL_INCOMPLETE", slice_outcome: "TEMPORARILY_FAILED" }]);
      expect(await code(asWorker(t, (tx) => tx.execute(sql`insert into coverage.coverage_records (id, organization_id, workspace_id, connected_account_id, capability, content_item_id,
          interaction_kind, interval_start, interval_end, state, reason, limitation_code, slice_outcome, correlation_id, as_of, created_at)
        values (${randomUUID()}, ${t.organizationId}, ${t.workspaceId}, ${t.account}, 'read_interactions', null, 'comment', now() - interval '1 hour', now(), 'UNKNOWN', 'BUDGET_GONE', null,
          'TEMPORARILY_FAILED', ${correlation()}, now(), now())`)))).toBe("23514");
      expect(await oracle("select convalidated from pg_constraint where conname = 'coverage_records_reason_check'")).toEqual([{ convalidated: true }]);
    });

    it("18. audit admits connected_account.reconciliation_requested (validated; the live set is the application's)", async () => {
      const t = await tenant();
      const rows = await oracle<{ def: string; convalidated: boolean }>("select pg_get_constraintdef(oid) as def, convalidated from pg_constraint where conname = 'audit_events_action_check'");
      expect(rows[0]?.convalidated).toBe(true);
      expect([...(rows[0]?.def ?? "").matchAll(/'([^']+)'::text/g)].map((m) => m[1]).sort()).toEqual([...AUDIT_ACTIONS].sort());
      expect(AUDIT_ACTIONS).toContain("connected_account.reconciliation_requested");
      await asWorker(t, (tx) => tx.execute(sql`insert into audit.audit_events (id, occurred_at, action, actor_type, organization_id, workspace_id, target_type, target_id, correlation_id, outcome, change)
        values (${randomUUID()}, now(), 'connected_account.reconciliation_requested', 'system', ${t.organizationId}, ${t.workspaceId}, 'connected_account', ${t.account}, ${correlation()}, 'succeeded', null)`));
      expect(await code(asWorker(t, (tx) => tx.execute(sql`insert into audit.audit_events (id, occurred_at, action, actor_type, organization_id, workspace_id, target_type, target_id, correlation_id, outcome, change)
        values (${randomUUID()}, now(), 'connected_account.reconciliation_scheduled', 'system', ${t.organizationId}, ${t.workspaceId}, 'connected_account', ${t.account}, ${correlation()}, 'succeeded', null)`)))).toBe("23514");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("tenancy", () => {
    it("19. runs are readable by non-guest members of their workspace only; slices, watermarks and conflicts by the job runtime only", async () => {
      const a = await tenant();
      const b = await tenant();
      const run = await insertRun(a, { state: "RUNNING", started_at: new Date().toISOString() });
      await insertSlice(a, run);
      await insertWatermark(a);
      const count = (tx: DatabaseTransaction, table: string) => tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`)).then((r) => r.rows[0]?.n ?? -1);
      expect(await asUser(a, a.owner, (tx) => count(tx, "ingestion.reconciliation_runs"))).toBe(1);
      expect(await asUser(a, a.guest, (tx) => count(tx, "ingestion.reconciliation_runs"))).toBe(0);
      expect(await asUser(b, b.owner, (tx) => count(tx, "ingestion.reconciliation_runs"))).toBe(0);
      for (const table of ["ingestion.reconciliation_slices", "ingestion.reconciliation_watermarks", "ingestion.authority_conflicts"]) {
        expect(await code(asUser(a, a.owner, (tx) => count(tx, table))), table).toBe("42501");
        expect(await asWorker(a, (tx) => count(tx, table)), table).toBeGreaterThanOrEqual(0);
        expect(await asWorker(b, (tx) => count(tx, table)), table).toBe(0);
      }
      expect(await asWorker(b, (tx) => count(tx, "ingestion.reconciliation_runs"))).toBe(0);
      // Members never write any of them.
      expect(await code(asUser(a, a.owner, (tx) => tx.execute(sql`update ingestion.reconciliation_runs set state = 'FAILED'`)))).toBe("42501");
      expect(await code(asUser(a, a.owner, (tx) => tx.execute(sql`insert into ingestion.reconciliation_runs (id) values (${randomUUID()})`)))).toBe("42501");
    });

    it("20. cross-workspace references fail like missing ones", async () => {
      const a = await tenant();
      const b = await tenant();
      const runA = await insertRun(a);
      const sliceA = await insertSlice(a, runA);
      // B's worker naming A's account, run, content or slice.
      expect(await code(insertRun(b, { connected_account_id: a.account }))).toBe("23503");
      const runB = await insertRun(b);
      expect(await code(insertSlice(b, runA, { connected_account_id: b.account }))).toBe("23503");
      expect(await code(insertSlice(b, runB, { unit: "content_interactions", content_item_id: a.content }))).toBe("23503");
      expect(await code(insertWatermark(b, { content_item_id: a.content }))).toBe("23503");
      expect(await code(asWorker(b, (tx) => tx.execute(sql`insert into ingestion.authority_conflicts (id, organization_id, workspace_id, connected_account_id, reconciliation_run_id,
          reconciliation_slice_id, interaction_id, conflict_class, observed_at, correlation_id, created_at)
        values (${randomUUID()}, ${b.organizationId}, ${b.workspaceId}, ${b.account}, ${runB}, ${sliceA}, null, 'KIND_CHANGED', now(), ${correlation()}, now())`)))).toBe("23503");
      // A row claiming A's workspace from B's binding is refused by RLS.
      expect(await code(asWorker(b, (tx) => tx.execute(sql`insert into ingestion.reconciliation_runs (id, organization_id, workspace_id, connected_account_id, state, initiator_type,
          correlation_id, requested_at, budget_listing_pages_per_slice, budget_interaction_pages_per_slice, budget_continuations_per_content, budget_interaction_pages_per_content,
          budget_content_items, budget_overlap_seconds, max_operations, created_at, updated_at)
        values (${randomUUID()}, ${a.organizationId}, ${a.workspaceId}, ${a.account}, 'REQUESTED', 'system', ${correlation()}, now(), 1, 5, 2, 15, 10, 86400, 40, now(), now())`)))).toBe("42501");
    });
  });
}
