/**
 * Capability evaluation services (Step 5E; TA §16.3). The module evaluates per account with the pure domain function
 * (catalog version + account facts + explicit observations → profile) and stores the result with its as-of time,
 * reasons, catalog version and the normalized inputs it used.
 *
 *   selectCatalog            provider → catalog. The SIMULATOR catalog is refused outside development/test; a real
 *                            provider always gets the platform catalog (all UNKNOWN until API validation).
 *   factsFromDescription     the contract's describeAccount DTO → normalized facts (no raw reference kept).
 *   observationFromError     ONLY PermissionMissing(capability) and TargetNotEligible(unsupported_for_target, exact
 *                            scope) become observations; Transient, RateLimited, OutcomeUnknown and everything else
 *                            return undefined — they belong to retry/health and never rewrite a profile.
 *   evaluateAndStore         pure evaluation → digest of the inputs → stale-safe write.
 *   capabilityAvailability   stored row for the target + connection health → effective availability (overlay).
 */
import { createHash } from "node:crypto";
import type { ConnectionStatus } from "@/domain/connections";
import type { PlatformKey } from "@/domain/platforms";
import { isProviderError, type AccountDescriptionDto } from "@/integrations/providers/contract";
import { PLATFORM_CATALOG, SIMULATOR_CATALOG, type CapabilityCatalog } from "../domain/catalog";
import {
  effectiveAvailability,
  evaluateProfile,
  resolveEntry,
  type AccountFacts,
  type CapabilityAvailability,
  type CapabilityObservation,
  type CapabilityProfile,
  type EvaluationInput,
  type FactsInput,
} from "../domain/profile";
import {
  type ANY,
  isCapabilityKey,
  type CapabilityAssetClass,
  type CapabilityContentKind,
  type CapabilityKey,
  type CapabilitySource,
} from "../domain/vocabulary";
import type { CapabilityProfileStore, CapabilityReadStore, ProfileWriteOutcome } from "./ports";

export const SIMULATOR_CATALOG_ENVIRONMENTS: readonly string[] = ["development", "test"];

export class CapabilityCatalogError extends Error {
  override readonly name = "CapabilityCatalogError";
  constructor() {
    super("capability_simulator_catalog_forbidden");
  }
}

/** The catalog for a connection provider. Never chosen by platform: simulator evidence can't reach a real provider. */
export function selectCatalog(provider: "meta" | "tiktok" | "simulator", environment: Readonly<Record<string, string | undefined>>): CapabilityCatalog {
  if (provider !== "simulator") return PLATFORM_CATALOG;
  if (!SIMULATOR_CATALOG_ENVIRONMENTS.includes(environment["NODE_ENV"] ?? "")) throw new CapabilityCatalogError();
  return SIMULATOR_CATALOG;
}

/** `obtainedAt` is the local time the description was received (the provider's own timestamp is not compared). */
export function factsFromDescription(description: AccountDescriptionDto, obtainedAt: Date): AccountFacts {
  return {
    kind: "available",
    assetClass: description.assetClass,
    grantedPermissions: [...new Set(description.grantedPermissions)].sort(),
    linkedAdAccountIds: [...new Set(description.linkedAdAccounts.map((ref) => ref.id))].sort(),
    accountIdentityKnown: description.accountIdentity !== null,
    obtainedAt,
  };
}

/** A provider error as capability evidence, or undefined when it is not semantically relevant (fail safe). */
export function observationFromError(
  error: unknown,
  target: { readonly capability: CapabilityKey; readonly contentKind: CapabilityContentKind; readonly source: CapabilitySource },
  observedAt: Date,
  ref: string,
): CapabilityObservation | undefined {
  if (!isProviderError(error)) return undefined;
  const details = error.toJSON().details;
  if (error.kind === "permission_missing") {
    const capability = details["capability"];
    return isCapabilityKey(capability) && capability === target.capability ? { kind: "permission_missing", capability, observedAt, ref } : undefined;
  }
  if (error.kind === "target_not_eligible" && details["reason"] === "unsupported_for_target") {
    return { kind: "target_not_eligible", capability: target.capability, contentKind: target.contentKind, source: target.source, observedAt, ref };
  }
  return undefined;
}


/**
 * SHA-256 of the canonical evaluation CONTENT: catalog, account dimensions, facts and observations, plus the entries
 * they evaluate to. Acquisition and evaluation times are excluded, so re-checking unchanged facts later is the same
 * evaluation (only "last verified" moves) — yet any change in the result (e.g. facts now newer than an observation)
 * changes the digest.
 */
export function inputDigest(input: EvaluationInput): string {
  const facts = input.facts.kind === "unavailable"
    ? "unavailable"
    : { assetClass: input.facts.assetClass, grantedPermissions: input.facts.grantedPermissions, linkedAdAccountIds: input.facts.linkedAdAccountIds, accountIdentityKnown: input.facts.accountIdentityKnown };
  const observations = input.observations.map((o) => ({ ...o, observedAt: o.observedAt.toISOString() })).sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const canonical = JSON.stringify([input.catalog.id, input.catalog.revision, input.platform, input.assetClass, facts, observations, evaluateProfile(input).entries]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface EvaluateAndStoreInput {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly connectedAccountId: string;
  readonly catalog: CapabilityCatalog;
  readonly platform: PlatformKey;
  readonly assetClass: CapabilityAssetClass;
  readonly facts: FactsInput;
  readonly observations: readonly CapabilityObservation[];
  readonly evaluatedAt: Date;
}

export async function evaluateAndStore(store: CapabilityProfileStore, input: EvaluateAndStoreInput): Promise<{ readonly profile: CapabilityProfile; readonly outcome: ProfileWriteOutcome }> {
  const profile = evaluateProfile(input);
  const outcome = await store.write({
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    connectedAccountId: input.connectedAccountId,
    profile,
    facts: input.facts,
    observations: input.observations,
    inputDigest: inputDigest(input),
  });
  return { profile, outcome };
}

/** Effective availability of one capability for one target scope, from the stored profile and connection health. */
export async function capabilityAvailability(
  store: CapabilityReadStore,
  input: {
    readonly connectedAccountId: string;
    readonly capability: CapabilityKey;
    readonly contentKind: CapabilityContentKind | typeof ANY;
    readonly source: CapabilitySource | typeof ANY;
    readonly connection: ConnectionStatus;
  },
): Promise<CapabilityAvailability> {
  const header = await store.header(input.connectedAccountId);
  const entries = header === undefined ? [] : await store.entries(input.connectedAccountId);
  return effectiveAvailability(resolveEntry(entries, input.capability, input.contentKind, input.source), input.connection, input.capability, header?.evaluatedAt ?? null);
}
