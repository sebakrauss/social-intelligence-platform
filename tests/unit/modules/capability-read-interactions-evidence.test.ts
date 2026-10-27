/**
 * read_interactions evidence contract (Step 7G-H5.5-P12-B2; modules/capability/domain/catalog-contract.ts;
 * design/phase-7g/meta-provider/api-validation/README.md). One record stays the sole authority for one entry; a
 * read_interactions record must state EXACTLY the interaction kinds one controlled LIVE validation proved on both
 * operations — closed, canonical, non-empty, always with `comment`, never a wildcard — and every other capability's
 * record states none. Step 7G-H5.5-P12-D2b defines how kinds decide an entry's state (catalog-contract.ts ›
 * readInteractionsPublication; tests/unit/modules/capability-read-interactions-publication.test.ts). Synthetic records
 * here; the accepted files are read as they are on disk.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INTERACTION_KINDS } from "@/integrations/providers/contract";
import { ANY, PLATFORM_CATALOG, type CatalogEntry } from "@/modules/capability";
import {
  CAPABILITY_REQUIRED_OPERATIONS,
  EVIDENCE_INTERACTION_KINDS,
  IMPLEMENTED_PLATFORM_OPERATIONS,
  OFFLINE_IMPLEMENTED_OPERATIONS,
  READ_INTERACTIONS_REQUIRED_OPERATIONS,
  apiValidationRecordViolations,
  isEvidenceInteractionKindSet,
  platformCatalogViolations,
  platformEntryViolations,
  type ApiValidationRecord,
  type CatalogContractContext,
} from "@/modules/capability/domain/catalog-contract";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const RECORDS = "design/phase-7g/meta-provider/api-validation/records/meta";
const onDisk = (file: string): ApiValidationRecord => JSON.parse(readFileSync(path.join(ROOT, RECORDS, file), "utf8")) as ApiValidationRecord;

const EVIDENCE = "api-validation:meta.facebook.read_interactions.20261101-01";
/** A synthetic read_interactions record: the shape a future accepted record would have. */
const RECORD: ApiValidationRecord = Object.freeze({
  id: EVIDENCE,
  provider: "meta",
  platform: "facebook",
  assetClass: "content_bearing",
  accountKind: "facebook_page",
  capability: "read_interactions",
  contentKind: "post",
  source: "unknown",
  operations: READ_INTERACTIONS_REQUIRED_OPERATIONS,
  validatedOn: "2026-11-01",
  sourceRevision: "b".repeat(40),
  requiredPermissions: Object.freeze(["synthetic_read_comments"]),
  scenario: "Synthetic fixture scenario: one controlled interaction read of a test asset.",
  observedResult: "Synthetic fixture result: list and get both returned the documented shape.",
  polarity: "positive",
  negativeBasis: null,
  reviewer: "TL",
  status: "accepted",
  interactionKinds: Object.freeze(["comment"] as const),
});
const record = (patch: Record<string, unknown>): ApiValidationRecord => ({ ...RECORD, ...patch });

describe("the declared operation set and the offline registrations", () => {
  it("read_interactions requires exactly getInteraction + listInteractions (never the content reads)", () => {
    expect(READ_INTERACTIONS_REQUIRED_OPERATIONS).toEqual(["getInteraction", "listInteractions"]);
    expect(CAPABILITY_REQUIRED_OPERATIONS.read_interactions).toEqual(["getInteraction", "listInteractions"]);
    expect(CAPABILITY_REQUIRED_OPERATIONS.read_interactions).not.toContain("listContent");
    expect(CAPABILITY_REQUIRED_OPERATIONS.read_interactions).not.toContain("getContent");
  });

  it("exactly Facebook and Instagram read_interactions are registered OFFLINE, each with exactly the declared set and its implemented kinds; and (P12-D2b) LIVE on their own records", () => {
    const offline = OFFLINE_IMPLEMENTED_OPERATIONS.filter((op) => op.capability === "read_interactions");
    expect(offline).toEqual([
      { provider: "meta", platform: "facebook", capability: "read_interactions", operations: ["getInteraction", "listInteractions"], interactionKinds: ["comment", "reply"] },
      { provider: "meta", platform: "instagram", capability: "read_interactions", operations: ["getInteraction", "listInteractions"], interactionKinds: ["comment"] },
    ]);
    for (const op of offline) expect(op.operations).toEqual(CAPABILITY_REQUIRED_OPERATIONS[op.capability]);
    expect(IMPLEMENTED_PLATFORM_OPERATIONS.map((op) => [op.platform, op.capability])).toEqual([["facebook", "read_content"], ["instagram", "read_content"], ["facebook", "read_interactions"], ["instagram", "read_interactions"]]);
  });

  it("the evidence kinds mirror the provider contract's closed INTERACTION_KINDS, in the same canonical order", () => {
    expect([...EVIDENCE_INTERACTION_KINDS]).toEqual([...INTERACTION_KINDS]);
    expect(EVIDENCE_INTERACTION_KINDS).toEqual(["comment", "reply"]);
  });
});

describe("interactionKinds on a record", () => {
  it("1. a read_content record without interactionKinds (absent) or with null is valid", () => {
    const content = record({ id: "api-validation:meta.facebook.read_content.20261101-01", capability: "read_content", operations: ["getContent", "listContent"], interactionKinds: undefined });
    expect(apiValidationRecordViolations(content)).toEqual([]);
    expect(apiValidationRecordViolations({ ...content, interactionKinds: null })).toEqual([]);
    const withoutField: Record<string, unknown> = { ...content };
    delete withoutField["interactionKinds"];
    expect(Object.keys(withoutField)).not.toContain("interactionKinds");
    expect(apiValidationRecordViolations(withoutField as unknown as ApiValidationRecord)).toEqual([]);
  });

  it.each([[["comment"]], [["comment", "reply"]], [[]]])("2. a read_content record with interactionKinds %j is invalid (not applicable)", (kinds) => {
    const content = record({ id: "api-validation:meta.facebook.read_content.20261101-01", capability: "read_content", operations: ["getContent", "listContent"], interactionKinds: kinds });
    expect(apiValidationRecordViolations(content)).toEqual(["INTERACTION_KINDS_NOT_APPLICABLE"]);
  });

  it("every other capability's record must state no kinds either", () => {
    for (const capability of ["read_history", "reply_public", "hide", "detect_native_replies"]) {
      const other = record({ id: `api-validation:meta.facebook.${capability}.20261101-01`, capability, interactionKinds: ["comment"] });
      expect(apiValidationRecordViolations(other), capability).toEqual(["INTERACTION_KINDS_NOT_APPLICABLE"]);
    }
  });

  it("3. a read_interactions record without interactionKinds (absent or null) is invalid", () => {
    expect(apiValidationRecordViolations(record({ interactionKinds: undefined }))).toEqual(["INTERACTION_KINDS_MALFORMED"]);
    expect(apiValidationRecordViolations(record({ interactionKinds: null }))).toEqual(["INTERACTION_KINDS_MALFORMED"]);
  });

  it("5–6. ['comment'] and ['comment', 'reply'] are valid shapes", () => {
    expect(apiValidationRecordViolations(record({ interactionKinds: ["comment"] }))).toEqual([]);
    expect(apiValidationRecordViolations(record({ interactionKinds: ["comment", "reply"] }))).toEqual([]);
  });

  it.each([
    ["4. empty", []],
    ["7. reply only", ["reply"]],
    ["8. non-canonical order", ["reply", "comment"]],
    ["9. a duplicate", ["comment", "comment"]],
    ["9. a duplicated reply", ["comment", "reply", "reply"]],
    ["10. an unknown kind", ["comment", "mention"]],
    ["10. any", ["any"]],
    ["10. any next to comment", ["comment", "any"]],
    ["a DM kind", ["comment", "direct_message"]],
    ["a prototype name", ["constructor"]],
    ["a non-string", ["comment", 1]],
    ["a bare string", "comment"],
    ["an object", { comment: true }],
    ["a wildcard string", "any"],
  ])("%s is malformed", (_label, kinds) => {
    expect(apiValidationRecordViolations(record({ interactionKinds: kinds }))).toEqual(["INTERACTION_KINDS_MALFORMED"]);
    expect(isEvidenceInteractionKindSet(kinds)).toBe(false);
  });

  it("the kinds never make a non-positive record positive: polarity, status and every other rule stand", () => {
    expect(apiValidationRecordViolations(record({ status: "rejected" }))).toEqual([]);
    expect(apiValidationRecordViolations(record({ polarity: "authoritative_negative", negativeBasis: null }))).toEqual(["POLARITY_BASIS_INCONSISTENT"]);
    expect(apiValidationRecordViolations(record({ sourceRevision: "abc" }))).toEqual(["SOURCE_REVISION_MALFORMED"]);
    expect(apiValidationRecordViolations(record({ operations: ["listInteractions", "getInteraction"] }))).toEqual(["OPERATIONS_MALFORMED"]);
  });
});

describe("an entry resting on a read_interactions record", () => {
  const ENTRY: CatalogEntry = Object.freeze({
    platform: "facebook", assetClass: "content_bearing", capability: "read_interactions", contentKind: "post", source: "unknown", state: "SUPPORTED", limitation: null,
    requiredPermissions: Object.freeze(["synthetic_read_comments"]), validation: "validated", evidence: EVIDENCE,
  });
  /** A hypothetical future: an accepted record, the offline registration and a matching LIVE registration. */
  const FUTURE: CatalogContractContext = {
    records: [RECORD],
    offlineImplementations: OFFLINE_IMPLEMENTED_OPERATIONS,
    implementedOperations: [{ provider: "meta", platform: "facebook", capability: "read_interactions", operations: READ_INTERACTIONS_REQUIRED_OPERATIONS, interactionKinds: ["comment"], evidence: EVIDENCE }],
    authorizationSemantics: "RESOLVED",
  };
  const check = (entry: Partial<CatalogEntry> = {}, context: Partial<CatalogContractContext> = {}) => platformEntryViolations({ ...ENTRY, ...entry }, { ...FUTURE, ...context });

  it("fully evidenced, a read_interactions entry is admissible exactly at the state its record's kinds derive (P12-D2b)", () => {
    // ["comment"] derives AVAILABLE_WITH_LIMITATION / REPLIES_NOT_READ: SUPPORTED is refused, the derived shape admitted.
    expect(check()).toEqual(["INTERACTION_KINDS_STATE_MISMATCH"]);
    expect(check({ state: "AVAILABLE_WITH_LIMITATION", limitation: { code: "HISTORY_DEPTH_LIMITED", value: 7 } })).toEqual(["INTERACTION_KINDS_STATE_MISMATCH"]);
    expect(check({ state: "AVAILABLE_WITH_LIMITATION", limitation: { code: "REPLIES_NOT_READ", value: null } })).toEqual([]);
    // A comment + reply record derives SUPPORTED — and its LIVE registration must state those kinds too.
    const full = { records: [record({ interactionKinds: ["comment", "reply"] })] };
    expect(check({}, full)).toEqual(["IMPLEMENTATION_EVIDENCE_MISMATCH"]);
    expect(check({}, { ...full, implementedOperations: [{ provider: "meta", platform: "facebook", capability: "read_interactions", operations: READ_INTERACTIONS_REQUIRED_OPERATIONS, interactionKinds: ["comment", "reply"], evidence: EVIDENCE }] })).toEqual([]);
  });

  it("11–13. the record's operations must be exactly getInteraction + listInteractions", () => {
    for (const operations of [["listInteractions"], ["getInteraction"], ["getContent", "getInteraction", "listInteractions"], ["getContent", "listContent"]]) {
      const v = check({}, { records: [record({ operations })] });
      expect(v, operations.join(",")).toContain("EVIDENCE_OPERATIONS_INCOMPLETE");
    }
  });

  it("a malformed kinds record invalidates the entry", () => {
    for (const kinds of [["reply"], null, ["any"]]) expect(check({}, { records: [record({ interactionKinds: kinds })] }), JSON.stringify(kinds)).toContain("EVIDENCE_RECORD_INVALID");
  });

  it("the read_content capability is untouched by the new rule", () => {
    const content = { ...ENTRY, capability: "read_content" as const, evidence: "api-validation:meta.facebook.read_content.20261101-01" };
    const v = platformEntryViolations(content, { ...FUTURE, records: [] });
    expect(v).not.toContain("INTERACTION_KINDS_STATE_MISMATCH");
    expect(v).not.toContain("INTERACTION_KINDS_NOT_IMPLEMENTED");
  });
});

describe("14–15. the accepted P11 read_content records are unchanged, and the r5 catalog is admissible against every record on disk", () => {
  it("both accepted read_content records validate as they are on disk: no interactionKinds field, 18 fields each", () => {
    for (const file of ["facebook/read_content/20261023-01.json", "instagram/read_content/20261023-01.json"]) {
      const stored = onDisk(file);
      expect(apiValidationRecordViolations(stored), file).toEqual([]);
      expect(Object.keys(stored), file).not.toContain("interactionKinds");
      expect(Object.keys(stored), file).toHaveLength(18);
    }
  });

  it("the platform catalog is r5: the two read_content entries plus the two read_interactions entries, all post / unknown, and admissible", () => {
    expect([PLATFORM_CATALOG.revision, PLATFORM_CATALOG.label, PLATFORM_CATALOG.entries.length]).toEqual([5, "platform-catalog-r5", 4]);
    expect(PLATFORM_CATALOG.entries.map((entry) => entry.capability)).toEqual(["read_content", "read_content", "read_interactions", "read_interactions"]);
    expect(PLATFORM_CATALOG.entries.every((entry) => entry.contentKind === "post" && entry.source === "unknown")).toBe(true);
    expect(PLATFORM_CATALOG.entries.some((entry) => entry.contentKind === ANY || entry.source === ANY)).toBe(false);
    const records = ["facebook/read_content/20261023-01.json", "instagram/read_content/20261023-01.json", "facebook/read_interactions/20261027-01.json", "instagram/read_interactions/20261026-01.json"].map(onDisk);
    expect(platformCatalogViolations(PLATFORM_CATALOG, { records, offlineImplementations: OFFLINE_IMPLEMENTED_OPERATIONS, implementedOperations: IMPLEMENTED_PLATFORM_OPERATIONS, authorizationSemantics: "RESOLVED" })).toEqual([]);
  });
});
