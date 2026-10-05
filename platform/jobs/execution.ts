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

/** Runs a tenant task in its single workspace. Throws NonRetryableJobError for permanent failures. */
export async function runTenantJob<T>(
  deps: TenantJobDependencies,
  taskName: string,
  rawPayload: unknown,
  run: RunInfo,
  handler: (context: TenantJobContext) => Promise<T>,
): Promise<T> {
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
  const startedAt = Date.now();
  try {
    const result = await withWorkspaceJobScope(deps.worker, payload.workspaceId, (tx) =>
      handler({
        tx,
        payload,
        run,
        claimEffect: (effectKey) =>
          claimEffect(tx, { workspaceId: payload.workspaceId, effectKey, task: taskName, outboxId: payload.outboxId, runId: run.runId }),
      }),
    );
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
