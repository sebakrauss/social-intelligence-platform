/**
 * Per-plane environment contract of the jobs deployments (Step 7E.4B.3). Each execution plane is its own Trigger.dev
 * project, and a project's environment variables reach EVERY task of that project — so a capability must simply not be
 * configured in a plane that has no use for it.
 *
 *   TRIGGER_INTEGRATION_TASK_OPERATOR_KEY   main → integration: a named integration-project key (Task operator,
 *                                           restricted to the integration tasks) to trigger them and read their runs
 *   TRIGGER_MAIN_RELAY_TRIGGER_KEY          integration → main: a named main-project key (Trigger only, restricted to
 *                                           outbox.relay) for the post-commit relay wake-up
 *
 *   INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID,     the integration worker's AWS bootstrap identity (Step 7E.4C; DEV/non-prod):
 *   INTEGRATION_AWS_BOOTSTRAP_SECRET_ACCESS_KEY, an IAM user allowed only to assume INTEGRATION_AWS_WORKER_ROLE_ARN
 *   INTEGRATION_AWS_WORKER_ROLE_ARN              (jobs/integration-aws-identity.ts)
 *
 * The two Trigger keys are orchestration credentials — never AWS identity — and neither ever falls back to
 * TRIGGER_SECRET_KEY (the project's own key that Trigger.dev injects into each run). Partial DB separation: the
 * integration plane never holds the system database credential; the main plane still needs the worker one (Move saga).
 *
 * Deployed runs refuse a variable that belongs to the other plane, and the integration plane also refuses the standard
 * AWS credential-chain variables: its one AWS identity source is the explicit bootstrap above. Local development runs
 * share one .env file across both `trigger dev` sessions, so the check applies to deployed runs only.
 */
import { NonRetryableJobError, type ExecutionPlane, type JobRelease } from "@/platform/jobs";

export const INTEGRATION_TASK_OPERATOR_KEY_ENV = "TRIGGER_INTEGRATION_TASK_OPERATOR_KEY";
export const MAIN_RELAY_TRIGGER_KEY_ENV = "TRIGGER_MAIN_RELAY_TRIGGER_KEY";
export const INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID_ENV = "INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID";
export const INTEGRATION_AWS_BOOTSTRAP_SECRET_ACCESS_KEY_ENV = "INTEGRATION_AWS_BOOTSTRAP_SECRET_ACCESS_KEY";
export const INTEGRATION_AWS_WORKER_ROLE_ARN_ENV = "INTEGRATION_AWS_WORKER_ROLE_ARN";

/** The standard AWS SDK credential-chain variables: never an identity source of the integration worker. */
const AWS_CREDENTIAL_CHAIN_VARIABLES = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_WEB_IDENTITY_TOKEN_FILE"];

/** Variables a deployed run of each plane must NOT hold. */
export const PLANE_FORBIDDEN_VARIABLES: Readonly<Record<ExecutionPlane, readonly string[]>> = Object.freeze({
  main: Object.freeze([MAIN_RELAY_TRIGGER_KEY_ENV, INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID_ENV, INTEGRATION_AWS_BOOTSTRAP_SECRET_ACCESS_KEY_ENV, INTEGRATION_AWS_WORKER_ROLE_ARN_ENV]),
  integration: Object.freeze(["DATABASE_SYSTEM_URL", INTEGRATION_TASK_OPERATOR_KEY_ENV, ...AWS_CREDENTIAL_CHAIN_VARIABLES]),
});

type Environment = Readonly<Record<string, string | undefined>>;

/** The forbidden variables present (names only, never values); empty for local development runs. */
export function planeEnvironmentProblems(plane: ExecutionPlane, release: JobRelease, environment: Environment): readonly string[] {
  if (release.kind === "development") return [];
  return PLANE_FORBIDDEN_VARIABLES[plane].filter((name) => (environment[name] ?? "") !== "");
}

/** Fails a deployed run closed (no retry) when its plane's environment carries another plane's capability. */
export function assertPlaneEnvironment(plane: ExecutionPlane, release: JobRelease, environment: Environment): void {
  if (planeEnvironmentProblems(plane, release, environment).length > 0) throw new NonRetryableJobError("plane_environment_refused");
}
