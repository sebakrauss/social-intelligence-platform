/**
 * WORKFLOW-WF-2B — the Comments list read from the workflow queue, at scale, on the real database: 210 workspaces (one
 * with 10,000 conversations, two with 2,000, 207 with 20 — more tenants than the 100 most-common-values statistics keep),
 * synthetic rows only, seeded in bulk by the bootstrap role.
 *
 *   Q1  plan regression (WF-2A): the EXACT statement the read store issues — captured from the store itself, not retyped —
 *       uses an ordered Index (Only) Scan on a queue index, with no Sort and no Bitmap, carries the bound workspace as an
 *       index condition, and examines at most 2 × (page + 1) rows, for Open / Done / All, first and deep pages, in the
 *       large workspace; every tenant's read stays bounded
 *   Q2  T-31 pagination correctness through the REAL command (pipeline, web unit of work, RLS): every view walked to the
 *       end equals the oracle row for row — no missing, duplicated or out-of-order row, no partial page
 *   Q3  cursor stability while people mark Done / Reopen and new activity arrives during the walk
 *   Q4  tenant isolation through the real command: a neighbour sees only its own rows; another workspace is NOT_FOUND
 *   Q5  measured local latency of the real command (reported, not asserted beyond a generous bound)
 */
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import { createPostgresWorkflowReadStore } from "@/modules/workflow/persistence";
import type { QueueView } from "@/modules/workflow";
import { withUserScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { createLogger } from "@/platform/observability";
import { markDoneCommand, reopenCommand } from "@/server/commands/workflow";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { createActionPipeline, type ActionPipeline, type PipelineResult } from "@/server/pipeline";
import { INBOX_PAGE_SIZE, inboxListCommand, parseListCursor, type InboxPage, type InboxStateFilter } from "@/server/queries/inbox";
import { FakeIdentity, verifiedUser } from "../../support/in-memory";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";

const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(what);
  return value;
};
const LARGE = 10_000;
const NEIGHBOURS = 2_000;
const SMALL = 20;
const TENANTS = 210;
const BOUNDED = 2 * (INBOX_PAGE_SIZE + 1);

interface PlanNode {
  readonly "Node Type": string;
  readonly "Index Name"?: string;
  readonly "Relation Name"?: string;
  readonly "Actual Rows"?: number;
  readonly "Actual Loops"?: number;
  readonly "Rows Removed by Filter"?: number;
  readonly "Index Cond"?: string;
  readonly Plans?: readonly PlanNode[];
}

/** The keyset scan's facts from EXPLAIN (ANALYZE, FORMAT JSON). */
function scanOf(plan: unknown): { ordered: boolean; scan: string; examined: number; indexCond: string; executionMs: number } {
  const root = (plan as readonly { readonly Plan: PlanNode; readonly "Execution Time": number }[])[0];
  if (root === undefined) throw new Error("no plan");
  const flags = { sorted: false, bitmap: false };
  let scan: PlanNode | undefined;
  let examined = 0;
  const visit = (node: PlanNode): void => {
    if (node["Node Type"].includes("Sort")) flags.sorted = true;
    if (node["Node Type"].startsWith("Bitmap")) flags.bitmap = true;
    if (node["Node Type"].includes("Scan") && (node["Relation Name"] === "work_items" || (node["Index Name"] ?? "").startsWith("work_items"))) {
      scan ??= node;
      examined += ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) * (node["Actual Loops"] ?? 1);
    }
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(root.Plan);
  const found: PlanNode | undefined = scan;
  return {
    ordered: !flags.sorted && !flags.bitmap && found !== undefined && /^Index (Only )?Scan$/.test(found["Node Type"]) && (found["Index Name"] ?? "").startsWith("work_items_queue"),
    scan: found === undefined ? "none" : `${found["Node Type"]} ${found["Index Name"] ?? ""}`.trim(),
    examined,
    indexCond: found?.["Index Cond"] ?? "",
    executionMs: root["Execution Time"],
  };
}

const percentile = (values: readonly number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round((sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? Number.NaN) * 100) / 100;
};

export function defineWorkflowQueueSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  const organizations: string[] = [];
  let large: { workspaceId: WorkspaceId; manager: string };
  let neighbour: { workspaceId: WorkspaceId; manager: string };
  let small: { workspaceId: WorkspaceId; manager: string };
  const measured: Record<string, { p50: number; p95: number; n: number }> = {};

  const pipelineAs = (user: string): ActionPipeline => createActionPipeline({
    identity: new FakeIdentity(verifiedUser(must(parseUserId(user), "user"))),
    unitOfWork: createPostgresUnitOfWork(web),
    clock: () => new Date(),
    newId: randomUUID,
    logger: createLogger({ sink: () => undefined }),
  });
  const ok = <R>(result: PipelineResult<R>): R => {
    if (result.status !== "ok") throw new Error(`pipeline ${result.status}${result.status === "error" ? `: ${result.error.code}` : ""}`);
    return result.value;
  };
  const list = async (who: { workspaceId: WorkspaceId; manager: string }, state: InboxStateFilter | undefined, cursor?: string): Promise<InboxPage> =>
    ok(await pipelineAs(who.manager).run(inboxListCommand, { workspaceId: who.workspaceId, input: { ...(state === undefined ? {} : { state }), ...(cursor === undefined ? {} : { cursor }) } }));
  /** The list's definition from the source rows: newest activity first, then id (descending), in one state or all. */
  const oracleIds = async (workspaceId: string, state: "OPEN" | "DONE" | undefined): Promise<string[]> =>
    (await privileged.query<{ id: string }>(
      `select c.id from conversations.conversations c join workflow.work_items w on w.workspace_id = c.workspace_id and w.id = c.id
        cross join lateral (select date_trunc('milliseconds', max(coalesce(i.provider_created_at, i.first_observed_at, i.created_at))) as at
                              from interactions.interactions i where i.workspace_id = c.workspace_id and i.conversation_id = c.id) a
        where c.workspace_id = $1 ${state === undefined ? "" : "and w.state = $2"}
        order by a.at desc, c.id desc`, state === undefined ? [workspaceId] : [workspaceId, state])).rows.map((row) => row.id);
  const walk = async (who: { workspaceId: WorkspaceId; manager: string }, state: InboxStateFilter | undefined, between?: (page: number) => Promise<void>) => {
    const seen: { id: string; at: number }[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await list(who, state, cursor);
      pages += 1;
      expect("partial" in page).toBe(false);
      seen.push(...page.items.map((item) => ({ id: item.conversationId, at: item.latestActivityAt.getTime() })));
      if (page.nextCursor === null) return { seen, pages };
      expect(parseListCursor(page.nextCursor)?.state).toBe(state);
      cursor = page.nextCursor;
      if (between !== undefined) await between(pages);
    }
  };

  beforeAll(async () => {
    const target = getTarget();
    privileged = privilegedPool(target);
    web = runtimeDatabase(target, "web");
    const client = await privileged.connect();
    try {
      await client.query("begin");
      await client.query(`create temporary table wf2b_tenants on commit drop as
        select n, gen_random_uuid() as org, gen_random_uuid() as ws, gen_random_uuid() as manager, gen_random_uuid() as connection, gen_random_uuid() as discovered,
               gen_random_uuid() as account, gen_random_uuid() as content,
               case when n = 1 then ${String(LARGE)} when n <= 3 then ${String(NEIGHBOURS)} else ${String(SMALL)} end as size
          from generate_series(1, ${String(TENANTS)}) n`);
      await client.query("insert into tenancy.organizations (id, name, created_at) select org, 'WF2B queue ' || n, now() from wf2b_tenants");
      await client.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) select ws, org, 'Q' || n, 'STANDARD', now() from wf2b_tenants");
      await client.query("insert into tenancy.organization_memberships select org, manager, 'MEMBER', now() from wf2b_tenants");
      await client.query("insert into tenancy.workspace_memberships select org, ws, manager, 'MANAGER', '{}', now() from wf2b_tenants");
      await client.query(`insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
        select connection, org, ws, 'simulator', 'ACTIVE', null, manager, now(), 1, now(), now() from wf2b_tenants`);
      await client.query(`insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
        select discovered, org, ws, connection, 'facebook', 'fb_q_' || n, 'content_bearing', 'Synthetic', now(), now(), now() from wf2b_tenants`);
      await client.query(`insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
        select account, org, ws, connection, 'facebook', 'fb_q_' || n, 'content_bearing', 'ACTIVE', now(), now(), now() from wf2b_tenants`);
      await client.query(`insert into content.content_items (id, organization_id, workspace_id, platform, connected_account_id, provider_asset_id, provider_content_id, content_kind, reported_source, source_state, first_observed_at, latest_observed_at, created_at, updated_at)
        select content, org, ws, 'facebook', account, 'fb_q_' || n, 'post_q_' || n, 'post', 'organic', 'available', now(), now(), now(), now() from wf2b_tenants`);
      // One audience anchor per conversation; groups of three on the same instant (ties straddle every page boundary), some
      // apart only below the millisecond; activity spread over ~4 months; about a third Done (the older ones more often).
      await client.query(`create temporary table wf2b_conversations on commit drop as
        select t.n, t.org, t.ws, t.account, t.content, i, gen_random_uuid() as conversation, gen_random_uuid() as anchor,
               timestamptz '2026-11-01 00:00:00+00' - ((i / 3) * interval '997 seconds') + ((i % 5 = 0)::int * interval '400 microseconds') as at,
               case when (i * 7919) % 100 < case when i > t.size / 3 then 45 else 15 end then 'DONE' else 'OPEN' end as state
          from wf2b_tenants t cross join lateral generate_series(1, t.size) i`);
      await client.query(`insert into interactions.interactions (id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id, provider_content_id,
            observed, parent_interaction_id, kind, author_id, author_role, conversation_id, current_source_text_version_id, text_observed_at, current_visibility, current_availability, current_removal_basis,
            provider_created_at, provider_edited_at, state_observed_at, first_observed_at, latest_observed_at, created_at, updated_at)
        select anchor, org, ws, 'facebook', 'q' || n || '_' || i, account, 'fb_q_' || n, content, 'post_q_' || n,
               true, null, 'comment', null, 'user', null, null, null, 'visible', 'available', null, at, null, at, at, at, at, at
          from wf2b_conversations`);
      await client.query(`insert into conversations.conversations (id, organization_id, workspace_id, anchor_interaction_id, anchor_observed, workflow_state, created_by, created_at, updated_at)
        select conversation, org, ws, anchor, true, 'OPEN', 'system_ingestion', at, at from wf2b_conversations`);
      await client.query("update interactions.interactions i set conversation_id = c.conversation from wf2b_conversations c where i.workspace_id = c.ws and i.id = c.anchor");
      await client.query(`insert into workflow.work_items (id, organization_id, workspace_id, subject_kind, conversation_id, state, resolution, state_changed_at, state_changed_by_kind, state_changed_by_user, version, latest_activity_at, created_at, updated_at)
        select conversation, org, ws, 'comment_conversation', conversation, state, null, at, 'migration', null, 1, date_trunc('milliseconds', at), at, at from wf2b_conversations`);
      const rows = (await client.query<{ n: number; ws: string; manager: string; org: string }>("select n, ws, manager, org from wf2b_tenants where n in (1, 2, 4) order by n")).rows;
      for (const row of (await client.query<{ org: string }>("select org from wf2b_tenants")).rows) organizations.push(row.org);
      await client.query("commit");
      const tenant = (n: number) => {
        const row = must(rows.find((r) => r.n === n), `tenant ${String(n)}`);
        return { workspaceId: must(parseWorkspaceId(row.ws), "ws"), manager: row.manager };
      };
      large = tenant(1);
      neighbour = tenant(2);
      small = tenant(4);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    await privileged.query("analyze workflow.work_items");
    await privileged.query("analyze interactions.interactions");
    await privileged.query("analyze conversations.conversations");
  }, 300_000);

  afterAll(async () => {
    // Organizations in bounded batches (cleanupWorld deletes their rows through the cascades).
    for (let n = 0; n < organizations.length; n += 50) await cleanupWorld(privileged, organizations.slice(n, n + 50));
    await web.end();
    await privileged.end();
    // The measured numbers, for the report (stdout of this suite only; no file is written).
    if (Object.keys(measured).length > 0) process.stdout.write(`[WF-2B measured, local] ${JSON.stringify(measured)}\n`);
  }, 300_000);

  describe("Q1 · plan regression on the EXACT store statement (WF-2A shape), with more than 200 tenants", () => {
    /** Runs the read store against a transaction that EXPLAINs whatever it executes: the plan of the production SQL. */
    const explainQueue = (who: { workspaceId: WorkspaceId; manager: string }, view: QueueView, before: { latestActivityAt: Date; id: string } | null) =>
      withUserScope(web, { sub: who.manager, role: "authenticated" }, who.workspaceId, async (tx) => {
        let plan: unknown;
        const explaining = { execute: async (query: SQL) => { plan = (await tx.execute<{ "QUERY PLAN": unknown }>(sql`explain (analyze, buffers, format json) ${query}`)).rows[0]?.["QUERY PLAN"]; return { rows: [] }; } } as unknown as DatabaseTransaction;
        await createPostgresWorkflowReadStore(explaining).queue({ workspaceId: who.workspaceId, view, before, limit: INBOX_PAGE_SIZE + 1 });
        return scanOf(plan);
      });
    const deepPosition = async (who: { workspaceId: WorkspaceId }, view: QueueView) => {
      const row = (await privileged.query<{ at: Date; id: string }>(
        `select latest_activity_at as at, id from workflow.work_items where workspace_id = $1 ${view === "all" ? "" : "and state = $2"} order by latest_activity_at desc, id desc offset 975 limit 1`,
        view === "all" ? [who.workspaceId] : [who.workspaceId, view === "open" ? "OPEN" : "DONE"])).rows[0];
      return row === undefined ? null : { latestActivityAt: row.at, id: row.id };
    };

    it("the statistics really span more than the 100 most-common values (the WF-2A untested case)", async () => {
      const stats = (await privileged.query<{ distinct: number; mcv: number }>(
        "select n_distinct::int as distinct, coalesce(array_length(most_common_vals::text::text[], 1), 0) as mcv from pg_stats where schemaname = 'workflow' and tablename = 'work_items' and attname = 'workspace_id'")).rows[0];
      const tenants = Number((await privileged.query<{ n: string }>("select count(distinct workspace_id) as n from workflow.work_items")).rows[0]?.n);
      expect(tenants).toBeGreaterThan(200);
      expect(stats?.mcv ?? 0).toBeLessThanOrEqual(100);
    });

    for (const view of ["open", "done", "all"] as const) {
      it(`${view}: first and deep pages of the 10,000-conversation workspace are an ordered, bounded index read with the workspace as index condition`, async () => {
        for (const before of [null, await deepPosition(large, view)]) {
          const plan = await explainQueue(large, view, before);
          expect(plan.ordered, `${view} ${before === null ? "p1" : "deep"}: ${plan.scan}`).toBe(true);
          expect(plan.examined).toBeLessThanOrEqual(BOUNDED);
          expect(plan.indexCond).toContain(`workspace_id = '${large.workspaceId}'::uuid`);
          measured[`plan_${view}_${before === null ? "p1" : "deep"}_ms`] = { p50: plan.executionMs, p95: plan.executionMs, n: 1 };
        }
      });
    }

    it("every tenant's queue read is bounded — a 2,000-conversation neighbour and a 20-conversation tenant beyond the common values", async () => {
      for (const who of [neighbour, small]) {
        for (const view of ["open", "done", "all"] as const) {
          const plan = await explainQueue(who, view, null);
          expect(plan.examined, `${who === small ? "small" : "neighbour"} ${view}: ${plan.scan}`).toBeLessThanOrEqual(BOUNDED);
          if (who === neighbour) expect(plan.ordered, `neighbour ${view}: ${plan.scan}`).toBe(true);
        }
      }
    });
  });

  describe("Q2 · T-31 pagination correctness through the real command", () => {
    for (const [state, label] of [["open", "OPEN"], ["done", "DONE"], [undefined, undefined]] as const) {
      it(`${state ?? "all"}: walked to the end, row for row equal to the oracle (no missing, duplicate or out-of-order row; never partial)`, async () => {
        const expected = await oracleIds(large.workspaceId, label);
        const { seen, pages } = await walk(large, state);
        expect(seen.map((row) => row.id)).toEqual(expected);
        expect(pages).toBe(Math.max(1, Math.ceil(expected.length / INBOX_PAGE_SIZE)));
      }, 180_000);
    }
  });

  describe("Q3 · cursor stability while the queue changes", () => {
    it("people mark Done / Reopen and new activity arrives during an Open walk: nothing repeats, order holds, every untouched Open row is seen", async () => {
      const before = await oracleIds(neighbour.workspaceId, "OPEN");
      const touched = new Set<string>();
      const versions = new Map((await privileged.query<{ id: string; version: number }>("select id, version from workflow.work_items where workspace_id = $1", [neighbour.workspaceId])).rows.map((row) => [row.id, row.version]));
      const pipeline = pipelineAs(neighbour.manager);
      const { seen } = await walk(neighbour, "open", async (page) => {
        if (page % 4 !== 0) return;
        // Somebody marks two Open conversations Done, reopens one Done, and a new comment bumps one to the top.
        const candidates = (await privileged.query<{ id: string; state: string }>("select id, state from workflow.work_items where workspace_id = $1 order by md5(id::text || $2) limit 4", [neighbour.workspaceId, String(page)])).rows;
        for (const row of candidates) {
          const version = must(versions.get(row.id), "version");
          const input = { conversationId: row.id, expectedVersion: version };
          const result = row.state === "OPEN" ? await pipeline.run(markDoneCommand, { workspaceId: neighbour.workspaceId, input }) : await pipeline.run(reopenCommand, { workspaceId: neighbour.workspaceId, input });
          if (result.status === "ok") versions.set(row.id, result.value.version);
          touched.add(row.id);
        }
        const bumped = must(candidates[0], "candidate").id;
        await privileged.query("update workflow.work_items set latest_activity_at = date_trunc('milliseconds', now()) where workspace_id = $1 and id = $2", [neighbour.workspaceId, bumped]);
      });
      const ids = seen.map((row) => row.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (let n = 1; n < seen.length; n += 1) {
        const a = must(seen[n - 1], "a");
        const b = must(seen[n], "b");
        expect(a.at > b.at || (a.at === b.at && a.id > b.id)).toBe(true);
      }
      const untouched = before.filter((id) => !touched.has(id));
      expect(untouched.filter((id) => !ids.includes(id))).toEqual([]);
      expect(touched.size).toBeGreaterThan(0);
    }, 180_000);
  });

  describe("Q4 · tenant isolation through the real command", () => {
    it("a neighbour's manager sees exactly its own conversations; another workspace is NOT_FOUND", async () => {
      const first = await list(neighbour, undefined);
      const own = new Set(await oracleIds(neighbour.workspaceId, undefined));
      expect(first.items.every((item) => own.has(item.conversationId))).toBe(true);
      const foreign = await pipelineAs(neighbour.manager).run(inboxListCommand, { workspaceId: large.workspaceId, input: {} });
      expect(foreign.status === "error" ? foreign.error.code : foreign.status).toBe("NOT_FOUND");
    });
  });

  describe("Q5 · measured local latency of the real command (pipeline, web unit of work, RLS, every read of the page)", () => {
    it("Open, Done and All, first and deep pages of the 10,000-conversation workspace", async () => {
      for (const state of ["open", "done", undefined] as const) {
        const first = await list(large, state);
        let deep: string | undefined = first.nextCursor ?? undefined;
        for (let n = 0; n < 38 && deep !== undefined; n += 1) deep = (await list(large, state, deep)).nextCursor ?? undefined;
        for (const [depth, cursor] of [["p1", undefined], ["p40", deep]] as const) {
          for (let n = 0; n < 3; n += 1) await list(large, state, cursor);
          const times: number[] = [];
          for (let n = 0; n < 20; n += 1) {
            const started = performance.now();
            await list(large, state, cursor);
            times.push(performance.now() - started);
          }
          measured[`command_${state ?? "all"}_${depth}_ms`] = { p50: percentile(times, 0.5), p95: percentile(times, 0.95), n: times.length };
          // Generous bound (local, x86_64 PostgreSQL under emulation on this machine): a regression to a workspace scan
          // costs seconds, not tens of milliseconds.
          expect(percentile(times, 0.95)).toBeLessThan(250);
        }
      }
    }, 300_000);
  });
}
