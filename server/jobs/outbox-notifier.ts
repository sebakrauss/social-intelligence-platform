/**
 * Web composition of the post-commit relay nudge. The web runtime holds only the job runtime's trigger
 * credential (TRIGGER_SECRET_KEY), never a system or worker database credential: it asks the job runtime
 * to run the system relay, and the relay (system scope) does the delivery.
 */
import type { JobRuntime } from "@/platform/jobs";
import { createTriggerDevRuntime } from "@/platform/jobs/trigger-dev";
import { nudgeRelay, type OutboxNotice } from "@/platform/outbox";

export function createOutboxNotifier(runtime: JobRuntime): (notices: readonly OutboxNotice[]) => Promise<void> {
  return async (notices) => {
    const first = notices[0];
    if (first === undefined) return;
    await nudgeRelay(runtime, { outboxId: first.id, correlationId: first.correlationId });
  };
}

let runtime: JobRuntime | undefined;

/**
 * The web runtime's job runtime, or undefined when jobs aren't configured (the sweeper still delivers). It targets the
 * MAIN plane only (Step 7E.4B.3): TRIGGER_SECRET_KEY is the main project's key (to be a named Trigger-only key restricted
 * to outbox.relay); the web never knows the integration project. Preview branch and version-skew pin follow the SDK's
 * documented variables (TRIGGER_PREVIEW_BRANCH, TRIGGER_EXTERNAL_DEPLOYMENT_ID), exactly as before.
 */
export function webJobRuntime(env: Readonly<Record<string, string | undefined>> = process.env): JobRuntime | undefined {
  const accessToken = env["TRIGGER_SECRET_KEY"];
  if (accessToken === undefined || accessToken === "") return undefined;
  const externalDeploymentId = env["TRIGGER_EXTERNAL_DEPLOYMENT_ID"];
  runtime ??= createTriggerDevRuntime({
    accessToken,
    branch: "inherit",
    externalDeploymentId: externalDeploymentId === undefined || externalDeploymentId === "" ? undefined : externalDeploymentId,
  });
  return runtime;
}
