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
 * Payloads and tags are identifiers only (validated before they get here). Credentials are passed in explicitly by the
 * composition roots (never read here) and are never logged.
 */
import { ApiError, TriggerClient, idempotencyKeys } from "@trigger.dev/sdk";
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
  /**
   * API key of the target project environment. Always explicit: this adapter never reads TRIGGER_SECRET_KEY (or any
   * other variable) itself, so a missing cross-project key can never silently become this project's own key.
   */
  readonly accessToken: string;
  readonly baseURL?: string | undefined;
  /**
   * Preview-branch policy. "inherit": the target is this runtime's own project, so the SDK's documented branch
   * discovery applies (TRIGGER_PREVIEW_BRANCH, then VERCEL_GIT_COMMIT_REF). "none": the target is another project, whose
   * branches are unrelated: no branch is sent (an explicit empty branch disables the SDK's environment fallback).
   */
  readonly branch: "inherit" | "none";
  /**
   * Version-skew protection: every run this client triggers is pinned to the target deployment built with this
   * external deployment id (Trigger.dev waits for it while it builds and expires the run if it never arrives).
   */
  readonly externalDeploymentId?: string | undefined;
}

/**
 * A job runtime bound to ONE Trigger.dev project environment, through an explicit TriggerClient instance (the SDK's
 * multi-project API): no global configure(), no ambient task context (parent run, version lock, TRIGGER_VERSION or
 * TRIGGER_EXTERNAL_DEPLOYMENT_ID are not inherited), so two runtimes in one process never share credentials or state.
 */
export function createTriggerDevRuntime(options: TriggerDevRuntimeOptions): JobRuntime {
  if (typeof options.accessToken !== "string" || options.accessToken.trim() === "") throw new JobRuntimeRejectedError("job runtime credential missing");
  const client = new TriggerClient({
    accessToken: options.accessToken,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.branch === "none" ? { previewBranch: "" } : {}),
    ...(options.externalDeploymentId === undefined ? {} : { externalDeploymentId: options.externalDeploymentId }),
  });
  return {
    async enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
      const { queue, priority } = queueAndPriority(request.lane);
      try {
        const idempotencyKey = await idempotencyKeys.create(request.dispatchKey, { scope: "global" });
        const handle = await client.tasks.trigger(request.task, request.payload, {
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
        const run = await client.runs.retrieve(runId);
        return { runId: run.id, status: normalizeTriggerStatus(run.status), attemptCount: run.attemptCount };
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return { runId, status: "UNKNOWN", attemptCount: 0 };
        throw classifyError(error);
      }
    },
  };
}

/**
 * A runtime that refuses everything (fail closed): the plane it stands for can't be reached from here — its credential
 * is not configured, or the running release can't be identified for a version-pinned cross-project trigger. Enqueue is
 * a permanent rejection (backoff, SLO alert); a run lookup is "unavailable" (re-checked later, never UNKNOWN).
 */
export function unreachableJobRuntime(): JobRuntime {
  return {
    enqueue: () => Promise.reject(new JobRuntimeRejectedError("execution plane not reachable from this runtime")),
    getRun: () => Promise.reject(new JobRuntimeUnavailableError("execution plane not reachable from this runtime")),
  };
}
