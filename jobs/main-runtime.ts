/**
 * Main-plane-only job composition (Step 7E.4B.3): the system runtime database (outbox delivery) and the delivery
 * runtimes of both planes, as seen from the main plane. The integration plane never imports this module (dependency
 * rule), so it never needs DATABASE_SYSTEM_URL nor the integration task-operator key.
 */
import { createRuntimeDatabaseFromEnv, type RuntimeDatabase } from "@/platform/db";
import { crossPlanePin, type ExecutionPlaneRuntimes, type JobRelease, type JobRuntime } from "@/platform/jobs";
import { createTriggerDevRuntime, unreachableJobRuntime } from "@/platform/jobs/trigger-dev";
import { INTEGRATION_TASK_OPERATOR_KEY_ENV } from "./plane-environment";
import { mainSelfRuntime } from "./runtime";

type Environment = Readonly<Record<string, string | undefined>>;

let system: RuntimeDatabase<"system"> | undefined;

export function systemDatabase(): RuntimeDatabase<"system"> {
  system ??= createRuntimeDatabaseFromEnv("system", process.env, { max: 2 });
  return system;
}

/**
 * The integration plane's project, from the main plane: only the named integration-project key (Task operator,
 * restricted to the integration tasks: trigger them, read their runs) — never TRIGGER_SECRET_KEY, which is the main
 * project's own key. No preview branch is inherited; every trigger is pinned to the running release, and refused when
 * the release can't be identified. Missing key → unreachable (enqueue rejected, run lookups unavailable).
 */
export function integrationRemoteFromMain(release: JobRelease, environment: Environment = process.env): JobRuntime {
  const accessToken = environment[INTEGRATION_TASK_OPERATOR_KEY_ENV];
  const pin = crossPlanePin(release);
  if (accessToken === undefined || accessToken === "" || !pin.allowed) return unreachableJobRuntime();
  return createTriggerDevRuntime({ accessToken, branch: "none", externalDeploymentId: pin.externalDeploymentId });
}

/** The job runtime of each plane, for the outbox relay and sweepers running in the main plane. */
export function deliveryRuntimes(release: JobRelease, environment: Environment = process.env): ExecutionPlaneRuntimes {
  return Object.freeze({ main: mainSelfRuntime(release, environment), integration: integrationRemoteFromMain(release, environment) });
}
