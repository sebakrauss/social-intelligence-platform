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
import { types } from "node:util";
import { AbortTaskRunError, ApiError, CompleteTaskWithOutput, task, type TaskRunContext } from "@trigger.dev/sdk";
import { AppError } from "@/domain/errors";
import { looksLikeSecret } from "@/domain/secret-patterns";
import {
  NonRetryableJobError,
  jobRelease,
  runTenantJob,
  runTenantStepJob,
  type DeliveryPlane,
  type JobRelease,
  type RetryPolicy,
  type TaskRegistry,
  type TenantJobContext,
  type TenantStepJobContext,
} from "@/platform/jobs";
import { UnexpectedJobError, describeUnexpectedError, isTrustedAppError } from "@/platform/observability";
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

/** A failure code the vendor may store: identifier-shaped, short, never credential-like (else a fixed fallback). */
const SAFE_FAILURE_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function safeFailureCode(value: unknown, fallback: string): string {
  return typeof value === "string" && SAFE_FAILURE_CODE.test(value) && !looksLikeSecret(value) ? value : fallback;
}

/**
 * A vendor API error reduced to the two fields the vendor's retry decision reads (Trigger.dev 4.7.2
 * `taskExecutor.#handleError`: `name === "TriggerApiError"` with a numeric `status`, 4xx except 408/429 skip retrying;
 * a 429 waits `millisecondsUntilReset`). Message, response body, headers and cause are dropped.
 */
class SanitizedVendorApiError extends Error {
  readonly status: number;
  readonly millisecondsUntilReset: number | undefined;

  constructor(status: unknown, millisecondsUntilReset: unknown) {
    const code = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
    super(`vendor_api_error:${String(code)}`);
    Object.defineProperty(this, "name", { value: "TriggerApiError", enumerable: false });
    this.stack = `TriggerApiError: ${this.message}`;
    this.status = code;
    this.millisecondsUntilReset = typeof millisecondsUntilReset === "number" && Number.isFinite(millisecondsUntilReset) && millisecondsUntilReset >= 0 ? millisecondsUntilReset : undefined;
  }
}

/**
 * The error a task hands the vendor (W12-SEC-01 L-2; hardened in W12-LOG-HARDEN-03 F-2). The vendor stores a failed
 * attempt's name, message, stack and causes in its run record, so nothing else crosses this boundary. Vendor control
 * errors are recognized by CLASS IDENTITY with the SDK's own exports (one @trigger.dev/core copy), never by a `name`
 * the value itself controls; an error that only claims a vendor name is treated as unknown.
 *   - a permanent failure → the vendor's non-retryable abort with its failure class (identifier-shaped, else a fixed code);
 *   - a genuine AbortTaskRunError → re-created from its (identifier-shaped) code only: still an abort;
 *   - a genuine CompleteTaskWithOutput → unchanged (the vendor completes the run with its output; not an error record);
 *   - a genuine vendor ApiError → status and rate-limit reset only, so the vendor's retry decision is unchanged;
 *   - a genuine AppError (retryable here: non-retryable codes were classified before) → re-created from its code and
 *     validated params only, without its cause;
 *   - anything else → an UnexpectedJobError carrying only its kind (and a validated SQLSTATE).
 * Fail closed: a proxy is never trusted; if recognizing or rebuilding the value throws (throwing getter, forged AppError), the
 * result is a fixed, retryable `unexpected_error:unknown`; the original value never reaches the vendor.
 */
export function toVendorError(error: unknown): unknown {
  try {
    // A proxy can answer every check differently from what the vendor later reads: never trusted, never passed on.
    if (types.isProxy(error)) return new UnexpectedJobError({ errorKind: "unknown" });
    if (error instanceof NonRetryableJobError) return new AbortTaskRunError(safeFailureCode(error.failureClass, "non_retryable"));
    if (error instanceof AbortTaskRunError) return new AbortTaskRunError(safeFailureCode(error.message, "aborted"));
    if (error instanceof CompleteTaskWithOutput) return error;
    if (error instanceof ApiError) return new SanitizedVendorApiError(error.status, (error as { readonly millisecondsUntilReset?: unknown }).millisecondsUntilReset);
    if (isTrustedAppError(error)) return new AppError(error.code, error.params);
    return new UnexpectedJobError(describeUnexpectedError(error));
  } catch {
    return new UnexpectedJobError({ errorKind: "unknown" });
  }
}

/** The release of a running task: its deployment's external id (or local development). */
export function releaseOf(ctx: TaskRunContext): JobRelease {
  return jobRelease({ environmentType: ctx.environment.type, externalDeploymentId: ctx.deployment?.externalId });
}

/** Post-commit wake-up of the system relay from a task in `plane` (best effort; the runner logs a failure, never fails the run). */
export function wakeRelay(plane: DeliveryPlane, release: JobRelease): (notices: readonly OutboxNotice[]) => Promise<void> {
  return async (notices) => {
    const first = notices[0];
    if (first !== undefined) await nudgeRelay(relayWakeRuntime(plane, release), { outboxId: first.id, correlationId: first.correlationId });
  };
}

/** Refuses a deployed run whose environment carries another plane's capability, then builds the tenant dependencies. */
function tenantDeps(registry: TaskRegistry, plane: DeliveryPlane, ctx: TaskRunContext) {
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
