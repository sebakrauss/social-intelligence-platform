/**
 * Step 7G-H5.5-P12-D2b (design P12-D1) — read_interactions publication: the pure kinds → state rule, the two new entry
 * violations, the r5 entries resting on the two accepted LIVE records (read from disk), and what r5 means for profiles
 * and availability through the existing evaluator and overlay. No database, no provider, no profile write.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INTERACTION_KINDS } from "@/integrations/providers/contract";
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
  type CatalogEntry,
} from "@/modules/capability";
import {
  AUTHORIZATION_SEMANTICS,
  EVIDENCE_INTERACTION_KINDS,
  IMPLEMENTED_PLATFORM_OPERATIONS,
  OFFLINE_IMPLEMENTED_OPERATIONS,
  apiValidationRecordViolations,
  platformCatalogViolations,
  platformEntryViolations,
  readInteractionsPublication,
  type ApiValidationRecord,
  type CatalogContractContext,
} from "@/modules/capability/domain/catalog-contract";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const RECORDS = "design/phase-7g/meta-provider/api-validation/records/meta";
const onDisk = (file: string): ApiValidationRecord => JSON.parse(readFileSync(path.join(ROOT, RECORDS, file), "utf8")) as ApiValidationRecord;
const FB_RECORD = onDisk("facebook/read_interactions/20261027-01.json");
const IG_RECORD = onDisk("instagram/read_interactions/20261026-01.json");
const ALL_RECORDS = [onDisk("facebook/read_content/20261023-01.json"), onDisk("instagram/read_content/20261023-01.json"), FB_RECORD, IG_RECORD];
const TODAY: CatalogContractContext = { records: ALL_RECORDS, offlineImplementations: OFFLINE_IMPLEMENTED_OPERATIONS, implementedOperations: IMPLEMENTED_PLATFORM_OPERATIONS, authorizationSemantics: AUTHORIZATION_SEMANTICS };

const FB_PERMISSIONS = ["pages_read_engagement", "pages_read_user_content", "pages_show_list"];
const IG_PERMISSIONS = ["instagram_basic", "instagram_manage_comments", "pages_read_engagement"];
const REPLIES_NOT_READ = { code: "REPLIES_NOT_READ", value: null } as const;
const FB_ENTRY: CatalogEntry = { platform: "facebook", assetClass: "content_bearing", capability: "read_interactions", contentKind: "post", source: "unknown", state: "SUPPORTED", limitation: null,
  requiredPermissions: FB_PERMISSIONS, validation: "validated", evidence: "api-validation:meta.facebook.read_interactions.20261027-01" };
const IG_ENTRY: CatalogEntry = { platform: "instagram", assetClass: "content_bearing", capability: "read_interactions", contentKind: "post", source: "unknown", state: "AVAILABLE_WITH_LIMITATION",
  limitation: REPLIES_NOT_READ, requiredPermissions: IG_PERMISSIONS, validation: "validated", evidence: "api-validation:meta.instagram.read_interactions.20261026-01" };
/** r4 exactly as it was published (Step 7G-H5.5-P11-E). */
const R4_ENTRIES: readonly CatalogEntry[] = [
  { platform: "facebook", assetClass: "content_bearing", capability: "read_content", contentKind: "post", source: "unknown", state: "SUPPORTED", limitation: null,
    requiredPermissions: ["pages_read_engagement", "pages_show_list"], validation: "validated", evidence: "api-validation:meta.facebook.read_content.20261023-01" },
  { platform: "instagram", assetClass: "content_bearing", capability: "read_content", contentKind: "post", source: "unknown", state: "SUPPORTED", limitation: null,
    requiredPermissions: ["instagram_basic", "pages_read_engagement"], validation: "validated", evidence: "api-validation:meta.instagram.read_content.20261023-01" },
];

describe("the pure kinds → state rule", () => {
  it("every canonical kind → SUPPORTED; comment without reply → AVAILABLE_WITH_LIMITATION / REPLIES_NOT_READ", () => {
    expect(readInteractionsPublication(["comment", "reply"])).toEqual({ state: "SUPPORTED", limitation: null });
    expect(readInteractionsPublication(["comment"])).toEqual({ state: "AVAILABLE_WITH_LIMITATION", limitation: REPLIES_NOT_READ });
    expect(Object.isFrozen(readInteractionsPublication(["comment"]))).toBe(true);
  });

  it.each([
    ["empty", []], ["reply only", ["reply"]], ["duplicate comment", ["comment", "comment"]], ["duplicate reply", ["comment", "reply", "reply"]],
    ["non-canonical order (never normalized)", ["reply", "comment"]], ["an unknown kind", ["comment", "mention"]], ["a DM kind", ["comment", "direct_message"]],
    ["any", ["any"]], ["comment + any", ["comment", "any"]], ["null", null], ["undefined", undefined], ["a bare string", "comment"], ["an object", { comment: true }], ["a non-string", ["comment", 1]],
  ])("%s has no rule (null)", (_label, kinds) => {
    expect(readInteractionsPublication(kinds)).toBeNull();
  });

  it("is deterministic and depends on the kinds alone; the vocabulary mirrors the provider contract", () => {
    expect(readInteractionsPublication(["comment"])).toEqual(readInteractionsPublication(Object.freeze(["comment"])));
    expect([...EVIDENCE_INTERACTION_KINDS]).toEqual([...INTERACTION_KINDS]);
    expect(EVIDENCE_INTERACTION_KINDS).toEqual(["comment", "reply"]);
  });
});

describe("implemented kinds are declared per platform on the OFFLINE registrations", () => {
  it("Facebook comment + reply, Instagram comment only; no TikTok; no other capability states kinds", () => {
    const declared = OFFLINE_IMPLEMENTED_OPERATIONS.filter((op) => op.capability === "read_interactions").map((op) => [op.platform, op.interactionKinds]);
    expect(declared).toEqual([["facebook", ["comment", "reply"]], ["instagram", ["comment"]]]);
    for (const op of [...OFFLINE_IMPLEMENTED_OPERATIONS, ...IMPLEMENTED_PLATFORM_OPERATIONS]) {
      if (op.capability !== "read_interactions") expect(Object.keys(op), `${op.platform}:${op.capability}`).not.toContain("interactionKinds");
      expect(op.platform).not.toBe("tiktok");
    }
  });

  it("each LIVE registration states exactly its own record's kinds", () => {
    for (const op of IMPLEMENTED_PLATFORM_OPERATIONS.filter((registration) => registration.capability === "read_interactions")) {
      expect(op.interactionKinds, op.platform).toEqual(ALL_RECORDS.find((record) => record.id === op.evidence)?.interactionKinds);
    }
  });
});

describe("the two accepted records on disk", () => {
  it.each([
    [FB_RECORD, "facebook", "facebook_page", "2026-10-27", "e972010918aebcb22c552d809b82830084b7bd3b", FB_PERMISSIONS, ["comment", "reply"]],
    [IG_RECORD, "instagram", "instagram_professional_account", "2026-10-26", "6a29b0578b49704063f17eefb3ecd92051a7baa0", IG_PERMISSIONS, ["comment"]],
  ] as const)("%#: schema-valid, accepted, positive, exact scope, operations, revision, date, permissions and kinds", (record, platform, accountKind, date, revision, permissions, kinds) => {
    expect(apiValidationRecordViolations(record)).toEqual([]);
    expect(Object.keys(record)).toHaveLength(19);
    expect(record).toEqual(expect.objectContaining({
      id: `api-validation:meta.${platform}.read_interactions.${date.replaceAll("-", "")}-01`, provider: "meta", platform, assetClass: "content_bearing", accountKind, capability: "read_interactions",
      contentKind: "post", source: "unknown", operations: ["getInteraction", "listInteractions"], validatedOn: date, sourceRevision: revision, requiredPermissions: permissions,
      polarity: "positive", negativeBasis: null, reviewer: "TL", status: "accepted", interactionKinds: kinds,
    }));
    const text = `${record.scenario} ${record.observedResult}`;
    // No raw provider/content identifiers, links, run ids, minimality or source claims.
    expect(text).not.toMatch(/\d{8,}|:\/\/|run_|arn:|\bminimal\b|\borganic\b|\bpaid\b|business_management|public_profile/i);
    for (const forbidden of ["business_management", "public_profile"]) expect(record.requiredPermissions).not.toContain(forbidden);
  });

  it("Instagram's record never claims replies: its kinds are comment only and the text says replies were not attempted", () => {
    expect(IG_RECORD.interactionKinds).toEqual(["comment"]);
    expect(IG_RECORD.requiredPermissions).not.toContain("pages_show_list");
    expect(IG_RECORD.scenario).toMatch(/Replies are not read by this slice and were not attempted\./);
  });
});

describe("contract validation of the r5 read_interactions entries (against the records on disk)", () => {
  const check = (base: CatalogEntry, patch: Partial<CatalogEntry> = {}, context: Partial<CatalogContractContext> = {}) => platformEntryViolations({ ...base, ...patch }, { ...TODAY, ...context });

  it("both r5 entries are admissible, and r5 as a whole is", () => {
    expect(check(FB_ENTRY)).toEqual([]);
    expect(check(IG_ENTRY)).toEqual([]);
    expect(platformCatalogViolations(PLATFORM_CATALOG, TODAY)).toEqual([]);
  });

  it("the state must equal the derivation: Instagram as SUPPORTED, Facebook with REPLIES_NOT_READ, or any other limitation, are refused", () => {
    expect(check(IG_ENTRY, { state: "SUPPORTED", limitation: null })).toEqual(["INTERACTION_KINDS_STATE_MISMATCH"]);
    expect(check(FB_ENTRY, { state: "AVAILABLE_WITH_LIMITATION", limitation: REPLIES_NOT_READ })).toEqual(["INTERACTION_KINDS_STATE_MISMATCH"]);
    expect(check(IG_ENTRY, { limitation: { code: "HISTORY_DEPTH_LIMITED", value: 30 } })).toEqual(["INTERACTION_KINDS_STATE_MISMATCH"]);
    expect(check(IG_ENTRY, { limitation: { code: "REPLIES_NOT_READ", value: 1 } })).toEqual(["INTERACTION_KINDS_STATE_MISMATCH"]);
    expect(check(IG_ENTRY, { state: "AVAILABLE_WITH_LIMITATION", limitation: null })).toEqual(expect.arrayContaining(["LIMITATION_INCONSISTENT", "INTERACTION_KINDS_STATE_MISMATCH"]));
  });

  it("Instagram evidence containing reply is refused: not implemented on Instagram, and its live registration states other kinds", () => {
    const withReply: ApiValidationRecord = { ...IG_RECORD, interactionKinds: ["comment", "reply"] };
    const records = ALL_RECORDS.map((record) => (record.id === IG_RECORD.id ? withReply : record));
    expect(check(IG_ENTRY, { state: "SUPPORTED", limitation: null }, { records })).toEqual(["INTERACTION_KINDS_NOT_IMPLEMENTED", "IMPLEMENTATION_EVIDENCE_MISMATCH"]);
  });

  it("evidence kinds outside the platform's implementation are refused even when the live registration agrees", () => {
    const withReply: ApiValidationRecord = { ...IG_RECORD, interactionKinds: ["comment", "reply"] };
    const records = ALL_RECORDS.map((record) => (record.id === IG_RECORD.id ? withReply : record));
    const implementedOperations = IMPLEMENTED_PLATFORM_OPERATIONS.map((op) => (op.evidence === IG_RECORD.id ? { ...op, interactionKinds: ["comment", "reply"] as const } : op));
    expect(check(IG_ENTRY, { state: "SUPPORTED", limitation: null }, { records, implementedOperations })).toEqual(["INTERACTION_KINDS_NOT_IMPLEMENTED"]);
    // Without any declared implemented kinds, nothing is implemented.
    const undeclared = OFFLINE_IMPLEMENTED_OPERATIONS.map((op) => (op.capability === "read_interactions" ? { provider: op.provider, platform: op.platform, capability: op.capability, operations: op.operations } : op));
    expect(check(FB_ENTRY, {}, { offlineImplementations: undeclared })).toEqual(["INTERACTION_KINDS_NOT_IMPLEMENTED"]);
  });

  it("a live registration whose kinds differ from its record is refused", () => {
    const implementedOperations = IMPLEMENTED_PLATFORM_OPERATIONS.map((op) => (op.evidence === FB_RECORD.id ? { ...op, interactionKinds: ["comment"] as const } : op));
    expect(check(FB_ENTRY, {}, { implementedOperations })).toEqual(["IMPLEMENTATION_EVIDENCE_MISMATCH"]);
    const withoutKinds = IMPLEMENTED_PLATFORM_OPERATIONS.map((op) => (op.evidence === FB_RECORD.id ? { provider: op.provider, platform: op.platform, capability: op.capability, operations: op.operations, evidence: op.evidence } : op));
    expect(check(FB_ENTRY, {}, { implementedOperations: withoutKinds })).toEqual(["IMPLEMENTATION_EVIDENCE_MISMATCH"]);
  });

  it("a missing live registration is refused (IMPLEMENTATION_EVIDENCE_MISSING)", () => {
    const implementedOperations = IMPLEMENTED_PLATFORM_OPERATIONS.filter((op) => op.capability !== "read_interactions");
    expect(check(FB_ENTRY, {}, { implementedOperations })).toEqual(["IMPLEMENTATION_EVIDENCE_MISSING"]);
    expect(check(IG_ENTRY, {}, { implementedOperations })).toEqual(["IMPLEMENTATION_EVIDENCE_MISSING"]);
  });

  it("wrong required permissions are refused: dropping one, adding pages_show_list (Instagram) or the granted extras", () => {
    for (const permissions of [["pages_read_engagement", "pages_show_list"], ["pages_read_user_content"], [...FB_PERMISSIONS, "business_management"], [...FB_PERMISSIONS, "public_profile"]])
      expect(check(FB_ENTRY, { requiredPermissions: permissions }), permissions.join(",")).toContain("EVIDENCE_PERMISSIONS_MISMATCH");
    for (const permissions of [["instagram_basic", "pages_read_engagement"], [...IG_PERMISSIONS, "pages_show_list"], ["instagram_manage_comments"]])
      expect(check(IG_ENTRY, { requiredPermissions: permissions }), permissions.join(",")).toContain("EVIDENCE_PERMISSIONS_MISMATCH");
    expect(check(FB_ENTRY, { requiredPermissions: [] })).toEqual(expect.arrayContaining(["REQUIRED_PERMISSIONS_EMPTY", "EVIDENCE_PERMISSIONS_MISMATCH"]));
  });

  it("widened scopes are refused: any content kind or source, other content kinds, other sources, any / any", () => {
    for (const entry of [FB_ENTRY, IG_ENTRY]) {
      for (const contentKind of [ANY, "reel", "video", "carousel", "story"] as const) expect(check(entry, { contentKind }), `${entry.platform}:${contentKind}`).toContain("EVIDENCE_SCOPE_MISMATCH");
      for (const source of [ANY, "organic", "paid", "mixed"] as const) expect(check(entry, { source }), `${entry.platform}:${source}`).toContain("EVIDENCE_SCOPE_MISMATCH");
      expect(check(entry, { contentKind: ANY, source: ANY })).toContain("EVIDENCE_SCOPE_MISMATCH");
    }
  });

  it("no cross-platform reuse: each record backs only its own platform's entry", () => {
    expect(check(IG_ENTRY, { evidence: FB_ENTRY.evidence })).toEqual(expect.arrayContaining(["EVIDENCE_SCOPE_MISMATCH", "INTERACTION_KINDS_NOT_IMPLEMENTED"]));
    expect(check(FB_ENTRY, { evidence: IG_ENTRY.evidence })).toEqual(expect.arrayContaining(["EVIDENCE_SCOPE_MISMATCH", "INTERACTION_KINDS_STATE_MISMATCH"]));
  });

  it("UNSUPPORTED without a negative record is refused — Instagram replies are not unsupported", () => {
    expect(check(IG_ENTRY, { state: "UNSUPPORTED", limitation: null, requiredPermissions: [] })).toContain("EVIDENCE_POLARITY_MISMATCH");
    expect(check(IG_ENTRY, { state: "UNSUPPORTED", limitation: null, requiredPermissions: [], evidence: null })).toContain("EVIDENCE_NOT_API_VALIDATION");
    expect(PLATFORM_CATALOG.entries.some((entry) => entry.state === "UNSUPPORTED")).toBe(false);
  });

  it("an explicit UNKNOWN entry is refused: UNKNOWN is the default, never written", () => {
    expect(check(FB_ENTRY, { state: "UNKNOWN_NOT_VALIDATED", contentKind: ANY, source: ANY })).toContain("UNKNOWN_IS_THE_DEFAULT");
  });
});

describe("catalog revision: r5 = r4 + exactly the two read_interactions entries", () => {
  it("the first two entries are r4's, unchanged; then exactly Facebook and Instagram read_interactions; the simulator stays r2", () => {
    expect([PLATFORM_CATALOG.revision, PLATFORM_CATALOG.label]).toEqual([5, "platform-catalog-r5"]);
    expect(PLATFORM_CATALOG.entries.slice(0, 2)).toEqual(R4_ENTRIES);
    expect(PLATFORM_CATALOG.entries.slice(2)).toEqual([FB_ENTRY, IG_ENTRY]);
    expect([SIMULATOR_CATALOG.revision, SIMULATOR_CATALOG.label]).toEqual([2, "simulator-catalog-r2"]);
  });
});

describe("what r5 means for profiles and availability (existing evaluator and overlay, unchanged)", () => {
  const T = new Date("2026-10-27T12:00:00.000Z");
  const facts = (granted: readonly string[]): AccountFacts => ({ kind: "available", assetClass: "content_bearing", grantedPermissions: granted, linkedAdAccountIds: [], accountIdentityKnown: true, obtainedAt: T });
  const evaluate = (platform: "facebook" | "instagram", granted: readonly string[]) =>
    evaluateProfile({ catalog: selectCatalog("meta", { NODE_ENV: "production" }), platform, assetClass: "content_bearing", facts: facts(granted), observations: [], evaluatedAt: T });
  const row = (platform: "facebook" | "instagram", granted: readonly string[], kind: string = "post", source: string = "unknown") =>
    resolveEntry(evaluate(platform, granted).entries, "read_interactions", kind as never, source as never);

  it("Facebook with every required permission → SUPPORTED / CATALOG_SUPPORTED → AVAILABLE", () => {
    const entry = row("facebook", FB_PERMISSIONS);
    expect(entry).toMatchObject({ contentKind: "post", source: "unknown", state: "SUPPORTED", reasons: ["CATALOG_SUPPORTED"], limitation: null, evidence: FB_ENTRY.evidence });
    expect(effectiveAvailability(entry, "ACTIVE", "read_interactions", T)).toMatchObject({ state: "AVAILABLE", reason: "CAPABILITY_SUPPORTED", limitation: null });
  });

  it("Instagram with every required permission → AVAILABLE_WITH_LIMITATION / CATALOG_LIMITATION / REPLIES_NOT_READ → AVAILABLE_WITH_LIMITATION", () => {
    const entry = row("instagram", IG_PERMISSIONS);
    expect(entry).toMatchObject({ contentKind: "post", source: "unknown", state: "AVAILABLE_WITH_LIMITATION", reasons: ["CATALOG_LIMITATION"], limitation: REPLIES_NOT_READ, evidence: IG_ENTRY.evidence });
    expect(effectiveAvailability(entry, "ACTIVE", "read_interactions", T)).toMatchObject({ state: "AVAILABLE_WITH_LIMITATION", reason: "CAPABILITY_LIMITATION", limitation: REPLIES_NOT_READ });
  });

  it("the limitation survives the overlay while the connection is temporarily unavailable, and disappears only where the base state is unusable", () => {
    const entry = row("instagram", IG_PERMISSIONS);
    for (const status of ["CONNECTING", "DEGRADED", "FAILED", "DISCONNECTED"] as const) {
      expect(effectiveAvailability(entry, status, "read_interactions", T), status).toMatchObject({ state: "TEMPORARILY_UNAVAILABLE", limitation: REPLIES_NOT_READ, baseState: "AVAILABLE_WITH_LIMITATION" });
    }
    expect(effectiveAvailability(entry, "REMOVED", "read_interactions", T)).toMatchObject({ state: "UNAVAILABLE", reason: "CONNECTION_REMOVED", limitation: null });
  });

  it("missing EACH required permission → NOT_AUTHORIZED / ACCOUNT_PERMISSION_MISSING → UNAVAILABLE / REAUTHORIZE (never UNSUPPORTED, no limitation)", () => {
    for (const [platform, required] of [["facebook", FB_PERMISSIONS], ["instagram", IG_PERMISSIONS]] as const) {
      for (const missing of required) {
        const entry = row(platform, required.filter((permission) => permission !== missing));
        expect(entry, `${platform} without ${missing}`).toMatchObject({ state: "NOT_AUTHORIZED", reasons: ["ACCOUNT_PERMISSION_MISSING"], limitation: null });
        expect(effectiveAvailability(entry, "ACTIVE", "read_interactions", T)).toMatchObject({ state: "UNAVAILABLE", reason: "ACCOUNT_PERMISSION_MISSING", recovery: "REAUTHORIZE" });
      }
    }
  });

  it("any / any and every other kind or source stay UNKNOWN / CATALOG_NOT_VALIDATED — the capability is never downgraded as a whole", () => {
    for (const [platform, granted] of [["facebook", FB_PERMISSIONS], ["instagram", IG_PERMISSIONS]] as const) {
      const entries = evaluate(platform, granted).entries;
      expect(entries).toHaveLength(CAPABILITY_KEYS.length + 2);
      expect(resolveEntry(entries, "read_interactions", ANY, ANY)).toMatchObject({ contentKind: ANY, source: ANY, state: "UNKNOWN_NOT_VALIDATED", reasons: ["CATALOG_NOT_VALIDATED"], evidence: null });
      for (const contentKind of [...CAPABILITY_CONTENT_KINDS, ANY] as const)
        for (const source of [...CAPABILITY_SOURCES, ANY] as const) {
          if (contentKind === "post" && source === "unknown") continue;
          expect(resolveEntry(entries, "read_interactions", contentKind, source), `${platform} ${contentKind}/${source}`).toMatchObject({ contentKind: ANY, source: ANY, state: "UNKNOWN_NOT_VALIDATED" });
        }
      expect(entries.some((entry) => entry.state === "UNSUPPORTED")).toBe(false);
    }
  });

  it("r4 profiles are stale under r5 (PROFILE_STALE until an explicit Re-check); r5 profiles are current", () => {
    expect(isCurrentProfile({ catalogId: "platform", catalogRevision: 4 }, "meta")).toBe(false);
    expect(isCurrentProfile({ catalogId: "platform", catalogRevision: 5 }, "meta")).toBe(true);
    expect(evaluate("facebook", FB_PERMISSIONS).catalogRevision).toBe(5);
  });
});
