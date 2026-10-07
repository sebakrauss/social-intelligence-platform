/**
 * Job execution wrappers (TA §9.3, §11.3, §19.4; CLAUDE.md §10). Every run passes through one of them
 * before any handler code executes:
 *
 *   tenant job   registered tenant task → payload validated (IDs only) → worker login → SET LOCAL ROLE
 *                app_worker → the payload's ONE workspace bound with the sealed context → handler, which
 *                receives only that transaction and a domain-idempotency claim bound to it (R6)
 *   system job   registered named system task → system payload validated → handler receives the system
 *                runtime database (system tables only; no tenant content)
 *
 * Fail closed: an unknown task, a malformed or content-bearing payload, a missing workspace or a task/scope
 * mismatch is a NonRetryableJobError before a database connection is taken. Nothing is taken from process
 * state: the workspace comes only from the validated payload.
 */
import { parseCorrelationId } from "@/domain/correlation";
import { isAppError } from "@/domain/errors";
import { claimEffect, withWorkspaceJobScope, type DatabaseTransaction, type EffectClaim, type RuntimeDatabase } from "@/platform/db";
import type { Logger } from "@/platform/observability";
import { laneLabel } from "./lanes";
import { InvalidJobPayloadError, parseSystemJobPayload, parseTenantJobPayload, type SystemJobPayload, type TenantJobPayload } from "./payload";
import { NonRetryableJobError } from "./port";
import { payloadMatchesTask, type TaskRegistry } from "./registry";

/** Normalized error codes that retrying can't fix (TA §44.1 "Retryable? No"). */
const NON_RETRYABLE_CODES: readonly string[] = [
  "PERMISSION_DENIED", "NOT_FOUND", "MODE_BLOCKED", "CAPABILITY_UNSUPPORTED", "CAPABILITY_UNKNOWN",
  "PROVIDER_PERMANENT", "INVALID_INPUT", "CONFLICT", "PROTECTION_VETO", "AI_REFUSED", "AI_BUDGET_EXCEEDED",
];

export interface RunInfo {
  readonly runId: string;
  readonly attempt: number;
}

export interface TenantJobContext {
  /** Worker-scoped transaction bound to `payload.workspaceId`; it sees that workspace only. */
  readonly tx: DatabaseTransaction;
  readonly payload: TenantJobPayload;
  readonly run: RunInfo;
  /** R6: claims a domain effect in THIS transaction. Skip the effect when it returns "already_applied". */
  readonly claimEffect: (effectKey: string) => Promise<EffectClaim>;
}

/** One scoped step of a multi-step tenant job: a fresh worker transaction bound to the payload's workspace. */
export interface TenantJobScope {
  readonly tx: DatabaseTransaction;
  /** R6: claims a domain effect in THIS step's transaction. */
  readonly claimEffect: (effectKey: string) => Promise<EffectClaim>;
}

/**
 * Context of a tenant job whose handler makes provider calls: no transaction is held across the handler. Each
 * `inScope` call opens a fresh worker transaction bound to the SAME single workspace (from the validated payload)
 * and commits or rolls back on its own, so external calls happen between transactions, never inside one.
 */
export interface TenantStepJobContext {
  readonly payload: TenantJobPayload;
  readonly run: RunInfo;
  readonly inScope: <T>(work: (scope: TenantJobScope) => Promise<T>) => Promise<T>;
}

export interface SystemJobContext {
  readonly payload: SystemJobPayload;
  readonly run: RunInfo;
  readonly system: RuntimeDatabase<"system">;
}

export interface TenantJobDependencies {
  readonly registry: TaskRegistry;
  readonly worker: RuntimeDatabase<"worker">;
  readonly logger: Logger;
}

export interface SystemJobDependencies {
  readonly registry: TaskRegistry;
  readonly system: RuntimeDatabase<"system">;
  readonly logger: Logger;
}

function classify(error: unknown): unknown {
  if (error instanceof NonRetryableJobError) return error;
  if (error instanceof InvalidJobPayloadError) return new NonRetryableJobError("invalid_payload");
  if (isAppError(error) && NON_RETRYABLE_CODES.includes(error.code)) return new NonRetryableJobError(error.code);
  return error;
}

/** Validates a tenant run before anything else happens (fail closed, no connection taken). */
function admitTenantRun(deps: TenantJobDependencies, taskName: string, rawPayload: unknown, run: RunInfo) {
  const log = deps.logger.child({ module: "platform.jobs", task: taskName, runId: run.runId, attempt: run.attempt });
  const definition = deps.registry.tenant(taskName);
  if (definition === undefined) {
    log.error("job.rejected", { failureClass: "unknown_task" });
    throw new NonRetryableJobError("unknown_task");
  }
  let payload: TenantJobPayload;
  try {
    payload = parseTenantJobPayload(rawPayload);
  } catch {
    log.error("job.rejected", { failureClass: "invalid_payload" });
    throw new NonRetryableJobError("invalid_payload");
  }
  if (!payloadMatchesTask(definition, payload)) {
    log.error("job.rejected", { failureClass: "invalid_payload" });
    throw new NonRetryableJobError("invalid_payload");
  }
  const correlationId = parseCorrelationId(payload.correlationId);
  const scoped = log.child({
    workspaceId: payload.workspaceId,
    outboxId: payload.outboxId,
    lane: laneLabel(definition.lane),
    ...(correlationId === undefined ? {} : { correlationId }),
  });
  return { payload, scoped };
}

async function observe<T>(scoped: Logger, work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await work();
    scoped.info("job.completed", { outcome: "ok", durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    const classified = classify(error);
    scoped.warn("job.failed", {
      outcome: "error",
      durationMs: Date.now() - startedAt,
      failureClass: classified instanceof NonRetryableJobError ? "non_retryable" : "retryable",
    });
    throw classified;
  }
}

function scopeFor(tx: DatabaseTransaction, payload: TenantJobPayload, taskName: string, run: RunInfo): TenantJobScope {
  return {
    tx,
    claimEffect: (effectKey) => claimEffect(tx, { workspaceId: payload.workspaceId, effectKey, task: taskName, outboxId: payload.outboxId, runId: run.runId }),
  };
}

/** Runs a tenant task in its single workspace. Throws NonRetryableJobError for permanent failures. */
export async function runTenantJob<T>(
  deps: TenantJobDependencies,
  taskName: string,
  rawPayload: unknown,
  run: RunInfo,
  handler: (context: TenantJobContext) => Promise<T>,
): Promise<T> {
  const { payload, scoped } = admitTenantRun(deps, taskName, rawPayload, run);
  return observe(scoped, () =>
    withWorkspaceJobScope(deps.worker, payload.workspaceId, (tx) => handler({ ...scopeFor(tx, payload, taskName, run), payload, run })),
  );
}

/**
 * Runs a multi-step tenant task (e.g. one that calls a provider): same admission and single workspace as
 * runTenantJob, but each step gets its own scoped transaction and nothing is held open between steps.
 */
export async function runTenantStepJob<T>(
  deps: TenantJobDependencies,
  taskName: string,
  rawPayload: unknown,
  run: RunInfo,
  handler: (context: TenantStepJobContext) => Promise<T>,
): Promise<T> {
  const { payload, scoped } = admitTenantRun(deps, taskName, rawPayload, run);
  return observe(scoped, () =>
    handler({
      payload,
      run,
      inScope: (work) => withWorkspaceJobScope(deps.worker, payload.workspaceId, (tx) => work(scopeFor(tx, payload, taskName, run))),
    }),
  );
}

/** Runs a named system task. Only tasks registered as system-scoped are accepted. */
export async function runSystemJob<T>(
  deps: SystemJobDependencies,
  taskName: string,
  rawPayload: unknown,
  run: RunInfo,
  handler: (context: SystemJobContext) => Promise<T>,
): Promise<T> {
  const log = deps.logger.child({ module: "platform.jobs", task: taskName, runId: run.runId, attempt: run.attempt, lane: "system" });
  const definition = deps.registry.system(taskName);
  if (definition === undefined) {
    log.error("job.rejected", { failureClass: "unknown_task" });
    throw new NonRetryableJobError("unknown_task");
  }
  let payload: SystemJobPayload;
  try {
    payload = parseSystemJobPayload(rawPayload);
  } catch {
    log.error("job.rejected", { failureClass: "invalid_payload" });
    throw new NonRetryableJobError("invalid_payload");
  }
  if (payload.task !== taskName) {
    log.error("job.rejected", { failureClass: "invalid_payload" });
    throw new NonRetryableJobError("invalid_payload");
  }
  const startedAt = Date.now();
  try {
    const result = await handler({ payload, run, system: deps.system });
    log.info("job.completed", { outcome: "ok", durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    const classified = classify(error);
    log.warn("job.failed", { outcome: "error", durationMs: Date.now() - startedAt, failureClass: classified instanceof NonRetryableJobError ? "non_retryable" : "retryable" });
    throw classified;
  }
}
