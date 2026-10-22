/**
 * Step 7G-H5.5-P4-B — the PLATFORM catalog entry contract (modules/capability/domain/catalog-contract.ts), fixtures
 * only: no database, no network, no real catalog entry. A fully evidenced synthetic entry proves the contract is
 * satisfiable; every single defect then fails closed with its own violation. The authorization semantics are RESOLVED
 * (Step 7G-H5.5-P4-C: NOT_AUTHORIZED is profile-only), yet with no accepted record and no registered implementation
 * evidence no real platform entry is admissible. The LIVE-shaped facts observed in P3
 * (Facebook Page and Instagram professional account, five granted permissions) evaluate to ten UNKNOWN rows each.
 */
import { describe, expect, it } from "vitest";
import {
  ANY,
  CAPABILITY_KEYS,
  PLATFORM_CATALOG,
  SIMULATOR_CATALOG,
  effectiveAvailability,
  evaluateProfile,
  resolveEntry,
  selectCatalog,
  type AccountFacts,
  type CapabilityCatalog,
  type CatalogEntry,
} from "@/modules/capability";
import {
  AUTHORIZATION_SEMANTICS,
  FIRST_VALIDATED_PLATFORM_ENTRY_BLOCKED_UNTIL_AUTHORIZATION_SEMANTICS_RESOLVED,
  IMPLEMENTED_PLATFORM_OPERATIONS,
  apiValidationRecordViolations,
  platformCatalogViolations,
  platformEntryViolations,
  type ApiValidationRecord,
  type CatalogContractContext,
  type ImplementedOperation,
} from "@/modules/capability/domain/catalog-contract";

const EVIDENCE = "api-validation:meta.facebook.read_interactions.20261101-01";
const RECORD: ApiValidationRecord = Object.freeze({
  id: EVIDENCE,
  provider: "meta",
  platform: "facebook",
  assetClass: "content_bearing",
  accountKind: "facebook_page",
  capability: "read_interactions",
  contentKind: ANY,
  source: ANY,
  operation: "listInteractions",
  validatedOn: "2026-11-01",
  sourceRevision: "a".repeat(40),
  requiredPermissions: Object.freeze(["synthetic_read_comments"]),
  scenario: "Synthetic fixture scenario: one controlled read of a test asset.",
  observedResult: "Synthetic fixture result: the read returned the documented shape.",
  polarity: "positive",
  negativeBasis: null,
  reviewer: "TL",
  status: "accepted",
});
const ENTRY: CatalogEntry = Object.freeze({
  platform: "facebook",
  assetClass: "content_bearing",
  capability: "read_interactions",
  contentKind: ANY,
  source: ANY,
  state: "SUPPORTED",
  limitation: null,
  requiredPermissions: Object.freeze(["synthetic_read_comments"]),
  validation: "validated",
  evidence: EVIDENCE,
});
const IMPLEMENTED: ImplementedOperation = Object.freeze({ provider: "meta", platform: "facebook", capability: "read_interactions", operation: "listInteractions", evidence: EVIDENCE });
/** A hypothetical future in which the semantics are resolved and the operation is registered: proves satisfiability. */
const RESOLVED: CatalogContractContext = { records: [RECORD], implementedOperations: [IMPLEMENTED], authorizationSemantics: "RESOLVED" };
const TODAY: CatalogContractContext = { records: [], implementedOperations: IMPLEMENTED_PLATFORM_OPERATIONS, authorizationSemantics: AUTHORIZATION_SEMANTICS };

const violations = (entry: Partial<CatalogEntry>, context: Partial<CatalogContractContext> = {}) => platformEntryViolations({ ...ENTRY, ...entry }, { ...RESOLVED, ...context });

describe("P4-B freeze: the platform catalog stays r2 with zero entries; no entry is admissible yet", () => {
  it("platform r2, label platform-catalog-r2, entries [] (frozen) — and the whole catalog is admissible under today's context", () => {
    expect([PLATFORM_CATALOG.id, PLATFORM_CATALOG.revision, PLATFORM_CATALOG.label, PLATFORM_CATALOG.entries.length]).toEqual(["platform", 2, "platform-catalog-r2", 0]);
    expect(Object.isFrozen(PLATFORM_CATALOG) && Object.isFrozen(PLATFORM_CATALOG.entries)).toBe(true);
    expect(platformCatalogViolations(PLATFORM_CATALOG, TODAY)).toEqual([]);
  });

  it("authorization semantics are RESOLVED (P4-C): the blanket blocker is lifted, but today's context still admits no entry", () => {
    expect(FIRST_VALIDATED_PLATFORM_ENTRY_BLOCKED_UNTIL_AUTHORIZATION_SEMANTICS_RESOLVED).toBe(false);
    expect(AUTHORIZATION_SEMANTICS).toBe("RESOLVED");
    // The OPEN guard itself still works (a hypothetical context).
    expect(violations({}, { authorizationSemantics: "OPEN" })).toEqual(["AUTHORIZATION_SEMANTICS_OPEN"]);
    // Today: no accepted record and no implementation evidence → every state is still refused, for those reasons.
    for (const state of ["SUPPORTED", "AVAILABLE_WITH_LIMITATION", "UNSUPPORTED"] as const) {
      const today = platformEntryViolations({ ...ENTRY, state, limitation: state === "AVAILABLE_WITH_LIMITATION" ? { code: "HISTORY_DEPTH_LIMITED", value: 30 } : null }, TODAY);
      expect(today).not.toContain("AUTHORIZATION_SEMANTICS_OPEN");
      expect(today).toContain("EVIDENCE_RECORD_MISSING");
    }
  });

  it("NOT_AUTHORIZED is never a catalog verdict: the type refuses it, and a cast that smuggles it in is refused at runtime", () => {
    // @ts-expect-error — CatalogEntry.state is a CatalogState: NOT_AUTHORIZED is a profile-only state.
    const smuggled: CatalogEntry = { ...ENTRY, state: "NOT_AUTHORIZED" };
    expect(platformEntryViolations(smuggled, RESOLVED)).toContain("NOT_A_CATALOG_STATE");
    expect(violations({})).not.toContain("NOT_A_CATALOG_STATE");
  });

  it("no implementation evidence is registered today: every positive entry of every capability fails G2", () => {
    expect(IMPLEMENTED_PLATFORM_OPERATIONS).toEqual([]);
    for (const capability of CAPABILITY_KEYS)
      for (const platform of ["facebook", "instagram", "tiktok"] as const) {
        expect(platformEntryViolations({ ...ENTRY, platform, capability }, { ...TODAY, records: [RECORD] })).toContain("IMPLEMENTATION_EVIDENCE_MISSING");
      }
  });
});

describe("positive entries (SUPPORTED / AVAILABLE_WITH_LIMITATION) fail closed", () => {
  it("is satisfiable: an exactly evidenced, permissioned, implemented entry has no violation once semantics are resolved", () => {
    expect(apiValidationRecordViolations(RECORD)).toEqual([]);
    expect(violations({})).toEqual([]);
    expect(violations({ state: "AVAILABLE_WITH_LIMITATION", limitation: { code: "HISTORY_DEPTH_LIMITED", value: 30 } })).toEqual([]);
  });

  it("G1: an empty requiredPermissions set fails for SUPPORTED and for AVAILABLE_WITH_LIMITATION", () => {
    expect(violations({ requiredPermissions: [] })).toContain("REQUIRED_PERMISSIONS_EMPTY");
    expect(violations({ state: "AVAILABLE_WITH_LIMITATION", limitation: { code: "HIDE_VISIBLE_TO_AUTHOR", value: null }, requiredPermissions: [] })).toContain("REQUIRED_PERMISSIONS_EMPTY");
  });

  it("every required permission must be explicitly named, distinct and equal to the record's (never the simulator's)", () => {
    for (const bad of [[""], ["Read Comments"], ["sim.read_interactions"], ["synthetic_read_comments", "synthetic_read_comments"]]) {
      expect(violations({ requiredPermissions: bad })).toContain("REQUIRED_PERMISSION_UNNAMED");
    }
    expect(violations({ requiredPermissions: ["synthetic_other"] })).toContain("EVIDENCE_PERMISSIONS_MISMATCH");
  });

  it("validation must be 'validated' and the evidence an accepted api-validation record of the exact scope", () => {
    expect(violations({ validation: "not_validated" })).toContain("NOT_VALIDATED");
    for (const evidence of [null, "simulator:contract-v1", "api-validation:", "api-validation:meta.facebook.read_interactions"]) {
      expect(violations({ evidence })).toContain("EVIDENCE_NOT_API_VALIDATION");
    }
    expect(violations({}, { records: [] })).toContain("EVIDENCE_RECORD_MISSING");
    expect(violations({}, { records: [{ ...RECORD, status: "draft" }] })).toContain("EVIDENCE_RECORD_NOT_ACCEPTED");
    expect(violations({}, { records: [{ ...RECORD, status: "rejected" }] })).toContain("EVIDENCE_RECORD_NOT_ACCEPTED");
    expect(violations({ contentKind: "post" })).toContain("EVIDENCE_SCOPE_MISMATCH");
    expect(violations({ source: "paid" })).toContain("EVIDENCE_SCOPE_MISMATCH");
    expect(violations({ assetClass: "ad_account" })).toContain("EVIDENCE_SCOPE_MISMATCH");
    expect(violations({}, { records: [{ ...RECORD, polarity: "authoritative_negative", negativeBasis: "provider_documentation" }] })).toContain("EVIDENCE_POLARITY_MISMATCH");
    expect(violations({}, { records: [{ ...RECORD, sourceRevision: "not-a-commit" }] })).toContain("EVIDENCE_RECORD_INVALID");
  });

  it("G2: without implementation evidence, or with mismatched or infrastructure evidence, the entry fails", () => {
    expect(violations({}, { implementedOperations: [] })).toContain("IMPLEMENTATION_EVIDENCE_MISSING");
    expect(violations({}, { implementedOperations: [{ ...IMPLEMENTED, platform: "instagram" }] })).toContain("IMPLEMENTATION_EVIDENCE_MISSING");
    expect(violations({}, { implementedOperations: [{ ...IMPLEMENTED, operation: "getInteraction" }] })).toContain("IMPLEMENTATION_EVIDENCE_MISMATCH");
    expect(violations({}, { implementedOperations: [{ ...IMPLEMENTED, evidence: "api-validation:meta.facebook.read_interactions.20261102-01" }] })).toContain("IMPLEMENTATION_EVIDENCE_MISMATCH");
    // describeAccount (P3's live-validated read) is account infrastructure: never evidence for any capability.
    const infra = { ...RECORD, operation: "describeAccount" };
    expect(violations({}, { records: [infra], implementedOperations: [{ ...IMPLEMENTED, operation: "describeAccount" }] })).toContain("INFRASTRUCTURE_OPERATION_IS_NOT_EVIDENCE");
  });

  it("a wildcard platform, an UNKNOWN entry, a limitation mismatch and a duplicate scope all fail", () => {
    expect(violations({ platform: ANY })).toEqual(expect.arrayContaining(["PLATFORM_NOT_NAMED", "IMPLEMENTATION_EVIDENCE_MISSING"]));
    expect(violations({ state: "UNKNOWN_NOT_VALIDATED" })).toContain("UNKNOWN_IS_THE_DEFAULT");
    expect(violations({ state: "AVAILABLE_WITH_LIMITATION", limitation: null })).toContain("LIMITATION_INCONSISTENT");
    expect(violations({ limitation: { code: "HISTORY_DEPTH_LIMITED", value: 30 } })).toContain("LIMITATION_INCONSISTENT");
    const doubled: CapabilityCatalog = { id: "platform", revision: 2, label: "x", entries: [ENTRY, ENTRY] };
    expect(platformCatalogViolations(doubled, RESOLVED)).toEqual([{ index: 1, violations: ["DUPLICATE_SCOPE"] }]);
  });
});

describe("UNSUPPORTED entries need authoritative negative evidence", () => {
  const NEGATIVE: ApiValidationRecord = { ...RECORD, id: "api-validation:meta.facebook.read_interactions.20261101-02", requiredPermissions: [], polarity: "authoritative_negative", negativeBasis: "provider_documentation" };
  const unsupported = (patch: Partial<CatalogEntry> = {}, context: Partial<CatalogContractContext> = {}) =>
    platformEntryViolations({ ...ENTRY, state: "UNSUPPORTED", requiredPermissions: [], evidence: NEGATIVE.id, ...patch }, { ...RESOLVED, records: [NEGATIVE], ...context });

  it("is admissible only with an accepted authoritative-negative record (once semantics are resolved)", () => {
    expect(apiValidationRecordViolations(NEGATIVE)).toEqual([]);
    expect(unsupported()).toEqual([]);
    expect(unsupported({}, { authorizationSemantics: "OPEN" })).toEqual(["AUTHORIZATION_SEMANTICS_OPEN"]);
  });

  it("never from absence: no evidence, a positive record, a missing negative basis, a named permission or no record at all", () => {
    expect(unsupported({ evidence: null })).toContain("EVIDENCE_NOT_API_VALIDATION");
    expect(unsupported({ validation: "not_validated" })).toContain("NOT_VALIDATED");
    expect(unsupported({}, { records: [] })).toContain("EVIDENCE_RECORD_MISSING");
    expect(unsupported({ evidence: RECORD.id }, { records: [RECORD] })).toContain("EVIDENCE_POLARITY_MISMATCH");
    // "Unsupported because a permission is absent" is the forbidden shape: a negative entry names no permission.
    expect(unsupported({ requiredPermissions: ["synthetic_read_comments"] })).toContain("UNSUPPORTED_NAMES_PERMISSIONS");
    expect(apiValidationRecordViolations({ ...NEGATIVE, negativeBasis: null })).toContain("POLARITY_BASIS_INCONSISTENT");
    for (const basis of ["permission_absent", "operation_not_implemented", "facts_unavailable", "provider_read_failed", "catalog_has_no_rule"]) {
      expect(apiValidationRecordViolations({ ...NEGATIVE, negativeBasis: basis as never })).toContain("POLARITY_BASIS_INCONSISTENT");
    }
  });
});

describe("evidence records carry no identifying or secret material", () => {
  it("ids, dates, revisions, permissions and free text are validated; long digit runs and links are refused", () => {
    expect(apiValidationRecordViolations({ ...RECORD, id: "api-validation:meta.facebook.read_interactions.20261102-01" })).toContain("ID_FIELD_MISMATCH");
    expect(apiValidationRecordViolations({ ...RECORD, platform: "tiktok", id: "api-validation:meta.tiktok.read_interactions.20261101-01" })).toContain("PROVIDER_PLATFORM_MISMATCH");
    expect(apiValidationRecordViolations({ ...RECORD, validatedOn: "2026-13-01" })).toContain("DATE_MALFORMED");
    expect(apiValidationRecordViolations({ ...RECORD, requiredPermissions: ["b_scope", "a_scope"] })).toContain("PERMISSIONS_NOT_NAMED");
    expect(apiValidationRecordViolations({ ...RECORD, scenario: "Page 123456789012345 replied" })).toContain("TEXT_SUSPECTED_IDENTIFIER");
    expect(apiValidationRecordViolations({ ...RECORD, observedResult: "see https://graph.example/x" })).toContain("TEXT_SUSPECTED_IDENTIFIER");
    expect(apiValidationRecordViolations({ ...RECORD, reviewer: "" })).toContain("TEXT_MISSING_OR_OVERSIZED");
  });
});

describe("G3 — LIVE-shaped P3 facts produce no SUPPORTED and no UNSUPPORTED (fixtures only)", () => {
  const LIVE_GRANTED = ["business_management", "instagram_basic", "pages_read_engagement", "pages_show_list", "public_profile"];
  const liveFacts: AccountFacts = { kind: "available", assetClass: "content_bearing", grantedPermissions: LIVE_GRANTED, linkedAdAccountIds: [], accountIdentityKnown: true, obtainedAt: new Date("2026-10-22T12:47:03.097Z") };

  for (const platform of ["facebook", "instagram"] as const) {
    it(`${platform}: 10 × UNKNOWN_NOT_VALIDATED / CATALOG_NOT_VALIDATED on platform r2 (scope any/any)`, () => {
      const profile = evaluateProfile({ catalog: selectCatalog("meta", { NODE_ENV: "production" }), platform, assetClass: "content_bearing", facts: liveFacts, observations: [], evaluatedAt: new Date("2026-10-22T12:47:03.440Z") });
      expect([profile.catalogId, profile.catalogRevision]).toEqual(["platform", 2]);
      expect(profile.entries).toHaveLength(10);
      expect(profile.entries.map((e) => e.capability).sort()).toEqual([...CAPABILITY_KEYS].sort());
      expect(profile.entries.filter((e) => e.state === "SUPPORTED" || e.state === "AVAILABLE_WITH_LIMITATION")).toHaveLength(0);
      expect(profile.entries.filter((e) => e.state === "UNSUPPORTED")).toHaveLength(0);
      for (const e of profile.entries) expect(e).toMatchObject({ state: "UNKNOWN_NOT_VALIDATED", reasons: ["CATALOG_NOT_VALIDATED"], contentKind: ANY, source: ANY, catalogValidation: "not_validated", evidence: null });
    });
  }

  it("why the contract matters: one empty-permission SUPPORTED platform entry WOULD make both LIVE accounts SUPPORTED — the contract refuses it", () => {
    const unsafe: CatalogEntry = { ...ENTRY, platform: "facebook", requiredPermissions: [], evidence: null, validation: "validated" };
    const hypothetical: CapabilityCatalog = { id: "platform", revision: 2, label: "hypothetical", entries: [unsafe] };
    const profile = evaluateProfile({ catalog: hypothetical, platform: "facebook", assetClass: "content_bearing", facts: liveFacts, observations: [], evaluatedAt: new Date() });
    expect(profile.entries.find((e) => e.capability === "read_interactions")?.state).toBe("SUPPORTED");
    expect(platformCatalogViolations(hypothetical, TODAY)[0]?.violations).toEqual(expect.arrayContaining(["EVIDENCE_NOT_API_VALIDATION", "REQUIRED_PERMISSIONS_EMPTY", "IMPLEMENTATION_EVIDENCE_MISSING"]));
  });
});

describe("authorization semantics guardrail: a missing permission is never presented as platform non-support", () => {
  // A synthetic validated-looking catalog: the evaluator's authorization branches (Step 7G-H5.5-P4-C).
  const permissioned: CapabilityCatalog = { id: "platform", revision: 2, label: "hypothetical", entries: [ENTRY] };
  const factsWith = (granted: readonly string[]): AccountFacts => ({ kind: "available", assetClass: "content_bearing", grantedPermissions: granted, linkedAdAccountIds: [], accountIdentityKnown: true, obtainedAt: new Date("2026-10-22T12:00:00Z") });

  it("a missing permission is stored as NOT_AUTHORIZED / ACCOUNT_PERMISSION_MISSING and presented as ACCOUNT_PERMISSION_MISSING + REAUTHORIZE, never CAPABILITY_UNSUPPORTED / OPEN_ON_PLATFORM", () => {
    const profile = evaluateProfile({ catalog: permissioned, platform: "facebook", assetClass: "content_bearing", facts: factsWith(["pages_show_list"]), observations: [], evaluatedAt: new Date("2026-10-22T12:01:00Z") });
    const row = resolveEntry(profile.entries, "read_interactions", ANY, ANY);
    expect(row).toMatchObject({ state: "NOT_AUTHORIZED", reasons: ["ACCOUNT_PERMISSION_MISSING"], evidence: ENTRY.evidence });
    const shown = effectiveAvailability(row, "ACTIVE", "read_interactions", profile.evaluatedAt);
    expect(shown).toMatchObject({ state: "UNAVAILABLE", reason: "ACCOUNT_PERMISSION_MISSING", recovery: "REAUTHORIZE" });
    expect([shown.reason, shown.recovery]).not.toContain("CAPABILITY_UNSUPPORTED");
    expect([shown.reason, shown.recovery]).not.toContain("OPEN_ON_PLATFORM");
  });

  it("an observed PermissionMissing is presented the same way (authorization, not platform)", () => {
    const later = new Date("2026-10-22T12:05:00Z");
    const profile = evaluateProfile({ catalog: permissioned, platform: "facebook", assetClass: "content_bearing", facts: factsWith(["synthetic_read_comments"]), observations: [{ kind: "permission_missing", capability: "read_interactions", observedAt: later, ref: "obs-1" }], evaluatedAt: later });
    const row = resolveEntry(profile.entries, "read_interactions", ANY, ANY);
    expect(row).toMatchObject({ state: "NOT_AUTHORIZED", reasons: ["OBSERVED_PERMISSION_MISSING"], observationRefs: ["obs-1"] });
    const shown = effectiveAvailability(row, "ACTIVE", "read_interactions", later);
    expect(shown).toMatchObject({ state: "UNAVAILABLE", reason: "ACCOUNT_PERMISSION_MISSING", recovery: "REAUTHORIZE" });
  });
});

describe("simulator isolation is unchanged", () => {
  it("the simulator catalog keeps its own contract, is never selected for a real provider, and is refused outside development/test", () => {
    expect(SIMULATOR_CATALOG.entries.every((e) => e.evidence === "simulator:contract-v1" && e.platform === ANY)).toBe(true);
    expect(selectCatalog("meta", { NODE_ENV: "test" })).toBe(PLATFORM_CATALOG);
    expect(() => selectCatalog("simulator", { NODE_ENV: "production" })).toThrow();
    // The platform contract would refuse every simulator entry (wildcard platform, simulator evidence, sim.* permissions).
    for (const e of SIMULATOR_CATALOG.entries) expect(platformEntryViolations(e, RESOLVED)).toEqual(expect.arrayContaining(["PLATFORM_NOT_NAMED", "EVIDENCE_NOT_API_VALIDATION"]));
  });
});
