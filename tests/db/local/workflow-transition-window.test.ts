/**
 * WORKFLOW-WF-2C — the deployment transition window, simulated end to end on a disposable local cluster (synthetic data;
 * the production ingestion path; the real web pipeline; the operator CLI itself):
 *
 *   1. conversations exist under migration 0033 (ingested by the PREVIOUS worker build — no workflow);
 *   2. migration 0034 is applied by the real runner (backfill);
 *   3. the new web records manual decisions (Done with resolutions), while the PREVIOUS worker keeps ingesting — the
 *      gap: a new conversation, an audience reply to an Open one, an audience reply to a Done one, the account's reply to
 *      a Done one, and a new conversation in a SECOND workspace;
 *   4. reconciliation: dry run (reads only, the database refuses writes), then apply in bounded, resumed batches;
 *   5. repeated reconciliation: nothing changes, no event or audit row is added;
 *   6. concurrent ingestion (the NEW worker) and reconciliation: reconciliation waits on the work item and recomputes.
 * Verified at the end: exact counts, list order through the real command (walks equal the oracle), manual decisions
 * preserved (state, resolution, attribution, version), audit unchanged by reconciliation, tenant isolation; and the
 * operator CLI (`npm run ops:workflow-reconcile`, loopback-only) reconciles the second workspace.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseUserId } from "@/domain/ids";
import type { ContentDto } from "@/integrations/providers/contract";
import type { InteractionSourceFact } from "@/modules/interactions";
import type { IngestionStores } from "@/modules/ingestion";
import type { RuntimeDatabase } from "@/platform/db";
import { createLogger } from "@/platform/observability";
import { markDoneCommand } from "@/server/commands/workflow";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { reconcileWorkspaceWorkItems, type ReconciliationReport } from "@/server/persistence/workflow-reconciliation";
import { createActionPipeline, type PipelineResult } from "@/server/pipeline";
import { inboxListCommand, type InboxPage } from "@/server/queries/inbox";
import { applyMigrations, migrationStatus, readMigrations } from "@/tools/db/migrations";
import { FakeIdentity, verifiedUser } from "../../support/in-memory";
import { spawnLocalCluster, type SpawnedCluster } from "../support/spawn-cluster";
import { privilegedPool, runtimeDatabase } from "../support/target";
import { ingestAs, ingestTenant, organicTemplate, sighting, type IngestTenant } from "../support/workflow-ingest";

const THROUGH = "0033_mutation_intent_state_transition_guard.sql";
const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(what);
  return value;
};

describe("WF-2C · the 0034 deployment transition window, reconciled", () => {
  let cluster: SpawnedCluster;
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let worker2: RuntimeDatabase<"worker">;
  let A: IngestTenant;
  let B: IngestTenant;
  let contentA: ContentDto;
  let baseA: InteractionSourceFact;
  let contentB: ContentDto;
  let baseB: InteractionSourceFact;
  const conv: Record<string, string> = {};
  let firstRun: ReconciliationReport;

  const q = async <T extends pg.QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(text, [...values])).rows;
  const conversationOf = async (t: IngestTenant, providerId: string): Promise<string> =>
    must((await q<{ c: string | null }>("select conversation_id as c from interactions.interactions where workspace_id = $1 and provider_interaction_id = $2", [t.workspaceId, providerId]))[0]?.c ?? undefined, providerId);
  const item = async (id: string) => (await q<{ state: string; resolution: string | null; version: number; by: string; user: string | null; latest: Date }>(
    "select state, resolution, version, state_changed_by_kind as by, state_changed_by_user as user, latest_activity_at as latest from workflow.work_items where id = $1", [id]))[0];
  const trueActivity = async (id: string) => must((await q<{ at: Date }>("select date_trunc('milliseconds', max(coalesce(provider_created_at, first_observed_at, created_at))) as at from interactions.interactions where conversation_id = $1", [id]))[0]?.at, "activity");
  const snapshot = async (t: IngestTenant) => ({
    items: await q("select id, state, resolution, version, state_changed_at, state_changed_by_kind, state_changed_by_user, latest_activity_at, updated_at from workflow.work_items where workspace_id = $1 order by id", [t.workspaceId]),
    events: await q("select id from workflow.workflow_events where workspace_id = $1 order by id", [t.workspaceId]),
    audit: await q("select id from audit.audit_events where workspace_id = $1 order by id", [t.workspaceId]),
  });
  const pipelineAs = (user: string) => createActionPipeline({
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
  const walk = async (t: IngestTenant, state: "open" | "done" | undefined): Promise<string[]> => {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page: InboxPage = ok(await pipelineAs(t.users.MANAGER).run(inboxListCommand, { workspaceId: t.workspaceId, input: { ...(state === undefined ? {} : { state }), ...(cursor === undefined ? {} : { cursor }) } }));
      ids.push(...page.items.map((row) => row.conversationId));
      if (page.nextCursor === null) return ids;
      cursor = page.nextCursor;
    }
  };
  const oracleOrder = async (t: IngestTenant, state: "OPEN" | "DONE" | undefined): Promise<string[]> => (await q<{ id: string }>(
    `select c.id from conversations.conversations c join workflow.work_items w on w.id = c.id
      cross join lateral (select date_trunc('milliseconds', max(coalesce(i.provider_created_at, i.first_observed_at, i.created_at))) as at from interactions.interactions i where i.conversation_id = c.id) a
      where c.workspace_id = $1 ${state === undefined ? "" : "and w.state = $2"} order by a.at desc, c.id desc`, state === undefined ? [t.workspaceId] : [t.workspaceId, state])).map((row) => row.id);

  beforeAll(async () => {
    cluster = await spawnLocalCluster({ migrateThrough: THROUGH });
    privileged = privilegedPool(cluster.target);
    web = runtimeDatabase(cluster.target, "web");
    worker = runtimeDatabase(cluster.target, "worker");
    worker2 = runtimeDatabase(cluster.target, "worker");
  }, 180_000);
  afterAll(async () => {
    await Promise.all([web.end(), worker.end(), worker2.end()]);
    await privileged.end();
    await cluster.stop();
  });

  it("1 · under 0033, the PREVIOUS worker ingests conversations in two workspaces (no workflow exists yet)", async () => {
    expect((await migrationStatus(privileged as unknown as pg.Client, readMigrations())).applied.at(-1)).toBe(THROUGH);
    A = await ingestTenant(privileged);
    B = await ingestTenant(privileged);
    ({ content: contentA, base: baseA } = await organicTemplate(A));
    ({ content: contentB, base: baseB } = await organicTemplate(B));
    for (const [name, at] of [["a1", "2026-10-01T10:00:00.000Z"], ["a2", "2026-10-02T10:00:00.000Z"], ["a3", "2026-10-03T10:00:00.000Z"]] as const) {
      await ingestAs(worker, A, contentA, sighting(baseA, { id: `fb_${name}`, parent: null, author: "user", createdAt: at, observedAt: at }), { generation: "previous" });
      conv[name] = await conversationOf(A, `fb_${name}`);
    }
    await ingestAs(worker, A, contentA, sighting(baseA, { id: "fb_a1_r", parent: "fb_a1", author: "user", createdAt: "2026-10-01T12:00:00.000Z", observedAt: "2026-10-01T12:00:00.000Z" }), { generation: "previous" });
    for (const [name, at] of [["b1", "2026-10-01T09:00:00.000Z"], ["b2", "2026-10-02T09:00:00.000Z"]] as const) {
      await ingestAs(worker, B, contentB, sighting(baseB, { id: `fb_${name}`, parent: null, author: "user", createdAt: at, observedAt: at }), { generation: "previous" });
      conv[name] = await conversationOf(B, `fb_${name}`);
    }
    expect(Number((await q<{ n: string }>("select count(*) as n from conversations.conversations"))[0]?.n)).toBe(5);
  });

  it("2 · the real runner applies 0034: one OPEN v1 work item per conversation, with the list's own activity", async () => {
    const client = await privileged.connect();
    try {
      expect(await applyMigrations(client as unknown as pg.Client, readMigrations())).toEqual(["0034_workflow_core.sql"]);
    } finally {
      client.release();
    }
    for (const name of ["a1", "a2", "a3", "b1", "b2"]) {
      const row = must(await item(must(conv[name], name)), name);
      expect(row).toMatchObject({ state: "OPEN", version: 1, by: "migration" });
      expect(row.latest.toISOString()).toBe((await trueActivity(must(conv[name], name))).toISOString());
    }
  });

  it("3 · the gap: the new web records Done decisions while the PREVIOUS worker keeps ingesting", async () => {
    ok(await pipelineAs(A.users.MANAGER).run(markDoneCommand, { workspaceId: A.workspaceId, input: { conversationId: must(conv["a2"], "a2"), expectedVersion: 1, resolution: "no_reply_needed" } }));
    ok(await pipelineAs(A.users.RESPONDER).run(markDoneCommand, { workspaceId: A.workspaceId, input: { conversationId: must(conv["a3"], "a3"), expectedVersion: 1, resolution: "reviewed" } }));
    const previous = { generation: "previous" as const };
    await ingestAs(worker, A, contentA, sighting(baseA, { id: "fb_a4", parent: null, author: "user", createdAt: "2026-10-04T10:00:00.000Z", observedAt: "2026-10-04T10:00:00.000Z" }), previous);
    conv["a4"] = await conversationOf(A, "fb_a4");
    await ingestAs(worker, A, contentA, sighting(baseA, { id: "fb_a1_gap", parent: "fb_a1", author: "user", createdAt: "2026-10-05T10:00:00.000Z", observedAt: "2026-10-05T10:00:00.000Z" }), previous);
    await ingestAs(worker, A, contentA, sighting(baseA, { id: "fb_a2_gap", parent: "fb_a2", author: "user", createdAt: "2026-10-06T10:00:00.000Z", observedAt: new Date().toISOString() }), previous);
    await ingestAs(worker, A, contentA, sighting(baseA, { id: "fb_a3_brand", parent: "fb_a3", author: "brand", createdAt: "2026-10-07T10:00:00.000Z", observedAt: new Date().toISOString() }), previous);
    await ingestAs(worker, B, contentB, sighting(baseB, { id: "fb_b3", parent: null, author: "user", createdAt: "2026-10-08T09:00:00.000Z", observedAt: "2026-10-08T09:00:00.000Z" }), previous);
    conv["b3"] = await conversationOf(B, "fb_b3");
    // The gap's damage: a missing work item in each workspace, stale activity on three, a Done that did not reopen.
    expect(await item(must(conv["a4"], "a4"))).toBeUndefined();
    expect(await item(must(conv["b3"], "b3"))).toBeUndefined();
    expect(await item(must(conv["a2"], "a2"))).toMatchObject({ state: "DONE", version: 2 });
  });

  it("4a · dry run: the exact classification, from reads only — the database refuses writes, and nothing changed", async () => {
    const before = await snapshot(A);
    const dry = await reconcileWorkspaceWorkItems(worker, { workspaceId: A.workspaceId, dryRun: true, batchSize: 2, after: null });
    expect(dry.counts).toEqual({ inspected: 4, created: 1, repaired: 3, unchanged: 0, failed: 0, review: 1 });
    expect(dry.reviewIds).toEqual([conv["a2"]]);
    expect(dry.batches).toBe(3); // 2 + 2 + an empty last page
    expect(await snapshot(A)).toEqual(before);
  });

  it("4b · apply in bounded batches, interrupted after one batch and resumed with the same run: the totals equal the dry run; the other workspace is untouched", async () => {
    const beforeB = await snapshot(B);
    const first = await reconcileWorkspaceWorkItems(worker, { workspaceId: A.workspaceId, dryRun: false, batchSize: 2, after: null, maxBatches: 1 });
    expect(first.stoppedEarly).toBe(true);
    expect(first.next).not.toBeNull();
    const rest = await reconcileWorkspaceWorkItems(worker, { workspaceId: A.workspaceId, dryRun: false, batchSize: 2, after: first.next, runCorrelationId: first.runCorrelationId });
    expect(rest.stoppedEarly).toBe(false);
    const total = { inspected: first.counts.inspected + rest.counts.inspected, created: first.counts.created + rest.counts.created, repaired: first.counts.repaired + rest.counts.repaired,
      unchanged: first.counts.unchanged + rest.counts.unchanged, failed: first.counts.failed + rest.counts.failed, review: first.counts.review + rest.counts.review };
    expect(total).toEqual({ inspected: 4, created: 1, repaired: 3, unchanged: 0, failed: 0, review: 1 });
    expect(await snapshot(B)).toEqual(beforeB);
    firstRun = first;
  });

  it("5 · a repeated run changes nothing: all unchanged, no event, no audit row; the one `created` event carries the run's id", async () => {
    const before = await snapshot(A);
    const again = await reconcileWorkspaceWorkItems(worker, { workspaceId: A.workspaceId, dryRun: false, batchSize: 3, after: null });
    expect(again.counts).toEqual({ inspected: 4, created: 0, repaired: 0, unchanged: 4, failed: 0, review: 1 });
    expect(await snapshot(A)).toEqual(before);
    const created = await q<{ kind: string; initiator_kind: string; correlation_id: string }>("select kind, initiator_kind, correlation_id from workflow.workflow_events where work_item_id = $1", [conv["a4"]]);
    expect(created).toEqual([{ kind: "created", initiator_kind: "system_ingestion", correlation_id: firstRun.runCorrelationId }]);
  });

  it("state preservation: manual decisions keep state, resolution, attribution and version; activity equals the oracle everywhere", async () => {
    expect(await item(must(conv["a2"], "a2"))).toMatchObject({ state: "DONE", resolution: "no_reply_needed", version: 2, by: "user", user: A.users.MANAGER });
    expect(await item(must(conv["a3"], "a3"))).toMatchObject({ state: "DONE", resolution: "reviewed", version: 2, by: "user", user: A.users.RESPONDER });
    expect(await item(must(conv["a1"], "a1"))).toMatchObject({ state: "OPEN", version: 1, by: "migration" });
    expect(await item(must(conv["a4"], "a4"))).toMatchObject({ state: "OPEN", version: 1, by: "system_ingestion" });
    for (const name of ["a1", "a2", "a3", "a4"]) expect(must(await item(must(conv[name], name)), name).latest.toISOString(), name).toBe((await trueActivity(must(conv[name], name))).toISOString());
    // Audit: only the two manual Done decisions (actor user) — reconciliation wrote none.
    expect(await q("select action, actor_type from audit.audit_events where workspace_id = $1 order by occurred_at", [A.workspaceId])).toEqual([
      { action: "work_item.state_changed", actor_type: "user" }, { action: "work_item.state_changed", actor_type: "user" }]);
  });

  it("6 · concurrent ingestion (NEW worker) and reconciliation: reconciliation waits on the work item, then recomputes with the new member", async () => {
    const a4 = must(conv["a4"], "a4");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let projected!: () => void;
    const holding = new Promise<void>((resolve) => { projected = resolve; });
    const hold = (stores: IngestionStores): IngestionStores => ({ ...stores, workflow: { membersJoined: async (input) => { await stores.workflow.membersJoined(input); projected(); await gate; } } });
    const ingestion = ingestAs(worker, A, contentA, sighting(baseA, { id: "fb_a4_new", parent: "fb_a4", author: "user", createdAt: "2026-10-09T10:00:00.000Z", observedAt: "2026-10-09T10:00:00.000Z" }), { wrap: hold });
    await holding;
    const reconciling = reconcileWorkspaceWorkItems(worker2, { workspaceId: A.workspaceId, dryRun: false, batchSize: 10, after: null });
    let waitedOn: string | undefined;
    try {
      for (let n = 0; n < 100 && waitedOn === undefined; n += 1) {
        waitedOn = (await q<{ on: string | null }>(`select string_agg(distinct coalesce(l.relation::regclass::text, l.locktype), ',') as on from pg_locks l where l.pid in (select w.pid from pg_locks w where not w.granted)`))[0]?.on ?? undefined;
        if (waitedOn === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      release();
    }
    const [, report] = await Promise.all([ingestion, reconciling]);
    expect(waitedOn).toMatch(/work_items/);
    expect(report.counts.failed).toBe(0);
    expect(must(await item(a4), "a4").latest.toISOString()).toBe("2026-10-09T10:00:00.000Z");
    expect(await item(a4)).toMatchObject({ state: "OPEN", version: 2 }); // the new audience member, by the NEW worker
    expect(Number((await q<{ n: string }>("select count(*) as n from workflow.workflow_events where work_item_id = $1 and kind = 'created'", [a4]))[0]?.n)).toBe(1);
  });

  it("the list through the real command equals the oracle in every view; the other workspace sees none of it", async () => {
    for (const [view, state] of [["open", "OPEN"], ["done", "DONE"], [undefined, undefined]] as const) expect(await walk(A, view)).toEqual(await oracleOrder(A, state));
    expect(await walk(A, "done")).toEqual([conv["a3"], conv["a2"]]);
    const foreign = await pipelineAs(B.users.MANAGER).run(inboxListCommand, { workspaceId: A.workspaceId, input: {} });
    expect(foreign.status === "error" ? foreign.error.code : foreign.status).toBe("NOT_FOUND");
    // B still lacks its gap conversation (B was never reconciled): it is not listed — the reason the runbook reconciles every workspace.
    expect(await walk(B, undefined)).toEqual([conv["b2"], conv["b1"]]);
  });

  it("the operator CLI (loopback-only) reconciles the second workspace: dry run, then apply, then nothing left", () => {
    const run = (extra: readonly string[]) => {
      const result = spawnSync(process.execPath, ["tools/ops/workflow-reconcile.ts", "--database-url-env", "WF2C_LOCAL_WORKER_URL", "--workspace", B.workspaceId, "--batch", "2", ...extra], {
        cwd: process.cwd(), encoding: "utf8", env: { ...process.env, WF2C_LOCAL_WORKER_URL: cluster.target.runtimeUrls.worker }, timeout: 180_000,
      });
      const report = result.stdout.split("\n").filter((line) => line.startsWith('{"report"')).map((line) => (JSON.parse(line) as { report: ReconciliationReport }).report)[0];
      return { status: result.status, report, leaked: result.stdout.includes(cluster.target.runtimeUrls.worker) };
    };
    const dry = run([]);
    expect(dry).toMatchObject({ status: 0, leaked: false });
    expect(dry.report?.counts).toEqual({ inspected: 3, created: 1, repaired: 0, unchanged: 2, failed: 0, review: 0 });
    const applied = run(["--apply"]);
    expect(applied.status).toBe(0);
    expect(applied.report?.counts).toEqual({ inspected: 3, created: 1, repaired: 0, unchanged: 2, failed: 0, review: 0 });
    expect(run(["--apply"]).report?.counts).toEqual({ inspected: 3, created: 0, repaired: 0, unchanged: 3, failed: 0, review: 0 });
  }, 600_000);

  it("after reconciling every workspace, each lists exactly its own conversations in order", async () => {
    expect(await walk(B, undefined)).toEqual(await oracleOrder(B, undefined));
    expect(await walk(B, undefined)).toEqual([conv["b3"], conv["b2"], conv["b1"]]);
    expect(Number((await q<{ n: string }>("select count(*) as n from conversations.conversations c where not exists (select 1 from workflow.work_items w where w.id = c.id)"))[0]?.n)).toBe(0);
  });
});
