/**
 * Structured log record and its allowlist sanitizer (TA §42.1, §38.11).
 *
 * Only the fields declared here can ever reach a log line. Anything else a caller passes
 * (comment text, author names or handles, Brand Context, reply text, prompts, credentials,
 * connection strings…) is dropped silently: only the *number* of dropped fields is recorded,
 * because an undeclared key could itself carry personal or customer data. Declared fields are
 * validated: identifiers must be identifier-shaped and nothing may look like a credential.
 * An invalid declared value is omitted, never echoed; only the declared field name is reported.
 *
 * Job fields (task, run ID, attempt, dispatch key fingerprint, lane, outbox ID, run status, counters,
 * age and failure class) carry identifiers, closed vocabularies and numbers only. The dispatch key itself
 * is never logged: only a short, non-reversible fingerprint.
 */
import {
  parseCorrelationId,
  parseRequestId,
  type CorrelationId,
  type RequestId,
} from "@/domain/correlation";
import { isErrorCode, type ErrorCode } from "@/domain/errors";
import { looksLikeSecret } from "@/domain/secret-patterns";
import { EXECUTION_PLANES, type ExecutionPlane } from "@/platform/jobs/planes";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Who initiated the work. Never a name: identities are resolved by authorized tooling (TA §42.1). */
export const ACTOR_TYPES = ["user", "policy", "system", "anonymous"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const LOG_OUTCOMES = ["ok", "error"] as const;
export type LogOutcome = (typeof LOG_OUTCOMES)[number];

export const LOG_RUN_STATUSES = [
  "QUEUED", "EXECUTING", "WAITING", "COMPLETED", "FAILED", "CANCELED", "CRASHED", "SYSTEM_FAILURE", "EXPIRED", "TIMED_OUT", "UNKNOWN",
] as const;
export type LogRunStatus = (typeof LOG_RUN_STATUSES)[number];

export const LOG_FAILURE_CLASSES = [
  "enqueue_rejected", "enqueue_unavailable", "unknown_task", "invalid_payload", "run_failed", "run_canceled", "run_crashed",
  "run_system_failure", "run_expired", "run_timed_out", "run_not_found", "run_status_unknown", "non_retryable", "retryable", "scope_rejected",
] as const;
export type LogFailureClass = (typeof LOG_FAILURE_CLASSES)[number];

export const LOG_LANES = ["1", "2", "3", "4", "5", "system"] as const;
export type LogLane = (typeof LOG_LANES)[number];

export interface LogFields {
  /** Owning module or component, e.g. "platform.i18n". */
  readonly module?: string;
  /** Command, query or operation name, e.g. "translator.create". */
  readonly operation?: string;
  readonly correlationId?: CorrelationId;
  readonly requestId?: RequestId;
  /** Opaque identifiers only, never names. */
  readonly organizationId?: string;
  readonly workspaceId?: string;
  readonly actorType?: ActorType;
  readonly durationMs?: number;
  readonly outcome?: LogOutcome;
  readonly errorCode?: ErrorCode;
  // Job foundation (TA §42.1 worker/job logs).
  readonly task?: string;
  readonly lane?: LogLane;
  readonly outboxId?: string;
  readonly runId?: string;
  readonly runStatus?: LogRunStatus;
  readonly attempt?: number;
  readonly dispatchAttempts?: number;
  readonly recoveryCount?: number;
  readonly ageMs?: number;
  readonly failureClass?: LogFailureClass;
  /** First 12 hex chars of SHA-256(dispatch key): correlates runs without exposing the key. */
  readonly dispatchKeyFingerprint?: string;
  /** Counts in a sweep or relay pass. */
  readonly count?: number;
  /** The semantic execution plane a delivery is bound to (closed vocabulary; never a vendor project identifier). */
  readonly executionPlane?: ExecutionPlane;
  /** The plane the registry would route NEW work to, when it differs from a bound delivery's plane. */
  readonly routedPlane?: ExecutionPlane;
}

export interface LogRecord extends LogFields {
  readonly timestamp: string;
  readonly level: LogLevel;
  /** Dotted event identifier, e.g. "request.completed". Not free text. */
  readonly event: string;
  readonly environment?: string;
  /** Names of declared fields (controlled by this module) whose values were rejected. */
  readonly redactedFields?: readonly string[];
  /** Number of undeclared fields that were dropped. Their names are never serialized. */
  readonly droppedFieldCount?: number;
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && IDENTIFIER.test(value) && !looksLikeSecret(value) ? value : undefined;
}

function opaqueId(value: unknown): string | undefined {
  return typeof value === "string" && OPAQUE_ID.test(value) && !looksLikeSecret(value) ? value : undefined;
}

function oneOf<T extends string>(allowed: readonly T[]): (value: unknown) => T | undefined {
  return (value) => (allowed as readonly unknown[]).includes(value) ? (value as T) : undefined;
}

function duration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function counter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : undefined;
}

function fingerprint(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{12}$/.test(value) ? value : undefined;
}

function safeTraceId<T>(parse: (value: unknown) => T | undefined): (value: unknown) => T | undefined {
  return (value) => (typeof value === "string" && looksLikeSecret(value) ? undefined : parse(value));
}

type FieldValidators = { readonly [K in keyof Required<LogFields>]: (value: unknown) => LogFields[K] };

const FIELD_VALIDATORS: FieldValidators = {
  module: identifier,
  operation: identifier,
  correlationId: safeTraceId(parseCorrelationId),
  requestId: safeTraceId(parseRequestId),
  organizationId: opaqueId,
  workspaceId: opaqueId,
  actorType: oneOf(ACTOR_TYPES),
  durationMs: duration,
  outcome: oneOf(LOG_OUTCOMES),
  errorCode: (value) => (isErrorCode(value) ? value : undefined),
  task: identifier,
  lane: oneOf(LOG_LANES),
  outboxId: opaqueId,
  runId: opaqueId,
  runStatus: oneOf(LOG_RUN_STATUSES),
  attempt: counter,
  dispatchAttempts: counter,
  recoveryCount: counter,
  ageMs: duration,
  failureClass: oneOf(LOG_FAILURE_CLASSES),
  dispatchKeyFingerprint: fingerprint,
  count: counter,
  executionPlane: oneOf(EXECUTION_PLANES),
  routedPlane: oneOf(EXECUTION_PLANES),
};

const DECLARED_FIELDS = Object.keys(FIELD_VALIDATORS) as (keyof LogFields)[];

export interface SanitizeInput {
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: unknown;
  readonly timestamp: string;
  readonly environment?: string;
}

export function sanitizeLogRecord(input: SanitizeInput): LogRecord {
  const record: Record<string, unknown> = {
    timestamp: input.timestamp,
    level: input.level,
    event: identifier(input.event) ?? "invalid_event",
  };
  const redacted: string[] = identifier(input.event) === undefined ? ["event"] : [];
  let droppedFieldCount = 0;

  const environment = identifier(input.environment);
  if (environment !== undefined) {
    record["environment"] = environment;
  }

  if (typeof input.fields === "object" && input.fields !== null) {
    const fields = input.fields as Readonly<Record<string, unknown>>;
    for (const name of Object.keys(fields)) {
      if (!(DECLARED_FIELDS as readonly string[]).includes(name)) {
        droppedFieldCount += 1;
      }
    }
    for (const name of DECLARED_FIELDS) {
      const raw = fields[name];
      if (raw === undefined) {
        continue;
      }
      const value = FIELD_VALIDATORS[name](raw);
      if (value === undefined) {
        redacted.push(name);
      } else {
        record[name] = value;
      }
    }
  }

  if (redacted.length > 0) {
    record["redactedFields"] = redacted;
  }
  if (droppedFieldCount > 0) {
    record["droppedFieldCount"] = droppedFieldCount;
  }
  return record as unknown as LogRecord;
}
