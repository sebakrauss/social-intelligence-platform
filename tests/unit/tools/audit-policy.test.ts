/**
 * Step H7-D1b-sec1 — the dependency-audit policy (FULL npm audit − EXACT temporary exceptions = PASS), on synthetic
 * `npm audit --json` reports and lockfiles only (no registry, no npm). Plus the CI wiring and the exception record.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_EXCEPTIONS, type AuditException } from "@/tools/audit-policy/exceptions";
import { evaluateAuditPolicy, type AuditPolicyInput } from "@/tools/audit-policy/policy";
import { REPOSITORY_ROOT } from "../../support/source-scan";

const APPROVED = "GHSA-g3hv-75wg-m249";
const OTHER = "GHSA-2c8m-qq4x-7wph";
const EXCEPTION: AuditException = { advisory: APPROVED, package: "minimatch", maxSeverity: "moderate", scope: "dev", authorizedOn: "2026-10-31", expiresOn: "2026-11-30", reason: "synthetic", remediation: "synthetic" };
const TODAY = "2026-11-01";

type Via = string | Record<string, unknown>;
interface Entry { readonly name: string; readonly severity: string; readonly via: readonly Via[]; readonly nodes: readonly string[] }

const advisory = (id: string, name: string, severity = "moderate", url = `https://github.com/advisories/${id}`): Record<string, unknown> =>
  ({ source: 1, name, dependency: name, title: "synthetic", url, severity, cwe: [], cvss: { score: 0, vectorString: null }, range: "<11.0.1" });
const report = (entries: readonly Entry[]): Record<string, unknown> => ({
  auditReportVersion: 2,
  vulnerabilities: Object.fromEntries(entries.map((e) => [e.name, { name: e.name, severity: e.severity, isDirect: false, via: e.via, effects: [], range: "*", nodes: e.nodes, fixAvailable: false }])),
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: entries.length, high: 0, critical: 0, total: entries.length }, dependencies: { prod: 1, dev: 1, optional: 0, peer: 0, peerOptional: 0, total: 2 } },
});
const EMPTY = report([]);
/** The real shape: minimatch (two installs) + eslint and eslint-plugin-react depending on it. */
const DEV_TREE: readonly Entry[] = [
  { name: "minimatch", severity: "moderate", via: [advisory(APPROVED, "minimatch")], nodes: ["node_modules/minimatch", "node_modules/@typescript-eslint/typescript-estree/node_modules/minimatch"] },
  { name: "eslint", severity: "moderate", via: ["minimatch"], nodes: ["node_modules/eslint"] },
  { name: "eslint-plugin-react", severity: "moderate", via: ["minimatch"], nodes: ["node_modules/eslint-plugin-react"] },
];
const lockfile = (overrides: Readonly<Record<string, Record<string, unknown>>> = {}): Record<string, unknown> => ({
  lockfileVersion: 3,
  packages: {
    "": { name: "app" },
    "node_modules/minimatch": { version: "3.1.5", dev: true },
    "node_modules/@typescript-eslint/typescript-estree/node_modules/minimatch": { version: "10.2.6", dev: true },
    "node_modules/eslint": { version: "9.39.5", dev: true },
    "node_modules/eslint-plugin-react": { version: "7.37.5", dev: true },
    "node_modules/next": { version: "16.4.2" },
    ...overrides,
  },
});
const run = (input: Partial<AuditPolicyInput> = {}) => evaluateAuditPolicy({ full: report(DEV_TREE), production: EMPTY, lockfile: lockfile(), today: TODAY, exceptions: [EXCEPTION], ...input });

describe("the exact temporary exception", () => {
  it("1 · the approved GHSA on a dev-only tree ⇒ PASS_WITH_TEMPORARY_EXCEPTION (visible: advisory, nodes, applied exception)", () => {
    const result = run();
    expect(result.verdict).toBe("PASS_WITH_TEMPORARY_EXCEPTION");
    expect(result.reasons).toEqual([]);
    expect(result.advisories.map((a) => [a.advisory, a.severity, a.package])).toEqual([[APPROVED, "moderate", "minimatch"]]);
    expect(result.nodes).toHaveLength(4);
    expect(result.appliedExceptions.map((e) => e.advisory)).toEqual([APPROVED]);
  });

  it("2 · the same GHSA on a production package ⇒ FAIL (lockfile scope and the --omit=dev cross-check)", () => {
    expect(run({ lockfile: lockfile({ "node_modules/minimatch": { version: "3.1.5" } }) })).toMatchObject({ verdict: "FAIL", reasons: ["not_dev_only:node_modules/minimatch"] });
    const production = report([DEV_TREE[0] as Entry]);
    expect(run({ production }).reasons).toContain("production_audit_not_clean:1");
  });

  it("3–4 · an unknown moderate or high advisory ⇒ FAIL", () => {
    for (const severity of ["moderate", "high"]) {
      const result = run({ full: report([{ name: "left-pad", severity, via: [advisory(OTHER, "left-pad", severity)], nodes: ["node_modules/left-pad"] }]), lockfile: lockfile({ "node_modules/left-pad": { dev: true } }) });
      expect(result.verdict, severity).toBe("FAIL");
      expect(result.reasons, severity).toContain(`unapproved_advisory:${OTHER}:${severity}:left-pad`);
    }
  });

  it("5 · several advisories including the approved one ⇒ FAIL on the unapproved one (the approved one is still reported)", () => {
    const result = run({ full: report([...DEV_TREE, { name: "left-pad", severity: "low", via: [advisory(OTHER, "left-pad", "low")], nodes: ["node_modules/left-pad"] }]), lockfile: lockfile({ "node_modules/left-pad": { dev: true } }) });
    expect(result.verdict).toBe("FAIL");
    expect(result.reasons).toEqual([`unapproved_advisory:${OTHER}:low:left-pad`]);
    expect(result.advisories.map((a) => a.advisory).sort()).toEqual([OTHER, APPROVED].sort());
  });

  it("6 · malformed or error audit JSON, a missing report, a bad lockfile ⇒ FAIL", () => {
    for (const bad of [undefined, null, "text", [], {}, { auditReportVersion: 1, vulnerabilities: {}, metadata: { vulnerabilities: {} } }, { ...report(DEV_TREE), error: { code: "ENOAUDIT" } }]) {
      expect(run({ full: bad }).verdict, JSON.stringify(bad)).toBe("FAIL");
      expect(run({ production: bad }).verdict, JSON.stringify(bad)).toBe("FAIL");
    }
    const broken = report(DEV_TREE) as { vulnerabilities: Record<string, Record<string, unknown>> };
    broken.vulnerabilities["eslint"] = { ...broken.vulnerabilities["eslint"], nodes: "node_modules/eslint" };
    expect(run({ full: broken }).reasons).toContain("full_entry_malformed:eslint");
    const miscount = report(DEV_TREE) as { metadata: { vulnerabilities: { total: number } } };
    miscount.metadata.vulnerabilities.total = 2;
    expect(run({ full: miscount }).reasons).toContain("full_metadata_count_mismatch");
    for (const bad of [undefined, { lockfileVersion: 2, packages: {} }, { lockfileVersion: 3 }]) expect(run({ lockfile: bad }).reasons, JSON.stringify(bad)).toContain("lockfile_malformed");
  });

  it("7–8 · the exception is valid through its last day (UTC) and fails closed the day after", () => {
    expect(run({ today: "2026-11-30" }).verdict).toBe("PASS_WITH_TEMPORARY_EXCEPTION");
    expect(run({ today: "2026-10-31" }).verdict).toBe("PASS_WITH_TEMPORARY_EXCEPTION");
    expect(run({ today: "2026-12-01" })).toMatchObject({ verdict: "FAIL", reasons: [`exception_expired:${APPROVED}:2026-11-30`] });
    for (const today of ["2026-13-01", "2026-11-31", "yesterday", ""]) expect(run({ today }).reasons, today).toEqual(["today_invalid"]);
  });

  it("9 · the approved advisory is gone ⇒ STALE_EXCEPTION_DETECTED (delete the exception); with no exception a clean audit passes", () => {
    expect(run({ full: EMPTY })).toMatchObject({ verdict: "FAIL", reasons: [`STALE_EXCEPTION_DETECTED:${APPROVED}`] });
    expect(run({ full: EMPTY, exceptions: [] })).toMatchObject({ verdict: "PASS", reasons: [] });
    expect(run({ exceptions: [] }).verdict).toBe("FAIL");
  });

  it("10 · scope that can't be proven dev-only ⇒ FAIL (unknown node, devOptional, missing dev flag)", () => {
    expect(run({ lockfile: lockfile({ "node_modules/eslint": { version: "9.39.5", dev: true, devOptional: true } }) }).reasons).toEqual(["not_dev_only:node_modules/eslint"]);
    expect(run({ lockfile: lockfile({ "node_modules/eslint-plugin-react": { version: "7.37.5" } }) }).reasons).toEqual(["not_dev_only:node_modules/eslint-plugin-react"]);
    const unknownNode = report([...DEV_TREE, { name: "glob", severity: "moderate", via: ["minimatch"], nodes: ["node_modules/glob"] }]);
    expect(run({ full: unknownNode }).reasons).toEqual(["not_dev_only:node_modules/glob"]);
  });
});

describe("identity is the exact GHSA — never package, severity or range alone", () => {
  it("an advisory without a canonical GHSA URL can't be mapped ⇒ FAIL", () => {
    for (const url of [undefined, "https://npmjs.com/advisories/1244012", `https://github.com/advisories/${APPROVED.toUpperCase()}`, `https://github.com/advisories/${APPROVED}/extra`, `http://github.com/advisories/${APPROVED}`]) {
      const via = advisory(APPROVED, "minimatch", "moderate", url);
      if (url === undefined) delete via["url"];
      const result = run({ full: report([{ ...DEV_TREE[0] as Entry, via: [via] }]) });
      expect(result.verdict, String(url)).toBe("FAIL");
      expect(result.reasons, String(url)).toContain("advisory_identity_unmapped:minimatch");
    }
  });

  it("the approved id on another package, or at a higher severity, ⇒ FAIL", () => {
    expect(run({ full: report([{ name: "brace-expansion", severity: "moderate", via: [advisory(APPROVED, "brace-expansion")], nodes: ["node_modules/minimatch"] }]) }).reasons).toEqual([`approved_advisory_wrong_package:${APPROVED}:brace-expansion`]);
    const high = run({ full: report([{ ...DEV_TREE[0] as Entry, severity: "high", via: [advisory(APPROVED, "minimatch", "high")] }]) });
    expect(high.reasons).toEqual([`approved_advisory_severity_exceeded:${APPROVED}:high`, "severity_exceeded:minimatch:high"]);
  });

  it("a vulnerable entry whose via chain doesn't resolve to a reported advisory ⇒ FAIL", () => {
    expect(run({ full: report([...DEV_TREE, { name: "eslint-utils", severity: "moderate", via: ["not-reported"], nodes: ["node_modules/eslint"] }]) }).reasons).toEqual(["unexplained_vulnerability:eslint-utils"]);
    expect([...run({ full: report([...DEV_TREE, { name: "a", severity: "moderate", via: ["b"], nodes: ["node_modules/eslint"] }, { name: "b", severity: "moderate", via: ["a"], nodes: ["node_modules/eslint"] }]) }).reasons].sort()).toEqual(["unexplained_vulnerability:a", "unexplained_vulnerability:b"]);
  });

  it("an exception record that isn't exact (bad id, non-dev scope, bad dates, duplicate) ⇒ FAIL", () => {
    for (const bad of [{ advisory: "CVE-2026-0001" }, { advisory: "GHSA-aaaa-bbbb-cccc" }, { scope: "prod" }, { expiresOn: "2026-02-30" }, { expiresOn: "2026-10-30" }, { maxSeverity: "severe" }]) {
      expect(run({ exceptions: [{ ...EXCEPTION, ...bad } as AuditException] }).verdict, JSON.stringify(bad)).toBe("FAIL");
    }
    expect(run({ exceptions: [EXCEPTION, EXCEPTION] }).reasons).toEqual(["exception_duplicate"]);
  });
});

describe("the repository's exception record and CI wiring", () => {
  const code = (file: string): string => readFileSync(path.join(REPOSITORY_ROOT, file), "utf8");

  it("exactly one exception: GHSA-g3hv-75wg-m249 on minimatch, moderate, dev-only, authorized 2026-10-31, expires 2026-11-30", () => {
    expect(AUDIT_EXCEPTIONS.map(({ advisory: id, package: name, maxSeverity, scope, authorizedOn, expiresOn }) => ({ id, name, maxSeverity, scope, authorizedOn, expiresOn })))
      .toEqual([{ id: APPROVED, name: "minimatch", maxSeverity: "moderate", scope: "dev", authorizedOn: "2026-10-31", expiresOn: "2026-11-30" }]);
    for (const e of AUDIT_EXCEPTIONS) expect(e.reason.length > 0 && e.remediation.length > 0).toBe(true);
  });

  it("CI runs the policy wrapper (full audit) with no swallowed exit code, no --omit=dev primary check, no lowered level", () => {
    const ci = code(".github/workflows/ci.yml");
    expect(ci).toMatch(/- name: Dependency audit\n\s+run: node tools\/audit-policy\/cli\.ts\n/);
    expect(ci).not.toMatch(/\|\| true|continue-on-error|--audit-level|npm audit --omit|npm run audit/);
    const cli = code("tools/audit-policy/cli.ts");
    expect(cli).toMatch(/spawnSync\("npm", \["audit", "--json", \.\.\.args\]/);
    expect(cli).toMatch(/const full = audit\(\[\]\);/);
    expect(cli).toMatch(/const production = audit\(\["--omit=dev"\]\);/);
    expect(cli).toMatch(/process\.exitCode = result\.verdict === "FAIL" \? 1 : 0;/);
  });

  it("no minimatch override or audit configuration was added to package.json / .npmrc", () => {
    const pkg = JSON.parse(code("package.json")) as { overrides?: Record<string, string>; scripts: Record<string, string> };
    expect(Object.keys(pkg.overrides ?? {}).sort()).toEqual(["ws", "zod"]);
    expect(pkg.scripts["audit"]).toBe("npm audit");
    expect(() => code(".npmrc")).toThrow();
  });
});
