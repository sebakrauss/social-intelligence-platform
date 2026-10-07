/**
 * Maps registry declarations onto Trigger.dev tasks. Tenant tasks always run through runTenantJob (one
 * workspace, worker scope, validated IDs-only payload); a NonRetryableJobError becomes the vendor's abort, so
 * permanent failures end FAILED after one attempt and are surfaced rather than retried. Outbox rows a committed
 * tenant transaction appended or routed wake the system relay right after the commit (the same nudge the web uses);
 * the dispatch sweeper only recovers a lost wake-up.
 */
import { AbortTaskRunError, task } from "@trigger.dev/sdk";
import {
  NonRetryableJobError,
  runTenantJob,
  runTenantStepJob,
  type RetryPolicy,
  type TaskRegistry,
  type TenantJobContext,
  type TenantStepJobContext,
} from "@/platform/jobs";
import { nudgeRelay, type OutboxNotice } from "@/platform/outbox";
import { jobLogger, jobRuntime, workerDatabase } from "../runtime";
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

/** Post-commit wake-up of the system relay (best effort; the runner logs a failure, never fails the run). */
export async function wakeRelay(notices: readonly OutboxNotice[]): Promise<void> {
  const first = notices[0];
  if (first !== undefined) await nudgeRelay(jobRuntime(), { outboxId: first.id, correlationId: first.correlationId });
}

const tenantDeps = (registry: TaskRegistry) => ({ registry, worker: workerDatabase(), logger: jobLogger, outboxCommitted: wakeRelay });

export function defineTenantTask<T>(registry: TaskRegistry, name: string, handler: (context: TenantJobContext) => Promise<T>) {
  const definition = registry.tenant(name);
  if (definition === undefined) throw new Error(`tenant task not registered: ${name}`);
  return task({
    id: definition.name,
    queue: LANE_QUEUES[definition.lane],
    retry: triggerRetry(definition.retry),
    run: async (payload: unknown, { ctx }) => {
      try {
        return await runTenantJob(tenantDeps(registry), definition.name, payload, { runId: ctx.run.id, attempt: ctx.attempt.number }, handler);
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
        return await runTenantStepJob(tenantDeps(registry), definition.name, payload, { runId: ctx.run.id, attempt: ctx.attempt.number }, handler);
      } catch (error) {
        throw toVendorError(error);
      }
    },
  });
}
