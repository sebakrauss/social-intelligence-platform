/**
 * Dependency-audit policy (Step H7-D1b-sec1): FULL npm audit − EXACT temporary exceptions = PASS; everything else
 * fails closed. Pure and deterministic (the CLI in `cli.ts` runs npm and reads the lockfile).
 *
 *   identity    an advisory is identified ONLY by the canonical GHSA id in its GitHub advisory URL; a vulnerable
 *               entry whose advisory can't be mapped to one fails (never by package name, severity or range alone)
 *   chains      every reported entry must resolve, through its `via` chain, to advisories in the report; anything
 *               unresolvable fails
 *   approval    every advisory must match an exception: same id, same package, severity ≤ the approved maximum,
 *               not expired (UTC, inclusive last day)
 *   scope       every node of every reported entry must be a dev-only lockfile package (`dev: true`, not
 *               `devOptional`), and the production audit (`--omit=dev`) must be empty
 *   stale       an exception whose advisory is no longer reported fails as STALE_EXCEPTION_DETECTED (delete it)
 */
import { AUDIT_SEVERITIES, type AuditException, type AuditSeverity } from "./exceptions.ts";

export type AuditVerdict = "PASS" | "PASS_WITH_TEMPORARY_EXCEPTION" | "FAIL";

export interface ReportedAdvisory {
  readonly advisory: string;
  readonly package: string;
  readonly severity: AuditSeverity;
  readonly nodes: readonly string[];
}

export interface AuditPolicyResult {
  readonly verdict: AuditVerdict;
  readonly reasons: readonly string[];
  readonly advisories: readonly ReportedAdvisory[];
  /** Every reported node (advisory packages and the packages that depend on them). */
  readonly nodes: readonly string[];
  readonly appliedExceptions: readonly AuditException[];
}

export interface AuditPolicyInput {
  /** `npm audit --json` (all dependencies). */
  readonly full: unknown;
  /** `npm audit --omit=dev --json` (production cross-check). */
  readonly production: unknown;
  /** package-lock.json (lockfileVersion 3). */
  readonly lockfile: unknown;
  /** Today's date, UTC, `YYYY-MM-DD`. */
  readonly today: string;
  readonly exceptions: readonly AuditException[];
}

const GHSA_URL = /^https:\/\/github\.com\/advisories\/(GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const record = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const isSeverity = (value: unknown): value is AuditSeverity => typeof value === "string" && (AUDIT_SEVERITIES as readonly string[]).includes(value);
const rank = (severity: AuditSeverity): number => AUDIT_SEVERITIES.indexOf(severity);
const validDate = (value: string): boolean => DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

interface ParsedEntry {
  readonly name: string;
  readonly severity: AuditSeverity;
  readonly nodes: readonly string[];
  readonly advisories: readonly ReportedAdvisory[];
  readonly dependsOn: readonly string[];
}

type Parsed = { readonly ok: true; readonly entries: ReadonlyMap<string, ParsedEntry> } | { readonly ok: false; readonly reasons: readonly string[] };

/** Parses an auditReportVersion 2 report; anything unexpected is a reason to fail, never skipped. */
function parseReport(raw: unknown, label: string): Parsed {
  if (!record(raw) || raw["auditReportVersion"] !== 2 || !record(raw["vulnerabilities"]) || !record(raw["metadata"]) || !record(raw["metadata"]["vulnerabilities"])) {
    return { ok: false, reasons: [`${label}_report_malformed`] };
  }
  if ("error" in raw) return { ok: false, reasons: [`${label}_report_error`] };
  const reasons: string[] = [];
  const entries = new Map<string, ParsedEntry>();
  for (const [name, value] of Object.entries(raw["vulnerabilities"])) {
    if (!record(value) || value["name"] !== name || !isSeverity(value["severity"]) || !Array.isArray(value["via"]) || !Array.isArray(value["nodes"]) || !value["nodes"].every((n) => typeof n === "string")) {
      reasons.push(`${label}_entry_malformed:${name}`);
      continue;
    }
    const nodes: readonly string[] = value["nodes"];
    const advisories: ReportedAdvisory[] = [];
    const dependsOn: string[] = [];
    for (const via of value["via"] as unknown[]) {
      if (typeof via === "string") {
        dependsOn.push(via);
        continue;
      }
      const url = record(via) ? via["url"] : undefined;
      const match = typeof url === "string" ? GHSA_URL.exec(url) : null;
      const id = match?.[1];
      if (!record(via) || id === undefined || !isSeverity(via["severity"]) || typeof via["name"] !== "string") {
        reasons.push(`advisory_identity_unmapped:${name}`);
        continue;
      }
      advisories.push(Object.freeze({ advisory: id, package: via["name"], severity: via["severity"], nodes: Object.freeze([...nodes]) }));
    }
    entries.set(name, Object.freeze({ name, severity: value["severity"], nodes: Object.freeze([...nodes]), advisories: Object.freeze(advisories), dependsOn: Object.freeze(dependsOn) }));
  }
  const total = raw["metadata"]["vulnerabilities"]["total"];
  if (total !== entries.size + reasons.filter((r) => r.startsWith(`${label}_entry_malformed:`)).length) reasons.push(`${label}_metadata_count_mismatch`);
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, entries };
}

/** The advisories an entry resolves to through its `via` chain; undefined when the chain can't be resolved. */
function resolve(entries: ReadonlyMap<string, ParsedEntry>, name: string, seen: Set<string> = new Set()): readonly string[] | undefined {
  const entry = entries.get(name);
  if (entry === undefined) return undefined;
  if (seen.has(name)) return [];
  seen.add(name);
  const ids = new Set(entry.advisories.map((a) => a.advisory));
  for (const dependency of entry.dependsOn) {
    const resolved = resolve(entries, dependency, seen);
    if (resolved === undefined) return undefined;
    for (const id of resolved) ids.add(id);
  }
  return [...ids];
}

function devOnlyLockPackages(lockfile: unknown): ReadonlyMap<string, boolean> | undefined {
  if (!record(lockfile) || lockfile["lockfileVersion"] !== 3 || !record(lockfile["packages"])) return undefined;
  const out = new Map<string, boolean>();
  for (const [path, value] of Object.entries(lockfile["packages"])) {
    if (!record(value)) return undefined;
    out.set(path, value["dev"] === true && value["devOptional"] !== true);
  }
  return out;
}

export function evaluateAuditPolicy(input: AuditPolicyInput): AuditPolicyResult {
  const reasons: string[] = [];
  const fail = (extra: readonly string[] = []): AuditPolicyResult => Object.freeze({ verdict: "FAIL" as const, reasons: Object.freeze([...reasons, ...extra]), advisories: Object.freeze([]), nodes: Object.freeze([]), appliedExceptions: Object.freeze([]) });

  if (!validDate(input.today)) return fail(["today_invalid"]);
  for (const exception of input.exceptions) {
    // Read as unknown: an exception built outside the type system must still say exactly "dev".
    const scope: unknown = exception.scope;
    if (!GHSA_URL.test(`https://github.com/advisories/${exception.advisory}`) || scope !== "dev" || !isSeverity(exception.maxSeverity) || !validDate(exception.expiresOn) || !validDate(exception.authorizedOn) || exception.expiresOn < exception.authorizedOn) {
      return fail([`exception_invalid:${exception.advisory}`]);
    }
  }
  if (new Set(input.exceptions.map((e) => e.advisory)).size !== input.exceptions.length) return fail(["exception_duplicate"]);

  const full = parseReport(input.full, "full");
  const production = parseReport(input.production, "production");
  if (!full.ok) reasons.push(...full.reasons);
  if (!production.ok) reasons.push(...production.reasons);
  const lock = devOnlyLockPackages(input.lockfile);
  if (lock === undefined) reasons.push("lockfile_malformed");
  if (!full.ok || !production.ok || lock === undefined) return fail();

  // Production / runtime advisories are never covered by any exception.
  if (production.entries.size > 0) reasons.push(`production_audit_not_clean:${String(production.entries.size)}`);

  const advisories = [...full.entries.values()].flatMap((entry) => entry.advisories);
  for (const name of full.entries.keys()) {
    const resolved = resolve(full.entries, name);
    if (resolved === undefined || resolved.length === 0) reasons.push(`unexplained_vulnerability:${name}`);
  }

  const applied = new Map<string, AuditException>();
  for (const advisory of advisories) {
    const exception = input.exceptions.find((e) => e.advisory === advisory.advisory);
    if (exception === undefined) {
      reasons.push(`unapproved_advisory:${advisory.advisory}:${advisory.severity}:${advisory.package}`);
      continue;
    }
    if (advisory.package !== exception.package) reasons.push(`approved_advisory_wrong_package:${advisory.advisory}:${advisory.package}`);
    if (rank(advisory.severity) > rank(exception.maxSeverity)) reasons.push(`approved_advisory_severity_exceeded:${advisory.advisory}:${advisory.severity}`);
    if (input.today > exception.expiresOn) reasons.push(`exception_expired:${advisory.advisory}:${exception.expiresOn}`);
    applied.set(exception.advisory, exception);
  }

  // Every reported node (the advisory packages and everything flagged through them) must be dev-only.
  const nodes = [...new Set([...full.entries.values()].flatMap((entry) => entry.nodes))].sort();
  for (const node of nodes) if (lock.get(node) !== true) reasons.push(`not_dev_only:${node}`);
  // Entry severities can't exceed what the covering exceptions allow.
  const ceiling = Math.max(-1, ...[...applied.values()].map((e) => rank(e.maxSeverity)));
  for (const entry of full.entries.values()) if (rank(entry.severity) > ceiling && applied.size > 0) reasons.push(`severity_exceeded:${entry.name}:${entry.severity}`);

  // An exception whose advisory is gone is dead configuration: remove it.
  const reported = new Set(advisories.map((a) => a.advisory));
  for (const exception of input.exceptions) if (!reported.has(exception.advisory)) reasons.push(`STALE_EXCEPTION_DETECTED:${exception.advisory}`);

  if (reasons.length > 0) return Object.freeze({ verdict: "FAIL" as const, reasons: Object.freeze(reasons), advisories: Object.freeze(advisories), nodes: Object.freeze(nodes), appliedExceptions: Object.freeze([...applied.values()]) });
  return Object.freeze({
    verdict: applied.size > 0 ? "PASS_WITH_TEMPORARY_EXCEPTION" as const : "PASS" as const,
    reasons: Object.freeze([]),
    advisories: Object.freeze(advisories),
    nodes: Object.freeze(nodes),
    appliedExceptions: Object.freeze([...applied.values()]),
  });
}
