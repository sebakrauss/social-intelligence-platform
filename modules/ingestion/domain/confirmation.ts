/**
 * Stored-interaction confirmation (Step H6-E). Pure. The closed vocabulary of one authoritative direct re-read of a
 * CANONICAL interaction, whose provider target is derived from stored provenance only.
 *
 *   FOUND                     the provider returned the node: its state/text are ingested like any observation
 *                             (an unchanged node adds nothing; a removed one that reappears becomes available again)
 *   AUTHORITATIVE_NOT_FOUND   the provider's answer for THIS node is a not-found it VALIDATED to mean "gone", while the
 *                             connection is healthy: the interaction becomes removed_at_source (direct_fetch_confirmed)
 *   TEMPORARY_FAILURE         transient / rate-limited / outcome unknown: nothing changes (the runtime may retry)
 *   AUTHORIZATION_FAILURE     permission missing, credential invalid or unreadable: nothing changes
 *   CAPABILITY_UNAVAILABLE    the account, connection, kill switch, profile or capability doesn't allow the read
 *                             (including an interaction kind the capability doesn't read, e.g. Instagram replies)
 *   PROVIDER_CONTRACT_AMBIGUOUS  anything the contract can't settle — an UNCONFIRMED not-found (Meta's 100/33), a node
 *                             that contradicts its stored provenance, a refused request: fail closed, nothing changes
 *   INTERACTION_NOT_FOUND     no such canonical interaction in the bound workspace (or not this account's)
 *   NOT_ELIGIBLE              a placeholder or an interaction without a kind: there is nothing stored to re-read
 *
 * Absence from a listing is never an input here: only this direct re-read can remove (TA §47.3). Coverage and
 * watermarks are traversal facts; an object-level confirmation never touches them.
 */
export const CONFIRMATION_OUTCOMES = [
  "FOUND",
  "AUTHORITATIVE_NOT_FOUND",
  "TEMPORARY_FAILURE",
  "AUTHORIZATION_FAILURE",
  "CAPABILITY_UNAVAILABLE",
  "PROVIDER_CONTRACT_AMBIGUOUS",
  "INTERACTION_NOT_FOUND",
  "NOT_ELIGIBLE",
] as const;
export type ConfirmationOutcome = (typeof CONFIRMATION_OUTCOMES)[number];

/** The INTEGRATION task of one confirmation (subjects: interaction_id, connected_account_id; IDs only). */
export const CONFIRM_INTERACTION_TOPIC = "ingestion.confirm_interaction" as const;

/** One dispatch per request: the request's own outbox id names it (a re-request is a new, bounded confirmation). */
export const confirmationDispatchKey = (requestId: string): string => `${CONFIRM_INTERACTION_TOPIC}:${requestId}`;

/** The budget of one confirmation: exactly one direct provider read per task attempt (retries: the task's policy). */
export const CONFIRMATION_RUNTIME = Object.freeze({ providerReadsPerAttempt: 1 });
