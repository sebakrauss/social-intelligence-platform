/**
 * Jobs composition across execution planes (Step 7E.4B.3), offline. The Trigger.dev adapter is replaced by a recorder,
 * so each test sees exactly which credential, branch policy and release pin a plane's runtime would be built with.
 * Synthetic key values only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as TriggerDevAdapter from "@/platform/jobs/trigger-dev";

const adapter = vi.hoisted(() => ({
  built: [] as Record<string, unknown>[],
  enqueued: [] as { readonly options: Record<string, unknown>; readonly task: string }[],
}));

vi.mock("@/platform/jobs/trigger-dev", async () => {
  const actual = await vi.importActual<typeof TriggerDevAdapter>("@/platform/jobs/trigger-dev");
  return {
    ...actual,
    createTriggerDevRuntime: (options: Record<string, unknown>) => {
      adapter.built.push(options);
      return {
        enqueue: (request: { task: string }) => {
          adapter.enqueued.push({ options, task: request.task });
          return Promise.resolve({ runId: "run_synthetic" });
        },
        getRun: (runId: string) => Promise.resolve({ runId, status: "COMPLETED", attemptCount: 1 }),
      };
    },
  };
});

const { JobRuntimeRejectedError, JobRuntimeUnavailableError, NonRetryableJobError, crossPlanePin, jobRelease, samePlanePin } = await import("@/platform/jobs");
const { mainRemoteFromIntegration, mainSelfRuntime, relayWakeRuntime } = await import("@/jobs/runtime");
const { deliveryRuntimes, integrationRemoteFromMain } = await import("@/jobs/main-runtime");
const { PLANE_FORBIDDEN_VARIABLES, assertPlaneEnvironment, planeEnvironmentProblems } = await import("@/jobs/plane-environment");
const { wakeRelay } = await import("@/jobs/trigger/define");

const PINNED = { kind: "pinned", releaseId: "commit-synthetic-1" } as const;
const DEVELOPMENT = { kind: "development" } as const;
const UNIDENTIFIED = { kind: "unidentified" } as const;
const OWN = "tr_stg_synthetic_own_key";
const OPERATOR = "tr_stg_sk_synthetic_integration_operator";
const RELAY = "tr_stg_sk_synthetic_main_relay";

const unreachable = async (runtime: { enqueue: (request: never) => Promise<unknown>; getRun: (id: string) => Promise<unknown> }) => {
  await expect(runtime.enqueue({ task: "outbox.relay", payload: {}, dispatchKey: "outbox.relay:1", lane: "system" } as never)).rejects.toBeInstanceOf(JobRuntimeRejectedError);
  await expect(runtime.getRun("run_x")).rejects.toBeInstanceOf(JobRuntimeUnavailableError);
};

beforeEach(() => {
  adapter.built.length = 0;
  adapter.enqueued.length = 0;
});

describe("the release of a running job (version-skew pin)", () => {
  it("a deployed run with an external deployment id is pinned; development is unpinned; a deployed run without one is unidentified", () => {
    expect(jobRelease({ environmentType: "STAGING", externalDeploymentId: "commit-synthetic-1" })).toEqual(PINNED);
    expect(jobRelease({ environmentType: "PREVIEW", externalDeploymentId: "commit-synthetic-1" })).toEqual(PINNED);
    expect(jobRelease({ environmentType: "DEVELOPMENT", externalDeploymentId: undefined })).toEqual(DEVELOPMENT);
    expect(jobRelease({ environmentType: "PRODUCTION", externalDeploymentId: undefined })).toEqual(UNIDENTIFIED);
    expect(jobRelease({ environmentType: "STAGING", externalDeploymentId: "" })).toEqual(UNIDENTIFIED);
    expect(jobRelease({ environmentType: "STAGING", externalDeploymentId: "has space" })).toEqual(UNIDENTIFIED);
    expect(jobRelease({ environmentType: "STAGING", externalDeploymentId: "x".repeat(129) })).toEqual(UNIDENTIFIED);
  });

  it("cross-plane triggers are pinned to the release, unpinned only in development, refused when unidentified", () => {
    expect(crossPlanePin(PINNED)).toEqual({ allowed: true, externalDeploymentId: "commit-synthetic-1" });
    expect(crossPlanePin(DEVELOPMENT)).toEqual({ allowed: true, externalDeploymentId: undefined });
    expect(crossPlanePin(UNIDENTIFIED)).toEqual({ allowed: false });
    expect(samePlanePin(PINNED)).toBe("commit-synthetic-1");
    expect(samePlanePin(UNIDENTIFIED)).toBeUndefined();
  });
});

describe("plane runtimes: explicit credentials, no fallback, no inherited branch across projects", () => {
  it("main → main (self): the run's own key, its own preview branch, pinned to the running release", () => {
    mainSelfRuntime(PINNED, { TRIGGER_SECRET_KEY: OWN });
    expect(adapter.built).toEqual([{ accessToken: OWN, branch: "inherit", externalDeploymentId: "commit-synthetic-1" }]);
  });

  it("main → integration: only the integration task-operator key, no branch, pinned — never TRIGGER_SECRET_KEY", async () => {
    integrationRemoteFromMain(PINNED, { TRIGGER_SECRET_KEY: OWN, TRIGGER_INTEGRATION_TASK_OPERATOR_KEY: OPERATOR });
    expect(adapter.built).toEqual([{ accessToken: OPERATOR, branch: "none", externalDeploymentId: "commit-synthetic-1" }]);
    adapter.built.length = 0;
    await unreachable(integrationRemoteFromMain(PINNED, { TRIGGER_SECRET_KEY: OWN }));
    await unreachable(integrationRemoteFromMain(PINNED, { TRIGGER_SECRET_KEY: OWN, TRIGGER_INTEGRATION_TASK_OPERATOR_KEY: "" }));
    await unreachable(integrationRemoteFromMain(UNIDENTIFIED, { TRIGGER_INTEGRATION_TASK_OPERATOR_KEY: OPERATOR }));
    expect(adapter.built).toEqual([]);
  });

  it("integration → main: only the main relay key, no branch, pinned — never TRIGGER_SECRET_KEY (the integration project's own key)", async () => {
    mainRemoteFromIntegration(PINNED, { TRIGGER_SECRET_KEY: OWN, TRIGGER_MAIN_RELAY_TRIGGER_KEY: RELAY });
    expect(adapter.built).toEqual([{ accessToken: RELAY, branch: "none", externalDeploymentId: "commit-synthetic-1" }]);
    adapter.built.length = 0;
    await unreachable(mainRemoteFromIntegration(PINNED, { TRIGGER_SECRET_KEY: OWN }));
    await unreachable(mainRemoteFromIntegration(UNIDENTIFIED, { TRIGGER_MAIN_RELAY_TRIGGER_KEY: RELAY }));
    expect(adapter.built).toEqual([]);
  });

  it("the relay wake-up path follows the task's plane", () => {
    relayWakeRuntime("main", PINNED, { TRIGGER_SECRET_KEY: OWN, TRIGGER_MAIN_RELAY_TRIGGER_KEY: RELAY });
    relayWakeRuntime("integration", PINNED, { TRIGGER_SECRET_KEY: OWN, TRIGGER_MAIN_RELAY_TRIGGER_KEY: RELAY });
    expect(adapter.built.map((options) => options["accessToken"])).toEqual([OWN, RELAY]);
  });

  it("the delivery runtimes are two distinct clients with their own credentials", () => {
    const runtimes = deliveryRuntimes(PINNED, { TRIGGER_SECRET_KEY: OWN, TRIGGER_INTEGRATION_TASK_OPERATOR_KEY: OPERATOR });
    expect(runtimes.main).not.toBe(runtimes.integration);
    expect(adapter.built.map((options) => [options["accessToken"], options["branch"]])).toEqual([[OWN, "inherit"], [OPERATOR, "none"]]);
  });

  it("an integration task's post-commit wake-up triggers MAIN's outbox.relay through the restricted relay key", async () => {
    vi.stubEnv("TRIGGER_SECRET_KEY", OWN);
    vi.stubEnv("TRIGGER_MAIN_RELAY_TRIGGER_KEY", RELAY);
    try {
      await wakeRelay("integration", PINNED)([{ id: crypto.randomUUID(), correlationId: "corr-planes-wake" }]);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(adapter.enqueued).toEqual([{ options: { accessToken: RELAY, branch: "none", externalDeploymentId: "commit-synthetic-1" }, task: "outbox.relay" }]);
  });
});

describe("per-plane environment contract (deployed runs)", () => {
  it("the integration plane refuses the system DB credential and the integration task-operator key", () => {
    expect(PLANE_FORBIDDEN_VARIABLES.integration).toEqual(["DATABASE_SYSTEM_URL", "TRIGGER_INTEGRATION_TASK_OPERATOR_KEY"]);
    expect(planeEnvironmentProblems("integration", PINNED, { DATABASE_SYSTEM_URL: "postgres://synthetic", DATABASE_WORKER_URL: "postgres://synthetic" })).toEqual(["DATABASE_SYSTEM_URL"]);
    expect(() => { assertPlaneEnvironment("integration", PINNED, { TRIGGER_INTEGRATION_TASK_OPERATOR_KEY: OPERATOR }); }).toThrow(NonRetryableJobError);
    expect(() => { assertPlaneEnvironment("integration", PINNED, { DATABASE_WORKER_URL: "postgres://synthetic", TRIGGER_MAIN_RELAY_TRIGGER_KEY: RELAY }); }).not.toThrow();
  });

  it("the main plane refuses the integration→main relay key, and still legitimately holds the worker DB credential (Move saga)", () => {
    expect(PLANE_FORBIDDEN_VARIABLES.main).toEqual(["TRIGGER_MAIN_RELAY_TRIGGER_KEY"]);
    expect(() => { assertPlaneEnvironment("main", UNIDENTIFIED, { TRIGGER_MAIN_RELAY_TRIGGER_KEY: RELAY }); }).toThrow(NonRetryableJobError);
    expect(() => { assertPlaneEnvironment("main", PINNED, { DATABASE_SYSTEM_URL: "x", DATABASE_WORKER_URL: "x", TRIGGER_INTEGRATION_TASK_OPERATOR_KEY: OPERATOR }); }).not.toThrow();
  });

  it("local development runs (one shared .env for both dev sessions) are not refused", () => {
    expect(planeEnvironmentProblems("integration", DEVELOPMENT, { DATABASE_SYSTEM_URL: "x", TRIGGER_INTEGRATION_TASK_OPERATOR_KEY: OPERATOR })).toEqual([]);
  });
});
