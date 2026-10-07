/**
 * T-27 — permanent Step 3 regression suite (TA §55; R6, R7; TA §19.3). Crashed runs and lost dispatches
 * recover safely and every durable domain effect happens exactly once.
 *
 * Real PostgreSQL throughout (local cluster, or the managed project through the transaction pooler):
 * the unchanged action pipeline writes state + outbox atomically (web login), the system relay and sweepers
 * deliver (system login), and tenant jobs run through the production wrapper (worker login, sealed
 * workspace) with the production domain-idempotency claim. Only the job runtime is a test double that models
 * the Trigger.dev behavior validated in TA-Q-04; the managed Trigger.dev leg is a separate, explicit suite.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@/domain/errors";
import { isUuid, parseUserId, type UserId } from "@/domain/ids";
import { object, oneOf, parsed } from "@/domain/validation";
import { readSwitchRows, withUserScope, withWorkspaceJobScope, type RuntimeDatabase } from "@/platform/db";
import { withSystemScope } from "@/platform/db/system-scope";
import { createSwitchReader, resolveSwitch } from "@/platform/flags";
import {
  LANE_DEFINITIONS,
  InvalidJobPayloadError,
  NonRetryableJobError,
  SYSTEM_QUEUE,
  TaskRegistryError,
  defineTaskRegistry,
  parseSystemJobPayload,
  parseTenantJobPayload,
  queueFor,
  runSystemJob,
  runTenantJob,
  type TenantJobContext,
} from "@/platform/jobs";
import { relayPass, sweepDispatch, sweepRunOutcomes, type DeliveryConfig, type DeliveryDependencies } from "@/platform/outbox/delivery";
import { createLogger } from "@/platform/observability";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { createActionPipeline, type UserCommand, type WorkspaceCommand } from "@/server/pipeline";
import { clearSwitch, setSwitch } from "../../../tools/ops/switches";
import { FakeJobRuntime, type FakeHandler } from "../../support/fake-job-runtime";
import { WEB_ENVIRONMENT_GUARD, codeWithoutForbiddenList, findReferences, sourceFiles } from "../../support/source-scan";
import { FakeIdentity, verifiedUser } from "../../support/in-memory";
import { errorCode, expectOk } from "../../support/harness";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld, seedWorld, type World } from "../support/world";
import { sqlState } from "./helpers";

const RETRY = { maxAttempts: 3, factor: 2, minDelayMs: 100, maxDelayMs: 1_000, randomize: false } as const;

/** Test tasks covering the lanes; real workloads arrive in later steps. */
const TASKS = defineTaskRegistry([
  { name: "testjobs.record_effect", scope: "workspace", lane: 2, retry: RETRY, concurrency: { by: "workspace" }, subjects: ["item_id"] },
  { name: "testjobs.unguarded_effect", scope: "workspace", lane: 4, retry: RETRY, concurrency: { by: "none" }, subjects: ["item_id"] },
  { name: "testjobs.permanent_failure", scope: "workspace", lane: 1, retry: RETRY, concurrency: { by: "subject", subject: "item_id" }, subjects: ["item_id"] },
  { name: "testjobs.cross_tenant_probe", scope: "workspace", lane: 3, retry: { ...RETRY, maxAttempts: 1 }, concurrency: { by: "none" }, subjects: ["item_id"] },
  { name: "testjobs.backfill_probe", scope: "workspace", lane: 5, retry: RETRY, concurrency: { by: "workspace" }, subjects: ["item_id"] },
]);
type TestTask = "testjobs.record_effect" | "testjobs.unguarded_effect" | "testjobs.permanent_failure" | "testjobs.cross_tenant_probe" | "testjobs.backfill_probe";
const TEST_TASK_NAMES: readonly TestTask[] = ["testjobs.record_effect", "testjobs.unguarded_effect", "testjobs.permanent_failure", "testjobs.cross_tenant_probe", "testjobs.backfill_probe"];

const CONFIG: DeliveryConfig = {
  batchSize: 200,
  leaseSeconds: 30,
  backoff: { baseSeconds: 5, maxSeconds: 60 },
  dispatchSweepMinAgeSeconds: 60,
  dispatchSloSeconds: 120,
  maxRecoveries: 2,
  outcomeBatchSize: 200,
  unknownObservation: { maxChecks: 4, maxSeconds: 600 },
};

export function defineT27Suite(getTarget: () => DbTarget): void {
  let target: DbTarget;
  let privileged: pg.Pool;
  let world: World;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let system: RuntimeDatabase<"system">;
  let roleOids: string;
  let now = new Date();
  const advance = (seconds: number): void => {
    now = new Date(now.getTime() + seconds * 1000);
  };
  const logLines: string[] = [];
  const logger = createLogger({ sink: (line) => logLines.push(line), now: () => now });
  const identity = new FakeIdentity();
  const nudges: string[][] = [];
  let pipeline: ReturnType<typeof createActionPipeline>;
  let runtime: FakeJobRuntime;

  const ownerA = (): UserId => world.users.ownerA as UserId;

  const effectHandlers: Record<TestTask, (context: TenantJobContext) => Promise<unknown>> = {
    "testjobs.record_effect": async ({ tx, payload, claimEffect }) => {
      const item = payload.subjectIds["item_id"] ?? "";
      if ((await claimEffect(`t27.effect:${item}`)) === "already_applied") return "skipped";
      await tx.execute(sql`insert into t26_fixture.conversations (id, workspace_id, title) values (${randomUUID()}, ${payload.workspaceId}, ${`effect ${item}`})`);
      return "applied";
    },
    "testjobs.unguarded_effect": async ({ tx, payload }) => {
      const item = payload.subjectIds["item_id"] ?? "";
      await tx.execute(sql`insert into t26_fixture.conversations (id, workspace_id, title) values (${randomUUID()}, ${payload.workspaceId}, ${`unguarded ${item}`})`);
    },
    "testjobs.permanent_failure": () => Promise.reject(new AppError("NOT_FOUND", {})),
    "testjobs.cross_tenant_probe": async ({ tx }) => {
      // Tries to see and write another workspace from inside a job bound to this one.
      const seen = await tx.execute<{ n: number }>(sql`select count(*)::int as n from t26_fixture.conversations where workspace_id = ${world.B1}`);
      if ((seen.rows[0]?.n ?? -1) !== 0) throw new Error("cross-tenant read");
      await tx.execute(sql`insert into t26_fixture.conversations (id, workspace_id, title) values (${randomUUID()}, ${world.B1}, 'smuggled')`);
    },
    "testjobs.backfill_probe": () => Promise.resolve(),
  };

  const handlers = (): ReadonlyMap<string, FakeHandler> =>
    new Map(TEST_TASK_NAMES.map((name) => [name, (payload: unknown, run) => runTenantJob({ registry: TASKS, worker, logger }, name, payload, run, effectHandlers[name])]));

  const deliveryDeps = (): DeliveryDependencies => ({ system, runtime, registry: TASKS, logger, clock: () => now, config: CONFIG });

  /** A workspace command that appends one outbox row (and optionally fails after appending). */
  const enqueueCommand: WorkspaceCommand<{ readonly task: TestTask; readonly itemId: string; readonly fail: "yes" | "no" }, string, string> = {
    scope: "workspace",
    name: "test.t27_enqueue",
    permission: "workflow.internal",
    requiresStandardMode: false,
    validate: object({ task: oneOf(TEST_TASK_NAMES), itemId: parsed((value) => (isUuid(value) ? value : undefined)), fail: oneOf(["yes", "no"] as const) }),
    async execute(context, input, tx, env) {
      const id = randomUUID();
      await tx.outbox.append({
        id,
        topic: input.task,
        organizationId: context.organizationId,
        workspaceId: context.workspaceId,
        subjectIds: { item_id: input.itemId },
        correlationId: env.correlationId,
        initiator: { type: "user", userId: context.userId },
        dispatchKey: `${input.task}:${input.itemId}`,
        createdAt: env.now,
      });
      if (input.fail === "yes") throw new AppError("CONFLICT", {});
      return id;
    },
    audit: () => undefined,
    respond: (id) => id,
  };

  async function commitWork(task: TestTask, itemId: string = randomUUID()): Promise<{ readonly outboxId: string; readonly itemId: string }> {
    identity.user = verifiedUser(ownerA(), "owner-a@example.test");
    const outboxId = expectOk(await pipeline.run(enqueueCommand, { workspaceId: world.A1, input: { task, itemId, fail: "no" } }));
    return { outboxId, itemId };
  }

  const oracle = async <T extends pg.QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(text, [...values])).rows;
  const effectCount = async (prefix: "effect" | "unguarded", itemId: string): Promise<number> =>
    (await oracle<{ n: number }>("select count(*)::int as n from t26_fixture.conversations where title = $1", [`${prefix} ${itemId}`]))[0]?.n ?? -1;
  const row = async (outboxId: string) =>
    (await oracle<{ status: string; run_outcome: string | null; recovery_count: number; dispatch_attempts: number; last_failure_class: string | null; slo_breached_at: Date | null; claimed_until: Date | null }>(
      "select status, run_outcome, recovery_count, dispatch_attempts, last_failure_class, slo_breached_at, claimed_until from system.outbox where id = $1", [outboxId]))[0];
  const runsOf = async (outboxId: string) =>
    oracle<{ run_id: string; last_status: string | null; recovery_generation: number }>(
      "select run_id, last_status, recovery_generation from system.outbox_runs where outbox_id = $1 order by dispatched_at, dispatch_attempt", [outboxId]);
  const foundationRoleOids = async (): Promise<string> =>
    JSON.stringify(await oracle("select rolname, oid::int as oid from pg_roles where rolname in ('web_login','worker_login','system_login','app_owner','app_worker','app_system') order by 1"));

  /** Full delivery cycle: relay → execute → observe outcome (→ recover → execute) until quiet. */
  async function deliver(rounds = 4): Promise<void> {
    await relayPass(deliveryDeps());
    for (let round = 0; round < rounds; round += 1) {
      await runtime.drain();
      await sweepRunOutcomes(deliveryDeps());
    }
  }

  beforeAll(async () => {
    target = getTarget();
    privileged = privilegedPool(target);
    roleOids = await foundationRoleOids();
    world = await seedWorld(privileged);
    web = runtimeDatabase(target, "web", 2);
    worker = runtimeDatabase(target, "worker", 2);
    system = runtimeDatabase(target, "system", 2);
    pipeline = createActionPipeline({
      identity,
      unitOfWork: createPostgresUnitOfWork(web),
      clock: () => now,
      newId: randomUUID,
      logger,
      outboxCommitted: (messages) => {
        nudges.push(messages.map((message) => message.id));
        return Promise.resolve();
      },
    });
  });

  beforeEach(() => {
    runtime = new FakeJobRuntime(handlers(), (task) => TASKS.get(task)?.retry ?? RETRY);
    now = new Date();
    logLines.length = 0;
  });

  afterAll(async () => {
    await Promise.all([web.end(), worker.end(), system.end()]);
    await cleanupWorld(privileged, [world.orgA, world.orgB]);
    await privileged.end();
  });

  describe("T-27 · transactional outbox delivery", () => {
    it("1 · committed outbox work is dispatched, executed and recorded COMPLETED, with a post-commit nudge", async () => {
      const work = await commitWork("testjobs.record_effect");
      expect(nudges.at(-1)).toEqual([work.outboxId]);
      expect((await relayPass(deliveryDeps())).dispatched).toBeGreaterThanOrEqual(1);
      expect(await row(work.outboxId)).toMatchObject({ status: "DISPATCHED", run_outcome: null, dispatch_attempts: 1 });
      await runtime.drain();
      await sweepRunOutcomes(deliveryDeps());
      expect(await row(work.outboxId)).toMatchObject({ status: "DISPATCHED", run_outcome: "COMPLETED" });
      expect(await effectCount("effect", work.itemId)).toBe(1);
      const request = runtime.enqueued.find((entry) => entry.payload.scope === "workspace" && entry.payload.outboxId === work.outboxId);
      expect(request).toMatchObject({ task: "testjobs.record_effect", lane: 2, dispatchKey: `testjobs.record_effect:${work.itemId}`, concurrencyKey: `ws:${world.A1}` });
    });

    it("2 · a rolled-back domain transaction never dispatches work", async () => {
      identity.user = verifiedUser(ownerA(), "owner-a@example.test");
      const before = nudges.length;
      const itemId = randomUUID();
      expect(errorCode(await pipeline.run(enqueueCommand, { workspaceId: world.A1, input: { task: "testjobs.record_effect", itemId, fail: "yes" } }))).toBe("CONFLICT");
      expect(nudges.length).toBe(before);
      expect(await oracle("select 1 from system.outbox where dispatch_key = $1", [`testjobs.record_effect:${itemId}`])).toEqual([]);
      await deliver();
      expect(runtime.enqueued.some((entry) => entry.dispatchKey === `testjobs.record_effect:${itemId}`)).toBe(false);
      expect(await effectCount("effect", itemId)).toBe(0);
    });

    it("3 · duplicate and concurrent relay passes produce one run and one durable effect", async () => {
      const work = await commitWork("testjobs.record_effect");
      await Promise.all([relayPass(deliveryDeps()), relayPass(deliveryDeps()), relayPass(deliveryDeps())]);
      await relayPass(deliveryDeps());
      const enqueues = runtime.enqueued.filter((entry) => entry.dispatchKey === `testjobs.record_effect:${work.itemId}`);
      expect(enqueues).toHaveLength(1);
      await deliver();
      expect(await runsOf(work.outboxId)).toHaveLength(1);
      expect(await effectCount("effect", work.itemId)).toBe(1);
    });

    it("4 · a relay crash after enqueue but before recording recovers to the same run and one effect", async () => {
      const work = await commitWork("testjobs.record_effect");
      const crashing: FakeJobRuntime = Object.assign(Object.create(runtime) as FakeJobRuntime, {
        enqueue: async (request: Parameters<FakeJobRuntime["enqueue"]>[0]) => {
          await runtime.enqueue(request);
          throw new Error("relay process crashed after enqueue");
        },
      });
      await expect(relayPass({ ...deliveryDeps(), runtime: crashing })).rejects.toThrow("relay process crashed");
      expect(await row(work.outboxId)).toMatchObject({ status: "PENDING" });
      expect((await row(work.outboxId))?.claimed_until).not.toBeNull();
      // Leased: another relay right now skips it; after the lease the same dispatch key returns the same run.
      expect((await relayPass(deliveryDeps())).claimed).toBe(0);
      advance(CONFIG.leaseSeconds + 1);
      await relayPass(deliveryDeps());
      expect(await row(work.outboxId)).toMatchObject({ status: "DISPATCHED" });
      expect(new Set(runtime.enqueued.filter((entry) => entry.dispatchKey === `testjobs.record_effect:${work.itemId}`).map(() => "same"))).toEqual(new Set(["same"]));
      expect(runtime.runs.size).toBe(1);
      await deliver();
      expect(await effectCount("effect", work.itemId)).toBe(1);
    });

    it("5 · the dispatch sweeper recovers a lost dispatch and alerts once past the SLO", async () => {
      const work = await commitWork("testjobs.record_effect");
      // The post-commit relay never ran (lost nudge). Too young for the sweeper first…
      expect((await sweepDispatch(deliveryDeps())).claimed).toBe(0);
      // …then the job runtime is down when the sweeper tries: back-off, not a hot loop.
      advance(CONFIG.dispatchSweepMinAgeSeconds + 1);
      runtime.failNextEnqueue = "unavailable";
      const first = await sweepDispatch(deliveryDeps());
      expect(first.failed).toBeGreaterThanOrEqual(1);
      expect(await row(work.outboxId)).toMatchObject({ status: "PENDING", last_failure_class: "enqueue_unavailable", dispatch_attempts: 1 });
      expect((await relayPass(deliveryDeps())).claimed).toBe(0); // backing off
      advance(CONFIG.dispatchSloSeconds);
      const second = await sweepDispatch(deliveryDeps());
      expect(second.dispatched).toBeGreaterThanOrEqual(1);
      expect(await row(work.outboxId)).toMatchObject({ status: "DISPATCHED", last_failure_class: null });
      await deliver();
      expect(await effectCount("effect", work.itemId)).toBe(1);

      const late = await commitWork("testjobs.record_effect");
      runtime.failNextEnqueue = "rejected";
      advance(CONFIG.dispatchSloSeconds + 1);
      await sweepDispatch(deliveryDeps());
      expect((await row(late.outboxId))?.slo_breached_at).not.toBeNull();
      expect(logLines.some((line) => line.includes("outbox.dispatch.slo_breached") && line.includes(late.outboxId))).toBe(true);
      await sweepDispatch(deliveryDeps());
      expect(logLines.filter((line) => line.includes("outbox.dispatch.slo_breached") && line.includes(late.outboxId))).toHaveLength(1);
    });
  });

  describe("T-27 · retries and permanent failures", () => {
    it("6 · a transient failure retries according to the task's policy, then succeeds once", async () => {
      const work = await commitWork("testjobs.record_effect");
      runtime.fault = (_run, attempt) => (attempt < 3 ? "transient" : undefined);
      await deliver();
      expect(await row(work.outboxId)).toMatchObject({ run_outcome: "COMPLETED" });
      const [run] = await runsOf(work.outboxId);
      expect(runtime.runs.get(run?.run_id ?? "")?.attemptCount).toBe(RETRY.maxAttempts);
      expect(await effectCount("effect", work.itemId)).toBe(1);
    });

    it("6b · a failure that never clears exhausts exactly maxAttempts and is surfaced FAILED", async () => {
      const work = await commitWork("testjobs.record_effect");
      runtime.fault = () => "transient";
      await deliver();
      expect(await row(work.outboxId)).toMatchObject({ run_outcome: "FAILED", last_failure_class: "run_failed" });
      expect([...runtime.runs.values()].find((run) => run.request.dispatchKey.endsWith(work.itemId))?.attemptCount).toBe(RETRY.maxAttempts);
    });

    it("7 · a non-retryable failure stops after one attempt and stays FAILED", async () => {
      const work = await commitWork("testjobs.permanent_failure");
      await deliver();
      expect(await row(work.outboxId)).toMatchObject({ run_outcome: "FAILED", last_failure_class: "run_failed" });
      const runs = await runsOf(work.outboxId);
      expect(runs).toHaveLength(1);
      expect(runtime.runs.get(runs[0]?.run_id ?? "")?.attemptCount).toBe(1);
      expect(logLines.some((line) => line.includes("outbox.run.failed") && line.includes(work.outboxId))).toBe(true);
    });
  });

  describe("T-27 · domain idempotency (R6)", () => {
    it("8 · vendor idempotency alone is insufficient; the domain claim still protects the effect", async () => {
      const itemId = randomUUID();
      const payload = (task: TestTask) => ({
        v: 1, scope: "workspace", task, workspaceId: world.A1, outboxId: randomUUID(), subjectIds: { item_id: itemId },
        correlationId: `corr-t27-${itemId}`, initiator: { type: "system" },
      });
      // Two deliveries of the same work under DIFFERENT vendor keys (dedup lost): both runs execute.
      for (const task of ["testjobs.record_effect", "testjobs.unguarded_effect"] as const) {
        await runtime.enqueue({ task, payload: payload(task) as never, dispatchKey: `${task}:a:${itemId}`, lane: 2 });
        await runtime.enqueue({ task, payload: payload(task) as never, dispatchKey: `${task}:b:${itemId}`, lane: 2 });
      }
      await runtime.drain();
      expect(await effectCount("unguarded", itemId)).toBe(2); // vendor keys alone: duplicate effect
      expect(await effectCount("effect", itemId)).toBe(1); // domain claim: one effect
      expect(await oracle("select count(*)::int as n from idempotency.effect_keys where effect_key = $1", [`t27.effect:${itemId}`])).toEqual([{ n: 1 }]);
    });

    it("8b · an effect whose transaction rolls back releases its claim (a later run applies it)", async () => {
      const itemId = randomUUID();
      const payload = { v: 1, scope: "workspace", task: "testjobs.record_effect", workspaceId: world.A1, outboxId: randomUUID(), subjectIds: { item_id: itemId }, correlationId: `corr-t27-${itemId}`, initiator: { type: "system" } };
      await expect(runTenantJob({ registry: TASKS, worker, logger }, "testjobs.record_effect", payload, { runId: "run_rollback", attempt: 1 }, async (context) => {
        await effectHandlers["testjobs.record_effect"](context);
        throw new Error("fails after applying, before commit");
      })).rejects.toThrow();
      expect(await effectCount("effect", itemId)).toBe(0);
      await runTenantJob({ registry: TASKS, worker, logger }, "testjobs.record_effect", payload, { runId: "run_retry", attempt: 2 }, effectHandlers["testjobs.record_effect"]);
      expect(await effectCount("effect", itemId)).toBe(1);
    });
  });

  describe("T-27 · run-outcome sweeper (R7)", () => {
    it("9 · a CRASHED run is observed and re-dispatched under the same dispatch key as a new run", async () => {
      const work = await commitWork("testjobs.record_effect");
      runtime.fault = (run) => (run.id === [...runtime.runs.keys()][0] ? "crash_before" : undefined);
      await relayPass(deliveryDeps());
      await runtime.drain();
      const [first] = await runsOf(work.outboxId);
      expect(runtime.runs.get(first?.run_id ?? "")?.status).toBe("CRASHED");
      const sweep = await sweepRunOutcomes(deliveryDeps());
      expect(sweep.recovered).toBeGreaterThanOrEqual(1);
      const runs = await runsOf(work.outboxId);
      expect(runs).toHaveLength(2);
      expect(runs[0]).toMatchObject({ last_status: "CRASHED", recovery_generation: 0 });
      expect(runs[1]?.run_id).not.toBe(runs[0]?.run_id);
      expect(runtime.enqueued.filter((entry) => entry.dispatchKey === `testjobs.record_effect:${work.itemId}`).map((entry) => entry.dispatchKey))
        .toEqual([`testjobs.record_effect:${work.itemId}`, `testjobs.record_effect:${work.itemId}`]);
      await deliver();
      expect(await row(work.outboxId)).toMatchObject({ run_outcome: "COMPLETED", recovery_count: 1 });
    });

    it("10 · a crash AFTER the effect committed recovers with exactly one durable effect", async () => {
      const work = await commitWork("testjobs.record_effect");
      let crashed = false;
      runtime.fault = () => {
        if (crashed) return undefined;
        crashed = true;
        return "crash_after";
      };
      await deliver();
      expect(await row(work.outboxId)).toMatchObject({ run_outcome: "COMPLETED", recovery_count: 1 });
      expect(await runsOf(work.outboxId)).toHaveLength(2);
      expect(await effectCount("effect", work.itemId)).toBe(1);
    });

    it("11 · SYSTEM_FAILURE follows the same bounded recovery path", async () => {
      const work = await commitWork("testjobs.record_effect");
      runtime.fault = () => "system_failure";
      await deliver(CONFIG.maxRecoveries + 3);
      expect(await row(work.outboxId)).toMatchObject({ run_outcome: "RECOVERY_EXHAUSTED", recovery_count: CONFIG.maxRecoveries, last_failure_class: "run_system_failure" });
      expect(await runsOf(work.outboxId)).toHaveLength(CONFIG.maxRecoveries + 1);
      expect(await effectCount("effect", work.itemId)).toBe(0);
    });

    it("12 · FAILED and CANCELED runs are recorded and never blindly re-dispatched", async () => {
      const failed = await commitWork("testjobs.permanent_failure");
      const canceled = await commitWork("testjobs.record_effect");
      await relayPass(deliveryDeps());
      const [canceledRun] = await runsOf(canceled.outboxId);
      runtime.cancel(canceledRun?.run_id ?? "");
      await deliver();
      await deliver();
      expect(await row(failed.outboxId)).toMatchObject({ run_outcome: "FAILED" });
      expect(await row(canceled.outboxId)).toMatchObject({ run_outcome: "CANCELED", last_failure_class: "run_canceled" });
      expect(await runsOf(failed.outboxId)).toHaveLength(1);
      expect(await runsOf(canceled.outboxId)).toHaveLength(1);
      expect(await effectCount("effect", canceled.itemId)).toBe(0);
    });

    it("13 · repeated crashes are bounded (RECOVERY_EXHAUSTED) and observable", async () => {
      const work = await commitWork("testjobs.record_effect");
      runtime.fault = () => "crash_before";
      await deliver(CONFIG.maxRecoveries + 3);
      expect(await row(work.outboxId)).toMatchObject({ run_outcome: "RECOVERY_EXHAUSTED", recovery_count: CONFIG.maxRecoveries, last_failure_class: "run_crashed" });
      expect(await runsOf(work.outboxId)).toHaveLength(CONFIG.maxRecoveries + 1);
      expect(logLines.filter((line) => line.includes("outbox.run.recovering") && line.includes(work.outboxId))).toHaveLength(CONFIG.maxRecoveries);
      expect(logLines.some((line) => line.includes("outbox.run.recovery_exhausted") && line.includes(work.outboxId))).toBe(true);
      // Further sweeps don't resurrect it.
      await deliver();
      expect(await runsOf(work.outboxId)).toHaveLength(CONFIG.maxRecoveries + 1);
    });

    it("23 · outbox and run state stay diagnosable after a re-dispatch", async () => {
      const work = await commitWork("testjobs.record_effect");
      let crashed = false;
      runtime.fault = () => {
        if (crashed) return undefined;
        crashed = true;
        return "crash_before";
      };
      await deliver();
      const runs = await runsOf(work.outboxId);
      expect(runs.map((run) => [run.last_status, run.recovery_generation])).toEqual([["CRASHED", 0], ["COMPLETED", 1]]);
      expect(await row(work.outboxId)).toMatchObject({ status: "DISPATCHED", run_outcome: "COMPLETED", recovery_count: 1, last_failure_class: null });
      const lines = logLines.filter((line) => line.includes(work.outboxId)).map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines.map((line) => line["event"])).toEqual(expect.arrayContaining(["outbox.dispatched", "outbox.run.recovering", "outbox.run.completed"]));
      for (const line of lines) {
        expect(JSON.stringify(line)).not.toMatch(/t27\.record_effect:[0-9a-f-]{36}/); // never the raw dispatch key
        expect(line["droppedFieldCount"]).toBeUndefined();
      }
    });
  });

  describe("T-27 · UNKNOWN run status (bounded observation)", () => {
    const diagnostic = async (outboxId: string) =>
      (await oracle<{ status: string; run_outcome: string | null; run_diagnostic: string | null; run_diagnostic_at: Date | null; recovery_count: number; last_failure_class: string | null }>(
        "select status, run_outcome, run_diagnostic, run_diagnostic_at, recovery_count, last_failure_class from system.outbox where id = $1", [outboxId]))[0];
    const streakOf = async (outboxId: string) =>
      oracle<{ run_id: string; last_status: string | null; unknown_checks: number; first_unknown_at: Date | null }>(
        "select run_id, last_status, unknown_checks, first_unknown_at from system.outbox_runs where outbox_id = $1 order by dispatched_at", [outboxId]);
    /** Dispatch + execute one row, then the vendor stops reporting its run's status. */
    async function executedThenLost(): Promise<{ readonly outboxId: string; readonly itemId: string; readonly runId: string }> {
      const work = await commitWork("testjobs.record_effect");
      await relayPass(deliveryDeps());
      await runtime.drain();
      const runId = (await runsOf(work.outboxId))[0]?.run_id ?? "";
      runtime.loseStatus(runId);
      return { ...work, runId };
    }

    it("24 · UNKNOWN is never re-dispatched and never classified FAILED, CRASHED or SYSTEM_FAILURE", async () => {
      const work = await executedThenLost();
      const dispatchesOf = () => runtime.enqueued.filter((entry) => entry.dispatchKey === `testjobs.record_effect:${work.itemId}`).length;
      const enqueuedBefore = dispatchesOf();
      for (let sweep = 0; sweep < CONFIG.unknownObservation.maxChecks - 1; sweep += 1) {
        const result = await sweepRunOutcomes(deliveryDeps());
        expect(result).toMatchObject({ recovered: 0, failed: 0, exhausted: 0, unobservable: 0 });
        await relayPass(deliveryDeps());
        await runtime.drain();
      }
      expect(dispatchesOf()).toBe(enqueuedBefore);
      expect(await runsOf(work.outboxId)).toHaveLength(1);
      expect(await diagnostic(work.outboxId)).toMatchObject({ status: "DISPATCHED", run_outcome: null, run_diagnostic: null, recovery_count: 0, last_failure_class: null });
      expect(await effectCount("effect", work.itemId)).toBe(1);
      // The last KNOWN status is kept for diagnosis; UNKNOWN is tracked as a streak beside it.
      expect((await streakOf(work.outboxId))[0]).toMatchObject({ run_id: work.runId, last_status: null, unknown_checks: CONFIG.unknownObservation.maxChecks - 1 });
    });

    it("25 · UNKNOWN is re-checked within the bound; a run that becomes observable again resets the streak and completes", async () => {
      const work = await executedThenLost();
      await sweepRunOutcomes(deliveryDeps());
      advance(30);
      await sweepRunOutcomes(deliveryDeps());
      expect(runtime.statusReads.get(work.runId)).toBe(2);
      expect((await streakOf(work.outboxId))[0]).toMatchObject({ unknown_checks: 2 });
      expect(logLines.filter((line) => line.includes("outbox.run.unknown") && line.includes(work.outboxId))).toHaveLength(2);

      runtime.restoreStatus(work.runId);
      await sweepRunOutcomes(deliveryDeps());
      expect((await streakOf(work.outboxId))[0]).toMatchObject({ last_status: "COMPLETED", unknown_checks: 0, first_unknown_at: null });
      expect(await diagnostic(work.outboxId)).toMatchObject({ run_outcome: "COMPLETED", run_diagnostic: null });
      expect(await effectCount("effect", work.itemId)).toBe(1);
    });

    it("26 · repeated or stale UNKNOWN becomes OBSERVATION_EXHAUSTED: alerted once, run ID and history kept, polling stops", async () => {
      // By count: the bound-th consecutive UNKNOWN observation.
      const byCount = await executedThenLost();
      for (let sweep = 0; sweep < CONFIG.unknownObservation.maxChecks; sweep += 1) await sweepRunOutcomes(deliveryDeps());
      expect(await diagnostic(byCount.outboxId)).toMatchObject({ status: "DISPATCHED", run_outcome: null, run_diagnostic: "OBSERVATION_EXHAUSTED", recovery_count: 0, last_failure_class: null });
      expect((await streakOf(byCount.outboxId))).toEqual([expect.objectContaining({ run_id: byCount.runId, unknown_checks: CONFIG.unknownObservation.maxChecks })]);

      // By elapsed time: within the check budget, but past maxSeconds since the first UNKNOWN.
      const byAge = await executedThenLost();
      await sweepRunOutcomes(deliveryDeps());
      advance(CONFIG.unknownObservation.maxSeconds + 1);
      const result = await sweepRunOutcomes(deliveryDeps());
      expect(result.unobservable).toBe(1);
      expect(await diagnostic(byAge.outboxId)).toMatchObject({ run_outcome: null, run_diagnostic: "OBSERVATION_EXHAUSTED" });
      expect((await streakOf(byAge.outboxId))[0]?.unknown_checks).toBe(2);

      // No hot loop: neither row is polled, re-dispatched or alerted again.
      const reads = [runtime.statusReads.get(byCount.runId), runtime.statusReads.get(byAge.runId)];
      const ours = new Set([byCount, byAge].map((work) => `testjobs.record_effect:${work.itemId}`));
      const dispatchesOf = () => runtime.enqueued.filter((entry) => ours.has(entry.dispatchKey)).length;
      const enqueuedBefore = dispatchesOf();
      for (let sweep = 0; sweep < 3; sweep += 1) {
        advance(120);
        await sweepRunOutcomes(deliveryDeps());
        await sweepDispatch(deliveryDeps());
      }
      expect([runtime.statusReads.get(byCount.runId), runtime.statusReads.get(byAge.runId)]).toEqual(reads);
      expect(dispatchesOf()).toBe(enqueuedBefore);
      for (const work of [byCount, byAge]) {
        const alerts = logLines.filter((line) => line.includes("outbox.run.observation_exhausted") && line.includes(work.outboxId));
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toContain('"failureClass":"run_status_unknown"');
        expect(alerts[0]).toContain(work.runId);
        expect(alerts[0]).not.toContain(work.itemId); // identifiers it carries are allowlisted; no subject IDs or content
        expect(await effectCount("effect", work.itemId)).toBe(1);
      }
    });
  });

  describe("T-27 · tenancy and scope", () => {
    it("14 · a job bound to workspace A can't read or write workspace B", async () => {
      const before = (await oracle<{ n: number }>("select count(*)::int as n from t26_fixture.conversations where workspace_id = $1", [world.B1]))[0]?.n;
      const payload = { v: 1, scope: "workspace", task: "testjobs.cross_tenant_probe", workspaceId: world.A1, outboxId: randomUUID(), subjectIds: { item_id: randomUUID() }, correlationId: "corr-t27-cross-tenant", initiator: { type: "system" } };
      const failure = await sqlState(runTenantJob({ registry: TASKS, worker, logger }, "testjobs.cross_tenant_probe", payload, { runId: "run_cross", attempt: 1 }, effectHandlers["testjobs.cross_tenant_probe"]));
      expect(failure.code).toBe("42501");
      expect((await oracle<{ n: number }>("select count(*)::int as n from t26_fixture.conversations where workspace_id = $1", [world.B1]))[0]?.n).toBe(before);
    });

    it("15 · a missing or malformed workspace fails closed before any connection", async () => {
      const fresh = runtimeDatabase(target, "worker", 1);
      try {
        for (const payload of [
          { v: 1, scope: "workspace", task: "testjobs.record_effect", outboxId: randomUUID(), subjectIds: {}, correlationId: "corr-t27-missing", initiator: { type: "system" } },
          { v: 1, scope: "workspace", task: "testjobs.record_effect", workspaceId: "A1", outboxId: randomUUID(), subjectIds: {}, correlationId: "corr-t27-bad-ws", initiator: { type: "system" } },
          { v: 1, scope: "workspace", task: "testjobs.record_effect", workspaceId: world.A1, outboxId: randomUUID(), subjectIds: { account_id: randomUUID() }, correlationId: "corr-t27-undeclared", initiator: { type: "system" } },
        ]) {
          await expect(runTenantJob({ registry: TASKS, worker: fresh, logger }, "testjobs.record_effect", payload, { runId: "run_x", attempt: 1 }, () => Promise.resolve()))
            .rejects.toBeInstanceOf(NonRetryableJobError);
        }
        expect(fresh.pool.totalCount).toBe(0);
      } finally {
        await fresh.end();
      }
      // An outbox row for a tenant task without a workspace is never dispatched.
      const noWorkspace: UserCommand<object, string, string> = {
        scope: "user",
        name: "test.t27_no_workspace",
        validate: object({}),
        async execute(context, _input, tx, env) {
          const id = randomUUID();
          await tx.outbox.append({ id, topic: "testjobs.record_effect", subjectIds: {}, correlationId: env.correlationId, initiator: { type: "user", userId: context.userId }, dispatchKey: `testjobs.nows:${id}`, createdAt: env.now });
          return id;
        },
        audit: () => undefined,
        respond: (id) => id,
      };
      identity.user = verifiedUser(ownerA(), "owner-a@example.test");
      const outboxId = expectOk(await pipeline.run(noWorkspace, { input: {} }));
      await relayPass(deliveryDeps());
      expect(await row(outboxId)).toMatchObject({ status: "PENDING", last_failure_class: "invalid_payload" });
      expect(runtime.enqueued.some((entry) => entry.dispatchKey === `testjobs.nows:${outboxId}`)).toBe(false);
      await privileged.query("delete from system.outbox where id = $1", [outboxId]);
    });

    it("17 · a system job has no tenant authority, and tenant tasks can't be run or registered as system jobs", async () => {
      await expect(runSystemJob({ registry: TASKS, system, logger }, "testjobs.record_effect", { v: 1, scope: "system", task: "testjobs.record_effect", correlationId: "corr-t27-system", initiator: { type: "system" } }, { runId: "run_s", attempt: 1 }, () => Promise.resolve()))
        .rejects.toBeInstanceOf(NonRetryableJobError);
      for (const table of ["idempotency.effect_keys", "t26_fixture.conversations", "tenancy.workspaces", "audit.audit_events"]) {
        const denied = withSystemScope(system, (tx) => tx.execute(sql.raw(`select count(*) from ${table}`)));
        expect((await sqlState(denied)).code).toBe("42501");
      }
      expect(() => defineTaskRegistry([{ name: "testjobs.sneaky", scope: "system", retry: RETRY } as never])).toThrow(TaskRegistryError);
      expect(() => defineTaskRegistry([{ name: "outbox.relay", scope: "workspace", lane: 1, retry: RETRY, concurrency: { by: "none" }, subjects: [] }])).toThrow(TaskRegistryError);
    });

    it("18 · lanes route to their own bounded queues with the declared keyed concurrency", async () => {
      for (const task of ["testjobs.permanent_failure", "testjobs.cross_tenant_probe", "testjobs.backfill_probe"] as const) await commitWork(task);
      await relayPass(deliveryDeps());
      const byTask = new Map(runtime.enqueued.map((entry) => [entry.task, entry]));
      expect(byTask.get("testjobs.permanent_failure")).toMatchObject({ lane: 1 });
      expect(byTask.get("testjobs.permanent_failure")?.concurrencyKey).toMatch(/^item_id:/);
      expect(byTask.get("testjobs.cross_tenant_probe")).toMatchObject({ lane: 3 });
      expect(byTask.get("testjobs.cross_tenant_probe")?.concurrencyKey).toBeUndefined();
      expect(byTask.get("testjobs.backfill_probe")).toMatchObject({ lane: 5, concurrencyKey: `ws:${world.A1}` });
      const queues = TASKS.tasks.map((task) => queueFor(task));
      expect(queueFor(TASKS.get("testjobs.backfill_probe") ?? TASKS.tasks[0] as never)).toBe(LANE_DEFINITIONS[5].queue);
      expect(new Set(Object.values(LANE_DEFINITIONS).map((lane) => lane.queue)).size).toBe(5);
      expect(queues).not.toContain(SYSTEM_QUEUE.queue);
      await deliver();
    });

    it("22 · long-lived runtime roles are never dropped or recreated by the suite (R8)", async () => {
      expect(await foundationRoleOids()).toBe(roleOids);
    });
  });

  describe("T-27 · payload contract, operational switches, runtime credentials", () => {
    it("16 · the IDs-only payload contract rejects content, credentials and undeclared fields (database, relay and wrapper)", async () => {
      const base = (): Record<string, unknown> => ({
        v: 1, scope: "workspace", task: "testjobs.record_effect", workspaceId: world.A1, outboxId: randomUUID(),
        subjectIds: { item_id: randomUUID() }, correlationId: "corr-t27-payload", initiator: { type: "system" },
      });
      const forbidden: readonly (readonly [string, unknown])[] = [
        ["comment text field", { ...base(), text: "synthetic comment body" }],
        ["credential field", { ...base(), accessToken: "synthetic-token-value" }],
        ["provider payload field", { ...base(), providerPayload: { id: "1" } }],
        ["text as a subject id", { ...base(), subjectIds: { item_id: "synthetic complaint text" } }],
        ["object as a subject id", { ...base(), subjectIds: { item_id: { raw: "provider" } } }],
        ["too many subjects", { ...base(), subjectIds: Object.fromEntries(Array.from({ length: 17 }, (_, n) => [`s${String(n)}`, randomUUID()])) }],
        ["author handle on the initiator", { ...base(), initiator: { type: "user", userId: randomUUID(), handle: "@synthetic" } }],
        ["credential-shaped text as correlation id", { ...base(), correlationId: "token=synthetic value" }],
        ["URL as correlation id", { ...base(), correlationId: "https://example.test/x" }],
        ["email as request id", { ...base(), requestId: "someone@example.test" }],
        ["workspace as an object", { ...base(), workspaceId: { id: world.A1 } }],
        ["no workspace", { ...base(), workspaceId: undefined }],
        ["system scope on a tenant payload", { ...base(), scope: "system" }],
        ["unknown version", { ...base(), v: 2 }],
        ["array payload", [base()]],
        ["string payload", "synthetic comment body"],
      ];
      for (const [, payload] of forbidden) expect(() => parseTenantJobPayload(payload)).toThrow(InvalidJobPayloadError);
      expect(parseTenantJobPayload(base())).toMatchObject({ workspaceId: world.A1 });
      // Rejections name the field, never echo the value.
      try {
        parseTenantJobPayload({ ...base(), correlationId: "token=synthetic value" });
      } catch (error) {
        expect((error as Error).message).not.toContain("synthetic");
      }
      for (const payload of [
        { v: 1, scope: "system", task: "outbox.relay", correlationId: "corr-t27-sys", initiator: { type: "system" }, workspaceId: world.A1 },
        { v: 1, scope: "system", task: "outbox.relay", correlationId: "corr-t27-sys", initiator: { type: "user", userId: randomUUID() } },
        { v: 1, scope: "system", task: "outbox.relay", correlationId: "corr-t27-sys", initiator: { type: "system" }, subjectIds: {} },
      ]) expect(() => parseSystemJobPayload(payload)).toThrow(InvalidJobPayloadError);

      // The outbox itself refuses content in subject IDs, so the relay can't even read such a row.
      const contentRow = privileged.query(
        "insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type, dispatch_key, created_at) values ($1, 'testjobs.record_effect', $2, $3, $4, 'corr-t27-content', 'system', $5, now())",
        [randomUUID(), world.orgA, world.A1, JSON.stringify({ item_id: "synthetic complaint text" }), `testjobs.record_effect:${randomUUID()}`],
      );
      await expect(contentRow).rejects.toMatchObject({ code: "23514" });

      // The wrapper re-validates before taking a connection: content-bearing payloads never reach the database.
      const fresh = runtimeDatabase(target, "worker", 1);
      try {
        for (const [, payload] of forbidden.slice(0, 7)) {
          await expect(runTenantJob({ registry: TASKS, worker: fresh, logger }, "testjobs.record_effect", payload, { runId: "run_payload", attempt: 1 }, () => Promise.resolve()))
            .rejects.toBeInstanceOf(NonRetryableJobError);
        }
        expect(fresh.pool.totalCount).toBe(0);
      } finally {
        await fresh.end();
      }

      // What the relay sends: exactly the contract's identifier fields; tags carry the outbox ID only.
      await commitWork("testjobs.record_effect");
      await deliver();
      for (const request of runtime.enqueued) {
        expect(() => parseTenantJobPayload(request.payload)).not.toThrow();
        expect(Object.keys(request.payload as object).sort()).toEqual(["correlationId", "initiator", "outboxId", "scope", "subjectIds", "task", "v", "workspaceId"]);
        for (const tag of request.tags ?? []) expect(tag).toMatch(/^outbox_[0-9a-f-]{36}$/);
      }
      expect(logLines.join("\n")).not.toMatch(/synthetic (comment|complaint)|effect [0-9a-f-]{36}/);
    });

    const operator = { operator: "ops.t27", reason: "test" } as const;
    const testTask = "jobtest_task";
    const history = async (key: string, qualifier: string) =>
      oracle<{ operation: string; scope: string; changed_by: string; reason_code: string; new_value: unknown }>(
        "select operation, scope, changed_by, reason_code, new_value from system.operational_switch_changes where switch_key = $1 and qualifier = $2 order by changed_at, id", [key, qualifier]);
    async function withOperator<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
      const client = await privileged.connect();
      try {
        return await work(client);
      } finally {
        client.release();
      }
    }

    it("19 · switches resolve default → global → organization/workspace override per runtime, and every change is audited", async () => {
      // Run-unique qualifier: switch history is append-only and persists in a shared managed project, so the
      // exact-history assertion below must only ever see rows written by THIS execution.
      const runTask = `jobtest_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const routing = { key: "ai.task_routing", qualifier: runTask } as const;
      const workerRoute = async (workspace: string) =>
        resolveSwitch(await withWorkspaceJobScope(worker, workspace, (tx) => readSwitchRows(tx)), "ai.task_routing", { qualifier: runTask, workspaceId: workspace }).value.route;
      const systemRoute = async () => resolveSwitch(await withSystemScope(system, (tx) => readSwitchRows(tx)), "ai.task_routing", { qualifier: runTask }).value.route;
      try {
        expect(await workerRoute(world.A1)).toBe("default");
        await withOperator((client) => setSwitch(client, { ...routing, scope: "global" }, { route: "global_route", percentage: 50 }, operator));
        await withOperator((client) => setSwitch(client, { ...routing, scope: "workspace", workspaceId: world.A1 }, { route: "workspace_route", percentage: 10 }, operator));
        expect(await workerRoute(world.A1)).toBe("workspace_route");
        expect(await workerRoute(world.B1)).toBe("global_route");
        expect(await systemRoute()).toBe("global_route"); // system scope sees global rows only
        const memberRows = (user: string, workspace: string) => withUserScope(web, { sub: user, role: "authenticated" }, workspace, (tx) => readSwitchRows(tx));
        expect((await memberRows(world.users.ownerA, world.A1)).some((entry) => entry.workspaceId === world.A1)).toBe(true);
        expect((await memberRows(world.users.ownerB, world.B1)).some((entry) => entry.workspaceId === world.A1)).toBe(false);

        // Organization-level rollout: visible to a job in that organization's workspace only.
        await withOperator((client) => setSwitch(client, { key: "provider.rollout", qualifier: "tiktok:jobtest_capability", scope: "organization", organizationId: world.orgA }, { enabled: true }, operator));
        const rollout = async (workspace: string, organization: string) =>
          resolveSwitch(await withWorkspaceJobScope(worker, workspace, (tx) => readSwitchRows(tx)), "provider.rollout", { qualifier: "tiktok:jobtest_capability", organizationId: organization }).value.enabled;
        expect(await rollout(world.A1, world.orgA)).toBe(true);
        expect(await rollout(world.B1, world.orgA)).toBe(false); // B1's job can't see org A's row even if asked

        // Runtime roles never write switches or read their history.
        for (const attempt of [
          () => withWorkspaceJobScope(worker, world.A1, (tx) => tx.execute(sql`insert into system.operational_switches (switch_key, qualifier, scope, value) values ('automation.global_kill', '*', 'global', '{"active":false}')`)),
          () => withSystemScope(system, (tx) => tx.execute(sql`update system.operational_switches set value = '{"active":false}'`)),
          () => withUserScope(web, { sub: world.users.ownerA, role: "authenticated" }, world.A1, (tx) => tx.execute(sql`delete from system.operational_switches`)),
          () => withSystemScope(system, (tx) => tx.execute(sql`select count(*) from system.operational_switch_changes`)),
          () => withWorkspaceJobScope(worker, world.A1, (tx) => tx.execute(sql`select count(*) from system.operational_switch_changes`)),
        ]) expect((await sqlState(attempt())).code).toBe("42501");

        // A change that doesn't say who and why is refused by the database itself.
        const unattributed = privileged.query("insert into system.operational_switches (switch_key, qualifier, scope, value) values ('ai.task_kill', $1, 'global', '{\"active\":true}')", [runTask]);
        expect((await sqlState(unattributed)).code).toBe("42501");
        expect(await oracle("select 1 from system.operational_switches where switch_key = 'ai.task_kill' and qualifier = $1", [runTask])).toHaveLength(0);

        await withOperator((client) => setSwitch(client, { ...routing, scope: "global" }, { route: "global_route_2", percentage: 60 }, operator));
        expect(await withOperator((client) => clearSwitch(client, { ...routing, scope: "workspace", workspaceId: world.A1 }, operator))).toBe(true);
        expect(await workerRoute(world.A1)).toBe("global_route_2");
        expect(await history("ai.task_routing", runTask)).toEqual([
          { operation: "set", scope: "global", changed_by: "ops.t27", reason_code: "test", new_value: { route: "global_route", percentage: 50 } },
          { operation: "set", scope: "workspace", changed_by: "ops.t27", reason_code: "test", new_value: { route: "workspace_route", percentage: 10 } },
          { operation: "set", scope: "global", changed_by: "ops.t27", reason_code: "test", new_value: { route: "global_route_2", percentage: 60 } },
          { operation: "cleared", scope: "workspace", changed_by: "ops.t27", reason_code: "test", new_value: null },
        ]);

        // Removing a tenant clears its overrides through the cascade, and that is audited too (not refused).
        await withOperator((client) => setSwitch(client, { ...routing, scope: "workspace", workspaceId: world.A2 }, { route: "doomed_route", percentage: 1 }, operator));
        const direct = privileged.query("delete from system.operational_switches where workspace_id = $1", [world.A2]);
        expect((await sqlState(direct)).code).toBe("42501"); // the tenant still exists: an operator must say who and why
        await privileged.query("delete from tenancy.workspaces where id = $1", [world.A2]);
        expect((await history("ai.task_routing", runTask)).at(-1)).toMatchObject({ operation: "cleared", scope: "workspace", changed_by: "system:tenant_removal", reason_code: "maintenance" });
      } finally {
        await withOperator(async (client) => {
          await clearSwitch(client, { ...routing, scope: "global" }, operator);
          await clearSwitch(client, { key: "provider.rollout", qualifier: "tiktok:jobtest_capability", scope: "organization", organizationId: world.orgA }, operator);
        });
      }
    });

    it("20 · kill switches, gates and mutation switches fail safe on invalid configuration or an unreadable store", async () => {
      const rows = () => withSystemScope(system, (tx) => readSwitchRows(tx));
      const corrupt = (key: string, qualifier: string, value: string) =>
        withOperator(async (client) => {
          await client.query("begin");
          await client.query("select set_config('app.operator_id', 'ops.t27', true), set_config('app.change_reason', 'test', true)");
          await client.query("insert into system.operational_switches (switch_key, qualifier, scope, value) values ($1, $2, 'global', $3::jsonb)", [key, qualifier, value]);
          await client.query("commit");
        });
      const cleanup = [
        { key: "mutation.provider_action", qualifier: "*", scope: "global" },
        { key: "mutation.provider_action", qualifier: "tiktok:hide", scope: "global" },
        { key: "ai.task_kill", qualifier: testTask, scope: "global" },
        { key: "ingestion.provider_pause", qualifier: "tiktok", scope: "global" },
      ] as const;
      try {
        // Valid configuration resolves with the declared semantics.
        await withOperator((client) => setSwitch(client, { key: "mutation.provider_action", qualifier: "*", scope: "global" }, { enabled: true }, operator));
        await withOperator((client) => setSwitch(client, { key: "mutation.provider_action", qualifier: "tiktok:hide", scope: "global" }, { enabled: false }, operator));
        expect(resolveSwitch(await rows(), "mutation.provider_action", { qualifier: "tiktok:hide" }).value.enabled).toBe(false);
        expect(resolveSwitch(await rows(), "mutation.provider_action", { qualifier: "facebook:hide" }).value.enabled).toBe(true);

        // Invalid values (written around the tool) resolve to the fail-safe, never to a permissive guess.
        await corrupt("ai.task_kill", testTask, '{"active":"no"}');
        await corrupt("ingestion.provider_pause", "tiktok", '{"paused":false,"extra":1}');
        expect(resolveSwitch(await rows(), "ai.task_kill", { qualifier: testTask })).toEqual({ value: { active: true }, source: "fail_safe", failSafe: true });
        expect(resolveSwitch(await rows(), "ingestion.provider_pause", { qualifier: "tiktok" })).toEqual({ value: { paused: true }, source: "fail_safe", failSafe: true });
        expect(resolveSwitch(await rows(), "ingestion.provider_pause", { qualifier: "facebook" }).value.paused).toBe(false); // other providers unaffected

        // The tool refuses invalid values before writing.
        await expect(withOperator((client) => setSwitch(client, { key: "automation.global_kill", qualifier: "*", scope: "global" }, { active: "yes" }, operator))).rejects.toThrow();
        // The database refuses overrides where TA §66.2 allows none (a workspace-level global kill).
        const scoped = withOperator(async (client) => {
          await client.query("begin");
          await client.query("select set_config('app.operator_id', 'ops.t27', true), set_config('app.change_reason', 'test', true)");
          try {
            await client.query("insert into system.operational_switches (switch_key, qualifier, scope, workspace_id, value) values ('automation.global_kill', '*', 'workspace', $1, '{\"active\":false}')", [world.A1]);
          } finally {
            await client.query("rollback");
          }
        });
        expect((await sqlState(scoped)).code).toBe("23514");

        // An unreadable store (here: a read the system role is denied) resolves everything to fail-safe values.
        const reader = createSwitchReader({ load: () => withSystemScope(system, async (tx) => { await tx.execute(sql`select 1 from system.operational_switch_changes limit 1`); return []; }), ttlMs: 1_000 });
        expect(await reader.get("automation.global_kill")).toEqual({ value: { active: true }, source: "fail_safe", failSafe: true });
        expect((await reader.get("automation.release_gate", { qualifier: "tiktok:obvious_spam" })).value.open).toBe(false);
        expect((await reader.get("mutation.provider_action", { qualifier: "facebook:hide" })).value.enabled).toBe(false);
      } finally {
        await withOperator(async (client) => {
          for (const entry of cleanup) await clearSwitch(client, entry, operator);
        });
      }
    });

    it("21 · runtime connections are the dedicated login roles (never postgres or a service role), and runtime code never reads privileged credentials", async () => {
      const identityOf = async (scope: Promise<{ rows: Record<string, unknown>[] }>) => (await scope).rows[0];
      const query = sql`select session_user::text as login, r.rolsuper as superuser, r.rolbypassrls as bypass_rls, r.rolcreaterole as create_role
                          from pg_catalog.pg_roles r where r.rolname = session_user`;
      const seen = [
        await identityOf(withUserScope(web, { sub: world.users.ownerA, role: "authenticated" }, world.A1, (tx) => tx.execute(query))),
        await identityOf(withWorkspaceJobScope(worker, world.A1, (tx) => tx.execute(query))),
        await identityOf(withSystemScope(system, (tx) => tx.execute(query))),
      ];
      expect(seen.map((entry) => entry?.["login"])).toEqual(["web_login", "worker_login", "system_login"]);
      for (const entry of seen) expect(entry).toMatchObject({ superuser: false, bypass_rls: false, create_role: false });

      // The hosted-web guard (TA-11A) must NAME these credentials to refuse them: it is scanned separately below, with
      // only its closed refusal list removed, so it can never read or connect with them either.
      const runtimeFiles = sourceFiles(["app", "ui", "server", "domain", "modules", "platform", "integrations", "ai", "mutations", "jobs", "trigger.config.ts"])
        .filter((file) => file !== WEB_ENVIRONMENT_GUARD);
      expect(runtimeFiles.length).toBeGreaterThan(0);
      // (platform/db/connection.ts names forbidden roles in its deny list; credentials are what must never be read.)
      expect(findReferences(runtimeFiles, [/DATABASE_MIGRATION_URL/, /SERVICE_ROLE_KEY/i, /SUPABASE_SECRET_KEY/i, /postgres(ql)?:\/\/(postgres|supabase_admin|service_role)[.:@]/])).toEqual([]);
      // The job deployment never reads the web credential; the web never reads worker/system credentials.
      expect(findReferences(sourceFiles(["jobs", "trigger.config.ts"]), [/DATABASE_WEB_URL/, /createRuntimeDatabaseFromEnv\(\s*"web"/])).toEqual([]);
      expect(findReferences(sourceFiles(["app", "ui", "server"]).filter((file) => file !== WEB_ENVIRONMENT_GUARD), [/DATABASE_(WORKER|SYSTEM)_URL/, /createRuntimeDatabaseFromEnv\(\s*"(worker|system)"/])).toEqual([]);
      const guard = codeWithoutForbiddenList(WEB_ENVIRONMENT_GUARD);
      for (const pattern of [/DATABASE_(MIGRATION|WORKER|SYSTEM)_URL/, /SERVICE_ROLE_KEY/i, /SUPABASE_SECRET_KEY/i, /createRuntimeDatabaseFromEnv/, /postgres(ql)?:\/\//]) {
        expect(pattern.test(guard), `${WEB_ENVIRONMENT_GUARD}: ${pattern.source}`).toBe(false);
      }
    });
  });
}

export const T27_USER = (value: string): UserId => {
  const id = parseUserId(value);
  if (id === undefined) throw new Error("uuid");
  return id;
};
