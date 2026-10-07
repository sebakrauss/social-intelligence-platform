/**
 * Step 5E capability, without a database: the code-versioned catalogs (real platforms UNKNOWN; the simulator
 * catalog explicit and local/test only), the pure evaluator (conservative, deterministic, no data-volume input), the
 * runtime overlay (health never rewrites platform truth), observation semantics and the stale-write ordering.
 */
import { describe, expect, it } from "vitest";
import { CONNECTION_STATUSES } from "@/domain/connections";
import { PLATFORM_KEYS } from "@/domain/platforms";
import {
  CONTENT_KINDS,
  CONTENT_SOURCES,
  ASSET_CLASSES,
  OutcomeUnknownError,
  PERMISSION_CAPABILITIES,
  PermanentRejectedError,
  PermissionMissingError,
  RateLimitedError,
  TargetNotEligibleError,
  TransientError,
} from "@/integrations/providers/contract";
import {
  ANY,
  CAPABILITY_ASSET_CLASSES,
  CAPABILITY_CONTENT_KINDS,
  CAPABILITY_KEYS,
  CAPABILITY_SOURCES,
  CapabilityCatalogError,
  PLATFORM_CATALOG,
  SIMULATOR_CATALOG,
  effectiveAvailability,
  evaluateProfile,
  inputDigest,
  lookupCatalog,
  observationFromError,
  resolveEntry,
  selectCatalog,
  compareFreshness,
  type AccountFacts,
  type CapabilityObservation,
  type EvaluationInput,
  type ProfileEntry,
} from "@/modules/capability";
import { codeOf } from "../../support/source-scan";

const T0 = new Date("2026-10-07T10:00:00.000Z");
const ALL_PERMISSIONS = ["sim.read_interactions", "sim.reply_public", "sim.reply_private", "sim.hide", "sim.delete", "sim.block", "sim.read_paid_context"];
const facts = (patch: Partial<AccountFacts> = {}): AccountFacts => ({
  kind: "available",
  assetClass: "content_bearing",
  grantedPermissions: ALL_PERMISSIONS,
  linkedAdAccountIds: [],
  accountIdentityKnown: true,
  obtainedAt: T0,
  ...patch,
});
const input = (patch: Partial<EvaluationInput> = {}): EvaluationInput => ({
  catalog: SIMULATOR_CATALOG,
  platform: "instagram",
  assetClass: "content_bearing",
  facts: facts(),
  observations: [],
  evaluatedAt: new Date(T0.getTime() + 60_000),
  ...patch,
});
const entry = (profile: ReturnType<typeof evaluateProfile>, capability: string, contentKind = ANY, source = ANY): ProfileEntry | undefined =>
  profile.entries.find((e) => e.capability === capability && e.contentKind === contentKind && e.source === source);

describe("vocabulary", () => {
  it("mirrors the provider contract's closed vocabularies exactly and reuses its normalized capability names", () => {
    expect([...CAPABILITY_CONTENT_KINDS]).toEqual([...CONTENT_KINDS]);
    expect([...CAPABILITY_SOURCES]).toEqual([...CONTENT_SOURCES]);
    expect([...CAPABILITY_ASSET_CLASSES]).toEqual([...ASSET_CLASSES]);
    const reused = CAPABILITY_KEYS.filter((key) => (PERMISSION_CAPABILITIES as readonly string[]).includes(key));
    expect(reused.sort()).toEqual(["block", "delete", "hide", "read_interactions", "read_paid_context", "reply_private", "reply_public"]);
    expect(CAPABILITY_KEYS.filter((key) => !reused.includes(key)).sort()).toEqual(["detect_native_replies", "read_history"]);
  });
});

describe("platform capability catalog", () => {
  it("carries a monotonic integer revision (the only ordering value) and a human label that is never compared", () => {
    expect([PLATFORM_CATALOG.id, PLATFORM_CATALOG.revision, SIMULATOR_CATALOG.id, SIMULATOR_CATALOG.revision]).toEqual(["platform", 1, "simulator", 1]);
    expect(Number.isInteger(PLATFORM_CATALOG.revision) && Number.isInteger(SIMULATOR_CATALOG.revision)).toBe(true);
    expect([PLATFORM_CATALOG.label, SIMULATOR_CATALOG.label]).toEqual(["platform-catalog-r1", "simulator-catalog-r1"]);
    for (const file of ["modules/capability/application/ports.ts", "modules/capability/persistence/store.ts"]) expect(codeOf(file)).not.toMatch(/\.label\b/);
    expect(Object.isFrozen(PLATFORM_CATALOG.entries) && Object.isFrozen(SIMULATOR_CATALOG.entries)).toBe(true);
  });

  it("resolves EVERY real-platform scope to UNKNOWN_NOT_VALIDATED (nothing has passed API validation)", () => {
    let checked = 0;
    for (const platform of PLATFORM_KEYS)
      for (const assetClass of CAPABILITY_ASSET_CLASSES)
        for (const capability of CAPABILITY_KEYS)
          for (const contentKind of [...CAPABILITY_CONTENT_KINDS, ANY] as const)
            for (const source of [...CAPABILITY_SOURCES, ANY] as const) {
              const result = lookupCatalog(PLATFORM_CATALOG, { platform, assetClass, capability, contentKind, source });
              expect(result).toMatchObject({ state: "UNKNOWN_NOT_VALIDATED", validation: "not_validated", evidence: null, limitation: null });
              checked += 1;
            }
    expect(checked).toBe(3 * 2 * 9 * 8 * 5);
  });

  it("guard: a real-platform entry may exist only as a validated, api-validation-evidenced fact — never a simulator one", () => {
    for (const e of PLATFORM_CATALOG.entries) {
      expect(e.validation).toBe("validated");
      expect(e.evidence).toMatch(/^api-validation:/);
    }
    expect(PLATFORM_CATALOG.entries).toHaveLength(0);
    for (const e of SIMULATOR_CATALOG.entries) {
      expect(e.evidence).toBe("simulator:contract-v1");
      expect(e.platform).toBe(ANY);
    }
  });

  it("a capability the catalog doesn't mention resolves UNKNOWN, never supported (simulator: detect_native_replies)", () => {
    for (const assetClass of CAPABILITY_ASSET_CLASSES) {
      expect(lookupCatalog(SIMULATOR_CATALOG, { platform: "facebook", assetClass, capability: "detect_native_replies", contentKind: ANY, source: ANY }).state).toBe("UNKNOWN_NOT_VALIDATED");
    }
    expect(lookupCatalog(SIMULATOR_CATALOG, { platform: "facebook", assetClass: "ad_account", capability: "hide", contentKind: ANY, source: ANY }).state).toBe("UNKNOWN_NOT_VALIDATED");
  });

  it("the simulator catalog is selected only for the simulator provider, and only in development/test", () => {
    expect(selectCatalog("simulator", { NODE_ENV: "test" })).toBe(SIMULATOR_CATALOG);
    expect(selectCatalog("simulator", { NODE_ENV: "development" })).toBe(SIMULATOR_CATALOG);
    for (const env of [{ NODE_ENV: "production" }, {}, { NODE_ENV: "staging" }]) expect(() => selectCatalog("simulator", env)).toThrow(CapabilityCatalogError);
    expect(selectCatalog("meta", { NODE_ENV: "test" })).toBe(PLATFORM_CATALOG);
    expect(selectCatalog("tiktok", { NODE_ENV: "development" })).toBe(PLATFORM_CATALOG);
  });
});

describe("account capability evaluator (pure, conservative)", () => {
  it("SUPPORTED, AVAILABLE_WITH_LIMITATION (limitation kept), UNSUPPORTED and UNKNOWN from the simulator catalog", () => {
    const profile = evaluateProfile(input());
    expect(entry(profile, "read_interactions")).toMatchObject({ state: "SUPPORTED", reasons: ["CATALOG_SUPPORTED"], catalogValidation: "validated", evidence: "simulator:contract-v1" });
    expect(entry(profile, "hide")).toMatchObject({ state: "AVAILABLE_WITH_LIMITATION", limitation: { code: "HIDE_VISIBLE_TO_AUTHOR", value: null } });
    expect(entry(profile, "read_history")?.limitation).toEqual({ code: "HISTORY_DEPTH_LIMITED", value: 90 });
    expect(entry(profile, "reply_public", "story")).toMatchObject({ state: "UNSUPPORTED", reasons: ["CATALOG_UNSUPPORTED"] });
    expect(entry(profile, "reply_private", ANY, "paid")).toMatchObject({ state: "UNSUPPORTED" });
    expect(entry(profile, "detect_native_replies")).toMatchObject({ state: "UNKNOWN_NOT_VALIDATED", reasons: ["CATALOG_NOT_VALIDATED"], catalogValidation: "not_validated" });
  });

  it("missing or inconsistent facts never upgrade; a permission the account lacks makes it UNSUPPORTED", () => {
    const noFacts = evaluateProfile(input({ facts: { kind: "unavailable", observedAt: T0 } }));
    for (const e of noFacts.entries) expect(["UNKNOWN_NOT_VALIDATED", "UNSUPPORTED"]).toContain(e.state);
    expect(entry(noFacts, "read_interactions")?.reasons).toEqual(["ACCOUNT_FACTS_UNAVAILABLE"]);
    expect(entry(evaluateProfile(input({ facts: facts({ assetClass: "ad_account" }) })), "read_interactions")?.reasons).toEqual(["ACCOUNT_FACTS_INCONSISTENT"]);
    const limited = evaluateProfile(input({ facts: facts({ grantedPermissions: ["sim.read_account", "sim.read_content"] }) }));
    expect(entry(limited, "read_interactions")).toMatchObject({ state: "UNSUPPORTED", reasons: ["ACCOUNT_PERMISSION_MISSING"] });
  });

  it("the real-platform catalog stays UNKNOWN even with every permission granted (facts never upgrade a catalog)", () => {
    const profile = evaluateProfile(input({ catalog: PLATFORM_CATALOG, facts: facts({ grantedPermissions: ["pages_manage_engagement", ...ALL_PERMISSIONS] }) }));
    expect(profile.entries.every((e) => e.state === "UNKNOWN_NOT_VALIDATED")).toBe(true);
    expect(profile.entries).toHaveLength(CAPABILITY_KEYS.length);
  });

  it("explicit observations: PermissionMissing (newer than the facts) and TargetNotEligible for its exact scope only", () => {
    const later = new Date(T0.getTime() + 30_000);
    const observations: CapabilityObservation[] = [
      { kind: "permission_missing", capability: "delete", observedAt: later, ref: "obs-1" },
      { kind: "target_not_eligible", capability: "reply_public", contentKind: "reel", source: "paid", observedAt: later, ref: "obs-2" },
    ];
    const profile = evaluateProfile(input({ observations }));
    expect(entry(profile, "delete")).toMatchObject({ state: "UNSUPPORTED", reasons: ["OBSERVED_PERMISSION_MISSING"], observationRefs: ["obs-1"] });
    expect(entry(profile, "reply_public", "reel", "paid")).toMatchObject({ state: "UNSUPPORTED", reasons: ["OBSERVED_NOT_ELIGIBLE"], observationRefs: ["obs-2"] });
    expect(entry(profile, "reply_public")).toMatchObject({ state: "SUPPORTED" });
    // Facts described AFTER the observation (e.g. re-authorization) supersede it.
    const refreshed = evaluateProfile(input({ observations, facts: facts({ obtainedAt: new Date(later.getTime() + 1) }) }));
    expect(entry(refreshed, "delete")?.state).toBe("SUPPORTED");
    // An observation can never upgrade: UNKNOWN stays UNKNOWN whatever is observed.
    expect(entry(evaluateProfile(input({ observations: [{ kind: "permission_missing", capability: "detect_native_replies", observedAt: later, ref: "x" }] })), "detect_native_replies")?.state).toBe("UNKNOWN_NOT_VALIDATED");
  });

  it("only semantically relevant provider errors become observations; transient/rate-limit/timeout never do", () => {
    const target = { capability: "hide" as const, contentKind: "post" as const, source: "organic" as const };
    expect(observationFromError(new PermissionMissingError("hide", "hide"), target, T0, "r1")).toEqual({ kind: "permission_missing", capability: "hide", observedAt: T0, ref: "r1" });
    expect(observationFromError(new PermissionMissingError("hide", "read_content"), target, T0, "r1")).toBeUndefined();
    expect(observationFromError(new TargetNotEligibleError("hide", "unsupported_for_target"), target, T0, "r2")).toMatchObject({ kind: "target_not_eligible", contentKind: "post", source: "organic" });
    for (const error of [
      new TargetNotEligibleError("hide", "target_state"),
      new TransientError("hide", "network"),
      new RateLimitedError("hide", 30),
      new OutcomeUnknownError("hide"),
      new PermanentRejectedError("hide", "invalid_request"),
      new Error("timeout"),
    ]) {
      expect(observationFromError(error, target, T0, "r")).toBeUndefined();
    }
  });

  it("is deterministic and reproducible from its recorded inputs (no clock, no data volume)", () => {
    expect(JSON.stringify(evaluateProfile(input()))).toBe(JSON.stringify(evaluateProfile(input())));
    expect(inputDigest(input())).toBe(inputDigest({ ...input(), observations: [] }));
    expect(inputDigest(input())).not.toBe(inputDigest(input({ facts: facts({ grantedPermissions: ["sim.hide"] }) })));
    const evaluator = codeOf("modules/capability/domain/profile.ts");
    expect(evaluator).not.toMatch(/Date\.now|new Date\(\)|\bcounts?\b|\bvolume\b|interactions\.length/);
  });
});

describe("runtime overlay (connection health never rewrites the profile)", () => {
  const profile = evaluateProfile(input());
  const row = (capability: string, kind = ANY, source = ANY) => resolveEntry(profile.entries, capability as never, kind as never, source as never);

  it("healthy: SUPPORTED → AVAILABLE, limitation → AVAILABLE_WITH_LIMITATION; UNKNOWN and UNSUPPORTED stay unavailable", () => {
    expect(effectiveAvailability(row("read_interactions"), "ACTIVE", "read_interactions", T0)).toMatchObject({ state: "AVAILABLE", reason: "CAPABILITY_SUPPORTED" });
    expect(effectiveAvailability(row("hide"), "ACTIVE", "hide", T0)).toMatchObject({ state: "AVAILABLE_WITH_LIMITATION", limitation: { code: "HIDE_VISIBLE_TO_AUTHOR" } });
    expect(effectiveAvailability(row("detect_native_replies"), "ACTIVE", "detect_native_replies", T0)).toMatchObject({ state: "UNAVAILABLE", reason: "CAPABILITY_NOT_VALIDATED" });
    expect(effectiveAvailability(row("reply_public", "story"), "ACTIVE", "reply_public", T0)).toMatchObject({ state: "UNAVAILABLE", reason: "CAPABILITY_UNSUPPORTED", recovery: "OPEN_ON_PLATFORM" });
    expect(effectiveAvailability(undefined, "ACTIVE", "hide", null)).toMatchObject({ state: "UNAVAILABLE", reason: "PROFILE_NOT_EVALUATED" });
  });

  it("unhealthy connection: a normally usable capability is TEMPORARILY_UNAVAILABLE with recovery; platform truth keeps precedence", () => {
    for (const [status, reason] of [["DEGRADED", "CONNECTION_DEGRADED"], ["DISCONNECTED", "CONNECTION_DISCONNECTED"], ["FAILED", "CONNECTION_FAILED"], ["CONNECTING", "CONNECTION_VALIDATING"]] as const) {
      expect(effectiveAvailability(row("read_interactions"), status, "read_interactions", T0)).toMatchObject({ state: "TEMPORARILY_UNAVAILABLE", reason, baseState: "SUPPORTED" });
      expect(effectiveAvailability(row("detect_native_replies"), status, "detect_native_replies", T0)).toMatchObject({ state: "UNAVAILABLE", reason: "CAPABILITY_NOT_VALIDATED" });
      expect(effectiveAvailability(row("reply_public", "story"), status, "reply_public", T0)).toMatchObject({ state: "UNAVAILABLE", reason: "CAPABILITY_UNSUPPORTED" });
    }
    expect(effectiveAvailability(row("read_interactions"), "REMOVED", "read_interactions", T0)).toMatchObject({ state: "UNAVAILABLE", reason: "CONNECTION_REMOVED" });
    // Recovery: the same base row with a healthy connection is available again; nothing was rewritten.
    expect(effectiveAvailability(row("read_interactions"), "ACTIVE", "read_interactions", T0).state).toBe("AVAILABLE");
    expect(CONNECTION_STATUSES).toEqual(["CONNECTING", "ACTIVE", "DEGRADED", "FAILED", "DISCONNECTED", "REMOVED"]);
  });

  it("a permission-based UNSUPPORTED recovers by re-authorization; target rows resolve most-specific first", () => {
    const limited = evaluateProfile(input({ facts: facts({ grantedPermissions: [] }) }));
    expect(effectiveAvailability(resolveEntry(limited.entries, "hide", ANY, ANY), "ACTIVE", "hide", T0)).toMatchObject({ reason: "ACCOUNT_PERMISSION_MISSING", recovery: "REAUTHORIZE" });
    expect(resolveEntry(profile.entries, "reply_public", "story", "organic")?.state).toBe("UNSUPPORTED");
    expect(resolveEntry(profile.entries, "reply_public", "post", "organic")?.state).toBe("SUPPORTED");
    expect(resolveEntry(profile.entries, "reply_private", "post", "organic")?.state).toBe("SUPPORTED");
    expect(resolveEntry(profile.entries, "reply_private", "post", "mixed")?.state).toBe("UNKNOWN_NOT_VALIDATED");
  });
});

describe("semantic freshness (no hash ordering)", () => {
  const at = (ms: number) => new Date(T0.getTime() + ms);
  const f = (catalogRevision: number, ms: number, digest: string) => ({ catalogRevision, inputsAsOf: at(ms), inputDigest: digest });
  const A = "a".repeat(64);
  const F = "f".repeat(64);

  it("a higher catalog revision wins; a lower revision never overwrites a higher one, however late or new its inputs", () => {
    expect(compareFreshness(f(2, 0, A), f(1, 0, A))).toBe("newer");
    expect(compareFreshness(f(1, 999_999, F), f(2, 0, A))).toBe("stale");
    expect(compareFreshness(f(10, 0, A), f(2, 0, A))).toBe("newer"); // 10 > 2 numerically ("v10" < "v2" lexically)
  });

  it("within a revision, newer inputs_as_of wins and older inputs are stale", () => {
    expect(compareFreshness(f(1, 10, A), f(1, 5, F))).toBe("newer");
    expect(compareFreshness(f(1, 5, F), f(1, 10, A))).toBe("stale");
  });

  it("same revision and same inputs_as_of: same digest is the same evaluation; a different digest is a CONFLICT", () => {
    expect(compareFreshness(f(1, 0, A), f(1, 0, A))).toBe("same");
    expect(compareFreshness(f(1, 0, A), f(1, 0, F))).toBe("conflict");
    expect(compareFreshness(f(1, 0, F), f(1, 0, A))).toBe("conflict");
  });

  it("hash values have zero effect on freshness: swapping digests never changes a verdict between distinct contents", () => {
    for (const [next, stored] of [[f(2, 0, A), f(1, 0, F)], [f(1, 10, A), f(1, 5, F)], [f(1, 5, A), f(1, 10, F)], [f(1, 0, A), f(1, 0, F)]] as const) {
      const swapped = compareFreshness({ ...next, inputDigest: stored.inputDigest }, { ...stored, inputDigest: next.inputDigest });
      expect(swapped).toBe(compareFreshness(next, stored));
    }
  });

  it("identical content re-verified on newer inputs is bookkeeping (same_content_newer), never a semantic change", () => {
    expect(compareFreshness(f(1, 10, A), f(1, 5, A))).toBe("same_content_newer");
    expect(compareFreshness(f(1, 5, A), f(1, 10, A))).toBe("stale");
  });

  it("inputs_as_of is the newest input used — facts (or their dated absence) and observations — never the evaluation time", () => {
    expect(evaluateProfile(input()).inputsAsOf).toEqual(T0);
    expect(evaluateProfile(input({ evaluatedAt: at(9_999_999) })).inputsAsOf).toEqual(T0);
    expect(evaluateProfile(input({ facts: { kind: "unavailable", observedAt: at(42) } })).inputsAsOf).toEqual(at(42));
    const observed: CapabilityObservation = { kind: "permission_missing", capability: "hide", observedAt: at(77), ref: "o" };
    expect(evaluateProfile(input({ observations: [observed] })).inputsAsOf).toEqual(at(77));
  });
});
