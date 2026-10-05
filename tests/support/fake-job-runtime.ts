/**
 * TEST DOUBLE for the JobRuntime port. It models the job-runtime behavior validated on Trigger.dev in TA-Q-04,
 * so the vendor-neutral foundation (relay, sweepers, wrappers, domain idempotency) can be proven
 * deterministically against real PostgreSQL:
 *
 *   - a dispatch (idempotency) key returns the SAME run while that run is queued, executing, completed or
 *     canceled; a FAILED, CRASHED or SYSTEM_FAILURE run RELEASES the key, so the same key gets a new run
 *   - retries follow the task's registered retry policy; a NonRetryableJobError stops after one attempt
 *   - a worker-process crash ends the run CRASHED and is NEVER retried by the runtime (the TA-Q-04 finding)
 *
 * Execution is explicit (`drain()`), and faults are scripted per run attempt. Never used outside tests.
 */
import { NonRetryableJobError, RUN_STATUSES, type EnqueueRequest, type EnqueueResult, type JobRuntime, type RetryPolicy, type RunSnapshot, type RunStatus } from "@/platform/jobs";
import { JobRuntimeRejectedError, JobRuntimeUnavailableError } from "@/platform/jobs";

export type Fault =
  | "crash_before" // the worker process dies before the handler commits anything
  | "crash_after" // the handler commits its effect, then the process dies before reporting success
  | "system_failure" // the runtime fails the run (infrastructure), outside the handler
  | "transient"; // the handler throws a retryable error

export interface FakeRun {
  readonly id: string;
  readonly request: EnqueueRequest;
  status: RunStatus;
  attemptCount: number;
}

export type FakeHandler = (payload: unknown, run: { readonly runId: string; readonly attempt: number }) => Promise<unknown>;

const RELEASED: readonly RunStatus[] = ["FAILED", "CRASHED", "SYSTEM_FAILURE"];

/** Run IDs are unique across runtime instances (like vendor run IDs), so rows left by earlier tests never collide. */
let instances = 0;

export class FakeJobRuntime implements JobRuntime {
  readonly runs = new Map<string, FakeRun>();
  readonly enqueued: EnqueueRequest[] = [];
  private readonly keys = new Map<string, string>();
  /** Runs whose status the vendor can no longer report (getRun → UNKNOWN), e.g. a lost run record. */
  private readonly unobservable = new Set<string>();
  /** Status reads per run ID (proves polling stops). */
  readonly statusReads = new Map<string, number>();
  private sequence = 0;
  private readonly instance = (instances += 1);
  /** Next enqueue fails this way, once. */
  failNextEnqueue: "unavailable" | "rejected" | undefined;
  /** Scripted faults, decided per (run, attempt). */
  fault: (run: FakeRun, attempt: number) => Fault | undefined = () => undefined;

  private readonly handlers: ReadonlyMap<string, FakeHandler>;
  private readonly retryOf: (task: string) => RetryPolicy;

  constructor(handlers: ReadonlyMap<string, FakeHandler>, retryOf: (task: string) => RetryPolicy) {
    this.handlers = handlers;
    this.retryOf = retryOf;
  }

  enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
    if (this.failNextEnqueue !== undefined) {
      const failure = this.failNextEnqueue;
      this.failNextEnqueue = undefined;
      return Promise.reject(failure === "unavailable" ? new JobRuntimeUnavailableError("down") : new JobRuntimeRejectedError("rejected"));
    }
    this.enqueued.push(request);
    const existing = this.keys.get(request.dispatchKey);
    const run = existing === undefined ? undefined : this.runs.get(existing);
    if (run !== undefined && !RELEASED.includes(run.status)) return Promise.resolve({ runId: run.id });
    this.sequence += 1;
    const created: FakeRun = { id: `run_fake_${String(this.instance)}_${String(this.sequence).padStart(4, "0")}`, request, status: "QUEUED", attemptCount: 0 };
    this.runs.set(created.id, created);
    this.keys.set(request.dispatchKey, created.id);
    return Promise.resolve({ runId: created.id });
  }

  getRun(runId: string): Promise<RunSnapshot> {
    this.statusReads.set(runId, (this.statusReads.get(runId) ?? 0) + 1);
    if (this.unobservable.has(runId)) return Promise.resolve({ runId, status: "UNKNOWN", attemptCount: 0 });
    const run = this.runs.get(runId);
    return Promise.resolve(run === undefined ? { runId, status: "UNKNOWN", attemptCount: 0 } : { runId, status: run.status, attemptCount: run.attemptCount });
  }

  /** The vendor stops reporting this run's status (it may still have executed). */
  loseStatus(runId: string): void {
    this.unobservable.add(runId);
  }

  /** The vendor reports this run's status again. */
  restoreStatus(runId: string): void {
    this.unobservable.delete(runId);
  }

  cancel(runId: string): void {
    const run = this.runs.get(runId);
    if (run !== undefined && (run.status === "QUEUED" || run.status === "EXECUTING")) run.status = "CANCELED";
  }

  /** Executes every QUEUED run (lane order), applying the retry policy and scripted faults. */
  async drain(): Promise<void> {
    const queued = [...this.runs.values()]
      .filter((run) => run.status === "QUEUED")
      .sort((a, b) => (a.request.lane === "system" ? 0 : a.request.lane) - (b.request.lane === "system" ? 0 : b.request.lane));
    for (const run of queued) await this.execute(run);
  }

  private async execute(run: FakeRun): Promise<void> {
    const handler = this.handlers.get(run.request.task);
    const policy = this.retryOf(run.request.task);
    run.status = "EXECUTING";
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      run.attemptCount = attempt;
      const fault = this.fault(run, attempt);
      if (fault === "crash_before") {
        run.status = "CRASHED";
        return;
      }
      if (fault === "system_failure") {
        run.status = "SYSTEM_FAILURE";
        return;
      }
      if (handler === undefined) {
        run.status = "FAILED";
        return;
      }
      try {
        if (fault === "transient") throw new Error("simulated transient failure");
        await handler(run.request.payload, { runId: run.id, attempt });
        if (fault === "crash_after") {
          run.status = "CRASHED";
          return;
        }
        run.status = "COMPLETED";
        return;
      } catch (error) {
        if (error instanceof NonRetryableJobError) {
          run.status = "FAILED";
          return;
        }
        if (attempt === policy.maxAttempts) {
          run.status = "FAILED";
          return;
        }
      }
    }
  }

  statusCounts(): Readonly<Partial<Record<RunStatus, number>>> {
    const counts: Partial<Record<RunStatus, number>> = {};
    for (const status of RUN_STATUSES) {
      const n = [...this.runs.values()].filter((run) => run.status === status).length;
      if (n > 0) counts[status] = n;
    }
    return counts;
  }
}
