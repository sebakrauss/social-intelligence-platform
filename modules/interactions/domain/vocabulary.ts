/**
 * Interaction vocabulary (Step H6-A1; Model §11–§12). Pure. Kinds, author roles, visibility and availability MIRROR
 * the provider contract's closed vocabularies (this domain may not import the contract; a unit test pins them equal).
 *
 * Provenance: every source fact names the mechanism that brought it in and the provider operation + provenance kind
 * that made it authoritative. The pairs are closed:
 *
 *   mechanism          admissible authority (operation · provenance)
 *   reconciliation     listInteractions · listed       getInteraction · listed
 *   webhook_relist     listInteractions · listed       (a webhook is a signal: the content is re-listed, never trusted)
 *   stored_reread      getInteraction · stored         (a persisted canonical interaction, re-read directly)
 *   manual_recovery    listInteractions · listed       getInteraction · listed       getInteraction · stored
 *
 * A bare provider id is never an authority, and a webhook payload never is one either.
 */

export const INTERACTION_KINDS = ["comment", "reply"] as const;
export type InteractionKind = (typeof INTERACTION_KINDS)[number];

export const AUTHOR_ROLES = ["account_identity", "user", "unknown"] as const;
export type AuthorRole = (typeof AUTHOR_ROLES)[number];

export const INTERACTION_VISIBILITY = ["visible", "hidden", "unknown"] as const;
export type InteractionVisibility = (typeof INTERACTION_VISIBILITY)[number];

export const INTERACTION_AVAILABILITY = ["available", "removed_at_source"] as const;
export type InteractionAvailability = (typeof INTERACTION_AVAILABILITY)[number];

export const SOURCE_FACT_MECHANISMS = ["reconciliation", "webhook_relist", "stored_reread", "manual_recovery"] as const;
export type SourceFactMechanism = (typeof SOURCE_FACT_MECHANISMS)[number];

export const SOURCE_FACT_OPERATIONS = ["listInteractions", "getInteraction"] as const;
export type SourceFactOperation = (typeof SOURCE_FACT_OPERATIONS)[number];

export const SOURCE_FACT_PROVENANCE = ["listed", "stored"] as const;
export type SourceFactProvenance = (typeof SOURCE_FACT_PROVENANCE)[number];

const AUTHORITIES: Readonly<Record<SourceFactMechanism, readonly `${SourceFactOperation}:${SourceFactProvenance}`[]>> = Object.freeze({
  reconciliation: Object.freeze(["listInteractions:listed", "getInteraction:listed"] as const),
  webhook_relist: Object.freeze(["listInteractions:listed"] as const),
  stored_reread: Object.freeze(["getInteraction:stored"] as const),
  manual_recovery: Object.freeze(["listInteractions:listed", "getInteraction:listed", "getInteraction:stored"] as const),
});

/** Whether a mechanism may rest on that operation and provenance (the closed table above). */
export function isAdmissibleAuthority(mechanism: SourceFactMechanism, operation: SourceFactOperation, provenance: SourceFactProvenance): boolean {
  return (AUTHORITIES[mechanism] as readonly string[]).includes(`${operation}:${provenance}`);
}

/**
 * How a removal at source was established. Absence from a listing is never one of them (TA §47.3).
 *   explicit_provider_signal   a verified provider removal signal (a tombstone or a verified webhook removal)
 *   direct_fetch_confirmed     an authoritative direct re-fetch (the stored path) answered "gone", with a healthy
 *                              connection, on a platform whose not-found answer is VALIDATED to mean removal
 */
export const REMOVAL_BASES = ["explicit_provider_signal", "direct_fetch_confirmed"] as const;
export type RemovalBasis = (typeof REMOVAL_BASES)[number];

/** Upper bound of one interaction's text (defensive; no provider limit is assumed or claimed). */
export const SOURCE_TEXT_MAX_LENGTH = 32_768;
/** Upper bound of a provider-visible author label (a display name or a username). */
export const AUTHOR_LABEL_MAX_LENGTH = 256;
/** A text hash: SHA-256 over the exact UTF-8 text, lower-case hex (computed outside the pure domain). */
export const TEXT_HASH = /^[0-9a-f]{64}$/;

const includes = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && (values as readonly string[]).includes(value);
export const isInteractionKind = (value: unknown): value is InteractionKind => includes(INTERACTION_KINDS, value);
export const isAuthorRole = (value: unknown): value is AuthorRole => includes(AUTHOR_ROLES, value);
export const isInteractionVisibility = (value: unknown): value is InteractionVisibility => includes(INTERACTION_VISIBILITY, value);
export const isInteractionAvailability = (value: unknown): value is InteractionAvailability => includes(INTERACTION_AVAILABILITY, value);
export const isSourceFactMechanism = (value: unknown): value is SourceFactMechanism => includes(SOURCE_FACT_MECHANISMS, value);
export const isSourceFactOperation = (value: unknown): value is SourceFactOperation => includes(SOURCE_FACT_OPERATIONS, value);
export const isSourceFactProvenance = (value: unknown): value is SourceFactProvenance => includes(SOURCE_FACT_PROVENANCE, value);
export const isRemovalBasis = (value: unknown): value is RemovalBasis => includes(REMOVAL_BASES, value);
