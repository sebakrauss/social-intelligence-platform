/**
 * Outbox delivery (TA §19.3; R6, R7). Runs only in system scope (system login → app_system), the single
 * writer of delivery state:
 *
 *   relayPass            lease due PENDING rows → build the IDs-only payload from the row → enqueue under
 *                        the row's stable dispatch key → record DISPATCHED + the run (or back off)
 *   sweepDispatch        scheduled: the same pass for rows older than a threshold, plus SLO breach alerts
 *   sweepRunOutcomes     scheduled (R7): read each dispatched row's current run; record COMPLETED / FAILED /
 *                        CANCELED (surfaced, never blindly re-dispatched); re-queue CRASHED / SYSTEM_FAILURE
 *                        under the same dispatch key, bounded by maxRecoveries, then RECOVERY_EXHAUSTED;
 *                        UNKNOWN is never re-dispatched or classified: re-checked within unknownObservation,
 *                        then OBSERVATION_EXHAUSTED (diagnostic state, alerted once, no longer polled)
 *
 * Execution planes (Step 7E.4B.3; migration 0011): the claim binds every unbound row to the plane the task registry
 * declares for its topic, atomically with the lease; from then on the PERSISTED plane — never the current registry —
 * selects the job runtime for every dispatch attempt, every R7 recovery and every run lookup of that delivery. A run
 * is looked up only in the plane that owns it: a NOT FOUND there is UNKNOWN, never a reason to ask the other plane.
 *
 * Crash windows: dying before enqueue leaves the row PENDING (lease expires, re-claimed); dying after
 * enqueue but before recording leaves it leased PENDING — the next pass enqueues the same dispatch key and
 * gets the same run back. Concurrent relays skip leased rows. Domain idempotency (R6) keeps any duplicate
 * execution to one durable effect. This is at-least-once execution, never "exactly-once delivery".
 */
import { createHash } from "node:crypto";
import { parseCorrelationId } from "@/domain/correlation";
import type { RuntimeDatabase } from "@/platform/db";
import {
  claimDueRows,
  countExecutionCapableBound,
  flagSloBreaches,
  listAwaitingOutcome,
  markDispatched,
  markObservationExhausted,
  markDispatchFailed,
  oldestPendingAgeSeconds,
  recordOutcome,
  recordRunStatus,
  requeueForRecovery,
  type ClaimedOutboxRow,
  type DeliveryFailureClass,
} from "@/platform/db/outbox-delivery";
import { withSystemScope } from "@/platform/db/system-scope";
import {
  JobRuntimeRejectedError,
  JobRuntimeUnavailableError,
  TERMINAL_RUN_STATUSES,
  concurrencyKeyFor,
  laneLabel,
  parseTenantJobPayload,
  payloadMatchesTask,
  type ExecutionPlane,
  type ExecutionPlaneRuntimes,
  type TaskRegistry,
  type TenantJobPayload,
} from "@/platform/jobs";
import type { Logger } from "@/platform/observability";

/** Explicit delivery thresholds (no magic numbers in code paths). */
export interface DeliveryConfig {
  /** Rows leased per relay pass (bounds the work of one pass: no hot loop). */
  readonly batchSize: number;
  /** How long a relay owns a leased row before another relay may take it over. */
  readonly leaseSeconds: number;
  /** Back-off after a failed enqueue: base · 2^(attempts−1), capped. */
  readonly backoff: { readonly baseSeconds: number; readonly maxSeconds: number };
  /** The scheduled dispatch sweeper only re-dispatches rows at least this old. */
  readonly dispatchSweepMinAgeSeconds: number;
  /** Undispatched beyond this age = SLO breach (flagged once, alerted). */
  readonly dispatchSloSeconds: number;
  /** R7: CRASHED / SYSTEM_FAILURE recoveries allowed per row before RECOVERY_EXHAUSTED. */
  readonly maxRecoveries: number;
  /** Dispatched rows checked per run-outcome sweep. */
  readonly outcomeBatchSize: number;
  /**
   * Bound on observing a run whose status stays UNKNOWN (never re-dispatched, never classified): after
   * `maxChecks` consecutive UNKNOWN observations OR `maxSeconds` since the first one, whichever comes first,
   * the row becomes OBSERVATION_EXHAUSTED (alerted once, no longer polled).
   */
  readonly unknownObservation: { readonly maxChecks: number; readonly maxSeconds: number };
}

export const DEFAULT_DELIVERY_CONFIG: DeliveryConfig = {
  batchSize: 50,
  leaseSeconds: 60,
  backoff: { baseSeconds: 5, maxSeconds: 900 },
  dispatchSweepMinAgeSeconds: 60,
  dispatchSloSeconds: 300,
  maxRecoveries: 3,
  outcomeBatchSize: 100,
  unknownObservation: { maxChecks: 15, maxSeconds: 1_800 }, // ≈ 30 min at the 2-minute outcome-sweep cadence
};

export interface DeliveryDependencies {
  readonly system: RuntimeDatabase<"system">;
  /** The job runtime of each execution plane; a delivery's persisted plane picks one. */
  readonly runtimes: ExecutionPlaneRuntimes;
  readonly registry: TaskRegistry;
  readonly logger: Logger;
  readonly clock: () => Date;
  readonly config?: DeliveryConfig;
}

export interface RelayResult {
  readonly claimed: number;
  readonly dispatched: number;
  readonly failed: number;
}

export interface OutcomeSweepResult {
  readonly checked: number;
  readonly completed: number;
  readonly failed: number;
  readonly canceled: number;
  readonly recovered: number;
  readonly exhausted: number;
  /** Rows that entered OBSERVATION_EXHAUSTED in this sweep. */
  readonly unobservable: number;
  readonly pending: number;
}

/** First 12 hex characters of SHA-256(dispatch key): a log-safe correlation handle. */
export function dispatchKeyFingerprint(dispatchKey: string): string {
  return createHash("sha256").update(dispatchKey, "utf8").digest("hex").slice(0, 12);
}

function backoffSeconds(config: DeliveryConfig, attempts: number): number {
  return Math.min(config.backoff.maxSeconds, config.backoff.baseSeconds * 2 ** Math.max(0, attempts - 1));
}

function payloadFor(row: ClaimedOutboxRow): TenantJobPayload {
  return parseTenantJobPayload({
    v: 1,
    scope: "workspace",
    task: row.topic,
    workspaceId: row.workspaceId,
    outboxId: row.id,
    subjectIds: row.subjectIds,
    correlationId: row.correlationId,
    initiator: row.initiatorType === "user" ? { type: "user", userId: row.initiatorUserId } : { type: row.initiatorType },
  });
}

async function dispatchRow(deps: DeliveryDependencies, config: DeliveryConfig, row: ClaimedOutboxRow, now: Date): Promise<boolean> {
  const correlationId = parseCorrelationId(row.correlationId);
  const log = deps.logger.child({
    module: "platform.outbox",
    outboxId: row.id,
    task: row.topic,
    dispatchKeyFingerprint: dispatchKeyFingerprint(row.dispatchKey),
    executionPlane: row.executionPlane,
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(row.workspaceId === null ? {} : { workspaceId: row.workspaceId }),
  });
  const fail = async (failureClass: DeliveryFailureClass): Promise<false> => {
    const retryAt = new Date(now.getTime() + backoffSeconds(config, row.dispatchAttempts + 1) * 1000);
    await withSystemScope(deps.system, (tx) => markDispatchFailed(tx, { outboxId: row.id, failureClass, retryAt }));
    log.warn("outbox.dispatch.failed", { failureClass, dispatchAttempts: row.dispatchAttempts + 1 });
    return false;
  };

  const definition = deps.registry.tenant(row.topic);
  if (definition === undefined) return fail("unknown_task");
  let payload: TenantJobPayload;
  try {
    payload = payloadFor(row);
  } catch {
    return fail("invalid_payload");
  }
  if (!payloadMatchesTask(definition, payload)) return fail("invalid_payload");
  // A bound delivery stays on its persisted plane even when the registry now routes new work elsewhere (a moved task):
  // its implementation must stay deployed there until no bound delivery can still run it (retirementReadiness).
  if (definition.executionPlane !== row.executionPlane) log.info("outbox.dispatch.bound_plane_kept", { routedPlane: definition.executionPlane });

  let runId: string;
  try {
    const concurrencyKey = concurrencyKeyFor(definition, payload);
    ({ runId } = await deps.runtimes[row.executionPlane].enqueue({
      task: definition.name,
      payload,
      dispatchKey: row.dispatchKey,
      lane: definition.lane,
      ...(concurrencyKey === undefined ? {} : { concurrencyKey }),
      tags: [`outbox_${row.id}`],
    }));
  } catch (error) {
    if (error instanceof JobRuntimeRejectedError) return fail("enqueue_rejected");
    if (error instanceof JobRuntimeUnavailableError) return fail("enqueue_unavailable");
    throw error; // unexpected: abort the pass; the lease expires and another pass retries (crash window)
  }
  const recorded = await withSystemScope(deps.system, (tx) => markDispatched(tx, { outboxId: row.id, runId, now }));
  log.info("outbox.dispatched", {
    runId,
    lane: laneLabel(definition.lane),
    dispatchAttempts: row.dispatchAttempts + 1,
    recoveryCount: row.recoveryCount,
    ageMs: Math.max(0, now.getTime() - row.createdAt.getTime()),
    outcome: recorded ? "ok" : "error",
  });
  return recorded;
}

/** Dispatches due PENDING rows (at most `batchSize`). Safe to run concurrently and repeatedly. */
export async function relayPass(deps: DeliveryDependencies, options: { readonly minAgeSeconds?: number } = {}): Promise<RelayResult> {
  const config = deps.config ?? DEFAULT_DELIVERY_CONFIG;
  const now = deps.clock();
  const rows = await withSystemScope(deps.system, (tx) =>
    claimDueRows(tx, { now, minAgeSeconds: options.minAgeSeconds ?? 0, leaseSeconds: config.leaseSeconds, limit: config.batchSize, unboundRoutes: deps.registry.unboundRoutes }),
  );
  let dispatched = 0;
  let failed = 0;
  for (const row of rows) {
    if (await dispatchRow(deps, config, row, now)) dispatched += 1;
    else failed += 1;
  }
  if (rows.length > 0) deps.logger.info("outbox.relay.pass", { module: "platform.outbox", count: rows.length });
  return { claimed: rows.length, dispatched, failed };
}

/** Scheduled dispatch sweeper: re-dispatches lost dispatches and alerts on rows older than the SLO. */
export async function sweepDispatch(deps: DeliveryDependencies): Promise<RelayResult & { readonly sloBreaches: number }> {
  const config = deps.config ?? DEFAULT_DELIVERY_CONFIG;
  const result = await relayPass(deps, { minAgeSeconds: config.dispatchSweepMinAgeSeconds });
  const now = deps.clock();
  const { breaches, oldest } = await withSystemScope(deps.system, async (tx) => ({
    breaches: await flagSloBreaches(tx, { now, sloSeconds: config.dispatchSloSeconds }),
    oldest: await oldestPendingAgeSeconds(tx, now),
  }));
  for (const breach of breaches) {
    deps.logger.error("outbox.dispatch.slo_breached", {
      module: "platform.outbox",
      outboxId: breach.id,
      task: breach.topic,
      ageMs: Math.max(0, now.getTime() - breach.createdAt.getTime()),
    });
  }
  deps.logger.info("outbox.age", { module: "platform.outbox", ...(oldest === null ? { count: 0 } : { ageMs: Math.round(oldest * 1000) }) });
  return { ...result, sloBreaches: breaches.length };
}

/**
 * R7 run-outcome sweeper. Never re-dispatches FAILED or CANCELED; recovers crashes within a bound. An UNKNOWN
 * status is never re-dispatched or classified: it is re-checked within `unknownObservation`, then the row
 * becomes OBSERVATION_EXHAUSTED (alerted once) and is no longer polled.
 */
export async function sweepRunOutcomes(deps: DeliveryDependencies): Promise<OutcomeSweepResult> {
  const config = deps.config ?? DEFAULT_DELIVERY_CONFIG;
  const rows = await withSystemScope(deps.system, (tx) => listAwaitingOutcome(tx, { limit: config.outcomeBatchSize }));
  const tally = { checked: 0, completed: 0, failed: 0, canceled: 0, recovered: 0, exhausted: 0, unobservable: 0, pending: 0 };
  for (const row of rows) {
    const log = deps.logger.child({ module: "platform.outbox", outboxId: row.id, task: row.topic, runId: row.runId, recoveryCount: row.recoveryCount, executionPlane: row.executionPlane });
    let snapshot;
    try {
      // The plane that owns the run, chosen BEFORE the lookup; a NOT FOUND there is UNKNOWN — no other plane is asked.
      snapshot = await deps.runtimes[row.executionPlane].getRun(row.runId);
    } catch (error) {
      if (error instanceof JobRuntimeUnavailableError) {
        log.warn("outbox.run.status_unavailable", { failureClass: "enqueue_unavailable" });
        tally.pending += 1;
        continue;
      }
      throw error;
    }
    tally.checked += 1;
    const now = deps.clock();
    const terminal = TERMINAL_RUN_STATUSES.includes(snapshot.status);
    await withSystemScope(deps.system, async (tx) => {
      const streak = await recordRunStatus(tx, { outboxId: row.id, runId: row.runId, status: snapshot.status, attemptCount: snapshot.attemptCount, terminal, now });
      switch (snapshot.status) {
        case "COMPLETED":
          if (await recordOutcome(tx, { outboxId: row.id, outcome: "COMPLETED", failureClass: null, now })) tally.completed += 1;
          log.info("outbox.run.completed", { runStatus: snapshot.status, attempt: snapshot.attemptCount });
          return;
        case "FAILED":
        case "TIMED_OUT":
        case "EXPIRED": {
          const failureClass = snapshot.status === "FAILED" ? "run_failed" : snapshot.status === "TIMED_OUT" ? "run_timed_out" : "run_expired";
          if (await recordOutcome(tx, { outboxId: row.id, outcome: "FAILED", failureClass, now })) tally.failed += 1;
          // Surfaced for diagnosis (JOB_FAILED); never blindly re-dispatched.
          log.error("outbox.run.failed", { runStatus: snapshot.status, attempt: snapshot.attemptCount, failureClass });
          return;
        }
        case "CANCELED":
          if (await recordOutcome(tx, { outboxId: row.id, outcome: "CANCELED", failureClass: "run_canceled", now })) tally.canceled += 1;
          log.warn("outbox.run.canceled", { runStatus: snapshot.status, failureClass: "run_canceled" });
          return;
        case "CRASHED":
        case "SYSTEM_FAILURE": {
          const failureClass = snapshot.status === "CRASHED" ? "run_crashed" : "run_system_failure";
          if (row.recoveryCount >= config.maxRecoveries) {
            if (await recordOutcome(tx, { outboxId: row.id, outcome: "RECOVERY_EXHAUSTED", failureClass, now })) tally.exhausted += 1;
            log.error("outbox.run.recovery_exhausted", { runStatus: snapshot.status, failureClass });
            return;
          }
          // R7: same dispatch key; the vendor released it, so the relay gets a NEW run.
          if (await requeueForRecovery(tx, { outboxId: row.id, expectedRecoveryCount: row.recoveryCount, failureClass })) tally.recovered += 1;
          log.warn("outbox.run.recovering", { runStatus: snapshot.status, failureClass });
          return;
        }
        case "UNKNOWN": {
          // Never re-dispatched (the run may have executed) and never classified FAILED/CRASHED/SYSTEM_FAILURE.
          const bound = config.unknownObservation;
          const ageMs = streak.since === null ? 0 : Math.max(0, now.getTime() - streak.since.getTime());
          if (streak.checks >= bound.maxChecks || ageMs >= bound.maxSeconds * 1000) {
            if (await markObservationExhausted(tx, { outboxId: row.id, now })) {
              tally.unobservable += 1;
              log.error("outbox.run.observation_exhausted", { runStatus: snapshot.status, failureClass: "run_status_unknown", count: streak.checks, ageMs });
            }
            return;
          }
          tally.pending += 1;
          log.warn("outbox.run.unknown", { runStatus: snapshot.status, failureClass: "run_status_unknown", count: streak.checks, ageMs });
          return;
        }
        case "QUEUED":
        case "EXECUTING":
        case "WAITING":
          tally.pending += 1;
          return;
      }
    });
  }
  // Recovered rows are re-dispatched right away rather than waiting for the next dispatch sweep.
  if (tally.recovered > 0) await relayPass(deps);
  return tally;
}

export interface RetirementReadiness {
  /** Deliveries bound to the plane that can still cause a run of the topic there (claimable or awaiting an outcome). */
  readonly executionCapable: number;
  readonly ready: boolean;
}

/**
 * Whether `topic`'s implementation may be removed from `plane` (Step 7E.4B.3): only when no delivery bound to that plane
 * can still require a run of it. Bound work never follows a later route change, so the old plane must keep serving it
 * until then; terminal deliveries (an outcome, or OBSERVATION_EXHAUSTED) never run again and do not block.
 */
export async function retirementReadiness(system: RuntimeDatabase<"system">, options: { readonly topic: string; readonly plane: ExecutionPlane }): Promise<RetirementReadiness> {
  const executionCapable = await withSystemScope(system, (tx) => countExecutionCapableBound(tx, options));
  return { executionCapable, ready: executionCapable === 0 };
}
