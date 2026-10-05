/**
 * Maps registry declarations onto Trigger.dev tasks. Tenant tasks always run through runTenantJob (one
 * workspace, worker scope, validated IDs-only payload); a NonRetryableJobError becomes the vendor's abort, so
 * permanent failures end FAILED after one attempt and are surfaced rather than retried.
 */
import { AbortTaskRunError, task } from "@trigger.dev/sdk";
import { NonRetryableJobError, runTenantJob, type RetryPolicy, type TaskRegistry, type TenantJobContext } from "@/platform/jobs";
import { jobLogger, workerDatabase } from "../runtime";
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

export function defineTenantTask<T>(registry: TaskRegistry, name: string, handler: (context: TenantJobContext) => Promise<T>) {
  const definition = registry.tenant(name);
  if (definition === undefined) throw new Error(`tenant task not registered: ${name}`);
  return task({
    id: definition.name,
    queue: LANE_QUEUES[definition.lane],
    retry: triggerRetry(definition.retry),
    run: async (payload: unknown, { ctx }) => {
      try {
        return await runTenantJob({ registry, worker: workerDatabase(), logger: jobLogger }, definition.name, payload, { runId: ctx.run.id, attempt: ctx.attempt.number }, handler);
      } catch (error) {
        throw toVendorError(error);
      }
    },
  });
}
