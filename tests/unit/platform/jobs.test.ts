/**
 * Job foundation contracts without a database: task registry validation, lanes, queue and concurrency-key
 * derivation, and the IDs-only payload validator (the database-backed behavior is proven by T-27).
 */
import { describe, expect, it } from "vitest";
import {
  InvalidJobPayloadError,
  LANES,
  LANE_DEFINITIONS,
  RETRY_POLICIES,
  SYSTEM_QUEUE,
  SYSTEM_TASKS,
  TaskRegistryError,
  concurrencyKeyFor,
  defineTaskRegistry,
  isLane,
  laneLabel,
  parseSystemJobPayload,
  parseTenantJobPayload,
  payloadMatchesTask,
  queueFor,
  type TenantTaskDefinition,
} from "@/platform/jobs";
import { PRODUCTION_TASKS, SWEEPER_SCHEDULES } from "@/jobs/registry";

const WS = "0b5d5f4e-8f43-4c55-9a51-6a3c0f2a7e10";
const ITEM = "5e0a2b8c-9a77-4f3e-8c12-3b4d5e6f7a81";
const OUTBOX = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";

const tenant = (overrides: Partial<TenantTaskDefinition> = {}): TenantTaskDefinition => ({
  name: "workflow.example_task",
  scope: "workspace",
  lane: 2,
  retry: RETRY_POLICIES.transient,
  concurrency: { by: "workspace" },
  subjects: ["item_id"],
  ...overrides,
});

const payload = (overrides: Record<string, unknown> = {}) =>
  parseTenantJobPayload({
    v: 1, scope: "workspace", task: "workflow.example_task", workspaceId: WS, outboxId: OUTBOX,
    subjectIds: { item_id: ITEM }, correlationId: "corr-unit-1", initiator: { type: "policy" }, ...overrides,
  });

describe("lanes", () => {
  it("declares five lanes, each on its own bounded queue, in strict priority order", () => {
    expect(LANES).toEqual([1, 2, 3, 4, 5]);
    const queues = LANES.map((lane) => LANE_DEFINITIONS[lane].queue);
    expect(new Set([...queues, SYSTEM_QUEUE.queue]).size).toBe(6);
    for (const lane of LANES) {
      expect(LANE_DEFINITIONS[lane].lane).toBe(lane);
      expect(Number.isInteger(LANE_DEFINITIONS[lane].concurrencyLimit) && LANE_DEFINITIONS[lane].concurrencyLimit > 0).toBe(true);
    }
    const offsets = LANES.map((lane) => LANE_DEFINITIONS[lane].priorityOffsetSeconds);
    expect([...offsets].sort((a, b) => b - a)).toEqual(offsets);
    expect(LANE_DEFINITIONS[1].priorityOffsetSeconds).toBeGreaterThan(LANE_DEFINITIONS[2].priorityOffsetSeconds);
    expect(LANE_DEFINITIONS[5].concurrencyLimit).toBeLessThan(LANE_DEFINITIONS[1].concurrencyLimit);
  });

  it("validates lanes and labels them for logs", () => {
    expect(isLane(3)).toBe(true);
    expect([0, 6, "1", 1.5, undefined].some((value) => isLane(value))).toBe(false);
    expect(laneLabel(1)).toBe("1");
    expect(laneLabel("system")).toBe("system");
  });
});

describe("task registry", () => {
  it("routes tasks to their lane queue, and system tasks to the system queue", () => {
    const registry = defineTaskRegistry([tenant({ lane: 5 }), { name: "outbox.relay", scope: "system", retry: RETRY_POLICIES.transient }]);
    expect(queueFor(registry.get("workflow.example_task") as TenantTaskDefinition)).toBe(LANE_DEFINITIONS[5].queue);
    expect(queueFor(registry.get("outbox.relay") ?? registry.tasks[0] as never)).toBe(SYSTEM_QUEUE.queue);
    expect(registry.tenant("outbox.relay")).toBeUndefined();
    expect(registry.system("workflow.example_task")).toBeUndefined();
  });

  it.each([
    ["digits in the name", [tenant({ name: "workflow.task1" })]],
    ["a single-segment name", [tenant({ name: "workflow" })]],
    ["a duplicate", [tenant(), tenant()]],
    ["an unknown lane", [tenant({ lane: 9 as never })]],
    ["too many attempts", [tenant({ retry: { ...RETRY_POLICIES.transient, maxAttempts: 50 } })]],
    ["zero attempts", [tenant({ retry: { ...RETRY_POLICIES.transient, maxAttempts: 0 } })]],
    ["a backoff below the floor", [tenant({ retry: { ...RETRY_POLICIES.transient, minDelayMs: 1 } })]],
    ["an undeclared concurrency subject", [tenant({ concurrency: { by: "subject", subject: "account_id" } })]],
    ["duplicate subjects", [tenant({ subjects: ["item_id", "item_id"] })]],
    ["an unnamed system task", [{ name: "workflow.sneaky", scope: "system", retry: RETRY_POLICIES.singleAttempt } as never]],
    ["a system task declared as tenant", [tenant({ name: "outbox.relay" })]],
    ["an invalid cron", [{ name: "outbox.dispatch_sweep", scope: "system", retry: RETRY_POLICIES.singleAttempt, schedule: { cron: "every minute" } }]],
  ] as const)("refuses %s", (_label, definitions) => {
    expect(() => defineTaskRegistry(definitions)).toThrow(TaskRegistryError);
  });

  it("derives keyed concurrency from identifiers only", () => {
    expect(concurrencyKeyFor(tenant({ concurrency: { by: "none" } }), payload())).toBeUndefined();
    expect(concurrencyKeyFor(tenant(), payload())).toBe(`ws:${WS}`);
    expect(concurrencyKeyFor(tenant({ concurrency: { by: "subject", subject: "item_id" } }), payload())).toBe(`item_id:${ITEM}`);
    expect(concurrencyKeyFor(tenant({ concurrency: { by: "subject", subject: "item_id" } }), payload({ subjectIds: {} }))).toBe(`ws:${WS}`);
  });

  it("rejects payloads for another task or carrying undeclared subjects", () => {
    expect(payloadMatchesTask(tenant(), payload())).toBe(true);
    expect(payloadMatchesTask(tenant({ name: "workflow.other_task" }), payload())).toBe(false);
    expect(payloadMatchesTask(tenant({ subjects: [] }), payload())).toBe(false);
  });

  it("the production registry holds exactly the named system delivery jobs (explicit schedules) and the Step 5D/5F tenant tasks", () => {
    const tenantTasks = [
      "connections.discover_assets",
      "connections.move.release_source",
      "connections.move.activate_destination",
      "connections.move.reject_destination",
      "capability.evaluate_account",
    ];
    expect(PRODUCTION_TASKS.tasks.map((task) => task.name).sort()).toEqual([...SYSTEM_TASKS, ...tenantTasks].sort());
    expect(PRODUCTION_TASKS.tasks.filter((task) => task.scope === "system").map((task) => task.name).sort()).toEqual([...SYSTEM_TASKS].sort());
    expect(PRODUCTION_TASKS.tenant("connections.discover_assets")).toMatchObject({
      lane: 3,
      concurrency: { by: "subject", subject: "connection_id" },
      subjects: ["connection_id"],
    });
    // Step 5F: the saga steps serialize per move; release_source alone carries the definer-derived account and counterpart.
    expect(PRODUCTION_TASKS.tenant("connections.move.release_source")).toMatchObject({
      lane: 3,
      concurrency: { by: "subject", subject: "move_id" },
      subjects: ["move_id", "connected_account_id", "counterpart_workspace_id"],
    });
    for (const name of ["connections.move.activate_destination", "connections.move.reject_destination"]) {
      expect(PRODUCTION_TASKS.tenant(name)).toMatchObject({ lane: 3, concurrency: { by: "subject", subject: "move_id" }, subjects: ["move_id"] });
    }
    expect(PRODUCTION_TASKS.tenant("capability.evaluate_account")).toMatchObject({
      lane: 3,
      concurrency: { by: "subject", subject: "connected_account_id" },
      subjects: ["connected_account_id"],
    });
    expect(PRODUCTION_TASKS.system("outbox.dispatch_sweep")?.schedule?.cron).toBe(SWEEPER_SCHEDULES.dispatchSweep);
    expect(PRODUCTION_TASKS.system("outbox.outcome_sweep")?.schedule?.cron).toBe(SWEEPER_SCHEDULES.outcomeSweep);
    expect(PRODUCTION_TASKS.system("outbox.relay")?.schedule).toBeUndefined();
  });
});

describe("IDs-only payload contract", () => {
  it("accepts identifiers only and returns a frozen copy", () => {
    const parsed = payload({ requestId: "req-unit-0001", initiator: { type: "user", userId: ITEM } });
    expect(parsed).toEqual({
      v: 1, scope: "workspace", task: "workflow.example_task", workspaceId: WS, outboxId: OUTBOX,
      subjectIds: { item_id: ITEM }, correlationId: "corr-unit-1", requestId: "req-unit-0001", initiator: { type: "user", userId: ITEM },
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.subjectIds)).toBe(true);
  });

  it.each([
    ["extra content field", { body: "synthetic text" }],
    ["upper-case workspace", { workspaceId: WS.toUpperCase() }],
    ["subject name with spaces", { subjectIds: { "item id": ITEM } }],
    ["subject value as number", { subjectIds: { item_id: 42 } }],
    ["unknown initiator", { initiator: { type: "admin" } }],
    ["policy initiator with extra field", { initiator: { type: "policy", policyName: "x" } }],
    ["short correlation id", { correlationId: "abc" }],
    ["task with digits", { task: "workflow.task2" }],
  ])("rejects %s, naming the field and never the value", (_label, overrides) => {
    let caught: unknown;
    try {
      payload(overrides);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidJobPayloadError);
    expect((caught as Error).message).not.toMatch(/synthetic|admin|item id|abc|task2/);
  });

  it("rejects non-plain objects (class instances, null-prototype objects)", () => {
    class Smuggler {
      v = 1;
    }
    expect(() => parseTenantJobPayload(new Smuggler())).toThrow(InvalidJobPayloadError);
    expect(() => parseTenantJobPayload(Object.assign(Object.create(null) as object, { v: 1 }))).toThrow(InvalidJobPayloadError);
  });

  it("system payloads carry no workspace, subjects or user", () => {
    const system = { v: 1, scope: "system", task: "outbox.relay", correlationId: "corr-unit-sys", initiator: { type: "system" } };
    expect(parseSystemJobPayload(system)).toEqual(system);
    expect(() => parseSystemJobPayload({ ...system, workspaceId: WS })).toThrow(InvalidJobPayloadError);
    expect(() => parseSystemJobPayload({ ...system, initiator: { type: "policy" } })).toThrow(InvalidJobPayloadError);
    expect(() => parseTenantJobPayload(system)).toThrow(InvalidJobPayloadError);
  });
});
