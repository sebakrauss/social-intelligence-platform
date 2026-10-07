/**
 * Platform Capability Catalog (TA §16.1, layer 1): CODE-VERSIONED reference data, reviewed like code. Pure.
 *
 *   platform × asset kind × content type × source × capability  →  catalog state (+ limitation)
 *                                                                 + validation status + evidence reference
 *
 * Two catalogs exist and are selected by the CONNECTION PROVIDER, never by platform:
 *
 *   "platform"   Facebook / Instagram / TikTok through real adapters (meta, tiktok). It holds NO entries: nothing has
 *                passed real-provider API validation (PD OQ-18, OQ-19, OQ-27 VALIDATE), so every lookup resolves to
 *                UNKNOWN_NOT_VALIDATED. An entry may be added only with validation "validated" and an
 *                "api-validation:" evidence reference from the project's validation process (guard-tested). An
 *                adapter exposing a method, or a documented provider feature, is NOT evidence.
 *   "simulator"  SIMULATOR CONTRACT BEHAVIOR ONLY. Deterministic entries that exercise every state of the
 *                architecture in local development and tests. They are not evidence about Meta, Instagram or
 *                TikTok, are never consulted for a real provider, and are refused outside development/test.
 *
 * Lookup is most-specific-first over (platform, content kind, source), defaulting to UNKNOWN_NOT_VALIDATED: a
 * capability the catalog doesn't mention is never implied to be supported.
 */
import type { PlatformKey } from "@/domain/platforms";
import {
  ANY,
  CAPABILITY_KEYS,
  type CapabilityAssetClass,
  type CapabilityKey,
  type CapabilityState,
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
  readonly state: CapabilityState;
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

/** Real platforms: empty until API validation produces evidence-backed entries. */
export const PLATFORM_CATALOG: CapabilityCatalog = Object.freeze({ id: "platform", revision: 1, label: "platform-catalog-r1", entries: Object.freeze([]) });

const SIM_EVIDENCE = "simulator:contract-v1";
const sim = (
  assetClass: CapabilityAssetClass,
  capability: CapabilityKey,
  state: CapabilityState,
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
  revision: 1,
  label: "simulator-catalog-r1",
  entries: Object.freeze([
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
  readonly state: CapabilityState;
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
