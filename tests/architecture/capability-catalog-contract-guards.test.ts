/**
 * Step 7G-H5.5-P4-B — static guards around the PLATFORM capability catalog before its first validated entry:
 *   - the catalog literal stays `platform` r2 with zero entries (P4-B adds none and stales no profile);
 *   - the entry contract (modules/capability/domain/catalog-contract.ts) is development/test-time only — no runtime code
 *     imports it, so the evaluator and every deployed plane are unchanged;
 *   - every evidence record on disk passes the schema and the secret scan, and the real catalog is admissible against
 *     them, the registered implementation evidence and today's (OPEN) authorization semantics;
 *   - implementation evidence names a real provider contract operation the adapter actually implements (G2's static
 *     half) and never an account-infrastructure read;
 *   - the documents state the blocker, the four dimensions, the P3 scope and the re-evaluation contract;
 *   - no interface copy presents a missing permission as platform non-support.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectSecrets } from "@/domain/secret-patterns";
import { MUTATION_OPERATIONS, READ_OPERATIONS } from "@/integrations/providers/contract";
import { PLATFORM_CATALOG } from "@/modules/capability";
import {
  ACCOUNT_INFRASTRUCTURE_OPERATIONS,
  AUTHORIZATION_SEMANTICS,
  FIRST_VALIDATED_PLATFORM_ENTRY_BLOCKED_UNTIL_AUTHORIZATION_SEMANTICS_RESOLVED,
  IMPLEMENTED_PLATFORM_OPERATIONS,
  apiValidationRecordViolations,
  platformCatalogViolations,
  type ApiValidationRecord,
} from "@/modules/capability/domain/catalog-contract";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../support/source-scan";

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

describe("the platform catalog is frozen at r2 with zero entries", () => {
  it("the literal in catalog.ts is exactly the empty r2 catalog", () => {
    expect(codeOf("modules/capability/domain/catalog.ts")).toContain(
      'export const PLATFORM_CATALOG: CapabilityCatalog = Object.freeze({ id: "platform", revision: 2, label: "platform-catalog-r2", entries: Object.freeze([]) });',
    );
    expect(PLATFORM_CATALOG.entries).toHaveLength(0);
  });

  it("the entry contract is development/test-time only: no runtime file imports it, and the module's public API does not export it", () => {
    const runtime = sourceFiles(["app", "ui", "server", "domain", "modules", "mutations", "integrations", "ai", "jobs", "platform", "db", "tools"]).filter((file) => file !== CONTRACT);
    const importers = runtime.filter((file) => /catalog-contract/.test(codeOf(file)));
    expect(importers).toEqual([]);
    expect(codeOf("modules/capability/index.ts")).not.toMatch(/catalog-contract/);
  });

  it("the first validated entry stays blocked while the authorization semantics are OPEN", () => {
    expect(FIRST_VALIDATED_PLATFORM_ENTRY_BLOCKED_UNTIL_AUTHORIZATION_SEMANTICS_RESOLVED).toBe(true);
    expect(AUTHORIZATION_SEMANTICS).toBe("OPEN");
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
      expect(file).toBe(`${RECORDS_DIR}/${record.id.replace(/^api-validation:/, "")}.json`);
    }
  });

  it("the real platform catalog is admissible against the records on disk, the registered implementations and today's semantics", () => {
    expect(platformCatalogViolations(PLATFORM_CATALOG, { records, implementedOperations: IMPLEMENTED_PLATFORM_OPERATIONS, authorizationSemantics: AUTHORIZATION_SEMANTICS })).toEqual([]);
  });

  it("G2 (static): registered implementation evidence names a real, implemented, non-infrastructure operation with an accepted positive record", () => {
    expect(ACCOUNT_INFRASTRUCTURE_OPERATIONS.every((op) => (READ_OPERATIONS as readonly string[]).includes(op))).toBe(true);
    const readPort = codeOf("integrations/providers/meta/read-port.ts");
    const metaMutationPort = existsSync(path.join(REPOSITORY_ROOT, "integrations/providers/meta/mutation-port.ts"));
    for (const op of IMPLEMENTED_PLATFORM_OPERATIONS) {
      expect(ACCOUNT_INFRASTRUCTURE_OPERATIONS).not.toContain(op.operation);
      if (op.provider === "meta") expect(metaOperationImplemented(op.operation, readPort, metaMutationPort), op.operation).toBe(true);
      const record = records.find((r) => r.id === op.evidence);
      expect(record?.status).toBe("accepted");
      expect(record?.polarity).toBe("positive");
      expect(record?.operation).toBe(op.operation);
    }
    expect(IMPLEMENTED_PLATFORM_OPERATIONS).toEqual([]);
  });

  it("the implementation checker reads the adapter as it is: describeAccount implemented; capability reads refused; no Meta mutation port", () => {
    const readPort = codeOf("integrations/providers/meta/read-port.ts");
    expect(metaOperationImplemented("describeAccount", readPort, false)).toBe(true);
    for (const op of ["listContent", "listInteractions", "getInteraction", "getContent", "getCurrentState", "retrievePaidContext"]) expect(metaOperationImplemented(op, readPort, false), op).toBe(false);
    expect(existsSync(path.join(REPOSITORY_ROOT, "integrations/providers/meta/mutation-port.ts"))).toBe(false);
    for (const op of MUTATION_OPERATIONS) expect(metaOperationImplemented(op, readPort, false)).toBe(false);
    expect(metaOperationImplemented("notAnOperation", readPort, true)).toBe(false);
  });
});

describe("documents state the contract", () => {
  it("the evidence contract README defines the record fields, the forbidden content and the blocker", () => {
    const doc = raw(`${EVIDENCE_DIR}/README.md`);
    for (const field of ["`id`", "`provider`", "`platform`", "`assetClass`", "`accountKind`", "`capability`", "`contentKind`, `source`", "`operation`", "`validatedOn`", "`sourceRevision`", "`requiredPermissions`", "`scenario`", "`observedResult`", "`polarity`", "`negativeBasis`", "`reviewer`", "`status`"]) {
      expect(doc, field).toContain(field);
    }
    for (const phrase of ["api-validation:{provider}/{platform}/{capability}/{YYYYMMDD}-{NN}", "Never in a record: access tokens", "FIRST_VALIDATED_PLATFORM_ENTRY_BLOCKED_UNTIL_AUTHORIZATION_SEMANTICS_RESOLVED = YES", "never an entry: it is the catalog default"]) {
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
      "AUTHORIZATION_SEMANTICS_OPEN_BEFORE_FIRST_VALIDATED_ENTRY",
      "`FIRST_VALIDATED_PLATFORM_ENTRY_BLOCKED_UNTIL_AUTHORIZATION_SEMANTICS_RESOLVED = YES`",
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
