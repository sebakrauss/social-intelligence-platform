/**
 * Mutation intent (TA §26; CLAUDE.md §9) — the only thing the Platform Mutation Executor acts on. Step 7B-1 defines ONE
 * kind, the human public reply to a single target, and the whole lifecycle around it. Pure: the state machine, its
 * closed vocabularies and the rules the executor relies on (which statuses may execute, which outcomes are terminal,
 * which transitions exist). No I/O, no framework.
 *
 *   PENDING ──▶ EXECUTING ──▶ CONFIRMED
 *                 │  │  └────▶ FAILED (definite provider failure; a new intent is the only retry)
 *                 │  └───────▶ OUTCOME_UNKNOWN (timeout / lost response / redelivered run / unclassified error)
 *                 │                └──▶ CONFIRMED  only on POSITIVE evidence (the reply found unambiguously, or a late receipt)
 *                 │                └──▶ FAILED     never automatic: reserved for a reviewed human decision (no code path today)
 *                 └──────────▶ BLOCKED (a guard refused at execution time: mode, permission, capability, connection…)
 *   PENDING ──▶ BLOCKED (a guard refused before any provider call)
 *
 * A negative lookup is NOT evidence of absence (eventual consistency, limited reply reads, normalized text): an intent
 * stays OUTCOME_UNKNOWN until the platform shows our reply, and a person never gets "failed" for a reply that may exist.
 *
 * R6: EXECUTING is committed BEFORE the provider is called; an intent found EXECUTING without an outcome is never
 * re-sent — it becomes OUTCOME_UNKNOWN and is reconciled. Nothing here retries: ONE provider call per intent, ever.
 * A request that never left (transient, rate limit) is FAILED (PROVIDER_UNAVAILABLE); a person may ask again, which
 * is a NEW intent with a new idempotency key.
 */

export const MUTATION_KINDS = ["reply_public"] as const;
export type MutationKind = (typeof MUTATION_KINDS)[number];

/** Who asked. Step 7B-1 admits human requests only; automation (TA §25) arrives with its own request type. */
export const MUTATION_REQUEST_TYPES = ["human"] as const;
export type MutationRequestType = (typeof MUTATION_REQUEST_TYPES)[number];

export const INTENT_STATUSES = ["PENDING", "EXECUTING", "CONFIRMED", "FAILED", "BLOCKED", "OUTCOME_UNKNOWN"] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

/** Why an intent did not confirm. Closed, outcome-level codes: never a provider message or detail. */
export const INTENT_OUTCOME_CODES = [
  // BLOCKED: a guard refused (request time or execution time)
  "MODE_NOT_STANDARD",
  "INITIATOR_NOT_MEMBER",
  "PERMISSION_DENIED",
  "CAPABILITY_UNAVAILABLE",
  "CONNECTION_UNAVAILABLE",
  "ACCOUNT_INACTIVE",
  "TARGET_NOT_PRESENT",
  "TARGET_ACCOUNT_MISMATCH",
  // Step 7B-13C (F1): the platform does not accept a reply on this target (Instagram: a nested reply, or an unknown kind).
  "TARGET_NOT_REPLYABLE",
  "PROVIDER_ACTIONS_DISABLED",
  "PROVIDER_MUTATION_UNSUPPORTED",
  "CREDENTIAL_UNREADABLE",
  // FAILED: the provider definitely refused or could not create the reply
  "PROVIDER_REJECTED",
  "TARGET_NOT_ELIGIBLE",
  "TARGET_NOT_FOUND",
  "PROVIDER_FAILURE",
  // FAILED: the request never left (transient / rate limit / credential / permission): no retry — a new intent only
  "PROVIDER_UNAVAILABLE",
  "PERMISSION_MISSING",
  "CREDENTIAL_INVALID",
  // OUTCOME_UNKNOWN: ambiguity (a possible publication that no evidence settles)
  "RESPONSE_LOST",
  "RUN_INTERRUPTED",
  "PROVIDER_ERROR_UNCLASSIFIED",
  "REPLY_IDENTITY_CONFLICT",
] as const;
export type IntentOutcomeCode = (typeof INTENT_OUTCOME_CODES)[number];

/** Who recorded a transition. */
export const INTENT_ACTORS = ["web", "executor", "reconciliation"] as const;
export type IntentActor = (typeof INTENT_ACTORS)[number];

export interface MutationIntent {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly kind: MutationKind;
  readonly requestType: MutationRequestType;
  /** Canonical interaction the reply targets (interactions.interactions id, this workspace). */
  readonly targetInteractionId: string;
  readonly connectedAccountId: string;
  readonly initiatorUserId: string;
  /** Unique per workspace: a repeated request returns the existing intent. */
  readonly idempotencyKey: string;
  readonly status: IntentStatus;
  /** Execution attempts recorded (0 while PENDING). */
  readonly attempt: number;
  readonly runReference: string | null;
  readonly outcomeCode: IntentOutcomeCode | null;
  /** The capability state the request relied on (TA §16: intents reference the capability state). */
  readonly capabilityCatalogId: string;
  readonly capabilityCatalogRevision: number;
  readonly correlationId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface IntentTransition {
  readonly from: IntentStatus | null;
  readonly to: IntentStatus;
  readonly attempt: number;
  readonly actor: IntentActor;
  readonly code: IntentOutcomeCode | null;
  readonly runReference: string | null;
}

const TRANSITIONS: { readonly [S in IntentStatus]: readonly IntentStatus[] } = {
  PENDING: ["EXECUTING", "BLOCKED"],
  EXECUTING: ["CONFIRMED", "FAILED", "BLOCKED", "OUTCOME_UNKNOWN"],
  OUTCOME_UNKNOWN: ["CONFIRMED", "FAILED"],
  CONFIRMED: [],
  FAILED: [],
  BLOCKED: [],
};

export class IntentTransitionError extends Error {
  override readonly name = "IntentTransitionError";
  readonly from: IntentStatus;
  readonly to: IntentStatus;
  constructor(from: IntentStatus, to: IntentStatus) {
    super(`mutation intent: ${from} → ${to} is not a transition`);
    this.from = from;
    this.to = to;
  }
}

/** The one place a status change is admitted. */
export function assertTransition(from: IntentStatus, to: IntentStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new IntentTransitionError(from, to);
}

export const isTerminal = (status: IntentStatus): boolean => TRANSITIONS[status].length === 0;
/** Only PENDING executes (TA §26.3: "only PENDING/RETRYABLE executes"; no RETRYABLE exists in 7B-1). */
export const isExecutable = (status: IntentStatus): boolean => status === "PENDING";

/** Outcome codes by the status they belong to; an outcome in the wrong status is refused. */
export const OUTCOME_STATUS: { readonly [C in IntentOutcomeCode]: IntentStatus } = {
  MODE_NOT_STANDARD: "BLOCKED",
  INITIATOR_NOT_MEMBER: "BLOCKED",
  PERMISSION_DENIED: "BLOCKED",
  CAPABILITY_UNAVAILABLE: "BLOCKED",
  CONNECTION_UNAVAILABLE: "BLOCKED",
  ACCOUNT_INACTIVE: "BLOCKED",
  TARGET_NOT_PRESENT: "BLOCKED",
  TARGET_ACCOUNT_MISMATCH: "BLOCKED",
  TARGET_NOT_REPLYABLE: "BLOCKED",
  PROVIDER_ACTIONS_DISABLED: "BLOCKED",
  PROVIDER_MUTATION_UNSUPPORTED: "BLOCKED",
  CREDENTIAL_UNREADABLE: "BLOCKED",
  PROVIDER_REJECTED: "FAILED",
  TARGET_NOT_ELIGIBLE: "FAILED",
  TARGET_NOT_FOUND: "FAILED",
  PROVIDER_FAILURE: "FAILED",
  PROVIDER_UNAVAILABLE: "FAILED",
  PERMISSION_MISSING: "FAILED",
  CREDENTIAL_INVALID: "FAILED",
  RESPONSE_LOST: "OUTCOME_UNKNOWN",
  RUN_INTERRUPTED: "OUTCOME_UNKNOWN",
  PROVIDER_ERROR_UNCLASSIFIED: "OUTCOME_UNKNOWN",
  REPLY_IDENTITY_CONFLICT: "OUTCOME_UNKNOWN",
};

/**
 * Step 7B-13C (F1) — reply depth, decided on the PERSISTED target (never on anything the browser sends). Instagram
 * accepts public replies on TOP-LEVEL comments only: an Instagram target is eligible only when it is recorded as a
 * comment AND has no parent. A nested reply, an unknown kind or a parent on a "comment" (inconsistent data) is refused —
 * insufficient or ambiguous data never passes. Other platforms keep their own rules (Facebook admits a reply to a reply).
 */
export function publicReplyDepthAllowed(target: { readonly platform: string; readonly kind: string; readonly parentProviderInteractionId: string | null }): boolean {
  if (target.platform !== "instagram") return true;
  return target.kind === "comment" && target.parentProviderInteractionId === null;
}

/**
 * Step 7B-5 — cross-intent safety for reconciliation. A reply found on the platform (same account, parent and text)
 * can be attributed to an intent ONLY when no other intent of the same workspace, account, target and text could
 * plausibly have produced it. A competitor is plausible when it may have reached the provider without a provider
 * identity of its own: EXECUTING (a call in flight or lost), OUTCOME_UNKNOWN (a call whose answer was lost), or
 * CONFIRMED without a provider identity (a receipt that named no reply). PENDING never called; BLOCKED never called;
 * FAILED is the contract's definite non-publication; CONFIRMED with an identity owns a different reply (or the same
 * one, which the identity index refuses). Plausibility is decided by STATE and IDENTITY only: a provider's timestamp
 * and our own clock are independent, so no competitor is ever excluded by comparing them (a lagging provider clock
 * would otherwise hide the real producer).
 */
export interface CompetingIntent {
  readonly id: string;
  readonly status: IntentStatus;
  readonly hasProviderIdentity: boolean;
}

export function isPlausibleProducer(competitor: CompetingIntent): boolean {
  return competitor.status === "EXECUTING" || competitor.status === "OUTCOME_UNKNOWN" || (competitor.status === "CONFIRMED" && !competitor.hasProviderIdentity);
}

/** The reply text limits the executor enforces before any provider sees it (the smallest platform limit applies). */
export const REPLY_TEXT_MAX_CHARS = 2200;

export function isIntentStatus(value: unknown): value is IntentStatus {
  return typeof value === "string" && (INTENT_STATUSES as readonly string[]).includes(value);
}
export function isIntentOutcomeCode(value: unknown): value is IntentOutcomeCode {
  return typeof value === "string" && (INTENT_OUTCOME_CODES as readonly string[]).includes(value);
}
