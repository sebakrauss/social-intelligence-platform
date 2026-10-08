/**
 * Maps registry declarations onto Trigger.dev tasks. Tenant tasks always run through runTenantJob (one
 * workspace, worker scope, validated IDs-only payload); a NonRetryableJobError becomes the vendor's abort, so
 * permanent failures end FAILED after one attempt and are surfaced rather than retried. Outbox rows a committed
 * tenant transaction appended or routed wake the system relay right after the commit (the same nudge the web uses);
 * the dispatch sweeper only recovers a lost wake-up.
 *
 * Execution planes (Step 7E.4B.3): each task runs in the plane its registry declaration names. A run identifies its
 * release from its own deployment (external deployment id) and wakes the relay through its plane's path: a main-plane
 * task through its own project, an integration-plane task only through the restricted main-project relay key. A deployed
 * run whose environment holds another plane's capability is refused before any work.
 */
import { AbortTaskRunError, task, type TaskRunContext } from "@trigger.dev/sdk";
import {
  NonRetryableJobError,
  jobRelease,
  runTenantJob,
  runTenantStepJob,
  type ExecutionPlane,
  type JobRelease,
  type RetryPolicy,
  type TaskRegistry,
  type TenantJobContext,
  type TenantStepJobContext,
} from "@/platform/jobs";
import { nudgeRelay, type OutboxNotice } from "@/platform/outbox";
import { assertPlaneEnvironment } from "../plane-environment";
import { jobLogger, relayWakeRuntime, workerDatabase } from "../runtime";
import { LANE_QUEUES } from "./queues";

export function triggerRetry(policy: RetryPolicy) {
  return {
    maxAttempts: policy.maxAttempts,
    factor: policy.factor,
    minTimeoutInMs: policy.minDelayMs,
    maxTimeoutInMs: policy.maxDelayMs,
    randomize: policy.randomize,
  };
}

/** Rethrows permanent failures as the vendor's non-retryable abort. */
export function toVendorError(error: unknown): unknown {
  return error instanceof NonRetryableJobError ? new AbortTaskRunError(error.failureClass) : error;
}

/** The release of a running task: its deployment's external id (or local development). */
export function releaseOf(ctx: TaskRunContext): JobRelease {
  return jobRelease({ environmentType: ctx.environment.type, externalDeploymentId: ctx.deployment?.externalId });
}

/** Post-commit wake-up of the system relay from a task in `plane` (best effort; the runner logs a failure, never fails the run). */
export function wakeRelay(plane: ExecutionPlane, release: JobRelease): (notices: readonly OutboxNotice[]) => Promise<void> {
  return async (notices) => {
    const first = notices[0];
    if (first !== undefined) await nudgeRelay(relayWakeRuntime(plane, release), { outboxId: first.id, correlationId: first.correlationId });
  };
}

/** Refuses a deployed run whose environment carries another plane's capability, then builds the tenant dependencies. */
function tenantDeps(registry: TaskRegistry, plane: ExecutionPlane, ctx: TaskRunContext) {
  const release = releaseOf(ctx);
  assertPlaneEnvironment(plane, release, process.env);
  return { registry, worker: workerDatabase(), logger: jobLogger, outboxCommitted: wakeRelay(plane, release) };
}

export function defineTenantTask<T>(registry: TaskRegistry, name: string, handler: (context: TenantJobContext) => Promise<T>) {
  const definition = registry.tenant(name);
  if (definition === undefined) throw new Error(`tenant task not registered: ${name}`);
  return task({
    id: definition.name,
    queue: LANE_QUEUES[definition.lane],
    retry: triggerRetry(definition.retry),
    run: async (payload: unknown, { ctx }) => {
      try {
        return await runTenantJob(tenantDeps(registry, definition.executionPlane, ctx), definition.name, payload, { runId: ctx.run.id, attempt: ctx.attempt.number }, handler);
      } catch (error) {
        throw toVendorError(error);
      }
    },
  });
}

/** Like defineTenantTask, for multi-step handlers that call providers: no transaction is held across the handler. */
export function defineTenantStepTask<T>(registry: TaskRegistry, name: string, handler: (context: TenantStepJobContext) => Promise<T>) {
  const definition = registry.tenant(name);
  if (definition === undefined) throw new Error(`tenant task not registered: ${name}`);
  return task({
    id: definition.name,
    queue: LANE_QUEUES[definition.lane],
    retry: triggerRetry(definition.retry),
    run: async (payload: unknown, { ctx }) => {
      try {
        return await runTenantStepJob(tenantDeps(registry, definition.executionPlane, ctx), definition.name, payload, { runId: ctx.run.id, attempt: ctx.attempt.number }, handler);
      } catch (error) {
        throw toVendorError(error);
      }
    },
  });
}
