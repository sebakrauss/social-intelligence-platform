/**
 * Normalized provider DTOs (TA §15.2): the transport-level vocabulary every adapter returns. These are NOT the
 * product's persistence model (Steps 5–6 own that): they describe what a provider reported, with its identity,
 * provider timestamps and a raw reference.
 *
 * Semantics preserved here (PD C-05, C-07, §8; Model §8–§13, §18, §36):
 *   - platforms and organic/paid are dimensions: `reportedSource` is the platform's signal, defaulting to
 *     "unknown"; the product's source classification is an interpretation made later (TA §14.5);
 *   - one content item can be distributed by many ads: ads point to content, interactions point to content
 *     only, so nothing is duplicated per ad;
 *   - comments and replies are interactions; brand-authored ones are representable (`AuthorDto.role`);
 *   - an edit keeps the object's identity and adds a revision marker; history is the consumer's job (M-09);
 *   - removal at source is an observation that needs an explicit provider signal; absence on one fetch is
 *     `not_returned`, never deletion (TA §47.3);
 *   - there is no direct-message object of any kind (S9; TA §27.3).
 *
 * There is deliberately no generic metadata bag: core facts are explicit fields, and nothing provider-specific
 * can ride along to influence behavior or bypass capability evaluation.
 */
import type { ProviderCredential } from "./credential";
import type { IsoInstant, ProviderObjectRef, ProviderTimestamps, RawReference } from "./identity";

/** The credential and the account a call is made for. Adapters are stateless: every call says both. */
export interface ProviderAccess {
  readonly credential: ProviderCredential;
  readonly account: ProviderObjectRef<"asset">;
}

export const ASSET_CLASSES = ["content_bearing", "ad_account"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

/** A Social Asset an authorization exposes (Model §5): its exact platform kind stays VALIDATE (PD OQ-18). */
export interface SocialAssetDto {
  readonly ref: ProviderObjectRef<"asset">;
  readonly assetClass: AssetClass;
  readonly displayName: string;
  /** Other assets the provider reports as related (e.g. an ad account linked to a page), where exposed. */
  readonly relatedAssets: readonly ProviderObjectRef<"asset">[];
  readonly rawReference: RawReference;
}

/**
 * Facts about an account needed by capability evaluation (Step 5). Facts only: nothing here says what the
 * product may do. `grantedPermissions` are provider-defined opaque identifiers, interpreted only by the
 * versioned capability catalog.
 */
export interface AccountDescriptionDto {
  readonly asset: ProviderObjectRef<"asset">;
  readonly assetClass: AssetClass;
  readonly displayName: string;
  /** The identity the account posts as, so brand-authored interactions can be recognized. */
  readonly accountIdentity: ProviderObjectRef<"author"> | null;
  readonly grantedPermissions: readonly string[];
  readonly linkedAdAccounts: readonly ProviderObjectRef<"asset">[];
  readonly describedAt: IsoInstant;
  readonly rawReference: RawReference;
}

export const CONTENT_KINDS = ["post", "reel", "video", "carousel", "story", "ad_creative", "other"] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

/** Organic / paid / mixed / unknown as the platform reports it (PD C-05). Unknown unless the platform says. */
export const CONTENT_SOURCES = ["organic", "paid", "mixed", "unknown"] as const;
export type ContentSource = (typeof CONTENT_SOURCES)[number];

export const CONTENT_AVAILABILITY = ["available", "restricted", "removed_at_source", "unknown"] as const;
export type ContentAvailability = (typeof CONTENT_AVAILABILITY)[number];

export interface ContentDto {
  readonly ref: ProviderObjectRef<"content">;
  readonly account: ProviderObjectRef<"asset">;
  readonly contentKind: ContentKind;
  readonly reportedSource: ContentSource;
  /** Caption or text as published (original language, untrusted). */
  readonly caption: string | null;
  readonly publishedAt: IsoInstant | null;
  readonly availability: ContentAvailability;
  readonly timestamps: ProviderTimestamps;
  readonly rawReference: RawReference;
}

export const AUTHOR_ROLES = ["account_identity", "user", "unknown"] as const;
/** `account_identity`: the author is the connected account itself (a brand-authored interaction). */
export type AuthorRole = (typeof AUTHOR_ROLES)[number];

/** A platform-scoped author as reported (Model §12). No cross-platform identity, no profile, no contact data. */
export interface AuthorDto {
  readonly ref: ProviderObjectRef<"author">;
  readonly role: AuthorRole;
  readonly displayName: string | null;
  readonly handle: string | null;
}

export const INTERACTION_KINDS = ["comment", "reply"] as const;
/** Comments and replies only (PD D-07). There is no direct-message kind. */
export type InteractionKind = (typeof INTERACTION_KINDS)[number];

export const INTERACTION_VISIBILITY = ["visible", "hidden", "unknown"] as const;
export type InteractionVisibility = (typeof INTERACTION_VISIBILITY)[number];

export const INTERACTION_AVAILABILITY = ["available", "removed_at_source"] as const;
export type InteractionAvailability = (typeof INTERACTION_AVAILABILITY)[number];

export interface InteractionDto {
  readonly ref: ProviderObjectRef<"interaction">;
  readonly content: ProviderObjectRef<"content">;
  /** The interaction this replies to; `null` for a top-level comment. */
  readonly parent: ProviderObjectRef<"interaction"> | null;
  readonly interactionKind: InteractionKind;
  readonly author: AuthorDto;
  /** Text as the provider currently returns it (untrusted); `null` when removed at source. */
  readonly text: string | null;
  /** Provider-reported revision marker where exposed; a change means the text was edited. */
  readonly textRevision: string | null;
  readonly editedAt: IsoInstant | null;
  readonly visibility: InteractionVisibility;
  /** `removed_at_source` only on an explicit provider signal (e.g. a tombstone), never inferred. */
  readonly availability: InteractionAvailability;
  readonly timestamps: ProviderTimestamps;
  readonly rawReference: RawReference;
}

export const PAID_STATUSES = ["active", "paused", "ended", "unknown"] as const;
export type PaidStatus = (typeof PAID_STATUSES)[number];

/** Paid context is read-only distribution context (Model §9): never budgets, bids or edits. */
export interface CampaignDto {
  readonly type: "campaign";
  readonly ref: ProviderObjectRef<"campaign">;
  readonly adAccount: ProviderObjectRef<"asset">;
  readonly name: string | null;
  readonly status: PaidStatus;
  readonly timestamps: ProviderTimestamps;
  readonly rawReference: RawReference;
}

export interface AdGroupDto {
  readonly type: "ad_group";
  readonly ref: ProviderObjectRef<"ad_group">;
  readonly adAccount: ProviderObjectRef<"asset">;
  readonly campaign: ProviderObjectRef<"campaign"> | null;
  readonly name: string | null;
  readonly status: PaidStatus;
  readonly timestamps: ProviderTimestamps;
  readonly rawReference: RawReference;
}

export interface AdDto {
  readonly type: "ad";
  readonly ref: ProviderObjectRef<"ad">;
  readonly adAccount: ProviderObjectRef<"asset">;
  readonly adGroup: ProviderObjectRef<"ad_group"> | null;
  readonly campaign: ProviderObjectRef<"campaign"> | null;
  /** The content item this ad distributes; `null` when the provider doesn't expose the link. */
  readonly content: ProviderObjectRef<"content"> | null;
  readonly name: string | null;
  readonly status: PaidStatus;
  readonly timestamps: ProviderTimestamps;
  readonly rawReference: RawReference;
}

export type PaidContextItem = CampaignDto | AdGroupDto | AdDto;

export const PRESENCE_STATES = ["present", "removed_at_source", "not_returned", "unknown"] as const;
/**
 * `removed_at_source`: an explicit provider signal. `not_returned`: the provider didn't return the object on a
 * direct read with a working credential, which is NOT a deletion until reconciliation confirms it.
 */
export type PresenceState = (typeof PRESENCE_STATES)[number];

export const OBSERVATION_BASES = ["provider_field", "provider_signal", "direct_fetch"] as const;
export type ObservationBasis = (typeof OBSERVATION_BASES)[number];

export type StateTarget = ProviderObjectRef<"content" | "interaction" | "author">;

/** What the provider says about an object right now. A failed call is an error, never an observation. */
export interface StateObservationDto {
  readonly target: StateTarget;
  readonly presence: PresenceState;
  /** For interactions; `null` for other targets. */
  readonly visibility: InteractionVisibility | null;
  /** For authors in the access account's context; `null` for other targets or when not exposed. */
  readonly blocked: boolean | null;
  readonly observedAt: IsoInstant;
  readonly basis: ObservationBasis;
  readonly rawReference: RawReference | null;
}

export interface SubscriptionResultDto {
  readonly asset: ProviderObjectRef<"asset">;
  readonly state: "subscribed" | "unsubscribed";
  /** False when the asset was already in that state (subscription calls are idempotent). */
  readonly changed: boolean;
}

export type CredentialRefreshResult =
  | { readonly status: "refreshed"; readonly credential: ProviderCredential; readonly expiresAt: IsoInstant | null }
  | { readonly status: "not_needed"; readonly expiresAt: IsoInstant | null }
  | { readonly status: "not_supported" };
