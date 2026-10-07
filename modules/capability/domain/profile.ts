/**
 * Account Capability Profile (TA §16.1 layer 2) and the runtime overlay (layer 3). Pure and deterministic: every
 * input is explicit (catalog, normalized account facts, explicit observations, evaluation time); no clock, I/O or
 * provider call. The same inputs always yield the same profile, so a stored profile can be recomputed and explained.
 *
 * Conservative by construction (fail closed):
 *   - UNKNOWN or UNSUPPORTED in the catalog stays so: account facts or observations can never upgrade it;
 *   - SUPPORTED / AVAILABLE_WITH_LIMITATION needs account facts that are present, consistent, and grant every required
 *     permission; missing or inconsistent facts → UNKNOWN_NOT_VALIDATED, a missing permission → UNSUPPORTED;
 *   - only semantically relevant explicit observations count: PermissionMissing for this capability, and
 *     TargetNotEligible(unsupported_for_target) for this exact scope. Transient, rate-limited and timeout outcomes are
 *     not observations at all (they belong to retry/health) and can't rewrite a profile;
 *   - a limitation always stays visible.
 * Nothing here reads data volume: no input describes how many comments, ads or posts exist (Model §6, TA §16.3).
 */
import type { ConnectionStatus } from "@/domain/connections";
import type { PlatformKey } from "@/domain/platforms";
import { ALL_CAPABILITIES, lookupCatalog, profileScopes, type CapabilityCatalog, type CatalogId } from "./catalog";
import {
  ANY,
  type CapabilityAssetClass,
  type CapabilityContentKind,
  type CapabilityKey,
  type CapabilityReasonCode,
  type CapabilitySource,
  type CapabilityState,
  type Limitation,
  type ScopeKind,
  type ScopeSource,
  type ValidationStatus,
} from "./vocabulary";

/** Normalized facts about one account (from describeAccount). Never a raw provider response. */
export interface AccountFacts {
  readonly kind: "available";
  readonly assetClass: CapabilityAssetClass;
  /** Opaque provider permission identifiers, as granted. Interpreted only through the catalog. */
  readonly grantedPermissions: readonly string[];
  readonly linkedAdAccountIds: readonly string[];
  readonly accountIdentityKnown: boolean;
  /**
   * When OUR system obtained these facts (local clock, captured by the caller), not a provider-reported time: every
   * input time (facts, observations, evaluation) shares one time base, so the stale-write order is consistent.
   */
  readonly obtainedAt: Date;
}

/**
 * A DEFINITE provider answer that the facts can't be read (e.g. a permission or credential error), observed at
 * `observedAt` (local clock). It is a dated input in its own right — never permissive, never "no input".
 */
export interface FactsUnavailable {
  readonly kind: "unavailable";
  readonly observedAt: Date;
}

export type FactsInput = AccountFacts | FactsUnavailable;

/** When the facts input (or its definite absence) was observed. */
export const factsObservedAt = (facts: FactsInput): Date => (facts.kind === "available" ? facts.obtainedAt : facts.observedAt);

/** An explicit, normalized provider response that is evidence about account availability. */
export type CapabilityObservation =
  | { readonly kind: "permission_missing"; readonly capability: CapabilityKey; readonly observedAt: Date; readonly ref: string }
  | {
      readonly kind: "target_not_eligible";
      readonly capability: CapabilityKey;
      readonly contentKind: CapabilityContentKind;
      readonly source: CapabilitySource;
      readonly observedAt: Date;
      readonly ref: string;
    };

export interface EvaluationInput {
  readonly catalog: CapabilityCatalog;
  readonly platform: PlatformKey;
  /** The asset class of the Connected Account (from discovery). */
  readonly assetClass: CapabilityAssetClass;
  /** The account facts, or their definite, dated absence (never treated as permissive). */
  readonly facts: FactsInput;
  readonly observations: readonly CapabilityObservation[];
  readonly evaluatedAt: Date;
}

export interface ProfileEntry {
  readonly capability: CapabilityKey;
  readonly contentKind: ScopeKind;
  readonly source: ScopeSource;
  readonly state: CapabilityState;
  readonly reasons: readonly CapabilityReasonCode[];
  readonly limitation: Limitation | null;
  readonly catalogValidation: ValidationStatus;
  readonly evidence: string | null;
  /** References of the observations that changed this row. */
  readonly observationRefs: readonly string[];
}

export interface CapabilityProfile {
  readonly catalogId: CatalogId;
  readonly catalogRevision: number;
  /** Bookkeeping only: when this evaluation ran. Never used for freshness. */
  readonly evaluatedAt: Date;
  /**
   * The newest normalized input actually used: max(facts obtained / facts-unavailable observed, every observation's
   * observedAt). Deterministic from the inputs; the evaluation time never contributes.
   */
  readonly inputsAsOf: Date;
  readonly entries: readonly ProfileEntry[];
}

function evaluateScope(input: EvaluationInput, capability: CapabilityKey, contentKind: ScopeKind, source: ScopeSource): ProfileEntry {
  const catalog = lookupCatalog(input.catalog, { platform: input.platform, assetClass: input.assetClass, capability, contentKind, source });
  const base = { capability, contentKind, source, catalogValidation: catalog.validation, evidence: catalog.evidence };
  const result = (state: CapabilityState, reasons: readonly CapabilityReasonCode[], limitation: Limitation | null = null, observationRefs: readonly string[] = []): ProfileEntry =>
    ({ ...base, state, reasons, limitation, observationRefs });

  if (catalog.state === "UNKNOWN_NOT_VALIDATED") return result("UNKNOWN_NOT_VALIDATED", ["CATALOG_NOT_VALIDATED"]);
  if (catalog.state === "UNSUPPORTED") return result("UNSUPPORTED", ["CATALOG_UNSUPPORTED"]);

  const facts = input.facts;
  if (facts.kind === "unavailable") return result("UNKNOWN_NOT_VALIDATED", ["ACCOUNT_FACTS_UNAVAILABLE"]);
  if (facts.assetClass !== input.assetClass) return result("UNKNOWN_NOT_VALIDATED", ["ACCOUNT_FACTS_INCONSISTENT"]);
  if (!catalog.requiredPermissions.every((permission) => facts.grantedPermissions.includes(permission))) {
    return result("UNSUPPORTED", ["ACCOUNT_PERMISSION_MISSING"]);
  }

  // Explicit observations: a PermissionMissing newer than the facts that granted the permission wins; facts
  // described later (e.g. after re-authorization) supersede it. TargetNotEligible applies to its exact scope only.
  const permissionMissing = input.observations.filter(
    (o) => o.kind === "permission_missing" && o.capability === capability && o.observedAt.getTime() > facts.obtainedAt.getTime(),
  );
  if (permissionMissing.length > 0) return result("UNSUPPORTED", ["OBSERVED_PERMISSION_MISSING"], null, permissionMissing.map((o) => o.ref).sort());
  const notEligible = input.observations.filter(
    (o) => o.kind === "target_not_eligible" && o.capability === capability && o.contentKind === contentKind && o.source === source,
  );
  if (notEligible.length > 0) return result("UNSUPPORTED", ["OBSERVED_NOT_ELIGIBLE"], null, notEligible.map((o) => o.ref).sort());

  return catalog.state === "AVAILABLE_WITH_LIMITATION"
    ? result("AVAILABLE_WITH_LIMITATION", ["CATALOG_LIMITATION"], catalog.limitation)
    : result("SUPPORTED", ["CATALOG_SUPPORTED"]);
}

/** Scopes of an account's profile: the catalog's declared scopes plus every exact scope an observation names. */
function scopesFor(input: EvaluationInput, capability: CapabilityKey): readonly { readonly contentKind: ScopeKind; readonly source: ScopeSource }[] {
  const keys = new Set(profileScopes(input.catalog, input.platform, input.assetClass, capability).map((s) => `${s.contentKind}|${s.source}`));
  for (const o of input.observations) if (o.kind === "target_not_eligible" && o.capability === capability) keys.add(`${o.contentKind}|${o.source}`);
  return [...keys].sort().map((key) => {
    const [contentKind, source] = key.split("|") as [ScopeKind, ScopeSource];
    return { contentKind, source };
  });
}

export function evaluateProfile(input: EvaluationInput): CapabilityProfile {
  const times = [factsObservedAt(input.facts).getTime(), ...input.observations.map((o) => o.observedAt.getTime())];
  return {
    catalogId: input.catalog.id,
    catalogRevision: input.catalog.revision,
    evaluatedAt: input.evaluatedAt,
    inputsAsOf: new Date(Math.max(...times)),
    entries: ALL_CAPABILITIES.flatMap((capability) => scopesFor(input, capability).map(({ contentKind, source }) => evaluateScope(input, capability, contentKind, source))),
  };
}

/** The stored row for a concrete target: exact > kind-specific > source-specific > (any, any). */
export function resolveEntry(
  entries: readonly ProfileEntry[],
  capability: CapabilityKey,
  contentKind: CapabilityContentKind | typeof ANY,
  source: CapabilitySource | typeof ANY,
): ProfileEntry | undefined {
  const candidates: readonly (readonly [ScopeKind, ScopeSource])[] = [
    [contentKind, source],
    [contentKind, ANY],
    [ANY, source],
    [ANY, ANY],
  ];
  for (const [kind, src] of candidates) {
    const found = entries.find((e) => e.capability === capability && e.contentKind === kind && e.source === src);
    if (found !== undefined) return found;
  }
  return undefined;
}

// ── Runtime overlay (layer 3) ──────────────────────────────────────────────────────────────────────────────

export const AVAILABILITY_STATES = ["AVAILABLE", "AVAILABLE_WITH_LIMITATION", "UNAVAILABLE", "TEMPORARILY_UNAVAILABLE"] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

export const AVAILABILITY_REASONS = [
  "CAPABILITY_SUPPORTED",
  "CAPABILITY_LIMITATION",
  "CAPABILITY_UNSUPPORTED",
  "CAPABILITY_NOT_VALIDATED",
  "ACCOUNT_PERMISSION_MISSING",
  "PROFILE_NOT_EVALUATED",
  "CONNECTION_VALIDATING",
  "CONNECTION_DEGRADED",
  "CONNECTION_FAILED",
  "CONNECTION_DISCONNECTED",
  "CONNECTION_REMOVED",
] as const;
export type AvailabilityReason = (typeof AVAILABILITY_REASONS)[number];

export const RECOVERY_HINTS = ["REAUTHORIZE", "WAIT_FOR_VALIDATION", "OPEN_ON_PLATFORM"] as const;
export type RecoveryHint = (typeof RECOVERY_HINTS)[number];

export interface CapabilityAvailability {
  readonly state: AvailabilityState;
  readonly reason: AvailabilityReason;
  readonly recovery: RecoveryHint | null;
  readonly limitation: Limitation | null;
  readonly capability: CapabilityKey;
  /** Which stored row answered (null when no profile exists). */
  readonly scope: { readonly contentKind: ScopeKind; readonly source: ScopeSource } | null;
  /** The base profile state the answer rests on (never rewritten by health). */
  readonly baseState: CapabilityState | null;
  readonly asOf: Date | null;
}

const TEMPORARY: Readonly<Partial<Record<ConnectionStatus, { readonly reason: AvailabilityReason; readonly recovery: RecoveryHint }>>> = {
  CONNECTING: { reason: "CONNECTION_VALIDATING", recovery: "WAIT_FOR_VALIDATION" },
  DEGRADED: { reason: "CONNECTION_DEGRADED", recovery: "REAUTHORIZE" },
  FAILED: { reason: "CONNECTION_FAILED", recovery: "REAUTHORIZE" },
  DISCONNECTED: { reason: "CONNECTION_DISCONNECTED", recovery: "REAUTHORIZE" },
};

/**
 * Base profile row + current connection health → effective availability. Platform truth (UNSUPPORTED, UNKNOWN)
 * takes precedence over health; a healthy connection shows the base result; an unhealthy one makes a normally
 * usable capability TEMPORARILY_UNAVAILABLE without touching the profile, so recovery restores it.
 */
export function effectiveAvailability(
  entry: ProfileEntry | undefined,
  connection: ConnectionStatus,
  capability: CapabilityKey,
  asOf: Date | null,
): CapabilityAvailability {
  const base = { capability, scope: entry === undefined ? null : { contentKind: entry.contentKind, source: entry.source }, baseState: entry?.state ?? null, asOf };
  if (entry === undefined) return { ...base, state: "UNAVAILABLE", reason: "PROFILE_NOT_EVALUATED", recovery: null, limitation: null };
  if (entry.state === "UNKNOWN_NOT_VALIDATED") return { ...base, state: "UNAVAILABLE", reason: "CAPABILITY_NOT_VALIDATED", recovery: null, limitation: null };
  if (entry.state === "UNSUPPORTED") {
    const permission = entry.reasons.includes("ACCOUNT_PERMISSION_MISSING") || entry.reasons.includes("OBSERVED_PERMISSION_MISSING");
    return permission
      ? { ...base, state: "UNAVAILABLE", reason: "ACCOUNT_PERMISSION_MISSING", recovery: "REAUTHORIZE", limitation: null }
      : { ...base, state: "UNAVAILABLE", reason: "CAPABILITY_UNSUPPORTED", recovery: "OPEN_ON_PLATFORM", limitation: null };
  }
  if (connection === "REMOVED") return { ...base, state: "UNAVAILABLE", reason: "CONNECTION_REMOVED", recovery: null, limitation: null };
  const temporary = TEMPORARY[connection];
  if (temporary !== undefined) return { ...base, state: "TEMPORARILY_UNAVAILABLE", reason: temporary.reason, recovery: temporary.recovery, limitation: entry.limitation };
  return entry.state === "AVAILABLE_WITH_LIMITATION"
    ? { ...base, state: "AVAILABLE_WITH_LIMITATION", reason: "CAPABILITY_LIMITATION", recovery: null, limitation: entry.limitation }
    : { ...base, state: "AVAILABLE", reason: "CAPABILITY_SUPPORTED", recovery: null, limitation: null };
}
