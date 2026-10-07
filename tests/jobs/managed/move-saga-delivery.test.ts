/**
 * Step 5H managed leg (Trigger.dev DEVELOPMENT + the Supabase development project): the Move saga's post-commit relay
 * wake-up (G5, TA-Q-31) on the real job runtime, with the production relay, saga handlers and tenant task wiring
 * (tasks/move-saga.ts). No sweeper is scheduled in this session: a row is dispatched only by a wake-up, or by this test
 * acting as the dispatch sweeper. No provider is called (synthetic connections, capability evaluation stubbed).
 *
 *   A  normal path       web commit → web wake-up → relay → release (job commit → job wake-up) → relay → activation
 *                        → … each routed row dispatched well before the sweeper's minimum age, one run per row
 *   B  lost wake-up      the web wake-up fails: the commit stands, the row stays PENDING, the sweeper ignores it
 *                        while young and recovers it after the minimum age → the saga completes exactly once
 *   C  duplicate wakes   every wake-up delivered three times (same key twice + a distinct key) → one run per row
 *   R  rollback          a request that rolls back after routing wakes nothing and leaves nothing
 *
 * Runs only through `npm run test:jobs:managed` (which starts the ephemeral dev session).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inject } from "vitest";
import { AppError } from "@/domain/errors";
import type { UserId } from "@/domain/ids";
import type { RuntimeDatabase } from "@/platform/db";
import type { JobRuntime } from "@/platform/jobs";
import { createTriggerDevRuntime } from "@/platform/jobs/trigger-dev";
import { createLogger } from "@/platform/observability";
import { DEFAULT_DELIVERY_CONFIG, sweepDispatch, type DeliveryDependencies } from "@/platform/outbox/delivery";
import { createConnectedAccountCommands } from "@/server/commands/connected-accounts";
import { createOutboxNotifier } from "@/server/jobs/outbox-notifier";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { createActionPipeline, type WorkspaceCommand } from "@/server/pipeline";
import type { OutboxNotice } from "@/platform/outbox";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { privilegedPool, runtimeDatabase } from "../../db/support/target";
import { cleanupWorld, seedWorld, type World } from "../../db/support/world";
import { FakeIdentity, verifiedUser } from "../../support/in-memory";
import { errorCode, expectOk } from "../../support/harness";

const POLL_MS = 3_000;
const DEADLINE_MS = 4 * 60_000;
const RELEASE = "connections.move.release_source";
const ACTIVATE = "connections.move.activate_destination";
const EVALUATE = "capability.evaluate_account";
const TERMINAL = ["COMPLETED", "FAILED", "CANCELED", "CRASHED", "SYSTEM_FAILURE", "EXPIRED", "TIMED_OUT"];

interface Row {
  readonly id: string;
  readonly topic: string;
  readonly status: string;
  readonly age_at_dispatch: number | null;
  readonly runs: number;
}

describe("Step 5H managed · Move saga post-commit relay wake-up (G5, TA-Q-31)", () => {
  const target = inject("dbTarget");
  let privileged: ReturnType<typeof privilegedPool>;
  let world: World;
  let web: RuntimeDatabase<"web">;
  let system: RuntimeDatabase<"system">;
  let runtime: JobRuntime;
  const enqueued: { readonly task: string; readonly runId: string }[] = [];
  const identity = new FakeIdentity();
  const logger = createLogger({ sink: () => undefined });
  const commands = createConnectedAccountCommands();
  const connections: Record<string, string> = {};

  const q = async <T>(text: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query(text, [...values])).rows as T[];
  const orgOf = (workspace: string): string => (workspace === world.B1 ? world.orgB : world.orgA);
  const asOwner = (): void => {
    identity.user = verifiedUser(world.users.ownerA as UserId, "owner-a@example.test");
  };
  const pipelineWith = (outboxCommitted?: (notices: readonly OutboxNotice[]) => Promise<void>) =>
    createActionPipeline({ identity, unitOfWork: createPostgresUnitOfWork(web), clock: () => new Date(), newId: randomUUID, logger, ...(outboxCommitted === undefined ? {} : { outboxCommitted }) });
  /** Delivery dependencies of this test acting as the dispatch sweeper (real job runtime, real clock). */
  const sweeperDeps = (): DeliveryDependencies => ({ system, runtime, registry: PRODUCTION_TASKS, logger, clock: () => new Date(), config: DEFAULT_DELIVERY_CONFIG });

  /** Only this world's rows may ever be pending while this leg runs. */
  const quiet = () => q("update system.outbox set status = 'DISPATCHED', dispatched_at = now() where status = 'PENDING' and organization_id = any($1::uuid[])", [[world.orgA, world.orgB]]);
  const discover = async (workspace: string, name: string): Promise<string> => {
    const id = randomUUID();
    await q(
      `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'facebook', $5, 'content_bearing', 'Synthetic asset', now(), now(), now())`,
      [id, orgOf(workspace), workspace, connections[workspace], name],
    );
    return id;
  };
  /** An asset ACTIVE in A1 and discovered by A2; returns A2's discovered asset id. Setup only: nothing is woken. */
  const movable = async (): Promise<string> => {
    const name = `sim_asset_${randomUUID().slice(0, 12)}`;
    const source = await discover(world.A1, name);
    asOwner();
    expect(expectOk(await pipelineWith().run(commands.link, { workspaceId: world.A1, input: { discoveredAssetId: source } })).kind).toBe("linked");
    const destination = await discover(world.A2, name);
    await quiet();
    return destination;
  };
  const rowsOf = (moveId: string) =>
    q<Row>(
      `select o.id, o.topic, o.status,
              extract(epoch from (o.dispatched_at - o.created_at))::float as age_at_dispatch,
              (select count(*)::int from system.outbox_runs r where r.outbox_id = o.id) as runs
         from system.outbox o
        where o.subject_ids->>'move_id' = $1::text
           or (o.topic = $2 and o.subject_ids->>'connected_account_id' in (select connected_account_id::text from connections.asset_moves where move_id = $1::uuid and side = 'INCOMING'))
        order by case o.topic when $3 then 0 when $4 then 1 else 2 end, o.created_at`,
      [moveId, EVALUATE, RELEASE, ACTIVATE],
    );
  const incomingStatus = async (moveId: string): Promise<string | undefined> =>
    (await q<{ status: string }>("select status from connections.asset_moves where move_id = $1 and side = 'INCOMING'", [moveId]))[0]?.status;
  /** Waits until the saga completed AND its capability hand-off was delivered (or the deadline passes). */
  const settle = async (moveId: string): Promise<Row[]> => {
    const deadline = Date.now() + DEADLINE_MS;
    let rows: Row[] = [];
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      rows = await rowsOf(moveId);
      if ((await incomingStatus(moveId)) === "COMPLETED" && rows.length === 3 && rows.every((row) => row.status === "DISPATCHED")) break;
    }
    return rows;
  };
  /** Every vendor run this leg's rows got has finished: nothing is left executing or queued. */
  const runsTerminal = async (moveId: string): Promise<readonly string[]> => {
    const runIds = (await q<{ run_id: string }>(
      "select r.run_id from system.outbox_runs r join system.outbox o on o.id = r.outbox_id where o.id = any($1::uuid[])", [(await rowsOf(moveId)).map((row) => row.id)])).map((row) => row.run_id);
    const statuses: string[] = [];
    for (const runId of runIds) {
      let status = "UNKNOWN";
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        status = (await runtime.getRun(runId)).status;
        if (TERMINAL.includes(status)) break;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      statuses.push(status);
    }
    return statuses;
  };
  const effects = async (moveId: string) => ({
    audits: (await q<{ action: string }>("select action from audit.audit_events where target_id = $1 order by recorded_at, action", [moveId])).map((row) => row.action),
    movedIn: (await q<{ n: number }>(
      "select count(*)::int as n from connections.connected_account_events where move_id = $1 and event_type = 'MOVED_IN'", [moveId]))[0]?.n,
    activeInDestination: (await q<{ n: number }>(
      `select count(*)::int as n from connections.connected_accounts a join connections.asset_moves m on m.move_id = $1 and m.side = 'INCOMING'
        where a.workspace_id = m.workspace_id and a.provider_asset_id = m.provider_asset_id and a.status = 'ACTIVE'`, [moveId]))[0]?.n,
    effectKeys: (await q<{ n: number }>("select count(*)::int as n from idempotency.effect_keys where effect_key like $1", [`connections.move.%:${moveId}%`]))[0]?.n,
  });
  const report = (label: string, value: unknown): void => {
    process.stdout.write(`${label} ${JSON.stringify(value)}\n`);
  };

  beforeAll(async () => {
    const secretKey = process.env["TRIGGER_SECRET_KEY"] ?? "";
    if (!secretKey.startsWith("tr_dev_")) throw new Error("managed job suite refused: a DEVELOPMENT key is required");
    privileged = privilegedPool(target);
    world = await seedWorld(privileged);
    web = runtimeDatabase(target, "web", 2);
    system = runtimeDatabase(target, "system", 2);
    const real = createTriggerDevRuntime({ secretKey });
    runtime = {
      async enqueue(request) {
        const result = await real.enqueue(request);
        enqueued.push({ task: request.task, runId: result.runId });
        return result;
      },
      getRun: (runId) => real.getRun(runId),
    };
    for (const workspace of [world.A1, world.A2]) {
      const id = randomUUID();
      await q(
        `insert into connections.connections (id, organization_id, workspace_id, provider, status, authorized_by, authorized_at, version, created_at, updated_at)
         values ($1, $2, $3, 'simulator', 'ACTIVE', $4, now(), 1, now(), now())`,
        [id, world.orgA, workspace, world.users.ownerA],
      );
      connections[workspace] = id;
    }
  });

  afterAll(async () => {
    await Promise.all([web.end(), system.end()]);
    await privileged.query("delete from idempotency.effect_keys where workspace_id = any($1::uuid[])", [[world.A1, world.A2, world.B1]]);
    await cleanupWorld(privileged, [world.orgA, world.orgB]);
    await privileged.end();
  });

  it("A · normal path: each committed routed row wakes the relay and is dispatched well before the sweeper's minimum age", async () => {
    const discovered = await movable();
    const notified: string[][] = [];
    const notifier = createOutboxNotifier(runtime);
    asOwner();
    const output = expectOk(await pipelineWith(async (notices) => {
      notified.push(notices.map((notice) => notice.id));
      await notifier(notices);
    }).run(commands.requestMove, { workspaceId: world.A2, input: { discoveredAssetId: discovered } }));
    if (output.kind !== "requested") throw new Error("not requested");
    const rows = await settle(output.moveId);
    const statuses = await runsTerminal(output.moveId);
    const result = await effects(output.moveId);
    report("A", { rows: rows.map(({ topic, status, age_at_dispatch, runs }) => ({ topic, status, ageAtDispatchSeconds: age_at_dispatch === null ? null : Math.round(age_at_dispatch), runs })), statuses, result, webWakeUps: notified.length });

    expect(notified).toEqual([[rows[0]?.id]]); // the web woke the relay once, for its committed release row
    expect(rows.map((row) => row.topic)).toEqual([RELEASE, ACTIVATE, EVALUATE]);
    for (const row of rows) {
      expect(row.status, row.topic).toBe("DISPATCHED");
      expect(row.runs, row.topic).toBe(1);
      expect(row.age_at_dispatch ?? Number.POSITIVE_INFINITY, row.topic).toBeLessThan(DEFAULT_DELIVERY_CONFIG.dispatchSweepMinAgeSeconds);
    }
    expect(statuses.every((status) => status === "COMPLETED")).toBe(true);
    expect(result).toEqual({ audits: ["connected_account.move_requested", "connected_account.moved_out", "connected_account.moved_in"], movedIn: 1, activeInDestination: 1, effectKeys: 2 });
    // Nothing is left for the sweeper.
    expect((await sweepDispatch(sweeperDeps())).claimed).toBe(0);
  });

  it("C · duplicate wake-ups are harmless: one run per durable row, one effect", async () => {
    const discovered = await movable();
    const notifier = createOutboxNotifier(runtime);
    asOwner();
    const output = expectOk(await pipelineWith(async (notices) => {
      await notifier(notices); // same relay key twice …
      await notifier(notices);
      await notifier([{ id: randomUUID(), correlationId: notices[0]?.correlationId ?? "corr-duplicate-wake" }]); // … and a distinct one
    }).run(commands.requestMove, { workspaceId: world.A2, input: { discoveredAssetId: discovered } }));
    if (output.kind !== "requested") throw new Error("not requested");
    const rows = await settle(output.moveId);
    const statuses = await runsTerminal(output.moveId);
    const result = await effects(output.moveId);
    report("C", { rows: rows.map(({ topic, status, runs }) => ({ topic, status, runs })), statuses, result });
    expect(rows.map((row) => [row.topic, row.status, row.runs])).toEqual([[RELEASE, "DISPATCHED", 1], [ACTIVATE, "DISPATCHED", 1], [EVALUATE, "DISPATCHED", 1]]);
    expect(statuses.every((status) => status === "COMPLETED")).toBe(true);
    expect(result).toMatchObject({ movedIn: 1, activeInDestination: 1, effectKeys: 2 });
    expect(result.audits.filter((action) => action === "connected_account.moved_in")).toHaveLength(1);
  });

  it("B · lost web wake-up: the commit stands, the row waits PENDING, the sweeper ignores it while young and recovers it once", async () => {
    const discovered = await movable();
    asOwner();
    const output = expectOk(await pipelineWith(() => Promise.reject(new Error("wake-up lost"))).run(commands.requestMove, { workspaceId: world.A2, input: { discoveredAssetId: discovered } }));
    if (output.kind !== "requested") throw new Error("not requested");
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const before = await rowsOf(output.moveId);
    expect(before.map((row) => [row.topic, row.status, row.runs])).toEqual([[RELEASE, "PENDING", 0]]); // durable, committed, undispatched
    expect(await incomingStatus(output.moveId)).toBe("REQUESTED");
    expect((await sweepDispatch(sweeperDeps())).claimed).toBe(0); // too young: the sweeper is recovery, not the normal path
    const createdAt = (await q<{ age: number }>("select extract(epoch from (now() - created_at))::float as age from system.outbox where id = $1", [before[0]?.id]))[0]?.age ?? 0;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, (DEFAULT_DELIVERY_CONFIG.dispatchSweepMinAgeSeconds + 3 - createdAt) * 1000)));
    expect((await sweepDispatch(sweeperDeps())).dispatched).toBe(1); // recovered by the sweeper
    const rows = await settle(output.moveId);
    const statuses = await runsTerminal(output.moveId);
    const result = await effects(output.moveId);
    report("B", { rows: rows.map(({ topic, status, age_at_dispatch, runs }) => ({ topic, status, ageAtDispatchSeconds: age_at_dispatch === null ? null : Math.round(age_at_dispatch), runs })), statuses, result });
    expect(rows.map((row) => [row.topic, row.status, row.runs])).toEqual([[RELEASE, "DISPATCHED", 1], [ACTIVATE, "DISPATCHED", 1], [EVALUATE, "DISPATCHED", 1]]);
    expect(rows[0]?.age_at_dispatch ?? 0).toBeGreaterThanOrEqual(DEFAULT_DELIVERY_CONFIG.dispatchSweepMinAgeSeconds); // the sweeper's row
    expect(rows[1]?.age_at_dispatch ?? Number.POSITIVE_INFINITY).toBeLessThan(DEFAULT_DELIVERY_CONFIG.dispatchSweepMinAgeSeconds); // then the job's own wake-up
    expect(statuses.every((status) => status === "COMPLETED")).toBe(true);
    expect(result).toEqual({ audits: ["connected_account.move_requested", "connected_account.moved_out", "connected_account.moved_in"], movedIn: 1, activeInDestination: 1, effectKeys: 2 });
  });

  it("R · a request that rolls back after routing wakes nothing and leaves nothing", async () => {
    const discovered = await movable();
    let wakeUps = 0;
    const failing: WorkspaceCommand<{ readonly discoveredAssetId: string }, never, never> = {
      ...commands.requestMove,
      name: "test.managed_request_then_fail",
      async execute(context, input, tx, env) {
        await commands.requestMove.execute(context, input, tx, env);
        throw new AppError("CONFLICT", {});
      },
      audit: () => undefined,
      respond: (value) => value,
    };
    asOwner();
    const before = enqueued.length;
    const result = await pipelineWith(() => {
      wakeUps += 1;
      return Promise.resolve();
    }).run(failing, { workspaceId: world.A2, input: { discoveredAssetId: discovered } });
    expect(errorCode(result)).toBe("CONFLICT");
    expect(wakeUps).toBe(0);
    expect(enqueued.length).toBe(before);
    expect(await q("select 1 from connections.asset_moves where workspace_id = $1", [world.A2])).toHaveLength(3); // only A, B, C
    expect(await q("select 1 from system.outbox where status = 'PENDING' and organization_id = $1", [world.orgA])).toHaveLength(0);
  });

  it("this process enqueued only relay wake-ups and saga/stub tasks (the session registers no provider task)", () => {
    const tasks = new Set(enqueued.map((entry) => entry.task));
    report("enqueued tasks", [...tasks].sort());
    for (const task of tasks) expect(["outbox.relay", RELEASE, ACTIVATE, "connections.move.reject_destination", EVALUATE]).toContain(task);
  });
});
