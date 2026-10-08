/**
 * Trigger.dev adapter mapping, against a mocked SDK (the managed leg is a separate, explicit suite):
 * dispatch key → GLOBAL idempotency key, lane → queue + priority, keyed concurrency, tags, status
 * normalization, and error classification (permanent rejection vs transient unavailability).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  class ApiError extends Error {
    readonly status: number | undefined;
    constructor(status: number | undefined) {
      super(`api error ${String(status)}`);
      this.status = status;
    }
  }
  const tasks = { trigger: vi.fn<(task: string, payload: unknown, options: unknown) => Promise<{ id: string }>>(() => Promise.resolve({ id: "run_123" })) };
  const runs = { retrieve: vi.fn<(id: string) => Promise<{ id: string; status: string; attemptCount: number }>>(() => Promise.resolve({ id: "run_123", status: "COMPLETED", attemptCount: 2 })) };
  /** Every TriggerClient constructed, with its config; all instances share the call spies below. */
  const clients: unknown[] = [];
  class TriggerClient {
    readonly tasks = tasks;
    readonly runs = runs;
    constructor(config: unknown) {
      clients.push(config);
    }
  }
  return {
    ApiError,
    TriggerClient,
    clients,
    // The global API must never be used by the adapter (no configure(), no module-level tasks/runs).
    configure: vi.fn(),
    idempotencyKeys: { create: vi.fn((key: string, options: { scope: string }) => Promise.resolve(`idem(${options.scope}:${key})`)) },
    tasks,
    runs,
  };
});

vi.mock("@trigger.dev/sdk", () => sdk);

const { JobRuntimeRejectedError, JobRuntimeUnavailableError, LANE_DEFINITIONS, SYSTEM_QUEUE } = await import("@/platform/jobs");
const { createTriggerDevRuntime, normalizeTriggerStatus, unreachableJobRuntime } = await import("@/platform/jobs/trigger-dev");

const payload = { v: 1, scope: "system", task: "outbox.relay", correlationId: "corr-adapter-1", initiator: { type: "system" } } as const;

describe("Trigger.dev adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.clients.length = 0;
  });

  it("builds ONE explicit TriggerClient from the given credential only, never the global configure()", () => {
    createTriggerDevRuntime({ accessToken: "tr_dev_synthetic", branch: "inherit" });
    expect(sdk.clients).toEqual([{ accessToken: "tr_dev_synthetic" }]);
    expect(sdk.configure).not.toHaveBeenCalled();
  });

  it("a cross-project client sends no preview branch (explicit empty branch: no environment fallback) and pins its release", () => {
    createTriggerDevRuntime({ accessToken: "tr_stg_sk_synthetic", branch: "none", externalDeploymentId: "commit-synthetic" });
    expect(sdk.clients).toEqual([{ accessToken: "tr_stg_sk_synthetic", previewBranch: "", externalDeploymentId: "commit-synthetic" }]);
  });

  it("refuses to build a runtime without a credential (never falls back to an ambient key)", () => {
    for (const accessToken of ["", "   ", undefined as never]) {
      expect(() => createTriggerDevRuntime({ accessToken, branch: "none" })).toThrow(JobRuntimeRejectedError);
    }
    expect(sdk.clients).toEqual([]);
  });

  it("an unreachable plane rejects enqueues and reports lookups as unavailable (never UNKNOWN)", async () => {
    const runtime = unreachableJobRuntime();
    await expect(runtime.enqueue({ task: "outbox.relay", payload, dispatchKey: "outbox.relay:1", lane: "system" })).rejects.toBeInstanceOf(JobRuntimeRejectedError);
    await expect(runtime.getRun("run_123")).rejects.toBeInstanceOf(JobRuntimeUnavailableError);
    expect(sdk.tasks.trigger).not.toHaveBeenCalled();
  });

  it("maps the dispatch key to a GLOBAL idempotency key and the lane to its queue and priority", async () => {
    const runtime = createTriggerDevRuntime({ accessToken: "tr_dev_synthetic", branch: "inherit" });
    const result = await runtime.enqueue({ task: "workflow.example_task", payload, dispatchKey: "workflow.example_task:abc", lane: 1, concurrencyKey: "ws:1", tags: ["outbox_1"] });
    expect(result).toEqual({ runId: "run_123" });
    expect(sdk.idempotencyKeys.create).toHaveBeenCalledWith("workflow.example_task:abc", { scope: "global" });
    expect(sdk.tasks.trigger).toHaveBeenCalledWith("workflow.example_task", payload, {
      idempotencyKey: "idem(global:workflow.example_task:abc)",
      queue: LANE_DEFINITIONS[1].queue,
      priority: LANE_DEFINITIONS[1].priorityOffsetSeconds,
      concurrencyKey: "ws:1",
      tags: ["outbox_1"],
    });
  });

  it("system tasks go to the system queue; no concurrency key or tags unless given", async () => {
    const runtime = createTriggerDevRuntime({ accessToken: "tr_dev_synthetic", branch: "inherit" });
    await runtime.enqueue({ task: "outbox.relay", payload, dispatchKey: "outbox.relay:1", lane: "system" });
    expect(sdk.tasks.trigger).toHaveBeenCalledWith("outbox.relay", payload, { idempotencyKey: "idem(global:outbox.relay:1)", queue: SYSTEM_QUEUE.queue, priority: 0 });
  });

  it.each([
    [400, JobRuntimeRejectedError],
    [404, JobRuntimeRejectedError],
    [422, JobRuntimeRejectedError],
    [408, JobRuntimeUnavailableError],
    [429, JobRuntimeUnavailableError],
    [500, JobRuntimeUnavailableError],
    [503, JobRuntimeUnavailableError],
    [undefined, JobRuntimeUnavailableError],
  ])("classifies an enqueue failure with status %s", async (status, expected) => {
    sdk.tasks.trigger.mockRejectedValueOnce(new sdk.ApiError(status));
    const runtime = createTriggerDevRuntime({ accessToken: "tr_dev_synthetic", branch: "inherit" });
    const failure = runtime.enqueue({ task: "outbox.relay", payload, dispatchKey: "outbox.relay:1", lane: "system" });
    await expect(failure).rejects.toBeInstanceOf(expected);
  });

  it("a network failure is transient, and error messages never carry the vendor's message", async () => {
    sdk.tasks.trigger.mockRejectedValueOnce(new Error("ECONNRESET secret-ish detail"));
    const runtime = createTriggerDevRuntime({ accessToken: "tr_dev_synthetic", branch: "inherit" });
    const error = await runtime.enqueue({ task: "outbox.relay", payload, dispatchKey: "outbox.relay:1", lane: "system" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JobRuntimeUnavailableError);
    expect((error as Error).message).not.toContain("secret-ish");
  });

  it("reads run status (normalized) and maps a missing run to UNKNOWN", async () => {
    const runtime = createTriggerDevRuntime({ accessToken: "tr_dev_synthetic", branch: "inherit" });
    expect(await runtime.getRun("run_123")).toEqual({ runId: "run_123", status: "COMPLETED", attemptCount: 2 });
    sdk.runs.retrieve.mockRejectedValueOnce(new sdk.ApiError(404));
    expect(await runtime.getRun("run_gone")).toEqual({ runId: "run_gone", status: "UNKNOWN", attemptCount: 0 });
    sdk.runs.retrieve.mockRejectedValueOnce(new sdk.ApiError(503));
    await expect(runtime.getRun("run_123")).rejects.toBeInstanceOf(JobRuntimeUnavailableError);
  });

  it("normalizes every vendor status; anything unrecognized is UNKNOWN, never a known state", () => {
    expect(normalizeTriggerStatus("CRASHED")).toBe("CRASHED");
    expect(normalizeTriggerStatus("SYSTEM_FAILURE")).toBe("SYSTEM_FAILURE");
    expect(normalizeTriggerStatus("DELAYED")).toBe("QUEUED");
    expect(normalizeTriggerStatus("PENDING_VERSION")).toBe("QUEUED");
    expect(normalizeTriggerStatus("DEQUEUED")).toBe("QUEUED");
    expect(normalizeTriggerStatus("EXPIRED")).toBe("EXPIRED");
    expect(normalizeTriggerStatus("TIMED_OUT")).toBe("TIMED_OUT");
    expect(normalizeTriggerStatus("SOMETHING_NEW")).toBe("UNKNOWN");
    expect(normalizeTriggerStatus(undefined)).toBe("UNKNOWN");
  });
});
