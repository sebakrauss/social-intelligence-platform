/**
 * Step 7G-H5.5-P4-C — the profile-only NOT_AUTHORIZED state, without a database. A missing provider authorization is
 * NOT_AUTHORIZED (ACCOUNT_PERMISSION_MISSING from the facts, OBSERVED_PERMISSION_MISSING from a newer observation),
 * never UNSUPPORTED; UNSUPPORTED stays authoritative non-support (CATALOG_UNSUPPORTED, OBSERVED_NOT_ELIGIBLE). The
 * availability overlay is strict: NOT_AUTHORIZED is always UNAVAILABLE / ACCOUNT_PERMISSION_MISSING / REAUTHORIZE,
 * UNSUPPORTED always UNAVAILABLE / CAPABILITY_UNSUPPORTED / OPEN_ON_PLATFORM, and an incoherent row is never trusted.
 * Synthetic catalogs only: the real platform catalog stays r2 with zero entries.
 */
import { describe, expect, it } from "vitest";
import { CONNECTION_STATUSES } from "@/domain/connections";
import {
  ANY,
  CATALOG_STATES,
  PLATFORM_CATALOG,
  PROFILE_STATES,
  PROFILE_STATE_REASONS,
  SIMULATOR_CATALOG,
  effectiveAvailability,
  evaluateProfile,
  isCoherentProfileShape,
  profileLacksAuthorization,
  resolveEntry,
  type AccountFacts,
  type CapabilityCatalog,
  type CatalogEntry,
  type CatalogState,
  type EvaluationInput,
  type ProfileEntry,
  type ProfileState,
} from "@/modules/capability";

const T0 = new Date("2026-10-22T12:00:00.000Z");
const later = new Date(T0.getTime() + 60_000);
const supported = (patch: Partial<CatalogEntry> = {}): CatalogEntry => ({
  platform: "facebook",
  assetClass: "content_bearing",
  capability: "read_content",
  contentKind: ANY,
  source: ANY,
  state: "SUPPORTED",
  limitation: null,
  requiredPermissions: ["synthetic_read_content"],
  validation: "validated",
  evidence: "api-validation:meta.facebook.read_content.20261101-01",
  ...patch,
});
const catalogOf = (...entries: CatalogEntry[]): CapabilityCatalog => ({ id: "platform", revision: 2, label: "hypothetical", entries });
const facts = (granted: readonly string[], patch: Partial<AccountFacts> = {}): AccountFacts => ({
  kind: "available",
  assetClass: "content_bearing",
  grantedPermissions: granted,
  linkedAdAccountIds: [],
  accountIdentityKnown: true,
  obtainedAt: T0,
  ...patch,
});
const evaluate = (catalog: CapabilityCatalog, patch: Partial<EvaluationInput> = {}): ProfileEntry | undefined =>
  resolveEntry(
    evaluateProfile({ catalog, platform: "facebook", assetClass: "content_bearing", facts: facts(["synthetic_read_content"]), observations: [], evaluatedAt: later, ...patch }).entries,
    "read_content",
    ANY,
    ANY,
  );
const row = (state: ProfileState, reasons: ProfileEntry["reasons"], limitation: ProfileEntry["limitation"] = null): ProfileEntry => ({
  capability: "read_content",
  contentKind: ANY,
  source: ANY,
  state,
  reasons,
  limitation,
  catalogValidation: "validated",
  evidence: null,
  observationRefs: [],
});

describe("vocabulary: NOT_AUTHORIZED is a profile state, never a catalog state", () => {
  it("the catalog has four states; the profile has five, NOT_AUTHORIZED included", () => {
    expect([...CATALOG_STATES]).toEqual(["SUPPORTED", "AVAILABLE_WITH_LIMITATION", "UNSUPPORTED", "UNKNOWN_NOT_VALIDATED"]);
    expect([...PROFILE_STATES]).toEqual(["SUPPORTED", "AVAILABLE_WITH_LIMITATION", "UNSUPPORTED", "NOT_AUTHORIZED", "UNKNOWN_NOT_VALIDATED"]);
    expect(CATALOG_STATES).not.toContain("NOT_AUTHORIZED");
    // @ts-expect-error — NOT_AUTHORIZED is not a CatalogState.
    const notCatalog: CatalogState = "NOT_AUTHORIZED";
    const profile: ProfileState = "NOT_AUTHORIZED";
    expect([notCatalog, profile]).toEqual(["NOT_AUTHORIZED", "NOT_AUTHORIZED"]);
  });

  it("no catalog in code holds a NOT_AUTHORIZED entry; the real platform catalog is r4 with its two SUPPORTED entries (P5-C9-C, P11-E)", () => {
    for (const catalog of [PLATFORM_CATALOG, SIMULATOR_CATALOG]) for (const entry of catalog.entries) expect(CATALOG_STATES).toContain(entry.state);
    expect([PLATFORM_CATALOG.revision, SIMULATOR_CATALOG.revision, PLATFORM_CATALOG.entries.length]).toEqual([4, 2, 2]);
    expect(PLATFORM_CATALOG.entries.map((entry) => entry.state)).toEqual(["SUPPORTED", "SUPPORTED"]);
  });

  it("state ↔ reason coherence: authorization reasons only on NOT_AUTHORIZED, non-support reasons only on UNSUPPORTED", () => {
    expect(PROFILE_STATE_REASONS).toEqual({
      SUPPORTED: ["CATALOG_SUPPORTED"],
      AVAILABLE_WITH_LIMITATION: ["CATALOG_LIMITATION"],
      UNSUPPORTED: ["CATALOG_UNSUPPORTED", "OBSERVED_NOT_ELIGIBLE"],
      NOT_AUTHORIZED: ["ACCOUNT_PERMISSION_MISSING", "OBSERVED_PERMISSION_MISSING"],
      UNKNOWN_NOT_VALIDATED: ["CATALOG_NOT_VALIDATED", "ACCOUNT_FACTS_UNAVAILABLE", "ACCOUNT_FACTS_INCONSISTENT"],
    });
    const each = Object.values(PROFILE_STATE_REASONS).flat();
    expect(new Set(each).size).toBe(each.length); // every reason belongs to exactly one state
    expect(isCoherentProfileShape(row("NOT_AUTHORIZED", ["ACCOUNT_PERMISSION_MISSING"]))).toBe(true);
    expect(isCoherentProfileShape(row("NOT_AUTHORIZED", ["OBSERVED_PERMISSION_MISSING"]))).toBe(true);
    expect(isCoherentProfileShape(row("UNSUPPORTED", ["CATALOG_UNSUPPORTED"]))).toBe(true);
    expect(isCoherentProfileShape(row("UNSUPPORTED", ["OBSERVED_NOT_ELIGIBLE"]))).toBe(true);
    for (const reason of ["ACCOUNT_PERMISSION_MISSING", "OBSERVED_PERMISSION_MISSING"] as const) expect(isCoherentProfileShape(row("UNSUPPORTED", [reason]))).toBe(false);
    for (const reason of ["CATALOG_UNSUPPORTED", "OBSERVED_NOT_ELIGIBLE"] as const) expect(isCoherentProfileShape(row("NOT_AUTHORIZED", [reason]))).toBe(false);
    expect(isCoherentProfileShape(row("NOT_AUTHORIZED", ["ACCOUNT_PERMISSION_MISSING"], { code: "HISTORY_DEPTH_LIMITED", value: 30 }))).toBe(false);
    expect(isCoherentProfileShape(row("NOT_AUTHORIZED", []))).toBe(false);
    expect(isCoherentProfileShape(row("AVAILABLE_WITH_LIMITATION", ["CATALOG_LIMITATION"]))).toBe(false); // limitation required
  });
});

describe("evaluator: only the authorization branches changed", () => {
  it("SUPPORTED + permission granted → SUPPORTED / CATALOG_SUPPORTED", () => {
    expect(evaluate(catalogOf(supported()))).toMatchObject({ state: "SUPPORTED", reasons: ["CATALOG_SUPPORTED"] });
  });

  it("SUPPORTED + required permission missing → NOT_AUTHORIZED / ACCOUNT_PERMISSION_MISSING (the positive evidence stays on the row)", () => {
    expect(evaluate(catalogOf(supported()), { facts: facts(["something_else"]) })).toMatchObject({
      state: "NOT_AUTHORIZED",
      reasons: ["ACCOUNT_PERMISSION_MISSING"],
      catalogValidation: "validated",
      evidence: "api-validation:meta.facebook.read_content.20261101-01",
      limitation: null,
    });
    // A limited capability without the permission is NOT_AUTHORIZED too — and carries no limitation.
    const limited = supported({ state: "AVAILABLE_WITH_LIMITATION", limitation: { code: "HISTORY_DEPTH_LIMITED", value: 30 } });
    expect(evaluate(catalogOf(limited), { facts: facts([]) })).toMatchObject({ state: "NOT_AUTHORIZED", reasons: ["ACCOUNT_PERMISSION_MISSING"], limitation: null });
  });

  it("a newer PermissionMissing observation → NOT_AUTHORIZED / OBSERVED_PERMISSION_MISSING; later facts supersede it", () => {
    const observation = { kind: "permission_missing", capability: "read_content", observedAt: later, ref: "obs-1" } as const;
    expect(evaluate(catalogOf(supported()), { observations: [observation] })).toMatchObject({ state: "NOT_AUTHORIZED", reasons: ["OBSERVED_PERMISSION_MISSING"], observationRefs: ["obs-1"] });
    const refreshed = evaluate(catalogOf(supported()), { observations: [observation], facts: facts(["synthetic_read_content"], { obtainedAt: new Date(later.getTime() + 1) }) });
    expect(refreshed).toMatchObject({ state: "SUPPORTED" });
  });

  it("validated catalog UNSUPPORTED → UNSUPPORTED / CATALOG_UNSUPPORTED (whatever the permissions)", () => {
    const unsupported = supported({ state: "UNSUPPORTED", requiredPermissions: [], evidence: "api-validation:meta.facebook.read_content.20261101-02" });
    expect(evaluate(catalogOf(unsupported))).toMatchObject({ state: "UNSUPPORTED", reasons: ["CATALOG_UNSUPPORTED"] });
    expect(evaluate(catalogOf(unsupported), { facts: facts([]) })).toMatchObject({ state: "UNSUPPORTED", reasons: ["CATALOG_UNSUPPORTED"] });
  });

  it("TargetNotEligible for the exact scope → UNSUPPORTED / OBSERVED_NOT_ELIGIBLE", () => {
    const profile = evaluateProfile({
      catalog: catalogOf(supported()),
      platform: "facebook",
      assetClass: "content_bearing",
      facts: facts(["synthetic_read_content"]),
      observations: [{ kind: "target_not_eligible", capability: "read_content", contentKind: "story", source: "paid", observedAt: later, ref: "obs-2" }],
      evaluatedAt: later,
    });
    expect(resolveEntry(profile.entries, "read_content", "story", "paid")).toMatchObject({ state: "UNSUPPORTED", reasons: ["OBSERVED_NOT_ELIGIBLE"] });
    expect(resolveEntry(profile.entries, "read_content", ANY, ANY)).toMatchObject({ state: "SUPPORTED" });
  });

  it("facts unavailable or inconsistent → UNKNOWN_NOT_VALIDATED (not an authorization verdict)", () => {
    expect(evaluate(catalogOf(supported()), { facts: { kind: "unavailable", observedAt: T0 } })).toMatchObject({ state: "UNKNOWN_NOT_VALIDATED", reasons: ["ACCOUNT_FACTS_UNAVAILABLE"] });
    expect(evaluate(catalogOf(supported()), { facts: facts(["synthetic_read_content"], { assetClass: "ad_account" }) })).toMatchObject({ state: "UNKNOWN_NOT_VALIDATED", reasons: ["ACCOUNT_FACTS_INCONSISTENT"] });
  });

  it("every row the evaluator produces is coherent (simulator catalog, every permission subset of interest)", () => {
    for (const granted of [[], ["sim.read_interactions"], ["sim.read_content", "sim.read_interactions", "sim.reply_public", "sim.reply_private", "sim.hide", "sim.delete", "sim.block"]]) {
      const profile = evaluateProfile({ catalog: SIMULATOR_CATALOG, platform: "instagram", assetClass: "content_bearing", facts: facts(granted), observations: [], evaluatedAt: later });
      for (const entry of profile.entries) expect(isCoherentProfileShape(entry), JSON.stringify(entry)).toBe(true);
    }
  });
});

describe("strict availability overlay", () => {
  it("NOT_AUTHORIZED → UNAVAILABLE / ACCOUNT_PERMISSION_MISSING / REAUTHORIZE for EVERY connection status: never AVAILABLE, TEMPORARILY_UNAVAILABLE or platform non-support", () => {
    for (const reason of ["ACCOUNT_PERMISSION_MISSING", "OBSERVED_PERMISSION_MISSING"] as const) {
      for (const connection of CONNECTION_STATUSES) {
        const shown = effectiveAvailability(row("NOT_AUTHORIZED", [reason]), connection, "read_content", T0);
        expect(shown, `${reason} ${connection}`).toMatchObject({ state: "UNAVAILABLE", reason: "ACCOUNT_PERMISSION_MISSING", recovery: "REAUTHORIZE", baseState: "NOT_AUTHORIZED", limitation: null });
        expect(shown.reason).not.toBe("CAPABILITY_UNSUPPORTED");
        expect(shown.recovery).not.toBe("OPEN_ON_PLATFORM");
      }
    }
  });

  it("UNSUPPORTED → UNAVAILABLE / CAPABILITY_UNSUPPORTED / OPEN_ON_PLATFORM for every connection status", () => {
    for (const reason of ["CATALOG_UNSUPPORTED", "OBSERVED_NOT_ELIGIBLE"] as const) {
      for (const connection of CONNECTION_STATUSES) {
        expect(effectiveAvailability(row("UNSUPPORTED", [reason]), connection, "read_content", T0)).toMatchObject({ state: "UNAVAILABLE", reason: "CAPABILITY_UNSUPPORTED", recovery: "OPEN_ON_PLATFORM" });
      }
    }
  });

  it("no legacy tolerance: an incoherent row (UNSUPPORTED + permission reason, NOT_AUTHORIZED + non-support reason) is never trusted", () => {
    for (const bad of [row("UNSUPPORTED", ["ACCOUNT_PERMISSION_MISSING"]), row("UNSUPPORTED", ["OBSERVED_PERMISSION_MISSING"]), row("NOT_AUTHORIZED", ["CATALOG_UNSUPPORTED"]), row("SUPPORTED", ["ACCOUNT_PERMISSION_MISSING"])]) {
      for (const connection of CONNECTION_STATUSES) {
        expect(effectiveAvailability(bad, connection, "read_content", T0), JSON.stringify(bad)).toMatchObject({ state: "UNAVAILABLE", reason: "CAPABILITY_NOT_VALIDATED", recovery: null });
      }
    }
  });

  it("an end-to-end NOT_AUTHORIZED row is presented as authorization, while SUPPORTED stays AVAILABLE", () => {
    const missing = evaluate(catalogOf(supported()), { facts: facts([]) });
    expect(effectiveAvailability(missing, "ACTIVE", "read_content", later)).toMatchObject({ state: "UNAVAILABLE", reason: "ACCOUNT_PERMISSION_MISSING", recovery: "REAUTHORIZE" });
    expect(effectiveAvailability(evaluate(catalogOf(supported())), "ACTIVE", "read_content", later)).toMatchObject({ state: "AVAILABLE", reason: "CAPABILITY_SUPPORTED" });
  });

  it("profileLacksAuthorization: true exactly when a row is NOT_AUTHORIZED", () => {
    expect(profileLacksAuthorization([{ state: "SUPPORTED" }, { state: "NOT_AUTHORIZED" }])).toBe(true);
    expect(profileLacksAuthorization([{ state: "SUPPORTED" }, { state: "UNSUPPORTED" }, { state: "UNKNOWN_NOT_VALIDATED" }])).toBe(false);
    expect(profileLacksAuthorization([])).toBe(false);
  });
});
