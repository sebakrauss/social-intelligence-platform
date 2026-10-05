/**
 * Outbox delivery store (R7; TA §19.3): the queries the system relay and sweepers run, in system scope
 * only. Every transition is conditional on the state it expects, so concurrent relays or sweepers never
 * double-apply a transition (optimistic concurrency), and rows are claimed with a short lease
 * (FOR UPDATE SKIP LOCKED) so no database transaction is held open across a job-runtime call.
 *
 * Only platform/outbox may import this module (dependency rule): there is no other path that changes
 * delivery state.
 */
import { sql } from "drizzle-orm";
import type { RunStatus } from "@/platform/jobs";
import type { DatabaseTransaction } from "./scopes";

export const DELIVERY_FAILURE_CLASSES = [
  "enqueue_rejected",
  "enqueue_unavailable",
  "unknown_task",
  "invalid_payload",
  "run_failed",
  "run_canceled",
  "run_crashed",
  "run_system_failure",
  "run_expired",
  "run_timed_out",
  "run_not_found",
] as const;
export type DeliveryFailureClass = (typeof DELIVERY_FAILURE_CLASSES)[number];

export const RUN_OUTCOMES = ["COMPLETED", "FAILED", "CANCELED", "RECOVERY_EXHAUSTED"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/**
 * Operational diagnostic states: NOT outcomes. OBSERVATION_EXHAUSTED = the run's status stayed UNKNOWN past
 * the configured observation bound; the row is alerted and no longer polled, and its outcome stays unknown.
 */
export const RUN_DIAGNOSTICS = ["OBSERVATION_EXHAUSTED"] as const;
export type RunDiagnostic = (typeof RUN_DIAGNOSTICS)[number];

export interface ClaimedOutboxRow {
  readonly id: string;
  readonly topic: string;
  readonly organizationId: string | null;
  readonly workspaceId: string | null;
  readonly subjectIds: Readonly<Record<string, string>>;
  readonly correlationId: string;
  readonly initiatorType: "user" | "policy" | "system";
  readonly initiatorUserId: string | null;
  readonly dispatchKey: string;
  readonly createdAt: Date;
  readonly dispatchAttempts: number;
  readonly recoveryCount: number;
}

interface ClaimedRowRecord extends Record<string, unknown> {
  id: string;
  topic: string;
  organization_id: string | null;
  workspace_id: string | null;
  subject_ids: Record<string, string>;
  correlation_id: string;
  initiator_type: "user" | "policy" | "system";
  initiator_user_id: string | null;
  dispatch_key: string;
  created_at: Date | string;
  dispatch_attempts: number;
  recovery_count: number;
}

const date = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

/** Leases due PENDING rows (oldest first) so this relay alone dispatches them until the lease ends. */
export async function claimDueRows(
  tx: DatabaseTransaction,
  options: { readonly now: Date; readonly minAgeSeconds: number; readonly leaseSeconds: number; readonly limit: number },
): Promise<readonly ClaimedOutboxRow[]> {
  const result = await tx.execute<ClaimedRowRecord>(sql`
    with due as (
      select o.id from system.outbox o
       where o.status = 'PENDING' and o.run_outcome is null
         and (o.next_dispatch_at is null or o.next_dispatch_at <= ${options.now})
         and (o.claimed_until is null or o.claimed_until <= ${options.now})
         and o.created_at <= ${options.now}::timestamptz - make_interval(secs => ${options.minAgeSeconds})
       order by o.created_at
       limit ${options.limit}
       for update skip locked)
    update system.outbox o
       set claimed_until = ${options.now}::timestamptz + make_interval(secs => ${options.leaseSeconds})
      from due where o.id = due.id
    returning o.id, o.topic, o.organization_id, o.workspace_id, o.subject_ids, o.correlation_id, o.initiator_type,
              o.initiator_user_id, o.dispatch_key, o.created_at, o.dispatch_attempts, o.recovery_count`);
  return result.rows.map((row) => ({
    id: row.id,
    topic: row.topic,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    subjectIds: row.subject_ids,
    correlationId: row.correlation_id,
    initiatorType: row.initiator_type,
    initiatorUserId: row.initiator_user_id,
    dispatchKey: row.dispatch_key,
    createdAt: date(row.created_at),
    dispatchAttempts: row.dispatch_attempts,
    recoveryCount: row.recovery_count,
  }));
}

/** Records a successful enqueue: DISPATCHED with its run, plus the run in the history. Idempotent. */
export async function markDispatched(
  tx: DatabaseTransaction,
  options: { readonly outboxId: string; readonly runId: string; readonly now: Date },
): Promise<boolean> {
  const updated = await tx.execute<{ dispatch_attempts: number; recovery_count: number }>(sql`
    update system.outbox
       set status = 'DISPATCHED', dispatched_at = ${options.now}, dispatch_attempts = dispatch_attempts + 1,
           claimed_until = null, next_dispatch_at = null, last_failure_class = null
     where id = ${options.outboxId} and status = 'PENDING' and run_outcome is null
    returning dispatch_attempts, recovery_count`);
  const row = updated.rows[0];
  if (row === undefined) return false;
  await tx.execute(sql`
    insert into system.outbox_runs (outbox_id, run_id, dispatch_attempt, recovery_generation, dispatched_at)
    values (${options.outboxId}, ${options.runId}, ${row.dispatch_attempts}, ${row.recovery_count}, ${options.now})
    on conflict (outbox_id, run_id) do nothing`);
  return true;
}

/** Records a failed enqueue and schedules the next attempt (backoff), releasing the lease. */
export async function markDispatchFailed(
  tx: DatabaseTransaction,
  options: { readonly outboxId: string; readonly failureClass: DeliveryFailureClass; readonly retryAt: Date },
): Promise<void> {
  await tx.execute(sql`
    update system.outbox
       set dispatch_attempts = dispatch_attempts + 1, next_dispatch_at = ${options.retryAt},
           claimed_until = null, last_failure_class = ${options.failureClass}
     where id = ${options.outboxId} and status = 'PENDING'`);
}

export interface AwaitingOutcomeRow {
  readonly id: string;
  readonly topic: string;
  readonly workspaceId: string | null;
  readonly correlationId: string;
  readonly recoveryCount: number;
  readonly dispatchedAt: Date;
  readonly runId: string;
}

/** DISPATCHED rows without a terminal outcome or a diagnostic, each with its current (latest) run. */
export async function listAwaitingOutcome(tx: DatabaseTransaction, options: { readonly limit: number }): Promise<readonly AwaitingOutcomeRow[]> {
  const result = await tx.execute<{
    id: string; topic: string; workspace_id: string | null; correlation_id: string; recovery_count: number; dispatched_at: Date | string; run_id: string;
  }>(sql`
    select o.id, o.topic, o.workspace_id, o.correlation_id, o.recovery_count, o.dispatched_at, r.run_id
      from system.outbox o
      join lateral (
        select run_id from system.outbox_runs r where r.outbox_id = o.id order by r.dispatched_at desc, r.dispatch_attempt desc limit 1
      ) r on true
     where o.status = 'DISPATCHED' and o.run_outcome is null and o.run_diagnostic is null
     order by o.dispatched_at
     limit ${options.limit}`);
  return result.rows.map((row) => ({
    id: row.id,
    topic: row.topic,
    workspaceId: row.workspace_id,
    correlationId: row.correlation_id,
    recoveryCount: row.recovery_count,
    dispatchedAt: date(row.dispatched_at),
    runId: row.run_id,
  }));
}

/** The current streak of consecutive UNKNOWN observations of one run (0 / null once a status is known). */
export interface UnknownStreak {
  readonly checks: number;
  readonly since: Date | null;
}

/**
 * Stores the latest observation of a run (history stays diagnosable after recovery). An UNKNOWN observation
 * keeps the last KNOWN status and attempt count, and extends the run's UNKNOWN streak; any known status
 * resets the streak. Returns the streak after this observation.
 */
export async function recordRunStatus(
  tx: DatabaseTransaction,
  options: { readonly outboxId: string; readonly runId: string; readonly status: RunStatus; readonly attemptCount: number; readonly terminal: boolean; readonly now: Date },
): Promise<UnknownStreak> {
  const unknown = options.status === "UNKNOWN";
  const result = await tx.execute<{ unknown_checks: number; first_unknown_at: Date | string | null }>(sql`
    update system.outbox_runs
       set last_status = case when ${unknown} then last_status else ${options.status} end,
           attempt_count = case when ${unknown} then attempt_count else ${options.attemptCount} end,
           status_checked_at = ${options.now},
           terminal_at = case when ${options.terminal} then coalesce(terminal_at, ${options.now}) else terminal_at end,
           unknown_checks = case when ${unknown} then unknown_checks + 1 else 0 end,
           first_unknown_at = case when ${unknown} then coalesce(first_unknown_at, ${options.now}) else null end
     where outbox_id = ${options.outboxId} and run_id = ${options.runId}
    returning unknown_checks, first_unknown_at`);
  const row = result.rows[0];
  return { checks: row?.unknown_checks ?? 0, since: row?.first_unknown_at === null || row?.first_unknown_at === undefined ? null : date(row.first_unknown_at) };
}

/**
 * Puts a dispatched row whose run stayed UNKNOWN past the observation bound into the explicit diagnostic
 * state (once). Its outcome stays NULL and it is never re-dispatched; the outcome sweeper stops polling it.
 */
export async function markObservationExhausted(
  tx: DatabaseTransaction,
  options: { readonly outboxId: string; readonly now: Date },
): Promise<boolean> {
  const result = await tx.execute(sql`
    update system.outbox
       set run_diagnostic = 'OBSERVATION_EXHAUSTED', run_diagnostic_at = ${options.now}
     where id = ${options.outboxId} and status = 'DISPATCHED' and run_outcome is null and run_diagnostic is null`);
  return (result.rowCount ?? 0) === 1;
}

/** Records the terminal outcome of a dispatched row (only once). */
export async function recordOutcome(
  tx: DatabaseTransaction,
  options: { readonly outboxId: string; readonly outcome: RunOutcome; readonly failureClass: DeliveryFailureClass | null; readonly now: Date },
): Promise<boolean> {
  const result = await tx.execute(sql`
    update system.outbox
       set run_outcome = ${options.outcome}, run_outcome_at = ${options.now}, last_failure_class = ${options.failureClass}
     where id = ${options.outboxId} and status = 'DISPATCHED' and run_outcome is null`);
  return (result.rowCount ?? 0) === 1;
}

/**
 * R7 recovery: a CRASHED / SYSTEM_FAILURE run's row goes back to PENDING (same dispatch key) for the relay
 * to re-dispatch. Conditional on the recovery count the sweeper observed, so two sweepers can't both recover.
 */
export async function requeueForRecovery(
  tx: DatabaseTransaction,
  options: { readonly outboxId: string; readonly expectedRecoveryCount: number; readonly failureClass: DeliveryFailureClass },
): Promise<boolean> {
  const result = await tx.execute(sql`
    update system.outbox
       set status = 'PENDING', dispatched_at = null, recovery_count = recovery_count + 1,
           next_dispatch_at = null, claimed_until = null, last_failure_class = ${options.failureClass}
     where id = ${options.outboxId} and status = 'DISPATCHED' and run_outcome is null
       and recovery_count = ${options.expectedRecoveryCount}`);
  return (result.rowCount ?? 0) === 1;
}

/** Flags rows still undispatched beyond the SLO (once each) and returns them for alerting. */
export async function flagSloBreaches(
  tx: DatabaseTransaction,
  options: { readonly now: Date; readonly sloSeconds: number },
): Promise<readonly { readonly id: string; readonly topic: string; readonly createdAt: Date }[]> {
  const result = await tx.execute<{ id: string; topic: string; created_at: Date | string }>(sql`
    update system.outbox
       set slo_breached_at = ${options.now}
     where status = 'PENDING' and run_outcome is null and slo_breached_at is null
       and created_at <= ${options.now}::timestamptz - make_interval(secs => ${options.sloSeconds})
    returning id, topic, created_at`);
  return result.rows.map((row) => ({ id: row.id, topic: row.topic, createdAt: date(row.created_at) }));
}

/** Age in seconds of the oldest undispatched row (the "outbox age" metric, TA §42.2), or null. */
export async function oldestPendingAgeSeconds(tx: DatabaseTransaction, now: Date): Promise<number | null> {
  const result = await tx.execute<{ age: number | null }>(sql`
    select extract(epoch from (${now}::timestamptz - min(created_at)))::float8 as age
      from system.outbox where status = 'PENDING' and run_outcome is null`);
  const age = result.rows[0]?.age;
  return age === null || age === undefined ? null : Math.max(0, age);
}
