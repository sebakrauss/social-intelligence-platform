/**
 * Capability vocabulary (Model §6; TA §16). Pure. Product capability KEYS name what the product may try to do; a key
 * existing here says NOTHING about whether any platform supports it (PD C-07, OQ-18).
 *
 * Keys reuse the provider contract's normalized names where an equivalent exists (PERMISSION_CAPABILITIES):
 *   read_content        import the account's top-level content (posts, reels, videos…) — its own provider operation
 *                       (listContent / getContent) and permission, distinct from reading the conversation under it
 *   read_interactions   import comments/replies — organic vs paid is the SOURCE dimension, not a separate key
 *   read_paid_context   link content to campaign / ad group / ad
 *   reply_public · reply_private (one-shot, PD D-36) · hide (hide/unhide) · delete · block
 * and add only what has no equivalent:
 *   read_history        history/backfill availability (depth limits are a limitation)
 *   detect_native_replies   see brand replies made outside the product
 *
 * Content kinds, sources and asset classes MIRROR the provider contract's closed vocabularies (the module domain may
 * not import the contract); a unit test pins them equal.
 */

export const CAPABILITY_KEYS = [
  "read_content",
  "read_interactions",
  "read_history",
  "read_paid_context",
  "reply_public",
  "reply_private",
  "hide",
  "delete",
  "block",
  "detect_native_replies",
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export const CAPABILITY_CONTENT_KINDS = ["post", "reel", "video", "carousel", "story", "ad_creative", "other"] as const;
export type CapabilityContentKind = (typeof CAPABILITY_CONTENT_KINDS)[number];

export const CAPABILITY_SOURCES = ["organic", "paid", "mixed", "unknown"] as const;
export type CapabilitySource = (typeof CAPABILITY_SOURCES)[number];

export const CAPABILITY_ASSET_CLASSES = ["content_bearing", "ad_account"] as const;
export type CapabilityAssetClass = (typeof CAPABILITY_ASSET_CLASSES)[number];

/** Scope wildcard: an entry or profile row that applies to every value of that dimension. */
export const ANY = "any";
export type ScopeKind = CapabilityContentKind | typeof ANY;
export type ScopeSource = CapabilitySource | typeof ANY;

/**
 * CATALOG states (platform truth, validated by evidence): what the provider/platform supports for an account category.
 * NOT_AUTHORIZED is never one of them — authorization is a fact about ONE connected account (Step 7G-H5.5-P4-C).
 */
export const CATALOG_STATES = ["SUPPORTED", "AVAILABLE_WITH_LIMITATION", "UNSUPPORTED", "UNKNOWN_NOT_VALIDATED"] as const;
export type CatalogState = (typeof CATALOG_STATES)[number];

/**
 * PROFILE states (one connected account, through Wrenkind, now): the catalog states plus NOT_AUTHORIZED — the platform
 * supports the capability (validated catalog entry), but this account currently lacks the provider authorization
 * Wrenkind needs to perform it. UNSUPPORTED stays reserved for authoritative non-support (CATALOG_UNSUPPORTED,
 * OBSERVED_NOT_ELIGIBLE); a missing authorization is never stored as non-support. TEMPORARILY_UNAVAILABLE is only the
 * runtime overlay.
 */
export const PROFILE_STATES = ["SUPPORTED", "AVAILABLE_WITH_LIMITATION", "UNSUPPORTED", "NOT_AUTHORIZED", "UNKNOWN_NOT_VALIDATED"] as const;
export type ProfileState = (typeof PROFILE_STATES)[number];

export const VALIDATION_STATUSES = ["validated", "not_validated"] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

/** Known restrictions of an otherwise available capability (closed; an optional integer parameter, e.g. days). */
export const LIMITATION_CODES = ["HISTORY_DEPTH_LIMITED", "HIDE_VISIBLE_TO_AUTHOR"] as const;
export type LimitationCode = (typeof LIMITATION_CODES)[number];

export interface Limitation {
  readonly code: LimitationCode;
  readonly value: number | null;
}

/** Why a profile row has its state (closed; never provider text). */
export const CAPABILITY_REASON_CODES = [
  "CATALOG_SUPPORTED",
  "CATALOG_LIMITATION",
  "CATALOG_UNSUPPORTED",
  "CATALOG_NOT_VALIDATED",
  "ACCOUNT_FACTS_UNAVAILABLE",
  "ACCOUNT_FACTS_INCONSISTENT",
  "ACCOUNT_PERMISSION_MISSING",
  "OBSERVED_PERMISSION_MISSING",
  "OBSERVED_NOT_ELIGIBLE",
] as const;
export type CapabilityReasonCode = (typeof CAPABILITY_REASON_CODES)[number];

/**
 * The reasons each profile state may carry (state ↔ reason coherence; mirrored by the database CHECK in migration 0015).
 * Authorization reasons accompany only NOT_AUTHORIZED; authoritative non-support reasons only UNSUPPORTED.
 */
export const PROFILE_STATE_REASONS: { readonly [S in ProfileState]: readonly CapabilityReasonCode[] } = Object.freeze({
  SUPPORTED: Object.freeze(["CATALOG_SUPPORTED"] as const),
  AVAILABLE_WITH_LIMITATION: Object.freeze(["CATALOG_LIMITATION"] as const),
  UNSUPPORTED: Object.freeze(["CATALOG_UNSUPPORTED", "OBSERVED_NOT_ELIGIBLE"] as const),
  NOT_AUTHORIZED: Object.freeze(["ACCOUNT_PERMISSION_MISSING", "OBSERVED_PERMISSION_MISSING"] as const),
  UNKNOWN_NOT_VALIDATED: Object.freeze(["CATALOG_NOT_VALIDATED", "ACCOUNT_FACTS_UNAVAILABLE", "ACCOUNT_FACTS_INCONSISTENT"] as const),
});

/** Whether a stored profile row's shape is coherent: 1–8 reasons, all admitted for its state; a limitation exactly when limited. */
export function isCoherentProfileShape(row: { readonly state: ProfileState; readonly reasons: readonly CapabilityReasonCode[]; readonly limitation: unknown }): boolean {
  const allowed = PROFILE_STATE_REASONS[row.state] as readonly string[];
  return row.reasons.length >= 1 && row.reasons.length <= 8 && row.reasons.every((reason) => allowed.includes(reason))
    && (row.state === "AVAILABLE_WITH_LIMITATION") === (row.limitation !== null);
}

const includes = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && (values as readonly string[]).includes(value);
export const isCapabilityKey = (value: unknown): value is CapabilityKey => includes(CAPABILITY_KEYS, value);
export const isCapabilityContentKind = (value: unknown): value is CapabilityContentKind => includes(CAPABILITY_CONTENT_KINDS, value);
export const isCapabilitySource = (value: unknown): value is CapabilitySource => includes(CAPABILITY_SOURCES, value);
