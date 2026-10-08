/**
 * Execution-plane routing of the outbox relay and the R7 sweeper (Step 7E.4B.3), offline: the delivery store and the
 * system scope are replaced by an in-memory double, and each plane has its own recording job runtime. A delivery is
 * dispatched and observed ONLY through the runtime of its PERSISTED plane (what the claim returned); the registry's
 * current route never overrides it, and a NOT FOUND in the owning plane is never retried in the other one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnqueueRequest, ExecutionPlane, JobRuntime, RunStatus } from "@/platform/jobs";

const store = vi.hoisted(() => ({
  claimed: [] as Record<string, unknown>[],
  awaiting: [] as Record<string, unknown>[],
  dispatched: [] as { outboxId: string; runId: string }[],
  statuses: [] as { outboxId: string; status: string }[],
  claimOptions: [] as Record<string, unknown>[],
}));

vi.mock("@/platform/db/system-scope", () => ({ withSystemScope: (_system: unknown, work: (tx: unknown) => Promise<unknown>) => work({}) }));
vi.mock("@/platform/db/outbox-delivery", () => ({
  claimDueRows: (_tx: unknown, options: Record<string, unknown>) => {
    store.claimOptions.push(options);
    const rows = store.claimed;
    store.claimed = [];
    return Promise.resolve(rows);
  },
  markDispatched: (_tx: unknown, options: { outboxId: string; runId: string }) => {
    store.dispatched.push(options);
    return Promise.resolve(true);
  },
  markDispatchFailed: () => Promise.resolve(),
  listAwaitingOutcome: () => Promise.resolve(store.awaiting),
  recordRunStatus: (_tx: unknown, options: { outboxId: string; status: string }) => {
    store.statuses.push(options);
    return Promise.resolve({ checks: 1, since: new Date() });
  },
  recordOutcome: () => Promise.resolve(true),
  requeueForRecovery: () => Promise.resolve(true),
  markObservationExhausted: () => Promise.resolve(true),
  flagSloBreaches: () => Promise.resolve([]),
  oldestPendingAgeSeconds: () => Promise.resolve(null),
  countExecutionCapableBound: () => Promise.resolve(0),
}));

const { defineTaskRegistry, RETRY_POLICIES } = await import("@/platform/jobs");
const { relayPass, sweepRunOutcomes } = await import("@/platform/outbox/delivery");
const { createLogger } = await import("@/platform/observability");

const WS = "0b5d5f4e-8f43-4c55-9a51-6a3c0f2a7e10";
const MAIN_TASK = "connections.move.release_source";
const INTEGRATION_TASK = "connections.discover_assets";

const registry = (planes: Readonly<Record<string, ExecutionPlane>> = { [MAIN_TASK]: "main", [INTEGRATION_TASK]: "integration" }) =>
  defineTaskRegistry([
    { name: "outbox.relay", scope: "system", executionPlane: "main", retry: RETRY_POLICIES.transient },
    ...Object.entries(planes).map(([name, executionPlane]) => ({
      name, scope: "workspace" as const, executionPlane, lane: 3 as const, retry: RETRY_POLICIES.transient, concurrency: { by: "none" as const }, subjects: [] as string[],
    })),
  ]);

class RecordingRuntime implements JobRuntime {
  readonly enqueued: EnqueueRequest[] = [];
  readonly lookups: string[] = [];
  private readonly plane: ExecutionPlane;
  private readonly status: RunStatus;
  constructor(plane: ExecutionPlane, status: RunStatus = "EXECUTING") {
    this.plane = plane;
    this.status = status;
  }
  enqueue(request: EnqueueRequest) {
    this.enqueued.push(request);
    return Promise.resolve({ runId: `run_${this.plane}_${String(this.enqueued.length)}` });
  }
  getRun(runId: string) {
    this.lookups.push(runId);
    return Promise.resolve({ runId, status: this.status, attemptCount: this.status === "UNKNOWN" ? 0 : 1 });
  }
}

const claimedRow = (topic: string, executionPlane: ExecutionPlane, id = crypto.randomUUID()) => ({
  id, topic, organizationId: null, workspaceId: WS, subjectIds: {}, correlationId: `corr-planes-${id.slice(0, 8)}`, initiatorType: "system",
  initiatorUserId: null, dispatchKey: `${topic}:${id}`, createdAt: new Date(), dispatchAttempts: 0, recoveryCount: 0, executionPlane,
});
const awaitingRow = (topic: string, executionPlane: ExecutionPlane, runId: string) => ({
  id: crypto.randomUUID(), topic, workspaceId: WS, correlationId: "corr-planes-await", recoveryCount: 0, dispatchedAt: new Date(), runId, executionPlane,
});

const deps = (runtimes: { main: JobRuntime; integration: JobRuntime }, planes?: Readonly<Record<string, ExecutionPlane>>) => ({
  system: {} as never, runtimes, registry: registry(planes), logger: createLogger({ sink: () => undefined }), clock: () => new Date(),
});

beforeEach(() => {
  store.claimed = [];
  store.awaiting = [];
  store.dispatched = [];
  store.statuses = [];
  store.claimOptions = [];
});

describe("dispatch routes by the plane the claim persisted", () => {
  it("passes the registry's routes for UNBOUND work to the claim (the registry is the routing authority for new work)", async () => {
    await relayPass(deps({ main: new RecordingRuntime("main"), integration: new RecordingRuntime("integration") }));
    expect(store.claimOptions[0]?.["unboundRoutes"]).toEqual({ [MAIN_TASK]: "main", [INTEGRATION_TASK]: "integration" });
  });

  it("a main row goes to the main runtime only; an integration row to the integration runtime only", async () => {
    const main = new RecordingRuntime("main");
    const integration = new RecordingRuntime("integration");
    const mainRow = claimedRow(MAIN_TASK, "main");
    const integrationRow = claimedRow(INTEGRATION_TASK, "integration");
    store.claimed = [mainRow, integrationRow];
    expect((await relayPass(deps({ main, integration }))).dispatched).toBe(2);
    expect(main.enqueued.map((request) => request.task)).toEqual([MAIN_TASK]);
    expect(integration.enqueued.map((request) => request.task)).toEqual([INTEGRATION_TASK]);
    expect(store.dispatched.map(({ outboxId, runId }) => ({ outboxId, runId }))).toEqual([{ outboxId: mainRow.id, runId: "run_main_1" }, { outboxId: integrationRow.id, runId: "run_integration_1" }]);
  });

  it("a delivery bound to main stays on main after the task moved to integration (and vice versa)", async () => {
    const main = new RecordingRuntime("main");
    const integration = new RecordingRuntime("integration");
    store.claimed = [claimedRow(INTEGRATION_TASK, "main"), claimedRow(MAIN_TASK, "integration")];
    // The CURRENT registry routes both tasks the other way: it decides only for unbound work.
    await relayPass(deps({ main, integration }));
    expect(main.enqueued.map((request) => request.task)).toEqual([INTEGRATION_TASK]);
    expect(integration.enqueued.map((request) => request.task)).toEqual([MAIN_TASK]);
  });

  it("a bound row whose topic is no longer registered is not dispatched anywhere (its plane is never re-interpreted)", async () => {
    const main = new RecordingRuntime("main");
    const integration = new RecordingRuntime("integration");
    store.claimed = [claimedRow("capability.retired_task", "integration")];
    expect(await relayPass(deps({ main, integration }))).toMatchObject({ dispatched: 0, failed: 1 });
    expect([...main.enqueued, ...integration.enqueued]).toEqual([]);
  });
});

describe("R7 run observation routes by the persisted plane, with no cross-plane fallback", () => {
  it("a main run is looked up in main only; an integration run in integration only", async () => {
    const main = new RecordingRuntime("main");
    const integration = new RecordingRuntime("integration");
    store.awaiting = [awaitingRow(MAIN_TASK, "main", "run_m"), awaitingRow(INTEGRATION_TASK, "integration", "run_i")];
    await sweepRunOutcomes(deps({ main, integration }));
    expect(main.lookups).toEqual(["run_m"]);
    expect(integration.lookups).toEqual(["run_i"]);
  });

  it("NOT FOUND (UNKNOWN) in the owning plane is recorded as UNKNOWN and never retried in the other plane", async () => {
    for (const owner of ["main", "integration"] as const) {
      store.statuses = [];
      const main = new RecordingRuntime("main", owner === "main" ? "UNKNOWN" : "COMPLETED");
      const integration = new RecordingRuntime("integration", owner === "integration" ? "UNKNOWN" : "COMPLETED");
      store.awaiting = [awaitingRow(owner === "main" ? MAIN_TASK : INTEGRATION_TASK, owner, "run_gone")];
      const tally = await sweepRunOutcomes(deps({ main, integration }));
      expect(tally).toMatchObject({ checked: 1, pending: 1, completed: 0 });
      expect(store.statuses.map((entry) => entry.status)).toEqual(["UNKNOWN"]);
      const other = owner === "main" ? integration : main;
      expect(other.lookups, owner).toEqual([]);
    }
  });

  it("the run lookup never re-derives the plane from the current registry", async () => {
    const main = new RecordingRuntime("main");
    const integration = new RecordingRuntime("integration");
    store.awaiting = [awaitingRow(INTEGRATION_TASK, "main", "run_bound_main")];
    await sweepRunOutcomes(deps({ main, integration }));
    expect(main.lookups).toEqual(["run_bound_main"]);
    expect(integration.lookups).toEqual([]);
  });
});
