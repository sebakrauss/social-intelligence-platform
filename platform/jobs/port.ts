/**
 * JobRuntime port (TA §19.1, §6.3). The only surface product code uses to start background work; the
 * concrete runtime (Trigger.dev, selected; Graphile Worker, fallback) lives behind it. Deliberately thin:
 * enqueue a registered task with an IDs-only payload under a stable dispatch key, and read a run's status
 * for the run-outcome sweeper (R7). Nothing here promises exactly-once delivery: at-least-once execution
 * plus domain idempotency (R6) is what makes an effect happen once.
 */
import type { Lane } from "./lanes";
import type { JobPayload } from "./payload";

/** Normalized run status. Vendor statuses map onto these; anything unrecognized is UNKNOWN. */
export const RUN_STATUSES = [
  "QUEUED",
  "EXECUTING",
  "WAITING",
  "COMPLETED",
  "FAILED",
  "CANCELED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
  "UNKNOWN",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["COMPLETED", "FAILED", "CANCELED", "CRASHED", "SYSTEM_FAILURE", "EXPIRED", "TIMED_OUT"];

export interface EnqueueRequest {
  readonly task: string;
  readonly payload: JobPayload;
  /** Stable dispatch key = domain identity of this unit of work (the outbox dispatch key). */
  readonly dispatchKey: string;
  /** Product lane, or "system" for the named system jobs. */
  readonly lane: Lane | "system";
  /** Keyed concurrency (e.g. per workspace or per provider account) where ordering or budgets matter. */
  readonly concurrencyKey?: string;
  /** Opaque identifier tags for diagnosis (IDs only). */
  readonly tags?: readonly string[];
}

export interface EnqueueResult {
  /** Durable vendor run identifier. The same key returns the same run while the vendor keeps it. */
  readonly runId: string;
}

export interface RunSnapshot {
  readonly runId: string;
  readonly status: RunStatus;
  readonly attemptCount: number;
}

export interface JobRuntime {
  enqueue(request: EnqueueRequest): Promise<EnqueueResult>;
  /** Current status of a run; status UNKNOWN when the vendor doesn't know the run. */
  getRun(runId: string): Promise<RunSnapshot>;
}

/** The job runtime couldn't be reached or refused for a transient reason: retry later with backoff. */
export class JobRuntimeUnavailableError extends Error {
  override readonly name = "JobRuntimeUnavailableError";
}

/** The job runtime rejected the request permanently (e.g. unknown task): don't hammer it. */
export class JobRuntimeRejectedError extends Error {
  override readonly name = "JobRuntimeRejectedError";
}

/**
 * Thrown by a job handler to stop retries immediately (non-retryable failure classes, TA §44). The runtime
 * adapter maps it to the vendor's abort mechanism; the run ends FAILED and is surfaced, not re-dispatched.
 */
export class NonRetryableJobError extends Error {
  override readonly name = "NonRetryableJobError";
  readonly failureClass: string;
  constructor(failureClass: string) {
    super(`non-retryable job failure: ${failureClass}`);
    this.failureClass = failureClass;
  }
}
