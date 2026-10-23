/**
 * Step 7G-H5.5-P4-B — the PLATFORM catalog entry contract (modules/capability/domain/catalog-contract.ts), fixtures
 * only: no database, no network, no real catalog entry. A fully evidenced synthetic entry proves the contract is
 * satisfiable; every single defect then fails closed with its own violation. The authorization semantics are RESOLVED
 * (Step 7G-H5.5-P4-C: NOT_AUTHORIZED is profile-only), yet with no accepted record and no registered implementation
 * evidence no real platform entry is admissible. The LIVE-shaped facts observed in P3
 * (Facebook Page and Instagram professional account, five granted permissions) evaluate to ten UNKNOWN rows each.
 * Step 7G-H5.5-P5-C9-C: platform r3 holds exactly one entry (Facebook read_content · post · unknown, backed by the
 * first accepted record); the same LIVE-shaped facts now add one SUPPORTED row for that exact scope on Facebook only.
 */
import { describe, expect, it } from "vitest";
import {
  ANY,
  CAPABILITY_CONTENT_KINDS,
  CAPABILITY_KEYS,
  CAPABILITY_SOURCES,
  PLATFORM_CATALOG,
  SIMULATOR_CATALOG,
  effectiveAvailability,
  evaluateProfile,
  isCurrentProfile,
  resolveEntry,
  selectCatalog,
  type AccountFacts,
  type CapabilityCatalog,
  type CatalogEntry,
} from "@/modules/capability";
import {
  AUTHORIZATION_SEMANTICS,
  FIRST_VALIDATED_PLATFORM_ENTRY_BLOCKED_UNTIL_AUTHORIZATION_SEMANTICS_RESOLVED,
  CAPABILITY_REQUIRED_OPERATIONS,
  IMPLEMENTED_PLATFORM_OPERATIONS,
  OFFLINE_IMPLEMENTED_OPERATIONS,
  READ_CONTENT_REQUIRED_OPERATIONS,
  apiValidationRecordViolations,
  platformCatalogViolations,
  platformEntryViolations,
  type ApiValidationRecord,
  type CatalogContractContext,
  type ImplementedOperation,
  type OperationSetRegistration,
} from "@/modules/capability/domain/catalog-contract";

const EVIDENCE = "api-validation:meta.facebook.read_content.20261101-01";
const RECORD: ApiValidationRecord = Object.freeze({
  id: EVIDENCE,
  provider: "meta",
  platform: "facebook",
  assetClass: "content_bearing",
  accountKind: "facebook_page",
  capability: "read_content",
  contentKind: ANY,
  source: ANY,
  operations: READ_CONTENT_REQUIRED_OPERATIONS,
  validatedOn: "2026-11-01",
  sourceRevision: "a".repeat(40),
  requiredPermissions: Object.freeze(["synthetic_read_posts"]),
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
  capability: "read_content",
  contentKind: ANY,
  source: ANY,
  state: "SUPPORTED",
  limitation: null,
  requiredPermissions: Object.freeze(["synthetic_read_posts"]),
  validation: "validated",
  evidence: EVIDENCE,
});
const IMPLEMENTED: ImplementedOperation = Object.freeze({ provider: "meta", platform: "facebook", capability: "read_content", operations: READ_CONTENT_REQUIRED_OPERATIONS, evidence: EVIDENCE });
const OFFLINE: OperationSetRegistration = Object.freeze({ provider: "meta", platform: "facebook", capability: "read_content", operations: READ_CONTENT_REQUIRED_OPERATIONS });
/** A hypothetical future in which both operations are implemented AND validated live: proves satisfiability. */
const RESOLVED: CatalogContractContext = { records: [RECORD], offlineImplementations: [OFFLINE], implementedOperations: [IMPLEMENTED], authorizationSemantics: "RESOLVED" };
const TODAY: CatalogContractContext = { records: [], offlineImplementations: OFFLINE_IMPLEMENTED_OPERATIONS, implementedOperations: IMPLEMENTED_PLATFORM_OPERATIONS, authorizationSemantics: AUTHORIZATION_SEMANTICS };

const violations = (entry: Partial<CatalogEntry>, context: Partial<CatalogContractContext> = {}) => platformEntryViolations({ ...ENTRY, ...entry }, { ...RESOLVED, ...context });

/**
 * The first accepted record as a fixture (its file is design/phase-7g/meta-provider/api-validation/records/…; the
 * architecture guard proves the file itself parses to exactly these fields and admits the real catalog).
 */
const FIRST_EVIDENCE = "api-validation:meta.facebook.read_content.20261023-01";
const FIRST_RECORD: ApiValidationRecord = Object.freeze({
  ...RECORD,
  id: FIRST_EVIDENCE,
  contentKind: "post",
  source: "unknown",
  validatedOn: "2026-10-23",
  sourceRevision: "fb91ead8bfb79e8c8a5c1a210f65800997afc9b1",
  requiredPermissions: Object.freeze(["pages_read_engagement", "pages_show_list"]),
});
/** The accepted Instagram record as a fixture (Step 7G-H5.5-P11-D; the architecture guard pins the file itself). */
const INSTAGRAM_EVIDENCE = "api-validation:meta.instagram.read_content.20261023-01";
const INSTAGRAM_RECORD: ApiValidationRecord = Object.freeze({
  ...FIRST_RECORD,
  id: INSTAGRAM_EVIDENCE,
  platform: "instagram",
  accountKind: "instagram_professional_account",
  sourceRevision: "cd2c86365e71c589847a7b35e115ff1b4ac30ba8",
  requiredPermissions: Object.freeze(["instagram_basic", "pages_read_engagement"]),
});
const TODAY_WITH_RECORD: CatalogContractContext = { ...TODAY, records: [FIRST_RECORD, INSTAGRAM_RECORD] };
const R3_ENTRY: CatalogEntry = {
  platform: "facebook", assetClass: "content_bearing", capability: "read_content", contentKind: "post", source: "unknown", state: "SUPPORTED", limitation: null,
  requiredPermissions: ["pages_read_engagement", "pages_show_list"], validation: "validated", evidence: FIRST_EVIDENCE,
};
const R4_INSTAGRAM_ENTRY: CatalogEntry = {
  platform: "instagram", assetClass: "content_bearing", capability: "read_content", contentKind: "post", source: "unknown", state: "SUPPORTED", limitation: null,
  requiredPermissions: ["instagram_basic", "pages_read_engagement"], validation: "validated", evidence: INSTAGRAM_EVIDENCE,
};

describe("P11-E: platform catalog r4 holds exactly the two evidenced entries (Facebook unchanged + Instagram)", () => {
  it("platform r4, label platform-catalog-r4, exactly two frozen entries: facebook and instagram · content_bearing · read_content · post · unknown · SUPPORTED", () => {
    expect([PLATFORM_CATALOG.id, PLATFORM_CATALOG.revision, PLATFORM_CATALOG.label, PLATFORM_CATALOG.entries.length]).toEqual(["platform", 4, "platform-catalog-r4", 2]);
    expect(Object.isFrozen(PLATFORM_CATALOG) && Object.isFrozen(PLATFORM_CATALOG.entries)).toBe(true);
    expect(PLATFORM_CATALOG.entries).toEqual([R3_ENTRY, R4_INSTAGRAM_ENTRY]);
    for (const entry of PLATFORM_CATALOG.entries) expect(Object.isFrozen(entry) && Object.isFrozen(entry.requiredPermissions)).toBe(true);
    // The Instagram capability needs its two read-path permissions only: pages_show_list is not one of them.
    expect(PLATFORM_CATALOG.entries[1]?.requiredPermissions).not.toContain("pages_show_list");
  });

  it("the catalog is admissible with both accepted records — and each entry fails closed without its own", () => {
    expect(platformCatalogViolations(PLATFORM_CATALOG, TODAY_WITH_RECORD)).toEqual([]);
    expect(platformCatalogViolations(PLATFORM_CATALOG, TODAY)).toEqual([
      { index: 0, violations: ["EVIDENCE_RECORD_MISSING", "IMPLEMENTATION_EVIDENCE_MISMATCH"] },
      { index: 1, violations: ["EVIDENCE_RECORD_MISSING", "IMPLEMENTATION_EVIDENCE_MISMATCH"] },
    ]);
    // No cross-platform reuse: each record backs only its own platform's entry.
    expect(platformCatalogViolations(PLATFORM_CATALOG, { ...TODAY, records: [FIRST_RECORD] })).toEqual([{ index: 1, violations: ["EVIDENCE_RECORD_MISSING", "IMPLEMENTATION_EVIDENCE_MISMATCH"] }]);
    expect(platformEntryViolations({ ...R4_INSTAGRAM_ENTRY, evidence: FIRST_EVIDENCE }, TODAY_WITH_RECORD)).toEqual(expect.arrayContaining(["EVIDENCE_SCOPE_MISMATCH", "EVIDENCE_PERMISSIONS_MISMATCH", "IMPLEMENTATION_EVIDENCE_MISMATCH"]));
    expect(platformEntryViolations({ ...R3_ENTRY, evidence: INSTAGRAM_EVIDENCE }, TODAY_WITH_RECORD)).toEqual(expect.arrayContaining(["EVIDENCE_SCOPE_MISMATCH", "EVIDENCE_PERMISSIONS_MISMATCH", "IMPLEMENTATION_EVIDENCE_MISMATCH"]));
  });

  it("no organic, paid, mixed or any source; no any or other content kind; no other platform, asset class or capability", () => {
    const entries = PLATFORM_CATALOG.entries;
    for (const source of ["organic", "paid", "mixed", ANY]) expect(entries.filter((e) => e.source === source), source).toEqual([]);
    for (const contentKind of [ANY, ...CAPABILITY_CONTENT_KINDS.filter((k) => k !== "post")]) expect(entries.filter((e) => e.contentKind === contentKind), contentKind).toEqual([]);
    expect(entries.map((e) => e.platform)).toEqual(["facebook", "instagram"]);
    expect(entries.filter((e) => e.assetClass !== "content_bearing" || e.capability !== "read_content")).toEqual([]);
  });

  it("the Instagram entry fails closed on any defect: wrong evidence id, wrong permissions (including adding pages_show_list), other scope", () => {
    const check = (patch: Partial<CatalogEntry>) => platformEntryViolations({ ...R4_INSTAGRAM_ENTRY, ...patch }, TODAY_WITH_RECORD);
    expect(check({})).toEqual([]);
    expect(check({ evidence: "api-validation:meta.instagram.read_content.20261023-02" })).toEqual(expect.arrayContaining(["EVIDENCE_RECORD_MISSING", "IMPLEMENTATION_EVIDENCE_MISMATCH"]));
    expect(check({ requiredPermissions: ["instagram_basic", "pages_read_engagement", "pages_show_list"] })).toContain("EVIDENCE_PERMISSIONS_MISMATCH");
    expect(check({ requiredPermissions: ["instagram_basic"] })).toContain("EVIDENCE_PERMISSIONS_MISMATCH");
    expect(check({ requiredPermissions: ["pages_read_engagement"] })).toContain("EVIDENCE_PERMISSIONS_MISMATCH");
    for (const source of ["organic", "paid", "mixed", ANY] as const) expect(check({ source }), source).toContain("EVIDENCE_SCOPE_MISMATCH");
    for (const contentKind of ["reel", "video", "carousel", "story", ANY] as const) expect(check({ contentKind }), contentKind).toContain("EVIDENCE_SCOPE_MISMATCH");
    expect(check({ contentKind: ANY, source: ANY })).toContain("EVIDENCE_SCOPE_MISMATCH");
  });

  it("the entry fails closed on any defect: wrong evidence id, non-accepted or negative evidence, wrong permissions, other scope", () => {
    const check = (patch: Partial<CatalogEntry>, context: CatalogContractContext = TODAY_WITH_RECORD) => platformEntryViolations({ ...R3_ENTRY, ...patch }, context);
    expect(check({})).toEqual([]);
    expect(check({ evidence: "api-validation:meta.facebook.read_content.20261023-02" })).toEqual(expect.arrayContaining(["EVIDENCE_RECORD_MISSING", "IMPLEMENTATION_EVIDENCE_MISMATCH"]));
    expect(check({ evidence: "simulator:contract-v1" })).toContain("EVIDENCE_NOT_API_VALIDATION");
    expect(check({}, { ...TODAY, records: [{ ...FIRST_RECORD, status: "draft" }] })).toContain("EVIDENCE_RECORD_NOT_ACCEPTED");
    const negative: ApiValidationRecord = { ...FIRST_RECORD, polarity: "authoritative_negative", negativeBasis: "provider_documentation" };
    expect(check({}, { ...TODAY, records: [negative] })).toContain("EVIDENCE_POLARITY_MISMATCH");
    expect(check({ requiredPermissions: ["pages_read_engagement"] })).toContain("EVIDENCE_PERMISSIONS_MISMATCH");
    expect(check({ requiredPermissions: ["pages_read_engagement", "pages_read_user_content", "pages_show_list"] })).toContain("EVIDENCE_PERMISSIONS_MISMATCH");
    expect(check({ requiredPermissions: [] })).toEqual(expect.arrayContaining(["REQUIRED_PERMISSIONS_EMPTY", "EVIDENCE_PERMISSIONS_MISMATCH"]));
    for (const source of ["organic", "paid", "mixed", ANY] as const) expect(check({ source }), source).toContain("EVIDENCE_SCOPE_MISMATCH");
    for (const contentKind of ["reel", "video", "carousel", "story", ANY] as const) expect(check({ contentKind }), contentKind).toContain("EVIDENCE_SCOPE_MISMATCH");
    expect(check({ platform: "instagram" })).toContain("EVIDENCE_SCOPE_MISMATCH");
  });
});

describe("P5-C9-C (under r4): what the Facebook entry means for profiles (existing evaluator, unchanged)", () => {
  const T = new Date("2026-10-23T08:00:00.000Z");
  const both = ["pages_read_engagement", "pages_show_list"];
  const fbFacts = (granted: readonly string[]): AccountFacts => ({ kind: "available", assetClass: "content_bearing", grantedPermissions: granted, linkedAdAccountIds: [], accountIdentityKnown: true, obtainedAt: T });
  const evaluate = (granted: readonly string[], platform: "facebook" | "instagram" = "facebook") =>
    evaluateProfile({ catalog: selectCatalog("meta", { NODE_ENV: "production" }), platform, assetClass: "content_bearing", facts: fbFacts(granted), observations: [], evaluatedAt: T });

  it("A: a Facebook Page holding both permissions → exact post / unknown SUPPORTED / CATALOG_SUPPORTED → AVAILABLE", () => {
    const row = resolveEntry(evaluate(both).entries, "read_content", "post", "unknown");
    expect(row).toMatchObject({ contentKind: "post", source: "unknown", state: "SUPPORTED", reasons: ["CATALOG_SUPPORTED"], catalogValidation: "validated", evidence: FIRST_EVIDENCE });
    expect(effectiveAvailability(row, "ACTIVE", "read_content", T)).toMatchObject({ state: "AVAILABLE", reason: "CAPABILITY_SUPPORTED", scope: { contentKind: "post", source: "unknown" } });
  });

  it("B / C: missing pages_read_engagement or pages_show_list → NOT_AUTHORIZED / ACCOUNT_PERMISSION_MISSING (never UNSUPPORTED)", () => {
    for (const granted of [["pages_show_list"], ["pages_read_engagement"], []]) {
      const row = resolveEntry(evaluate(granted).entries, "read_content", "post", "unknown");
      expect(row, granted.join(",")).toMatchObject({ contentKind: "post", source: "unknown", state: "NOT_AUTHORIZED", reasons: ["ACCOUNT_PERMISSION_MISSING"] });
      expect(effectiveAvailability(row, "ACTIVE", "read_content", T)).toMatchObject({ state: "UNAVAILABLE", reason: "ACCOUNT_PERMISSION_MISSING", recovery: "REAUTHORIZE" });
    }
  });

  it("D: generic any / any does NOT inherit post / unknown support (its own row stays UNKNOWN; resolver not widened)", () => {
    const entries = evaluate(both).entries.filter((e) => e.capability === "read_content");
    expect(entries.map((e) => [e.contentKind, e.source, e.state])).toEqual([[ANY, ANY, "UNKNOWN_NOT_VALIDATED"], ["post", "unknown", "SUPPORTED"]]);
    const generic = resolveEntry(evaluate(both).entries, "read_content", ANY, ANY);
    expect(generic).toMatchObject({ contentKind: ANY, source: ANY, state: "UNKNOWN_NOT_VALIDATED", reasons: ["CATALOG_NOT_VALIDATED"], evidence: null });
    expect(effectiveAvailability(generic, "ACTIVE", "read_content", T)).toMatchObject({ state: "UNAVAILABLE", reason: "CAPABILITY_NOT_VALIDATED" });
  });

  it("E: the Facebook entry never reaches Instagram — an Instagram account holding only the Facebook permissions is NOT_AUTHORIZED on its own entry", () => {
    const profile = evaluate(both, "instagram");
    expect(profile.entries).toHaveLength(11);
    expect(resolveEntry(profile.entries, "read_content", "post", "unknown")).toMatchObject({ state: "NOT_AUTHORIZED", reasons: ["ACCOUNT_PERMISSION_MISSING"], evidence: INSTAGRAM_EVIDENCE });
  });

  it("F: every other content kind / source on Facebook read_content resolves to the UNKNOWN any/any row", () => {
    const entries = evaluate(both).entries;
    for (const contentKind of [...CAPABILITY_CONTENT_KINDS, ANY] as const)
      for (const source of [...CAPABILITY_SOURCES, ANY] as const) {
        if (contentKind === "post" && source === "unknown") continue;
        expect(resolveEntry(entries, "read_content", contentKind, source), `${contentKind}/${source}`).toMatchObject({ contentKind: ANY, source: ANY, state: "UNKNOWN_NOT_VALIDATED" });
      }
  });

  it("staleness: platform profiles evaluated at r2 or r3 are not current against r4 (PROFILE_STALE until an explicit Re-check)", () => {
    expect(isCurrentProfile({ catalogId: "platform", catalogRevision: 2 }, "meta")).toBe(false);
    expect(isCurrentProfile({ catalogId: "platform", catalogRevision: 3 }, "meta")).toBe(false);
    expect(isCurrentProfile({ catalogId: "platform", catalogRevision: 4 }, "meta")).toBe(true);
    expect(evaluate(both).catalogRevision).toBe(4);
  });

  it("a fresh r4 Facebook profile: 11 rows, exactly one SUPPORTED (read_content / post / unknown)", () => {
    const profile = evaluate(both);
    expect([profile.catalogRevision, profile.entries.length]).toEqual([4, 11]);
    expect(profile.entries.filter((e) => e.state === "SUPPORTED").map((e) => [e.capability, e.contentKind, e.source])).toEqual([["read_content", "post", "unknown"]]);
  });
});

describe("P11-E: what the r4 Instagram entry means for profiles (existing evaluator, unchanged)", () => {
  const T = new Date("2026-10-23T16:00:00.000Z");
  const required = ["instagram_basic", "pages_read_engagement"];
  const igFacts = (granted: readonly string[]): AccountFacts => ({ kind: "available", assetClass: "content_bearing", grantedPermissions: granted, linkedAdAccountIds: [], accountIdentityKnown: true, obtainedAt: T });
  const evaluate = (granted: readonly string[]) =>
    evaluateProfile({ catalog: selectCatalog("meta", { NODE_ENV: "production" }), platform: "instagram", assetClass: "content_bearing", facts: igFacts(granted), observations: [], evaluatedAt: T });

  it("instagram_basic + pages_read_engagement WITHOUT pages_show_list → exact post / unknown SUPPORTED / CATALOG_SUPPORTED → AVAILABLE", () => {
    const row = resolveEntry(evaluate(required).entries, "read_content", "post", "unknown");
    expect(row).toMatchObject({ contentKind: "post", source: "unknown", state: "SUPPORTED", reasons: ["CATALOG_SUPPORTED"], limitation: null, catalogValidation: "validated", evidence: INSTAGRAM_EVIDENCE });
    expect(effectiveAvailability(row, "ACTIVE", "read_content", T)).toMatchObject({ state: "AVAILABLE", reason: "CAPABILITY_SUPPORTED", limitation: null, scope: { contentKind: "post", source: "unknown" } });
    // The LIVE account's full grant set (with pages_show_list and the rest) gives the same answer.
    const live = resolveEntry(evaluate(["business_management", "instagram_basic", "pages_read_engagement", "pages_show_list", "public_profile"]).entries, "read_content", "post", "unknown");
    expect(live).toMatchObject({ state: "SUPPORTED", reasons: ["CATALOG_SUPPORTED"] });
  });

  it("missing instagram_basic or pages_read_engagement → NOT_AUTHORIZED / ACCOUNT_PERMISSION_MISSING → UNAVAILABLE / REAUTHORIZE (never UNSUPPORTED)", () => {
    for (const granted of [["pages_read_engagement", "pages_show_list"], ["instagram_basic", "pages_show_list"], []]) {
      const row = resolveEntry(evaluate(granted).entries, "read_content", "post", "unknown");
      expect(row, granted.join(",")).toMatchObject({ contentKind: "post", source: "unknown", state: "NOT_AUTHORIZED", reasons: ["ACCOUNT_PERMISSION_MISSING"] });
      expect(effectiveAvailability(row, "ACTIVE", "read_content", T)).toMatchObject({ state: "UNAVAILABLE", reason: "ACCOUNT_PERMISSION_MISSING", recovery: "REAUTHORIZE" });
    }
  });

  it("generic any / any stays UNKNOWN / CATALOG_NOT_VALIDATED → UNAVAILABLE / CAPABILITY_NOT_VALIDATED", () => {
    const generic = resolveEntry(evaluate(required).entries, "read_content", ANY, ANY);
    expect(generic).toMatchObject({ contentKind: ANY, source: ANY, state: "UNKNOWN_NOT_VALIDATED", reasons: ["CATALOG_NOT_VALIDATED"], evidence: null });
    expect(effectiveAvailability(generic, "ACTIVE", "read_content", T)).toMatchObject({ state: "UNAVAILABLE", reason: "CAPABILITY_NOT_VALIDATED" });
  });

  it("every other Instagram kind / source (video, reel, carousel, organic, paid, mixed, any) resolves to the UNKNOWN any/any row", () => {
    const entries = evaluate(required).entries;
    let others = 0;
    for (const contentKind of [...CAPABILITY_CONTENT_KINDS, ANY] as const)
      for (const source of [...CAPABILITY_SOURCES, ANY] as const) {
        if (contentKind === "post" && source === "unknown") continue;
        const row = resolveEntry(entries, "read_content", contentKind, source);
        expect(row, `${contentKind}/${source}`).toMatchObject({ contentKind: ANY, source: ANY, state: "UNKNOWN_NOT_VALIDATED" });
        expect(effectiveAvailability(row, "ACTIVE", "read_content", T).state).toBe("UNAVAILABLE");
        others += 1;
      }
    expect(others).toBe(39);
  });

  it("a fresh r4 Instagram profile: 11 rows, exactly one SUPPORTED (read_content / post / unknown); r3 is stale against r4", () => {
    const profile = evaluate(required);
    expect([profile.catalogId, profile.catalogRevision, profile.entries.length]).toEqual(["platform", 4, 11]);
    expect(profile.entries.filter((e) => e.state === "SUPPORTED").map((e) => [e.capability, e.contentKind, e.source])).toEqual([["read_content", "post", "unknown"]]);
    expect(profile.entries.filter((e) => e.state !== "SUPPORTED").every((e) => e.state === "UNKNOWN_NOT_VALIDATED" && e.contentKind === ANY && e.source === ANY)).toBe(true);
    expect(isCurrentProfile({ catalogId: "platform", catalogRevision: 3 }, "meta")).toBe(false);
  });
});

describe("P4-B / P4-C contract history", () => {
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

  it("exactly two live-validated registrations exist (Facebook P5-C9-B, Instagram P11-D read_content): every other platform × capability still fails G2", () => {
    expect(IMPLEMENTED_PLATFORM_OPERATIONS).toEqual([
      { provider: "meta", platform: "facebook", capability: "read_content", operations: ["getContent", "listContent"], evidence: "api-validation:meta.facebook.read_content.20261023-01" },
      { provider: "meta", platform: "instagram", capability: "read_content", operations: ["getContent", "listContent"], evidence: "api-validation:meta.instagram.read_content.20261023-01" },
    ]);
    for (const capability of CAPABILITY_KEYS)
      for (const platform of ["facebook", "instagram", "tiktok"] as const) {
        const v = platformEntryViolations({ ...ENTRY, platform, capability }, { ...TODAY, records: [RECORD] });
        // The registered Meta read_content operations rest on OTHER records than this synthetic one: still refused.
        const registered = platform !== "tiktok" && capability === "read_content";
        expect(v, `${platform}:${capability}`).toContain(registered ? "IMPLEMENTATION_EVIDENCE_MISMATCH" : "IMPLEMENTATION_EVIDENCE_MISSING");
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
    for (const bad of [[""], ["Read Comments"], ["sim.read_content"], ["synthetic_read_posts", "synthetic_read_posts"]]) {
      expect(violations({ requiredPermissions: bad })).toContain("REQUIRED_PERMISSION_UNNAMED");
    }
    expect(violations({ requiredPermissions: ["synthetic_other"] })).toContain("EVIDENCE_PERMISSIONS_MISMATCH");
  });

  it("validation must be 'validated' and the evidence an accepted api-validation record of the exact scope", () => {
    expect(violations({ validation: "not_validated" })).toContain("NOT_VALIDATED");
    for (const evidence of [null, "simulator:contract-v1", "api-validation:", "api-validation:meta.facebook.read_content"]) {
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
    expect(violations({}, { implementedOperations: [{ ...IMPLEMENTED, operations: ["getInteraction"] }] })).toContain("IMPLEMENTATION_EVIDENCE_MISMATCH");
    expect(violations({}, { implementedOperations: [{ ...IMPLEMENTED, evidence: "api-validation:meta.facebook.read_content.20261102-01" }] })).toContain("IMPLEMENTATION_EVIDENCE_MISMATCH");
    // describeAccount (P3's live-validated read) is account infrastructure: never evidence for any capability.
    const infra = { ...RECORD, operations: ["describeAccount"] };
    expect(violations({}, { records: [infra], implementedOperations: [{ ...IMPLEMENTED, operations: ["describeAccount"] }] })).toContain("INFRASTRUCTURE_OPERATION_IS_NOT_EVIDENCE");
    expect(violations({}, { offlineImplementations: [{ ...OFFLINE, operations: ["describeAccount", "getContent", "listContent"] }] })).toContain("INFRASTRUCTURE_OPERATION_IS_NOT_EVIDENCE");
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

describe("P5-B: read_content requires the exact operation SET listContent + getContent, implemented AND validated live", () => {
  it("the declared sets: read_content = getContent + listContent; no other capability declares one (no name inference)", () => {
    expect(READ_CONTENT_REQUIRED_OPERATIONS).toEqual(["getContent", "listContent"]);
    expect(CAPABILITY_REQUIRED_OPERATIONS).toEqual({ read_content: ["getContent", "listContent"] });
    for (const capability of CAPABILITY_KEYS.filter((key) => key !== "read_content")) {
      // Even a fully evidenced entry of another capability is refused: its operation set is undeclared.
      const other = `api-validation:meta.facebook.${capability}.20261101-01`;
      const record = { ...RECORD, id: other, capability };
      const v = platformEntryViolations({ ...ENTRY, capability, evidence: other }, { ...RESOLVED, records: [record], offlineImplementations: [{ ...OFFLINE, capability }], implementedOperations: [{ ...IMPLEMENTED, capability, evidence: other }] });
      expect(v, capability).toContain("REQUIRED_OPERATIONS_UNDEFINED");
    }
  });

  it("offline implementation (A) and live validation (B) are distinct; B now rests on ONE specific accepted record", () => {
    expect(OFFLINE_IMPLEMENTED_OPERATIONS).toEqual([
      { provider: "meta", platform: "facebook", capability: "read_content", operations: ["getContent", "listContent"] },
      { provider: "meta", platform: "instagram", capability: "read_content", operations: ["getContent", "listContent"] },
    ]);
    // Live validation: Facebook (P5-C9-B) and Instagram (P11-D), each resting on its own accepted record.
    expect(IMPLEMENTED_PLATFORM_OPERATIONS.map((op) => [op.platform, op.capability, op.evidence])).toEqual([
      ["facebook", "read_content", "api-validation:meta.facebook.read_content.20261023-01"],
      ["instagram", "read_content", "api-validation:meta.instagram.read_content.20261023-01"],
    ]);
    // A holds; B exists but for another evidence id than this synthetic entry's (and this context has no record).
    const today = platformEntryViolations({ ...ENTRY, contentKind: "post", source: "organic" }, TODAY);
    expect(today).not.toContain("IMPLEMENTATION_INCOMPLETE");
    expect(today).toEqual(expect.arrayContaining(["EVIDENCE_RECORD_MISSING", "IMPLEMENTATION_EVIDENCE_MISMATCH"]));
    // Even with a (hypothetical) accepted record, a registration resting on a DIFFERENT record still refuses it.
    expect(platformEntryViolations(ENTRY, { ...TODAY, records: [RECORD] })).toEqual(["IMPLEMENTATION_EVIDENCE_MISMATCH"]);
    // Offline registrations are never evidence: offline-only (no live registration) is refused; live without offline too.
    expect(violations({}, { implementedOperations: [] })).toEqual(["IMPLEMENTATION_EVIDENCE_MISSING"]);
    expect(violations({}, { offlineImplementations: [] })).toEqual(["IMPLEMENTATION_INCOMPLETE"]);
  });

  it("P11-D: an Instagram post/unknown entry on the accepted record satisfies A and B — admissible, and published by r4 (P11-E)", () => {
    const instagramRecord: ApiValidationRecord = { ...RECORD, id: INSTAGRAM_EVIDENCE, platform: "instagram", accountKind: "instagram_professional_account", contentKind: "post", source: "unknown",
      validatedOn: "2026-10-23", sourceRevision: "cd2c86365e71c589847a7b35e115ff1b4ac30ba8", requiredPermissions: ["instagram_basic", "pages_read_engagement"] };
    const instagram: CatalogEntry = { ...ENTRY, platform: "instagram", contentKind: "post", source: "unknown", requiredPermissions: ["instagram_basic", "pages_read_engagement"], evidence: INSTAGRAM_EVIDENCE };
    expect(apiValidationRecordViolations(instagramRecord)).toEqual([]);
    expect(platformEntryViolations(instagram, { ...TODAY, records: [instagramRecord] })).toEqual([]);
    // Without its record (this context's default), still fail closed.
    expect(platformEntryViolations(instagram, TODAY)).toEqual(expect.arrayContaining(["EVIDENCE_RECORD_MISSING"]));
    // Another (unaccepted) Instagram evidence id is not the registered one.
    expect(platformEntryViolations({ ...instagram, evidence: "api-validation:meta.instagram.read_content.20261101-01" }, TODAY)).toEqual(expect.arrayContaining(["EVIDENCE_RECORD_MISSING", "IMPLEMENTATION_EVIDENCE_MISMATCH"]));
    expect(PLATFORM_CATALOG.entries.filter((entry) => entry.platform === "instagram")).toEqual([R4_INSTAGRAM_ENTRY]);
  });

  it("one of the two operations is never enough — offline, in the record, or in the live registration", () => {
    for (const one of [["listContent"], ["getContent"]]) {
      expect(violations({}, { offlineImplementations: [{ ...OFFLINE, operations: one }] }), one.join()).toContain("IMPLEMENTATION_INCOMPLETE");
      expect(violations({}, { records: [{ ...RECORD, operations: one }] }), one.join()).toContain("EVIDENCE_OPERATIONS_INCOMPLETE");
      expect(violations({}, { implementedOperations: [{ ...IMPLEMENTED, operations: one }] }), one.join()).toContain("IMPLEMENTATION_EVIDENCE_MISMATCH");
    }
    expect(violations({}, { implementedOperations: [{ ...IMPLEMENTED, operations: ["listContent"] }, { ...IMPLEMENTED, operations: ["getContent"] }] })).toContain("IMPLEMENTATION_EVIDENCE_MISMATCH");
    // A superset is not the exact set.
    expect(violations({}, { records: [{ ...RECORD, operations: ["getContent", "getCurrentState", "listContent"] }] })).toContain("EVIDENCE_OPERATIONS_INCOMPLETE");
    expect(violations({}, { offlineImplementations: [{ ...OFFLINE, platform: "instagram" }] })).toContain("IMPLEMENTATION_INCOMPLETE");
  });

  it("a record's operations are a non-empty, sorted, distinct set of operation names", () => {
    for (const bad of [[], ["listContent", "getContent"], ["getContent", "getContent"], ["get content"], ["GetContent"]]) {
      expect(apiValidationRecordViolations({ ...RECORD, operations: bad }), bad.join("|")).toContain("OPERATIONS_MALFORMED");
    }
    expect(apiValidationRecordViolations(RECORD)).toEqual([]);
  });
});

describe("UNSUPPORTED entries need authoritative negative evidence", () => {
  const NEGATIVE: ApiValidationRecord = { ...RECORD, id: "api-validation:meta.facebook.read_content.20261101-02", requiredPermissions: [], polarity: "authoritative_negative", negativeBasis: "provider_documentation" };
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
    expect(unsupported({ requiredPermissions: ["synthetic_read_posts"] })).toContain("UNSUPPORTED_NAMES_PERMISSIONS");
    expect(apiValidationRecordViolations({ ...NEGATIVE, negativeBasis: null })).toContain("POLARITY_BASIS_INCONSISTENT");
    for (const basis of ["permission_absent", "operation_not_implemented", "facts_unavailable", "provider_read_failed", "catalog_has_no_rule"]) {
      expect(apiValidationRecordViolations({ ...NEGATIVE, negativeBasis: basis as never })).toContain("POLARITY_BASIS_INCONSISTENT");
    }
  });
});

describe("evidence records carry no identifying or secret material", () => {
  it("ids, dates, revisions, permissions and free text are validated; long digit runs and links are refused", () => {
    expect(apiValidationRecordViolations({ ...RECORD, id: "api-validation:meta.facebook.read_content.20261102-01" })).toContain("ID_FIELD_MISMATCH");
    expect(apiValidationRecordViolations({ ...RECORD, platform: "tiktok", id: "api-validation:meta.tiktok.read_content.20261101-01" })).toContain("PROVIDER_PLATFORM_MISMATCH");
    expect(apiValidationRecordViolations({ ...RECORD, validatedOn: "2026-13-01" })).toContain("DATE_MALFORMED");
    expect(apiValidationRecordViolations({ ...RECORD, requiredPermissions: ["b_scope", "a_scope"] })).toContain("PERMISSIONS_NOT_NAMED");
    expect(apiValidationRecordViolations({ ...RECORD, scenario: "Page 123456789012345 replied" })).toContain("TEXT_SUSPECTED_IDENTIFIER");
    expect(apiValidationRecordViolations({ ...RECORD, observedResult: "see https://graph.example/x" })).toContain("TEXT_SUSPECTED_IDENTIFIER");
    expect(apiValidationRecordViolations({ ...RECORD, reviewer: "" })).toContain("TEXT_MISSING_OR_OVERSIZED");
  });
});

describe("G3 — LIVE-shaped P3 facts: no UNSUPPORTED, and SUPPORTED only on each platform's exact r4 entry (fixtures only)", () => {
  const LIVE_GRANTED = ["business_management", "instagram_basic", "pages_read_engagement", "pages_show_list", "public_profile"];
  const liveFacts: AccountFacts = { kind: "available", assetClass: "content_bearing", grantedPermissions: LIVE_GRANTED, linkedAdAccountIds: [], accountIdentityKnown: true, obtainedAt: new Date("2026-10-22T12:47:03.097Z") };

  for (const platform of ["facebook", "instagram"] as const) {
    it(`${platform}: 10 × UNKNOWN_NOT_VALIDATED / CATALOG_NOT_VALIDATED (scope any/any) on platform r4 + exactly one SUPPORTED read_content post/unknown row`, () => {
      const profile = evaluateProfile({ catalog: selectCatalog("meta", { NODE_ENV: "production" }), platform, assetClass: "content_bearing", facts: liveFacts, observations: [], evaluatedAt: new Date("2026-10-22T12:47:03.440Z") });
      expect([profile.catalogId, profile.catalogRevision]).toEqual(["platform", 4]);
      const generic = profile.entries.filter((e) => e.contentKind === ANY && e.source === ANY);
      expect(generic).toHaveLength(10);
      expect(generic.map((e) => e.capability).sort()).toEqual([...CAPABILITY_KEYS].sort());
      for (const e of generic) expect(e).toMatchObject({ state: "UNKNOWN_NOT_VALIDATED", reasons: ["CATALOG_NOT_VALIDATED"], catalogValidation: "not_validated", evidence: null });
      const exact = profile.entries.filter((e) => !(e.contentKind === ANY && e.source === ANY));
      expect(exact).toEqual([{ capability: "read_content", contentKind: "post", source: "unknown", state: "SUPPORTED", reasons: ["CATALOG_SUPPORTED"], limitation: null, catalogValidation: "validated", evidence: platform === "facebook" ? FIRST_EVIDENCE : INSTAGRAM_EVIDENCE, observationRefs: [] }]);
      expect(profile.entries.filter((e) => e.state === "UNSUPPORTED" || e.state === "NOT_AUTHORIZED")).toHaveLength(0);
    });
  }

  it("why the contract matters: one empty-permission SUPPORTED platform entry WOULD make both LIVE accounts SUPPORTED — the contract refuses it", () => {
    const unsafe: CatalogEntry = { ...ENTRY, platform: "facebook", requiredPermissions: [], evidence: null, validation: "validated" };
    const hypothetical: CapabilityCatalog = { id: "platform", revision: 2, label: "hypothetical", entries: [unsafe] };
    const profile = evaluateProfile({ catalog: hypothetical, platform: "facebook", assetClass: "content_bearing", facts: liveFacts, observations: [], evaluatedAt: new Date() });
    expect(profile.entries.find((e) => e.capability === "read_content")?.state).toBe("SUPPORTED");
    expect(platformCatalogViolations(hypothetical, TODAY)[0]?.violations).toEqual(expect.arrayContaining(["EVIDENCE_NOT_API_VALIDATION", "REQUIRED_PERMISSIONS_EMPTY", "IMPLEMENTATION_EVIDENCE_MISMATCH"]));
  });
});

describe("authorization semantics guardrail: a missing permission is never presented as platform non-support", () => {
  // A synthetic validated-looking catalog: the evaluator's authorization branches (Step 7G-H5.5-P4-C).
  const permissioned: CapabilityCatalog = { id: "platform", revision: 2, label: "hypothetical", entries: [ENTRY] };
  const factsWith = (granted: readonly string[]): AccountFacts => ({ kind: "available", assetClass: "content_bearing", grantedPermissions: granted, linkedAdAccountIds: [], accountIdentityKnown: true, obtainedAt: new Date("2026-10-22T12:00:00Z") });

  it("a missing permission is stored as NOT_AUTHORIZED / ACCOUNT_PERMISSION_MISSING and presented as ACCOUNT_PERMISSION_MISSING + REAUTHORIZE, never CAPABILITY_UNSUPPORTED / OPEN_ON_PLATFORM", () => {
    const profile = evaluateProfile({ catalog: permissioned, platform: "facebook", assetClass: "content_bearing", facts: factsWith(["pages_show_list"]), observations: [], evaluatedAt: new Date("2026-10-22T12:01:00Z") });
    const row = resolveEntry(profile.entries, "read_content", ANY, ANY);
    expect(row).toMatchObject({ state: "NOT_AUTHORIZED", reasons: ["ACCOUNT_PERMISSION_MISSING"], evidence: ENTRY.evidence });
    const shown = effectiveAvailability(row, "ACTIVE", "read_content", profile.evaluatedAt);
    expect(shown).toMatchObject({ state: "UNAVAILABLE", reason: "ACCOUNT_PERMISSION_MISSING", recovery: "REAUTHORIZE" });
    expect([shown.reason, shown.recovery]).not.toContain("CAPABILITY_UNSUPPORTED");
    expect([shown.reason, shown.recovery]).not.toContain("OPEN_ON_PLATFORM");
  });

  it("an observed PermissionMissing is presented the same way (authorization, not platform)", () => {
    const later = new Date("2026-10-22T12:05:00Z");
    const profile = evaluateProfile({ catalog: permissioned, platform: "facebook", assetClass: "content_bearing", facts: factsWith(["synthetic_read_posts"]), observations: [{ kind: "permission_missing", capability: "read_content", observedAt: later, ref: "obs-1" }], evaluatedAt: later });
    const row = resolveEntry(profile.entries, "read_content", ANY, ANY);
    expect(row).toMatchObject({ state: "NOT_AUTHORIZED", reasons: ["OBSERVED_PERMISSION_MISSING"], observationRefs: ["obs-1"] });
    const shown = effectiveAvailability(row, "ACTIVE", "read_content", later);
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
