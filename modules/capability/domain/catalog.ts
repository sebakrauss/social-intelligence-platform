/**
 * Platform Capability Catalog (TA §16.1, layer 1): CODE-VERSIONED reference data, reviewed like code. Pure.
 *
 *   platform × asset kind × content type × source × capability  →  catalog state (+ limitation)
 *                                                                 + validation status + evidence reference
 *
 * Two catalogs exist and are selected by the CONNECTION PROVIDER, never by platform:
 *
 *   "platform"   Facebook / Instagram / TikTok through real adapters (meta, tiktok). It holds exactly FOUR entries (r5):
 *                Facebook and Instagram read_content, and Facebook and Instagram read_interactions, each for content
 *                kind `post` and source `unknown` and each backed by its own accepted LIVE record
 *                (api-validation:meta.{facebook,instagram}.read_content.20261023-01,
 *                api-validation:meta.facebook.read_interactions.20261027-01,
 *                api-validation:meta.instagram.read_interactions.20261026-01). Every other scope has passed no real-provider
 *                API validation (PD OQ-18, OQ-19, OQ-27 VALIDATE) and resolves to UNKNOWN_NOT_VALIDATED. An entry may
 *                be added only with validation "validated" and an "api-validation:" evidence reference from the
 *                project's validation process (guard-tested). An adapter exposing a method, or a documented provider
 *                feature, is NOT evidence.
 *   "simulator"  SIMULATOR CONTRACT BEHAVIOR ONLY. Deterministic entries that exercise every state of the
 *                architecture in local development and tests. They are not evidence about Meta, Instagram or
 *                TikTok, are never consulted for a real provider, and are refused outside development/test.
 *
 * Lookup is most-specific-first over (platform, content kind, source), defaulting to UNKNOWN_NOT_VALIDATED: a
 * capability the catalog doesn't mention is never implied to be supported.
 *
 * A revision covers everything an evaluation's output depends on besides the account's inputs: the entries AND the
 * capability vocabulary they are evaluated over. Revision 2 (Step 7G-H5.5) adds `read_content` to the vocabulary, so
 * every revision-1 profile lacks a row for it and is stale by revision: availability refuses it (PROFILE_STALE) and
 * reconciliation requests its re-evaluation. Revision 3 of the platform catalog (Step 7G-H5.5-P5-C9-C) adds its first
 * entry, so every platform profile evaluated at r2 is stale by revision in the same way until an explicit Re-check.
 * Revision 4 (Step 7G-H5.5-P11-E) adds the first Instagram entry; every platform profile evaluated at r3 is stale in
 * the same way until an explicit Re-check. Revision 5 (Step 7G-H5.5-P12-D2b) adds the two read_interactions entries;
 * every platform profile evaluated at r4 is stale in the same way until an explicit Re-check.
 *
 * The PROFILE state vocabulary is not part of a revision's content: Step 7G-H5.5-P4-C added NOT_AUTHORIZED (a missing
 * authorization, previously stored as UNSUPPORTED) without changing any entry, capability key or scope, so neither
 * catalog revision moved. Migration 0015's state↔reason CHECK refuses to validate while any stored row still carries
 * the old UNSUPPORTED + permission shape, so no such row can silently survive the change.
 */
import type { PlatformKey } from "@/domain/platforms";
import {
  ANY,
  CAPABILITY_KEYS,
  type CapabilityAssetClass,
  type CapabilityKey,
  type CatalogState,
  type Limitation,
  type ScopeKind,
  type ScopeSource,
  type ValidationStatus,
} from "./vocabulary";

export const CATALOG_IDS = ["platform", "simulator"] as const;
export type CatalogId = (typeof CATALOG_IDS)[number];

export interface CatalogEntry {
  readonly platform: PlatformKey | typeof ANY;
  readonly assetClass: CapabilityAssetClass;
  readonly capability: CapabilityKey;
  readonly contentKind: ScopeKind;
  readonly source: ScopeSource;
  readonly state: CatalogState;
  readonly limitation: Limitation | null;
  /** Provider permission identifiers the account must hold (opaque; interpreted only here). */
  readonly requiredPermissions: readonly string[];
  readonly validation: ValidationStatus;
  /** Identity of the evidence behind the entry (e.g. "api-validation:…", "simulator:contract-v1"). */
  readonly evidence: string | null;
}

export interface CapabilityCatalog {
  readonly id: CatalogId;
  /** Monotonic integer revision: the ONLY catalog value used for freshness ordering. */
  readonly revision: number;
  /** Human-readable label for reviews and logs. Never compared or used for ordering. */
  readonly label: string;
  readonly entries: readonly CatalogEntry[];
}

/**
 * Real platforms: only API-validated, evidence-backed entries. Every entry must satisfy the entry contract in
 * ./catalog-contract.ts (accepted api-validation evidence record of the exact scope, identical named permissions,
 * registered implementation evidence). The authorization semantics are resolved (Step 7G-H5.5-P4-C: a missing
 * authorization is the PROFILE state NOT_AUTHORIZED, never a catalog verdict).
 *
 * r3 (Step 7G-H5.5-P5-C9-C) publishes the first and only entry, scoped EXACTLY as its evidence: Facebook ·
 * content_bearing · read_content · `post` · `unknown`. `unknown` is the source the provider reported; it is never
 * widened to `any` nor read as `organic`, so organic, paid, mixed and every other content kind stay UNKNOWN. Whether an
 * account holds the two permissions is account truth, decided by the profile (NOT_AUTHORIZED), never here.
 *
 * r4 (Step 7G-H5.5-P11-E) adds exactly one more entry, scoped EXACTLY as the accepted Instagram record: Instagram ·
 * content_bearing · read_content · `post` · `unknown`, requiring `instagram_basic` and `pages_read_engagement` (the
 * known requirements of the validated read path — `pages_show_list` is not one). Video, reel, carousel, every other
 * source and any generic Instagram scope stay UNKNOWN. The Facebook entry is unchanged.
 *
 * r5 (Step 7G-H5.5-P12-D2b; design P12-D1) adds exactly two read_interactions entries, each scoped EXACTLY as its
 * accepted record (post · unknown) and with the state and limitation the record's interaction kinds derive
 * (catalog-contract.ts › readInteractionsPublication): Facebook — comment + reply proven (P12-C10) → SUPPORTED, requiring
 * `pages_read_engagement`, `pages_read_user_content` and `pages_show_list`; Instagram — comment proven (P12-C6), replies
 * not read by the adapter → AVAILABLE_WITH_LIMITATION / REPLIES_NOT_READ, requiring `instagram_basic`,
 * `instagram_manage_comments` and `pages_read_engagement`. Instagram replies are NOT unsupported (no negative evidence):
 * Wrenkind does not read them. Interaction kinds are not a scope dimension; every other content kind, source and the
 * generic any/any read_interactions scope stay UNKNOWN. The two read_content entries are unchanged.
 */
export const PLATFORM_CATALOG: CapabilityCatalog = Object.freeze({
  id: "platform",
  revision: 5,
  label: "platform-catalog-r5",
  entries: Object.freeze([
    Object.freeze({
      platform: "facebook",
      assetClass: "content_bearing",
      capability: "read_content",
      contentKind: "post",
      source: "unknown",
      state: "SUPPORTED",
      limitation: null,
      requiredPermissions: Object.freeze(["pages_read_engagement", "pages_show_list"]),
      validation: "validated",
      evidence: "api-validation:meta.facebook.read_content.20261023-01",
    }),
    Object.freeze({
      platform: "instagram",
      assetClass: "content_bearing",
      capability: "read_content",
      contentKind: "post",
      source: "unknown",
      state: "SUPPORTED",
      limitation: null,
      requiredPermissions: Object.freeze(["instagram_basic", "pages_read_engagement"]),
      validation: "validated",
      evidence: "api-validation:meta.instagram.read_content.20261023-01",
    }),
    Object.freeze({
      platform: "facebook",
      assetClass: "content_bearing",
      capability: "read_interactions",
      contentKind: "post",
      source: "unknown",
      state: "SUPPORTED",
      limitation: null,
      requiredPermissions: Object.freeze(["pages_read_engagement", "pages_read_user_content", "pages_show_list"]),
      validation: "validated",
      evidence: "api-validation:meta.facebook.read_interactions.20261027-01",
    }),
    Object.freeze({
      platform: "instagram",
      assetClass: "content_bearing",
      capability: "read_interactions",
      contentKind: "post",
      source: "unknown",
      state: "AVAILABLE_WITH_LIMITATION",
      limitation: Object.freeze({ code: "REPLIES_NOT_READ", value: null }),
      requiredPermissions: Object.freeze(["instagram_basic", "instagram_manage_comments", "pages_read_engagement"]),
      validation: "validated",
      evidence: "api-validation:meta.instagram.read_interactions.20261026-01",
    }),
  ]),
});

const SIM_EVIDENCE = "simulator:contract-v1";
const sim = (
  assetClass: CapabilityAssetClass,
  capability: CapabilityKey,
  state: CatalogState,
  options: { readonly contentKind?: ScopeKind; readonly source?: ScopeSource; readonly limitation?: Limitation; readonly permissions?: readonly string[] } = {},
): CatalogEntry =>
  Object.freeze({
    platform: ANY,
    assetClass,
    capability,
    contentKind: options.contentKind ?? ANY,
    source: options.source ?? ANY,
    state,
    limitation: options.limitation ?? null,
    requiredPermissions: Object.freeze([...(options.permissions ?? [])]),
    validation: "validated" as const,
    evidence: SIM_EVIDENCE,
  });

/** SIMULATOR CONTRACT BEHAVIOR ONLY (see header). detect_native_replies is deliberately absent → UNKNOWN. */
export const SIMULATOR_CATALOG: CapabilityCatalog = Object.freeze({
  id: "simulator",
  revision: 2,
  label: "simulator-catalog-r2",
  entries: Object.freeze([
    sim("content_bearing", "read_content", "SUPPORTED", { permissions: ["sim.read_content"] }),
    sim("content_bearing", "read_interactions", "SUPPORTED", { permissions: ["sim.read_interactions"] }),
    sim("content_bearing", "read_history", "AVAILABLE_WITH_LIMITATION", { limitation: { code: "HISTORY_DEPTH_LIMITED", value: 90 }, permissions: ["sim.read_interactions"] }),
    sim("content_bearing", "reply_public", "SUPPORTED", { permissions: ["sim.reply_public"] }),
    sim("content_bearing", "reply_public", "UNSUPPORTED", { contentKind: "story" }),
    sim("content_bearing", "reply_private", "SUPPORTED", { source: "organic", permissions: ["sim.reply_private"] }),
    sim("content_bearing", "reply_private", "UNSUPPORTED", { source: "paid" }),
    sim("content_bearing", "hide", "AVAILABLE_WITH_LIMITATION", { limitation: { code: "HIDE_VISIBLE_TO_AUTHOR", value: null }, permissions: ["sim.hide"] }),
    sim("content_bearing", "delete", "SUPPORTED", { permissions: ["sim.delete"] }),
    sim("content_bearing", "block", "SUPPORTED", { permissions: ["sim.block"] }),
    sim("ad_account", "read_paid_context", "SUPPORTED", { permissions: ["sim.read_paid_context"] }),
  ]),
});

/** The catalog result for one scope: an entry's facts, or the conservative default. */
export interface CatalogResult {
  readonly catalogId: CatalogId;
  readonly catalogRevision: number;
  readonly state: CatalogState;
  readonly limitation: Limitation | null;
  readonly requiredPermissions: readonly string[];
  readonly validation: ValidationStatus;
  readonly evidence: string | null;
}

export interface CatalogScope {
  readonly platform: PlatformKey;
  readonly assetClass: CapabilityAssetClass;
  readonly capability: CapabilityKey;
  readonly contentKind: ScopeKind;
  readonly source: ScopeSource;
}

/** Specificity of an entry for a scope (higher wins; -1 = doesn't apply). Platform before kind before source. */
function specificity(entry: CatalogEntry, scope: CatalogScope): number {
  if (entry.assetClass !== scope.assetClass || entry.capability !== scope.capability) return -1;
  if (entry.platform !== ANY && entry.platform !== scope.platform) return -1;
  if (entry.contentKind !== ANY && entry.contentKind !== scope.contentKind) return -1;
  if (entry.source !== ANY && entry.source !== scope.source) return -1;
  return (entry.platform === ANY ? 0 : 4) + (entry.contentKind === ANY ? 0 : 2) + (entry.source === ANY ? 0 : 1);
}

/** Most specific matching entry, or UNKNOWN_NOT_VALIDATED. A wildcard scope matches only wildcard entries. */
export function lookupCatalog(catalog: CapabilityCatalog, scope: CatalogScope): CatalogResult {
  let best: CatalogEntry | undefined;
  let bestScore = -1;
  for (const entry of catalog.entries) {
    const score = specificity(entry, scope);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  if (best === undefined) {
    return { catalogId: catalog.id, catalogRevision: catalog.revision, state: "UNKNOWN_NOT_VALIDATED", limitation: null, requiredPermissions: [], validation: "not_validated", evidence: null };
  }
  return {
    catalogId: catalog.id,
    catalogRevision: catalog.revision,
    state: best.state,
    limitation: best.limitation,
    requiredPermissions: best.requiredPermissions,
    validation: best.validation,
    evidence: best.evidence,
  };
}

/**
 * The scopes a profile stores for (platform, asset class, capability): the catalog-wide default (any, any) plus
 * every narrower (kind, source) the catalog distinguishes. Deterministic order.
 */
export function profileScopes(catalog: CapabilityCatalog, platform: PlatformKey, assetClass: CapabilityAssetClass, capability: CapabilityKey): readonly { readonly contentKind: ScopeKind; readonly source: ScopeSource }[] {
  const keys = new Set<string>([`${ANY}|${ANY}`]);
  for (const entry of catalog.entries) {
    if (entry.capability === capability && entry.assetClass === assetClass && (entry.platform === ANY || entry.platform === platform)) keys.add(`${entry.contentKind}|${entry.source}`);
  }
  return [...keys].sort().map((key) => {
    const [contentKind, source] = key.split("|") as [ScopeKind, ScopeSource];
    return { contentKind, source };
  });
}

export const ALL_CAPABILITIES: readonly CapabilityKey[] = CAPABILITY_KEYS;

export const CATALOGS: { readonly [I in CatalogId]: CapabilityCatalog } = Object.freeze({ platform: PLATFORM_CATALOG, simulator: SIMULATOR_CATALOG });

/**
 * The catalog a connection provider is evaluated against: the simulator's for the simulator, the platform catalog for
 * every real provider. Pure — which catalog a profile SHOULD rest on, for staleness checks and reconciliation; whether
 * the simulator catalog may be used at all in this environment is decided only where it is selected for an evaluation.
 */
export function catalogIdFor(provider: string): CatalogId {
  return provider === "simulator" ? "simulator" : "platform";
}

/** A stored profile rests on the CURRENT catalog for its provider: same catalog id and exactly its revision. */
export function isCurrentProfile(stored: { readonly catalogId: CatalogId; readonly catalogRevision: number }, provider: string): boolean {
  const expected = CATALOGS[catalogIdFor(provider)];
  return stored.catalogId === expected.id && stored.catalogRevision === expected.revision;
}
