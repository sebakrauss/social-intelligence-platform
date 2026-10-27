/**
 * Ingestion coverage (Step H6-A1, TL decisions 4 and 6; TA §17; Model §7). Pure.
 *
 * Coverage says how much WAS seen; capability says what CAN be done (TA §17.4). It is recorded as intervals: for one
 * connected account × capability × interaction kind (optionally one content item) × time range, a state with a reason.
 * A lack of coverage is never zero interactions (S11): a count is a Measured value only over covered intervals.
 *
 * Interval states are TA §17.1's. A slice of ingestion also gets one summary outcome:
 *   COMPLETE            every kind of the validated scope was read for the interval
 *   LIMITED             read, but the capability's limitation excludes some kinds (Instagram REPLIES_NOT_READ: comments
 *                       COMPLETE, replies UNAVAILABLE — "not covered", never "zero replies")
 *   TEMPORARILY_FAILED  the read failed or was deferred for a recoverable reason (provider failure, connection health,
 *                       a stale profile awaiting re-evaluation)
 *   AUTHORIZATION_MISSING  the account lacks the provider authorization (ACCOUNT_PERMISSION_MISSING)
 *   NOT_VALIDATED       the capability isn't validated for the scope (or no profile)
 *   PLATFORM_UNSUPPORTED   authoritative platform non-support
 * (Outcome names never reuse profile-state literals: coverage consumes availability reasons, it never reinterprets a
 * profile state — guard-tested.)
 *
 * Traversal exhausted (Step H6-C1, TL D-C5): a read that stopped because its authorized page/continuation budget ran
 * out — the provider still had pages — covers NOTHING for the interval: UNKNOWN / TRAVERSAL_INCOMPLETE (provider
 * ordering is not validated, so the pages read do not delimit any sub-interval), with the slice outcome
 * TEMPORARILY_FAILED (a later traversal may complete it). Never COMPLETE, never a count of zero. The database CHECK
 * admits this reason from migration 0018 on (H6-C2); until then no runtime path writes it.
 *
 * Historical depth (TL decision 6): `read_history` is not validated for Meta, so nothing before the earliest interval
 * ingestion actually read is covered — it is UNAVAILABLE / HISTORY_DEPTH_NOT_VALIDATED, never an implied 30-day import.
 *
 * The capability availability vocabulary is MIRRORED here (a module domain may not import another module's domain; a
 * unit test pins the mirror to modules/capability).
 */
import { compareInstants, type Instant } from "@/domain/instant";

export const COVERAGE_STATES = ["IMPORTING", "COMPLETE", "PARTIAL", "UNAVAILABLE", "NOT_REQUESTED", "FAILED", "UNKNOWN"] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];

export const COVERAGE_REASONS = [
  "VALIDATED_SCOPE_READ",
  "CAPABILITY_LIMITATION",
  "CAPABILITY_NOT_VALIDATED",
  "CAPABILITY_UNSUPPORTED",
  "ACCOUNT_PERMISSION_MISSING",
  "PROFILE_STALE",
  "ACCOUNT_INACTIVE",
  "CONNECTION_UNAVAILABLE",
  "PROVIDER_FAILURE",
  "HISTORY_DEPTH_NOT_VALIDATED",
  "IN_PROGRESS",
  "TRAVERSAL_INCOMPLETE",
] as const;
export type CoverageReason = (typeof COVERAGE_REASONS)[number];

export const SLICE_COVERAGE_OUTCOMES = ["COMPLETE", "LIMITED", "TEMPORARILY_FAILED", "AUTHORIZATION_MISSING", "NOT_VALIDATED", "PLATFORM_UNSUPPORTED"] as const;
export type SliceCoverageOutcome = (typeof SLICE_COVERAGE_OUTCOMES)[number];

/** Mirrors modules/capability AVAILABILITY_STATES (pinned by test). */
export const MIRRORED_AVAILABILITY_STATES = ["AVAILABLE", "AVAILABLE_WITH_LIMITATION", "UNAVAILABLE", "TEMPORARILY_UNAVAILABLE"] as const;
export type MirroredAvailabilityState = (typeof MIRRORED_AVAILABILITY_STATES)[number];

/** Mirrors modules/capability AVAILABILITY_REASONS (pinned by test). */
export const MIRRORED_AVAILABILITY_REASONS = [
  "CAPABILITY_SUPPORTED",
  "CAPABILITY_LIMITATION",
  "CAPABILITY_UNSUPPORTED",
  "CAPABILITY_NOT_VALIDATED",
  "ACCOUNT_PERMISSION_MISSING",
  "PROFILE_NOT_EVALUATED",
  "PROFILE_STALE",
  "ACCOUNT_INACTIVE",
  "CONNECTION_VALIDATING",
  "CONNECTION_DEGRADED",
  "CONNECTION_FAILED",
  "CONNECTION_DISCONNECTED",
  "CONNECTION_REMOVED",
] as const;
export type MirroredAvailabilityReason = (typeof MIRRORED_AVAILABILITY_REASONS)[number];

/** The interaction kinds of read_interactions (mirrors the contract; pinned by test). */
export const COVERAGE_INTERACTION_KINDS = ["comment", "reply"] as const;
export type CoverageInteractionKind = (typeof COVERAGE_INTERACTION_KINDS)[number];

/**
 * The kinds each limitation code EXCLUDES from read_interactions coverage. A limitation not listed here excludes
 * every kind (fail closed: an unknown restriction never claims coverage).
 */
export const LIMITATION_EXCLUDED_KINDS: Readonly<Record<string, readonly CoverageInteractionKind[]>> = Object.freeze({
  REPLIES_NOT_READ: Object.freeze(["reply"] as const),
});

export interface AvailabilityInput {
  readonly state: MirroredAvailabilityState;
  readonly reason: MirroredAvailabilityReason;
  readonly limitationCode: string | null;
}

/** The kinds a read may claim to cover under that availability (empty = none). Never inferred from data seen. */
export function coveredInteractionKinds(availability: AvailabilityInput): readonly CoverageInteractionKind[] {
  if (availability.state === "AVAILABLE") return COVERAGE_INTERACTION_KINDS;
  if (availability.state !== "AVAILABLE_WITH_LIMITATION") return [];
  const excluded = availability.limitationCode === null ? undefined : LIMITATION_EXCLUDED_KINDS[availability.limitationCode];
  if (excluded === undefined) return [];
  return COVERAGE_INTERACTION_KINDS.filter((kind) => !excluded.includes(kind));
}

export interface CoverageScope {
  readonly connectedAccountId: string;
  readonly capability: "read_interactions";
  /** One content item, or null for the account-level window. */
  readonly contentId: string | null;
}

export interface CoverageInterval {
  readonly scope: CoverageScope;
  readonly interactionKind: CoverageInteractionKind;
  readonly from: Instant;
  readonly to: Instant;
  readonly state: CoverageState;
  readonly reason: CoverageReason;
  readonly limitationCode: string | null;
  readonly asOf: Instant;
}

export type SliceReadResult = "completed" | "in_progress" | "failed_transient" | "not_attempted" | "budget_exhausted";

export interface SliceCoverage {
  readonly outcome: SliceCoverageOutcome | "IN_PROGRESS";
  readonly intervals: readonly CoverageInterval[];
}

const UNAVAILABLE_BY_REASON: Readonly<Partial<Record<MirroredAvailabilityReason, { readonly outcome: SliceCoverageOutcome; readonly state: CoverageState; readonly reason: CoverageReason }>>> = Object.freeze({
  ACCOUNT_PERMISSION_MISSING: { outcome: "AUTHORIZATION_MISSING", state: "UNAVAILABLE", reason: "ACCOUNT_PERMISSION_MISSING" },
  CAPABILITY_UNSUPPORTED: { outcome: "PLATFORM_UNSUPPORTED", state: "UNAVAILABLE", reason: "CAPABILITY_UNSUPPORTED" },
  CAPABILITY_NOT_VALIDATED: { outcome: "NOT_VALIDATED", state: "UNAVAILABLE", reason: "CAPABILITY_NOT_VALIDATED" },
  PROFILE_NOT_EVALUATED: { outcome: "NOT_VALIDATED", state: "UNAVAILABLE", reason: "CAPABILITY_NOT_VALIDATED" },
  PROFILE_STALE: { outcome: "TEMPORARILY_FAILED", state: "FAILED", reason: "PROFILE_STALE" },
  ACCOUNT_INACTIVE: { outcome: "NOT_VALIDATED", state: "UNAVAILABLE", reason: "ACCOUNT_INACTIVE" },
  CONNECTION_REMOVED: { outcome: "TEMPORARILY_FAILED", state: "FAILED", reason: "CONNECTION_UNAVAILABLE" },
});

/**
 * The coverage one ingestion slice establishes for one scope and interval, per interaction kind. Pure: the caller
 * passes the availability it gated on and how the read ended.
 */
export function coverageForSlice(input: {
  readonly scope: CoverageScope;
  readonly from: Instant;
  readonly to: Instant;
  readonly asOf: Instant;
  readonly availability: AvailabilityInput;
  readonly result: SliceReadResult;
}): SliceCoverage {
  if (compareInstants(input.from, input.to) >= 0) throw new TypeError("coverage_interval_empty");
  const interval = (interactionKind: CoverageInteractionKind, state: CoverageState, reason: CoverageReason): CoverageInterval =>
    Object.freeze({ scope: input.scope, interactionKind, from: input.from, to: input.to, state, reason, limitationCode: input.availability.limitationCode, asOf: input.asOf });
  const all = (state: CoverageState, reason: CoverageReason) => COVERAGE_INTERACTION_KINDS.map((kind) => interval(kind, state, reason));

  const { availability } = input;
  if (availability.state === "UNAVAILABLE") {
    const mapped = UNAVAILABLE_BY_REASON[availability.reason] ?? { outcome: "NOT_VALIDATED" as const, state: "UNKNOWN" as const, reason: "CAPABILITY_NOT_VALIDATED" as const };
    return { outcome: mapped.outcome, intervals: all(mapped.state, mapped.reason) };
  }
  if (availability.state === "TEMPORARILY_UNAVAILABLE") return { outcome: "TEMPORARILY_FAILED", intervals: all("FAILED", "CONNECTION_UNAVAILABLE") };

  const covered = coveredInteractionKinds(availability);
  const excluded = COVERAGE_INTERACTION_KINDS.filter((kind) => !covered.includes(kind));
  const notCovered = excluded.map((kind) => interval(kind, "UNAVAILABLE", "CAPABILITY_LIMITATION"));
  if (input.result === "failed_transient") return { outcome: "TEMPORARILY_FAILED", intervals: [...covered.map((kind) => interval(kind, "FAILED", "PROVIDER_FAILURE")), ...notCovered] };
  if (input.result === "not_attempted") return { outcome: "TEMPORARILY_FAILED", intervals: [...covered.map((kind) => interval(kind, "UNKNOWN", "PROVIDER_FAILURE")), ...notCovered] };
  if (input.result === "budget_exhausted") return { outcome: "TEMPORARILY_FAILED", intervals: [...covered.map((kind) => interval(kind, "UNKNOWN", "TRAVERSAL_INCOMPLETE")), ...notCovered] };
  if (input.result === "in_progress") return { outcome: "IN_PROGRESS", intervals: [...covered.map((kind) => interval(kind, "IMPORTING", "IN_PROGRESS")), ...notCovered] };
  if (covered.length === 0) return { outcome: "LIMITED", intervals: notCovered };
  return { outcome: excluded.length === 0 ? "COMPLETE" : "LIMITED", intervals: [...covered.map((kind) => interval(kind, "COMPLETE", "VALIDATED_SCOPE_READ")), ...notCovered] };
}

/** TL decision 6: everything before the earliest interval actually read is not covered (history depth unvalidated). */
export function historyBeforeFirstRead(input: { readonly scope: CoverageScope; readonly from: Instant; readonly firstReadFrom: Instant; readonly asOf: Instant }): readonly CoverageInterval[] {
  if (compareInstants(input.from, input.firstReadFrom) >= 0) return [];
  return COVERAGE_INTERACTION_KINDS.map((interactionKind) =>
    Object.freeze({ scope: input.scope, interactionKind, from: input.from, to: input.firstReadFrom, state: "UNAVAILABLE" as const, reason: "HISTORY_DEPTH_NOT_VALIDATED" as const, limitationCode: null, asOf: input.asOf }));
}

/** A count is only a number over complete (or partial, with extent) coverage; otherwise it is not available (S11). */
export type MeasuredCount =
  | { readonly state: "AVAILABLE"; readonly value: number }
  | { readonly state: "PARTIAL"; readonly value: number }
  | { readonly state: "NOT_AVAILABLE"; readonly reason: CoverageReason };

export function measuredInteractionCount(interval: Pick<CoverageInterval, "state" | "reason">, observedCount: number): MeasuredCount {
  if (!Number.isInteger(observedCount) || observedCount < 0) throw new TypeError("count_invalid");
  if (interval.state === "COMPLETE") return { state: "AVAILABLE", value: observedCount };
  if (interval.state === "PARTIAL") return { state: "PARTIAL", value: observedCount };
  return { state: "NOT_AVAILABLE", reason: interval.reason };
}
