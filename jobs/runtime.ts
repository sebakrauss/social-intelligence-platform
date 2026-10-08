/**
 * Job deployment composition shared by BOTH execution planes (Step 7E.4B.3). Dependencies are created lazily, on the
 * first run that needs them — never at import time (the runtime indexes task files without database access). Shared
 * means: the worker runtime database (tenant tasks of both planes) and the post-commit wake-up of MAIN's outbox.relay.
 * The system database and the delivery runtimes are main-only (jobs/main-runtime.ts); the provider-credential opener is
 * integration-only (jobs/connections.ts). Never the web URL, the migration credential or a service-role key.
 */
import { createRuntimeDatabaseFromEnv, type RuntimeDatabase } from "@/platform/db";
import { crossPlanePin, samePlanePin, type ExecutionPlane, type JobRelease, type JobRuntime } from "@/platform/jobs";
import { createTriggerDevRuntime, unreachableJobRuntime } from "@/platform/jobs/trigger-dev";
import { createLogger, stdoutSink, type Logger } from "@/platform/observability";
import { MAIN_RELAY_TRIGGER_KEY_ENV } from "./plane-environment";

type Environment = Readonly<Record<string, string | undefined>>;

let worker: RuntimeDatabase<"worker"> | undefined;

export const jobLogger: Logger = createLogger({ sink: stdoutSink, base: { module: "jobs" } });

export function workerDatabase(): RuntimeDatabase<"worker"> {
  worker ??= createRuntimeDatabaseFromEnv("worker", process.env, { max: 4 });
  return worker;
}

const present = (value: string | undefined): value is string => value !== undefined && value !== "";

/**
 * The main plane's own project, from a task running IN the main plane: the key Trigger.dev injects into the run
 * (TRIGGER_SECRET_KEY) and the run's own preview branch; pinned to the running release when it is known.
 */
export function mainSelfRuntime(release: JobRelease, environment: Environment = process.env): JobRuntime {
  const accessToken = environment["TRIGGER_SECRET_KEY"];
  if (!present(accessToken)) return unreachableJobRuntime();
  return createTriggerDevRuntime({ accessToken, branch: "inherit", externalDeploymentId: samePlanePin(release) });
}

/**
 * The main plane's project, from a task running in the INTEGRATION plane: only the named main-project relay key
 * (Trigger only, outbox.relay) — never TRIGGER_SECRET_KEY, which is the integration project's own key there. No
 * preview branch is inherited; the trigger is pinned to the running release (refused if it can't be identified).
 */
export function mainRemoteFromIntegration(release: JobRelease, environment: Environment = process.env): JobRuntime {
  const accessToken = environment[MAIN_RELAY_TRIGGER_KEY_ENV];
  const pin = crossPlanePin(release);
  if (!present(accessToken) || !pin.allowed) return unreachableJobRuntime();
  return createTriggerDevRuntime({ accessToken, branch: "none", externalDeploymentId: pin.externalDeploymentId });
}

/** The runtime that wakes MAIN's outbox.relay after a commit, from a task running in `plane`. */
export function relayWakeRuntime(plane: ExecutionPlane, release: JobRelease, environment: Environment = process.env): JobRuntime {
  return plane === "main" ? mainSelfRuntime(release, environment) : mainRemoteFromIntegration(release, environment);
}
