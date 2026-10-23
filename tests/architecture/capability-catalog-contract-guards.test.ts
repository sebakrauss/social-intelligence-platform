/**
 * Step 7G-H5.5-P4-B — static guards around the PLATFORM capability catalog before its first validated entry:
 *   - the catalog literal stayed `platform` r2 with zero entries through P4-B…P5-C9-B; Step 7G-H5.5-P5-C9-C publishes r3
 *     with exactly one entry, scoped exactly as the first accepted record (Facebook read_content · post · unknown); Step
 *     7G-H5.5-P11-E publishes r4, adding exactly the accepted Instagram read_content · post · unknown entry;
 *   - the entry contract (modules/capability/domain/catalog-contract.ts) is development/test-time only — no runtime code
 *     imports it, so the evaluator and every deployed plane are unchanged;
 *   - every evidence record on disk passes the schema and the secret scan, and the real catalog is admissible against
 *     them, the registered implementation evidence and today's (RESOLVED, Step 7G-H5.5-P4-C) authorization semantics;
 *   - implementation evidence names a real provider contract operation the adapter actually implements (G2's static
 *     half) and never an account-infrastructure read;
 *   - the documents state the resolved authorization semantics, the four dimensions, the P3 scope and the re-evaluation
 *     contract;
 *   - no interface copy presents a missing permission as platform non-support.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectSecrets } from "@/domain/secret-patterns";
import { MUTATION_OPERATIONS, READ_OPERATIONS } from "@/integrations/providers/contract";
import { ANY, CAPABILITY_KEYS, PLATFORM_CATALOG, type CatalogEntry } from "@/modules/capability";
import {
  ACCOUNT_INFRASTRUCTURE_OPERATIONS,
  API_VALIDATION_EVIDENCE_ID,
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
} from "@/modules/capability/domain/catalog-contract";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../support/source-scan";

const FIRST_RECORD_ID = "api-validation:meta.facebook.read_content.20261023-01";
const FIRST_RECORD_FILE = "design/phase-7g/meta-provider/api-validation/records/meta/facebook/read_content/20261023-01.json";
const INSTAGRAM_RECORD_ID = "api-validation:meta.instagram.read_content.20261023-01";
const INSTAGRAM_RECORD_FILE = "design/phase-7g/meta-provider/api-validation/records/meta/instagram/read_content/20261023-01.json";

const CONTRACT = "modules/capability/domain/catalog-contract.ts";
const EVIDENCE_DIR = "design/phase-7g/meta-provider/api-validation";
const RECORDS_DIR = `${EVIDENCE_DIR}/records`;
const META_README = "design/phase-7g/meta-provider/README.md";
const raw = (relative: string): string => readFileSync(path.join(REPOSITORY_ROOT, relative), "utf8");

function recordFiles(): string[] {
  const out: string[] = [];
  const walk = (relative: string): void => {
    const absolute = path.join(REPOSITORY_ROOT, relative);
    if (!existsSync(absolute)) return;
    for (const entry of readdirSync(absolute)) {
      const child = path.join(relative, entry);
      if (statSync(path.join(REPOSITORY_ROOT, child)).isDirectory()) walk(child);
      else out.push(child);
    }
  };
  walk(RECORDS_DIR);
  return out.sort();
}

/**
 * Whether the Meta adapter implements a provider contract operation: a read operation is implemented when the read port
 * does not route it to `refuse(…)`; a mutation needs a Meta mutation port, which does not exist yet.
 */
function metaOperationImplemented(operation: string, readPortCode: string, metaMutationPortExists: boolean): boolean {
  if ((READ_OPERATIONS as readonly string[]).includes(operation)) return new RegExp(`\\b${operation}\\s*:`).test(readPortCode) || new RegExp(`async\\s+${operation}\\s*\\(`).test(readPortCode)
    ? !new RegExp(`refuse\\("${operation}"\\)`).test(readPortCode)
    : false;
  if ((MUTATION_OPERATIONS as readonly string[]).includes(operation)) return metaMutationPortExists;
  return false;
}

describe("the platform catalog is r4 with exactly the two evidenced entries (P5-C9-C Facebook, P11-E Instagram)", () => {
  it("the catalog literal is r4 with two entries: facebook and instagram · content_bearing · read_content · post · unknown, SUPPORTED, each with its own permissions and accepted record", () => {
    expect([PLATFORM_CATALOG.id, PLATFORM_CATALOG.revision, PLATFORM_CATALOG.label]).toEqual(["platform", 4, "platform-catalog-r4"]);
    expect(PLATFORM_CATALOG.entries).toEqual([
      { platform: "facebook", assetClass: "content_bearing", capability: "read_content", contentKind: "post", source: "unknown", state: "SUPPORTED", limitation: null,
        requiredPermissions: ["pages_read_engagement", "pages_show_list"], validation: "validated", evidence: FIRST_RECORD_ID },
      { platform: "instagram", assetClass: "content_bearing", capability: "read_content", contentKind: "post", source: "unknown", state: "SUPPORTED", limitation: null,
        requiredPermissions: ["instagram_basic", "pages_read_engagement"], validation: "validated", evidence: INSTAGRAM_RECORD_ID },
    ]);
    // The literal names exactly the two evidence ids and no source other than "unknown" outside the simulator catalog.
    const code = codeOf("modules/capability/domain/catalog.ts");
    const platformLiteral = code.slice(code.indexOf("export const PLATFORM_CATALOG"), code.indexOf("const SIM_EVIDENCE"));
    expect(platformLiteral.match(/api-validation:[a-z0-9._-]+/g)).toEqual([FIRST_RECORD_ID, INSTAGRAM_RECORD_ID]);
    expect(platformLiteral).toMatch(/revision: 4,/);
    expect(platformLiteral).not.toMatch(/source: "(organic|paid|mixed|any)"|contentKind: "(?!post")|ANY|platform: "(?!facebook"|instagram")/);
    // The Instagram capability requires its read-path permissions only (never pages_show_list).
    expect(platformLiteral).toMatch(/requiredPermissions: Object\.freeze\(\["instagram_basic", "pages_read_engagement"\]\)/);
    expect(platformLiteral.match(/pages_show_list/g)).toHaveLength(1);
  });

  it("the entry contract is development/test-time only: no runtime file imports it, and the module's public API does not export it", () => {
    const runtime = sourceFiles(["app", "ui", "server", "domain", "modules", "mutations", "integrations", "ai", "jobs", "platform", "db", "tools"]).filter((file) => file !== CONTRACT);
    const importers = runtime.filter((file) => /catalog-contract/.test(codeOf(file)));
    expect(importers).toEqual([]);
    expect(codeOf("modules/capability/index.ts")).not.toMatch(/catalog-contract/);
  });

  it("the authorization semantics are RESOLVED (P4-C); TWO accepted records and TWO live registrations exist (Facebook P5-C9-B, Instagram P11-D); r4 publishes exactly one entry resting on each (P5-C9-C, P11-E)", () => {
    expect(FIRST_VALIDATED_PLATFORM_ENTRY_BLOCKED_UNTIL_AUTHORIZATION_SEMANTICS_RESOLVED).toBe(false);
    expect(AUTHORIZATION_SEMANTICS).toBe("RESOLVED");
    expect(recordFiles()).toEqual([FIRST_RECORD_FILE, INSTAGRAM_RECORD_FILE]);
    expect(IMPLEMENTED_PLATFORM_OPERATIONS).toHaveLength(2);
    // Publication was its own gate per platform: r4 has two entries, each resting on its own record and registration.
    expect(PLATFORM_CATALOG.revision).toBe(4);
    expect(PLATFORM_CATALOG.entries.map((entry) => entry.evidence)).toEqual([FIRST_RECORD_ID, INSTAGRAM_RECORD_ID]);
    expect(IMPLEMENTED_PLATFORM_OPERATIONS.map((op) => op.evidence)).toEqual([FIRST_RECORD_ID, INSTAGRAM_RECORD_ID]);
  });
});

describe("evidence records and implementation evidence", () => {
  const records: ApiValidationRecord[] = recordFiles().map((file) => JSON.parse(raw(file)) as ApiValidationRecord);

  it("every record on disk is a schema-valid .json file with no secret, stored at its id's path", () => {
    for (const file of recordFiles()) {
      expect(file, file).toMatch(/\.json$/);
      expect(detectSecrets(raw(file)), file).toEqual([]);
      const record = JSON.parse(raw(file)) as ApiValidationRecord;
      expect(apiValidationRecordViolations(record), file).toEqual([]);
      expect(file).toBe(`${RECORDS_DIR}/${record.id.replace(/^api-validation:/, "").replaceAll(".", "/")}.json`);
    }
  });

  it("every evidence id the contract admits is admitted by the stored column profile_entries.evidence_ref (0009 CHECK)", () => {
    const column = /evidence_ref\s+text check \(evidence_ref ~ '([^']+)'\)/.exec(readFileSync(path.join(REPOSITORY_ROOT, "db/migrations/0009_capability_profiles.sql"), "utf8"));
    expect(column).not.toBeNull();
    const stored = new RegExp(column?.[1] ?? "^$");
    const capabilities = ["read_content", "read_interactions", "read_history", "read_paid_context", "reply_public", "reply_private", "hide", "delete", "block", "detect_native_replies"];
    for (const [provider, platform] of [["meta", "facebook"], ["meta", "instagram"], ["tiktok", "tiktok"], ["p".repeat(32), "instagram"]] as const)
      for (const capability of capabilities) {
        const id = `api-validation:${provider}.${platform}.${capability}.20261231-99`;
        expect(API_VALIDATION_EVIDENCE_ID.test(id), id).toBe(true);
        expect(stored.test(id), id).toBe(true);
      }
    // The P4-B slash form would never have been storable.
    expect(stored.test("api-validation:meta/facebook/read_content/20261101-01")).toBe(false);
  });

  it("the real platform catalog is admissible against the records on disk, the registered implementations and today's semantics", () => {
    expect(platformCatalogViolations(PLATFORM_CATALOG, { records, offlineImplementations: OFFLINE_IMPLEMENTED_OPERATIONS, implementedOperations: IMPLEMENTED_PLATFORM_OPERATIONS, authorizationSemantics: AUTHORIZATION_SEMANTICS })).toEqual([]);
  });

  it("G2 (static): registered implementation evidence names a real, implemented, non-infrastructure operation with an accepted positive record", () => {
    expect(ACCOUNT_INFRASTRUCTURE_OPERATIONS.every((op) => (READ_OPERATIONS as readonly string[]).includes(op))).toBe(true);
    const readPort = codeOf("integrations/providers/meta/read-port.ts");
    const metaMutationPort = existsSync(path.join(REPOSITORY_ROOT, "integrations/providers/meta/mutation-port.ts"));
    for (const op of IMPLEMENTED_PLATFORM_OPERATIONS) {
      for (const name of op.operations) {
        expect(ACCOUNT_INFRASTRUCTURE_OPERATIONS).not.toContain(name);
        if (op.provider === "meta") expect(metaOperationImplemented(name, readPort, metaMutationPort), name).toBe(true);
      }
      const record = records.find((r) => r.id === op.evidence);
      expect(record?.status).toBe("accepted");
      expect(record?.polarity).toBe("positive");
      expect(record?.operations).toEqual(op.operations);
      expect(record?.operations).toEqual(CAPABILITY_REQUIRED_OPERATIONS[op.capability]);
      expect([record?.provider, record?.platform, record?.capability]).toEqual([op.provider, op.platform, op.capability]);
    }
    expect(IMPLEMENTED_PLATFORM_OPERATIONS.map((op) => op.evidence)).toEqual([FIRST_RECORD_ID, INSTAGRAM_RECORD_ID]);
  });

  it("P5-B (A, static): every OFFLINE registration names contract operations the adapter actually implements — the exact declared set", () => {
    const readPort = codeOf("integrations/providers/meta/read-port.ts");
    // Facebook Page (P5-B) and Instagram professional account (P11-B) read_content: offline-implemented, never evidence.
    expect(OFFLINE_IMPLEMENTED_OPERATIONS.map((op) => [op.provider, op.platform, op.capability])).toEqual([["meta", "facebook", "read_content"], ["meta", "instagram", "read_content"]]);
    for (const op of OFFLINE_IMPLEMENTED_OPERATIONS) {
      expect(op.operations).toEqual(CAPABILITY_REQUIRED_OPERATIONS[op.capability]);
      for (const name of op.operations) {
        expect([...READ_OPERATIONS, ...MUTATION_OPERATIONS] as readonly string[], name).toContain(name);
        expect(ACCOUNT_INFRASTRUCTURE_OPERATIONS).not.toContain(name);
        if (op.provider === "meta") expect(metaOperationImplemented(name, readPort, false), name).toBe(true);
      }
    }
    // Every declared set names real contract operations.
    for (const [capability, operations] of Object.entries(CAPABILITY_REQUIRED_OPERATIONS)) for (const name of operations) expect([...READ_OPERATIONS] as readonly string[], `${capability}:${name}`).toContain(name);
  });

  describe("P5-C9-B: the first accepted record — exact scope, exact operations, exact permissions", () => {
    const today = { records, offlineImplementations: OFFLINE_IMPLEMENTED_OPERATIONS, implementedOperations: IMPLEMENTED_PLATFORM_OPERATIONS, authorizationSemantics: AUTHORIZATION_SEMANTICS };
    const entry = (patch: Partial<CatalogEntry> = {}): CatalogEntry => ({ platform: "facebook", assetClass: "content_bearing", capability: "read_content", contentKind: "post", source: "unknown", state: "SUPPORTED",
      limitation: null, requiredPermissions: ["pages_read_engagement", "pages_show_list"], validation: "validated", evidence: FIRST_RECORD_ID, ...patch });
    const check = (patch: Partial<CatalogEntry> = {}) => platformEntryViolations(entry(patch), today);

    it("the record parses, is accepted and positive, and states exactly the approved scope, operations and permissions", () => {
      const record = records.find((r) => r.id === FIRST_RECORD_ID);
      expect(record).toBeDefined();
      expect(apiValidationRecordViolations(record as ApiValidationRecord)).toEqual([]);
      expect(record).toMatchObject({
        provider: "meta", platform: "facebook", assetClass: "content_bearing", accountKind: "facebook_page", capability: "read_content",
        contentKind: "post", source: "unknown", operations: ["getContent", "listContent"], validatedOn: "2026-10-23",
        sourceRevision: "fb91ead8bfb79e8c8a5c1a210f65800997afc9b1", requiredPermissions: ["pages_read_engagement", "pages_show_list"],
        polarity: "positive", negativeBasis: null, reviewer: "TL", status: "accepted",
      });
      expect(record?.operations).toEqual(READ_CONTENT_REQUIRED_OPERATIONS);
      // Not the observed grant set, never the user-content permission.
      for (const p of ["business_management", "instagram_basic", "public_profile", "pages_read_user_content"]) expect(record?.requiredPermissions).not.toContain(p);
      // No claim of organic/paid source, minimality or independent AWS verification in the free text.
      expect(`${record?.scenario ?? ""} ${record?.observedResult ?? ""}`).not.toMatch(/\borganic\b|\bpaid\b|minimal|CloudTrail|arn:|run_/i);
    });

    it("the r4 catalog is admissible, and its Facebook entry IS the matching post / unknown entry (P5-C9-C, unchanged)", () => {
      expect(platformCatalogViolations(PLATFORM_CATALOG, today)).toEqual([]);
      expect(check()).toEqual([]);
      expect(PLATFORM_CATALOG.entries.filter((e) => e.platform === "facebook")).toEqual([entry()]);
    });

    it("the record supports NO other source: organic, paid, mixed and any are refused (scope mismatch, fail closed)", () => {
      for (const source of ["organic", "paid", "mixed", ANY] as const) expect(check({ source }), source).toContain("EVIDENCE_SCOPE_MISMATCH");
    });

    it("the record supports NO other content kind, platform, asset class or capability", () => {
      for (const contentKind of ["reel", "video", "story", ANY] as const) expect(check({ contentKind }), contentKind).toContain("EVIDENCE_SCOPE_MISMATCH");
      // The Facebook record never backs an Instagram entry: scope mismatch, and Instagram's live registration rests on its OWN record.
      expect(check({ platform: "instagram" })).toEqual(expect.arrayContaining(["EVIDENCE_SCOPE_MISMATCH", "IMPLEMENTATION_EVIDENCE_MISMATCH"]));
      expect(check({ platform: "instagram" })).not.toContain("IMPLEMENTATION_INCOMPLETE");
      expect(check({ assetClass: "ad_account" })).toContain("EVIDENCE_SCOPE_MISMATCH");
      for (const capability of CAPABILITY_KEYS.filter((key) => key !== "read_content")) expect(check({ capability }), capability).toEqual(expect.arrayContaining(["EVIDENCE_SCOPE_MISMATCH", "REQUIRED_OPERATIONS_UNDEFINED"]));
    });

    it("the record's permissions are exact: adding the user-content permission or dropping one is refused", () => {
      expect(check({ requiredPermissions: ["pages_read_engagement", "pages_read_user_content", "pages_show_list"] })).toContain("EVIDENCE_PERMISSIONS_MISMATCH");
      expect(check({ requiredPermissions: ["pages_read_engagement"] })).toContain("EVIDENCE_PERMISSIONS_MISMATCH");
    });

    it("the record cannot back an UNSUPPORTED entry (polarity)", () => {
      expect(check({ state: "UNSUPPORTED", requiredPermissions: [] })).toContain("EVIDENCE_POLARITY_MISMATCH");
    });
  });

  describe("P11-D: the accepted Instagram record — exact post / unknown scope, both operations, its own permissions", () => {
    const today = { records, offlineImplementations: OFFLINE_IMPLEMENTED_OPERATIONS, implementedOperations: IMPLEMENTED_PLATFORM_OPERATIONS, authorizationSemantics: AUTHORIZATION_SEMANTICS };
    const entry = (patch: Partial<CatalogEntry> = {}): CatalogEntry => ({ platform: "instagram", assetClass: "content_bearing", capability: "read_content", contentKind: "post", source: "unknown", state: "SUPPORTED",
      limitation: null, requiredPermissions: ["instagram_basic", "pages_read_engagement"], validation: "validated", evidence: INSTAGRAM_RECORD_ID, ...patch });
    const check = (patch: Partial<CatalogEntry> = {}) => platformEntryViolations(entry(patch), today);

    it("the record parses, is accepted and positive, and states exactly the approved scope, operations and permissions", () => {
      const record = records.find((r) => r.id === INSTAGRAM_RECORD_ID);
      expect(record).toBeDefined();
      expect(apiValidationRecordViolations(record as ApiValidationRecord)).toEqual([]);
      expect(Object.keys(record ?? {})).toHaveLength(18);
      expect(record).toMatchObject({
        provider: "meta", platform: "instagram", assetClass: "content_bearing", accountKind: "instagram_professional_account", capability: "read_content",
        contentKind: "post", source: "unknown", operations: ["getContent", "listContent"], validatedOn: "2026-10-23",
        sourceRevision: "cd2c86365e71c589847a7b35e115ff1b4ac30ba8", requiredPermissions: ["instagram_basic", "pages_read_engagement"],
        polarity: "positive", negativeBasis: null, reviewer: "TL", status: "accepted",
      });
      expect(record?.operations).toEqual(READ_CONTENT_REQUIRED_OPERATIONS);
      // The known requirements of the implemented read path: never the granted set, never a minimality claim.
      for (const p of ["pages_show_list", "business_management", "public_profile", "pages_read_user_content"]) expect(record?.requiredPermissions).not.toContain(p);
      const text = `${record?.scenario ?? ""} ${record?.observedResult ?? ""}`;
      expect(text).not.toMatch(/\borganic\b|\bpaid\b|minimal|CloudTrail|arn:|run_|\breel\b|\bcarousel\b|\bstor(y|ies)\b/i);
      expect(text).toMatch(/IMAGE on the FEED surface normalized to content kind post/);
      expect(text).toMatch(/no Page token derived/);
    });

    it("the Instagram post / unknown entry is admissible (A + B + record) and IS the r4 Instagram entry (P11-E)", () => {
      expect(check()).toEqual([]);
      expect(PLATFORM_CATALOG.entries.filter((e) => e.platform === "instagram")).toEqual([entry()]);
      expect(platformCatalogViolations(PLATFORM_CATALOG, today)).toEqual([]);
    });

    it("the record supports NO other kind: video, reel, carousel, story and any are refused", () => {
      for (const contentKind of ["video", "reel", "carousel", "story", ANY] as const) expect(check({ contentKind }), contentKind).toContain("EVIDENCE_SCOPE_MISMATCH");
    });

    it("the record supports NO other source: organic, paid, mixed and any are refused; nor any / any", () => {
      for (const source of ["organic", "paid", "mixed", ANY] as const) expect(check({ source }), source).toContain("EVIDENCE_SCOPE_MISMATCH");
      expect(check({ contentKind: ANY, source: ANY })).toContain("EVIDENCE_SCOPE_MISMATCH");
      expect(check({ contentKind: ANY, source: "unknown" })).toContain("EVIDENCE_SCOPE_MISMATCH");
    });

    it("no cross-platform reuse: the Instagram record never backs Facebook, and the Facebook record never backs Instagram", () => {
      expect(check({ platform: "facebook" })).toEqual(expect.arrayContaining(["EVIDENCE_SCOPE_MISMATCH", "IMPLEMENTATION_EVIDENCE_MISMATCH"]));
      expect(check({ evidence: FIRST_RECORD_ID })).toEqual(expect.arrayContaining(["EVIDENCE_SCOPE_MISMATCH", "IMPLEMENTATION_EVIDENCE_MISMATCH"]));
      expect(check({ assetClass: "ad_account" })).toContain("EVIDENCE_SCOPE_MISMATCH");
      for (const capability of CAPABILITY_KEYS.filter((key) => key !== "read_content")) expect(check({ capability }), capability).toEqual(expect.arrayContaining(["EVIDENCE_SCOPE_MISMATCH", "REQUIRED_OPERATIONS_UNDEFINED"]));
    });

    it("the record's permissions are exact: adding pages_show_list or dropping one is refused; it cannot back UNSUPPORTED", () => {
      expect(check({ requiredPermissions: ["instagram_basic", "pages_read_engagement", "pages_show_list"] })).toContain("EVIDENCE_PERMISSIONS_MISMATCH");
      expect(check({ requiredPermissions: ["instagram_basic"] })).toContain("EVIDENCE_PERMISSIONS_MISMATCH");
      expect(check({ state: "UNSUPPORTED", requiredPermissions: [] })).toContain("EVIDENCE_POLARITY_MISMATCH");
    });

    it("the Facebook record and registration are unchanged", () => {
      expect(records.find((r) => r.id === FIRST_RECORD_ID)).toMatchObject({ platform: "facebook", contentKind: "post", source: "unknown", sourceRevision: "fb91ead8bfb79e8c8a5c1a210f65800997afc9b1", requiredPermissions: ["pages_read_engagement", "pages_show_list"] });
      expect(IMPLEMENTED_PLATFORM_OPERATIONS[0]).toEqual({ provider: "meta", platform: "facebook", capability: "read_content", operations: ["getContent", "listContent"], evidence: FIRST_RECORD_ID });
    });
  });

  it("the implementation checker reads the adapter as it is: describeAccount, listContent, getContent implemented; other capability reads refused; no Meta mutation port", () => {
    const readPort = codeOf("integrations/providers/meta/read-port.ts");
    for (const op of ["describeAccount", "listContent", "getContent"]) expect(metaOperationImplemented(op, readPort, false), op).toBe(true);
    for (const op of ["listInteractions", "getInteraction", "getCurrentState", "retrievePaidContext"]) expect(metaOperationImplemented(op, readPort, false), op).toBe(false);
    expect(existsSync(path.join(REPOSITORY_ROOT, "integrations/providers/meta/mutation-port.ts"))).toBe(false);
    for (const op of MUTATION_OPERATIONS) expect(metaOperationImplemented(op, readPort, false)).toBe(false);
    expect(metaOperationImplemented("notAnOperation", readPort, true)).toBe(false);
  });
});

describe("documents state the contract", () => {
  it("the evidence contract README defines the record fields, the forbidden content and the blocker", () => {
    const doc = raw(`${EVIDENCE_DIR}/README.md`);
    for (const field of ["`id`", "`provider`", "`platform`", "`assetClass`", "`accountKind`", "`capability`", "`contentKind`, `source`", "`operations`", "`validatedOn`", "`sourceRevision`", "`requiredPermissions`", "`scenario`", "`observedResult`", "`polarity`", "`negativeBasis`", "`reviewer`", "`status`"]) {
      expect(doc, field).toContain(field);
    }
    for (const phrase of ["api-validation:{provider}.{platform}.{capability}.{YYYYMMDD}-{NN}", "Never in a record: access tokens", "FIRST_VALIDATED_PLATFORM_ENTRY_BLOCKED_UNTIL_AUTHORIZATION_SEMANTICS_RESOLVED = NO", "never an entry: it is the catalog default", "never an entry: it is a profile-only state"]) {
      expect(doc, phrase).toContain(phrase);
    }
  });

  it("the Meta README records the P3 scope, the four dimensions, the authorization semantics and the re-evaluation contract", () => {
    const doc = raw(META_README);
    for (const phrase of [
      "P3 validated **account description only**",
      "did **NOT** validate any of the\nten product capabilities, and no mutation capability was tested",
      "\"Can Wrenkind perform X now for this connected account?\"",
      "A capability-profile `SUPPORTED` requires dimensions 1–3 proven",
      "`ACCOUNT_PERMISSION_MISSING` is an authorization condition, not proof of intrinsic provider/platform non-support",
      "**Authorization semantics — RESOLVED (Step 7G-H5.5-P4-C).**",
      "| NOT_AUTHORIZED | the provider/account supports it, but Wrenkind lacks the current provider authorization |",
      "`AUTO_REEVALUATE_AFTER_REAUTHORIZED = NOT_IMPLEMENTED`",
      "NOT_AUTHORIZED (availability ACCOUNT_PERMISSION_MISSING) must never become `CAPABILITY_UNSUPPORTED`",
      "`FIRST_VALIDATED_PLATFORM_ENTRY_BLOCKED_UNTIL_AUTHORIZATION_SEMANTICS_RESOLVED = NO`",
      "No automatic reconcile is enabled",
      "the canonical paired Trigger release (`npm run trigger:release`, INTEGRATION then MAIN)",
    ]) {
      expect(doc, phrase).toContain(phrase);
    }
    // Sanitized: no long numeric provider ids or UUIDs in the P3 section.
    const p3 = doc.slice(doc.indexOf("**First live capability evaluations"), doc.indexOf("**H6 readiness contract.**"));
    expect(p3).not.toMatch(/\d{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|proj_|arn:aws|dpl_|run_/);
  });
});

describe("P5-B documents: Facebook read_content implemented offline, validated live nowhere", () => {
  it("the Meta README states the P5-B status, the operations, the requests, the token model, the scope and the unresolved items", () => {
    const doc = raw(META_README);
    for (const phrase of [
      "## Facebook Page read_content (Step 7G-H5.5-P5-B) — IMPLEMENTED_OFFLINE_NOT_LIVE_VALIDATED",
      "`READ_CONTENT_REQUIRED_OPERATIONS = [listContent, getContent]`",
      "`GET /v25.0/{page-id}?fields=access_token`",
      "`GET /v25.0/{page-id}/published_posts?fields=id,from,message,created_time,updated_time,status_type&limit=10[&after={cursor}]`",
      "`GET /v25.0/{post-id}?fields=id,from,message,created_time,updated_time,status_type`",
      "**`/published_posts`, never `/feed`**",
      "`pages_read_user_content` is NOT added",
      "**First catalog scope: PROPOSED, not accepted**",
      "| LIVE_VALIDATED_OPERATIONS (`IMPLEMENTED_PLATFORM_OPERATIONS`) | none |",
      "| API_VALIDATION_RECORD_COUNT | 0 |",
      "**Unresolved (to be established LIVE; none is a validated fact):**",
      "pagination ordering of `/published_posts`",
      "the future `organic` classification of Page-published content",
      "Page role / task behavior",
      "the Page Access Token derivation's LIVE behavior",
      "INTEGRATION now discovers 4 tasks (2 product + 2 diagnostics); MAIN stays at 6.",
    ]) {
      expect(doc, phrase).toContain(phrase);
    }
    // The P5-B section itself (up to the C9-B acceptance section, which cites Meta-owned URLs and the evidence id).
    const section = doc.slice(doc.indexOf("## Facebook Page read_content (Step 7G-H5.5-P5-B)"), doc.indexOf("## Facebook read_content LIVE evidence accepted (Step 7G-H5.5-P5-C9-B)"));
    expect(section.length).toBeGreaterThan(0);
    expect(section).not.toMatch(/\d{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|proj_|arn:aws|dpl_|run_[a-z0-9]{6,}|https?:\/\//);
    // The C9-B section: no provider/account/run/AWS identifiers; the only digit run is the evidence date; URLs only Meta-owned.
    const accepted = doc.slice(doc.indexOf("## Facebook read_content LIVE evidence accepted (Step 7G-H5.5-P5-C9-B)"));
    expect(accepted).not.toMatch(/\d{9,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|proj_|arn:aws|dpl_|run_[a-z0-9]{6,}|worker_/);
    expect([...accepted.matchAll(/\d{8,}/g)].map((m) => m[0]).every((d) => d === "20261023")).toBe(true);
    for (const url of accepted.match(/https?:\/\/[^\s`)]+/g) ?? []) expect(url, url).toMatch(/^https:\/\/(developers\.facebook\.com|www\.postman\.com\/meta\/)/);
  });

  it("the evidence contract documents the first accepted read_content record (P5-C9-B)", () => {
    const doc = raw(`${EVIDENCE_DIR}/README.md`);
    expect(doc).toContain("## Facebook read_content: first accepted record (Step 7G-H5.5-P5-C9-B)");
    expect(doc).toContain("`api-validation:meta.facebook.read_content.20261023-01`");
    expect(doc).toContain("`source` `unknown`");
    expect(recordFiles()).toEqual([FIRST_RECORD_FILE, INSTAGRAM_RECORD_FILE]);
  });

  it("the READMEs record the P11-D Instagram acceptance: exact scope, no other kind or source, permissions semantics, no catalog change", () => {
    const meta = raw(META_README);
    const section = meta.slice(meta.indexOf("## Instagram read_content LIVE evidence accepted (Step 7G-H5.5-P11-D)"));
    expect(section.length).toBeGreaterThan(0);
    for (const phrase of [
      "`api-validation:meta.instagram.read_content.20261023-01`",
      "`instagram` · `content_bearing` ·\n`read_content` · `post` · `unknown`",
      "`video`, `reel` and `carousel` stay unvalidated",
      "the provider path proves neither organic nor paid",
      "no globally\n  minimal permission set is claimed",
      "Accepting this record does NOT change the catalog.",
    ]) expect(section, phrase).toContain(phrase);
    const evidence = raw(`${EVIDENCE_DIR}/README.md`);
    expect(evidence).toContain("## Instagram read_content: first accepted record (Step 7G-H5.5-P11-D)");
    expect(evidence).toContain("`api-validation:meta.instagram.read_content.20261023-01`");
    expect(evidence).not.toContain("expected future evidence shape\n\nP11-B");
  });

  it("the Meta README records the C9-B acceptance with its authoritative references and the permission/source semantics", () => {
    const doc = raw(META_README);
    for (const phrase of [
      "## Facebook read_content LIVE evidence accepted (Step 7G-H5.5-P5-C9-B)",
      "`requiredPermissions` = the known provider/contract conditions",
      "observed granted permissions are account facts",
      "does NOT claim a globally minimal permission set",
      "`unknown` is a real capability-source value",
      "organic, paid and mixed remain unvalidated",
      "| R13 |",
      "Accepting this record does NOT change the catalog",
    ]) expect(doc, phrase).toContain(phrase);
  });

  it("the Meta README records r4 (P11-E): exact Instagram scope, permissions, no broadening, Re-check pending, runtime not on r4", () => {
    const doc = raw(META_README);
    const section = doc.slice(doc.indexOf("## Platform catalog r4: first published Instagram capability (Step 7G-H5.5-P11-E)"));
    expect(section.length).toBeGreaterThan(0);
    for (const phrase of [
      "`api-validation:meta.instagram.read_content.20261023-01`",
      "| requiredPermissions | `instagram_basic`, `pages_read_engagement` |",
      "`pages_show_list` is not an Instagram read_content requirement",
      "Organic or paid\nsupport is not claimed",
      "`PROFILE_STALE`",
      "The runtime does not use r4 yet",
    ]) expect(section, phrase).toContain(phrase);
  });

  it("the Meta README records r3 (P5-C9-C): exact scope, no broadening, Re-check pending, runtime not on r3", () => {
    const doc = raw(META_README);
    const section = doc.slice(doc.indexOf("## Platform catalog r3: first published supported capability (Step 7G-H5.5-P5-C9-C)"));
    expect(section.length).toBeGreaterThan(0);
    for (const phrase of [
      "`read_content` · `post` · `unknown`",
      "`api-validation:meta.facebook.read_content.20261023-01`",
      "No `organic`, `paid`, `mixed` or `any` source entry exists",
      "`PROFILE_STALE`",
      "future H6 caller work",
      "The runtime does not use r3 yet",
    ]) expect(section, phrase).toContain(phrase);
  });
});

describe("interface copy never presents a missing permission as platform non-support", () => {
  it("no message about a missing permission says the platform does not support or offer the capability", () => {
    const catalogs = sourceFiles(["platform/i18n/catalogs"]);
    expect(catalogs.length).toBeGreaterThan(0);
    for (const file of catalogs) {
      for (const match of Array.from(raw(file).matchAll(/"([a-z0-9_.]*permission[a-z0-9_.]*)":\s*"([^"]*)"/gi))) {
        const [, key = "", text = ""] = match;
        expect(text, `${file} ${key}`).not.toMatch(/not support|doesn.t support|unsupported|doesn.t offer|not offered|not available on (facebook|instagram|tiktok|the platform)/i);
      }
    }
  });
});
