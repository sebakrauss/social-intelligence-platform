/**
 * Trigger.dev implementation of the JobRuntime port (TA §19.1; TA-Q-04 PASS). The ONLY runtime module that
 * imports the Trigger.dev SDK for triggering and run reads; task definitions live in the jobs deployment
 * (jobs/trigger). Product and domain code depend on the port, never on this module (dependency rule).
 *
 *   - dispatch key → GLOBAL idempotency key: a redispatch returns the original run while the vendor keeps
 *     it (pending, executing, completed, canceled); a FAILED or CRASHED run releases it, so R7 recovery
 *     gets a new run (validated in TA-Q-04)
 *   - lane → its own queue plus a priority offset; keyed concurrency through `concurrencyKey`
 *   - vendor statuses → the port's normalized RunStatus; anything unrecognized → UNKNOWN
 *
 * Payloads and tags are identifiers only (validated before they get here). Secrets come from the
 * environment of the deployment and are never logged.
 */
import { ApiError, configure, idempotencyKeys, runs, tasks } from "@trigger.dev/sdk";
import { LANE_DEFINITIONS, SYSTEM_QUEUE } from "./lanes";
import {
  JobRuntimeRejectedError,
  JobRuntimeUnavailableError,
  type EnqueueRequest,
  type EnqueueResult,
  type JobRuntime,
  type RunSnapshot,
  type RunStatus,
} from "./port";

const STATUS_MAP: Readonly<Record<string, RunStatus>> = {
  PENDING_VERSION: "QUEUED",
  DELAYED: "QUEUED",
  QUEUED: "QUEUED",
  DEQUEUED: "QUEUED",
  EXECUTING: "EXECUTING",
  WAITING: "WAITING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELED: "CANCELED",
  CRASHED: "CRASHED",
  SYSTEM_FAILURE: "SYSTEM_FAILURE",
  EXPIRED: "EXPIRED",
  TIMED_OUT: "TIMED_OUT",
};

/** Normalizes a Trigger.dev run status. Unknown values never pass as a known state. */
export function normalizeTriggerStatus(status: unknown): RunStatus {
  return typeof status === "string" ? (STATUS_MAP[status] ?? "UNKNOWN") : "UNKNOWN";
}

function queueAndPriority(lane: EnqueueRequest["lane"]): { readonly queue: string; readonly priority: number } {
  if (lane === "system") return { queue: SYSTEM_QUEUE.queue, priority: 0 };
  const definition = LANE_DEFINITIONS[lane];
  return { queue: definition.queue, priority: definition.priorityOffsetSeconds };
}

/** 4xx (except 408/429) is a permanent rejection; anything else (network, 408, 429, 5xx) is transient. */
function classifyError(error: unknown): Error {
  if (error instanceof ApiError && typeof error.status === "number" && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
    return new JobRuntimeRejectedError(`job runtime rejected the request (${String(error.status)})`);
  }
  return new JobRuntimeUnavailableError("job runtime unavailable");
}

export interface TriggerDevRuntimeOptions {
  /** Development/production secret key of the target environment (from the deployment's environment). */
  readonly secretKey: string;
  readonly baseURL?: string | undefined;
}

export function createTriggerDevRuntime(options: TriggerDevRuntimeOptions): JobRuntime {
  configure({ secretKey: options.secretKey, ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }) });
  return {
    async enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
      const { queue, priority } = queueAndPriority(request.lane);
      try {
        const idempotencyKey = await idempotencyKeys.create(request.dispatchKey, { scope: "global" });
        const handle = await tasks.trigger(request.task, request.payload, {
          idempotencyKey,
          queue,
          priority,
          ...(request.concurrencyKey === undefined ? {} : { concurrencyKey: request.concurrencyKey }),
          ...(request.tags === undefined ? {} : { tags: [...request.tags] }),
        });
        return { runId: handle.id };
      } catch (error) {
        throw classifyError(error);
      }
    },
    async getRun(runId: string): Promise<RunSnapshot> {
      try {
        const run = await runs.retrieve(runId);
        return { runId: run.id, status: normalizeTriggerStatus(run.status), attemptCount: run.attemptCount };
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return { runId, status: "UNKNOWN", attemptCount: 0 };
        throw classifyError(error);
      }
    },
  };
}
