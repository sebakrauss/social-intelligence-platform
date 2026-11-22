/**
 * Static source scanning for guard tests: lists repository source files under the given roots and finds
 * forbidden references. Comments are stripped first, so documentation may name what code must not use.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");

const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

/**
 * RECOVERY-REHEARSAL-03A — the one place where a directory is a SEPARATE package rather than this repository's code.
 * Provider rehearsals keep their synthetic Trigger.dev projects as untracked local evidence under tools/perf/, each with
 * its own package.json, SDK pin and trigger config (e.g. tools/perf/workflow-wf1/TRIGGER-ROLLBACK-REHEARSAL-01/
 * synthetic-project/). The repository is one package (CLAUDE.md §3), so those projects are not its application or
 * release code and source guards skip them — exactly like spikes/, which no guard root includes. The rule is anchored to
 * tools/perf/ only: a package.json anywhere else hides nothing, and tools/perf/ files that are not inside such a package
 * (the WF-1 benchmark harness) are still scanned.
 */
export const SEPARATE_PACKAGE_EVIDENCE_ROOT = "tools/perf/";

/** Whether a repository-relative directory is a separate package inside the local evidence root (skipped by guards). */
export function isSeparateEvidencePackage(relativeDirectory: string, hasOwnPackageJson: boolean): boolean {
  const normalized = relativeDirectory.split(path.sep).join("/");
  return hasOwnPackageJson && normalized.startsWith(SEPARATE_PACKAGE_EVIDENCE_ROOT) && !normalized.split("/").includes("..");
}

/** Source files (repository-relative) under each root; a root may also be a single file. */
export function sourceFiles(roots: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (relative: string): void => {
    const absolute = path.join(REPOSITORY_ROOT, relative);
    if (!existsSync(absolute)) return;
    if (statSync(absolute).isFile()) {
      if (SOURCE.test(relative)) out.push(relative);
      return;
    }
    if (isSeparateEvidencePackage(relative, existsSync(path.join(absolute, "package.json")))) return;
    for (const entry of readdirSync(absolute)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      walk(path.join(relative, entry));
    }
  };
  for (const root of roots) walk(root);
  return out.sort();
}

/** File content without block or line comments (string contents are kept). */
export function codeOf(relative: string): string {
  return readFileSync(path.join(REPOSITORY_ROOT, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** [file, pattern] pairs where a pattern occurs in code (not comments). */
export function findReferences(files: readonly string[], patterns: readonly RegExp[]): [string, string][] {
  const hits: [string, string][] = [];
  for (const file of files) {
    const code = codeOf(file);
    for (const pattern of patterns) if (pattern.test(code)) hits.push([file, pattern.source]);
  }
  return hits;
}

/**
 * The hosted-web environment guard must NAME the credentials it refuses (TA-11A). Guard tests that forbid those names
 * in runtime code exempt exactly this file, and only after removing its single closed `FORBIDDEN_WEB_VARIABLES` list
 * (and comments): the names may occur nowhere else in it, so it can refuse them but never use them.
 */
export const WEB_ENVIRONMENT_GUARD = "server/http/web-environment.ts";

export function codeWithoutForbiddenList(relative: string): string {
  const code = codeOf(relative);
  const stripped = code.replace(/export const FORBIDDEN_WEB_VARIABLES = \[[^\]]*\] as const;/, "");
  if (stripped === code) throw new Error(`${relative}: the FORBIDDEN_WEB_VARIABLES list was not found`);
  return stripped;
}

/**
 * The jobs per-plane environment contract (Step 7E.4B.3/7E.4C) must also NAME what it refuses: the integration worker's
 * bootstrap variables (as name constants), the standard AWS credential-chain variables and the hosted web's Meta app
 * configuration (Step 7G-C; one closed list each). Guards that forbid those names exempt this file only after removing
 * exactly those declarations, so it can refuse them but never read them as an identity source or configuration.
 */
export const PLANE_ENVIRONMENT_GUARD = "jobs/plane-environment.ts";

export function codeWithoutPlaneRefusals(relative: string): string {
  const code = codeOf(relative);
  const stripped = code
    .replace(/const AWS_CREDENTIAL_CHAIN_VARIABLES = \[[^\]]*\];/, "")
    .replace(/const PROVIDER_META_APP_VARIABLES = \[[^\]]*\];/, "")
    .replace(/export const INTEGRATION_AWS_[A-Z_]+_ENV = "INTEGRATION_AWS_[A-Z_]+";/g, "")
    .replace(/export const RETIRED_INTEGRATION_AWS_BOOTSTRAP_VARIABLES[^\n]*\n/, "")
    .replace(/export const PLANE_FORBIDDEN_VARIABLES[^\n]*\n[\s\S]*?\n\}\);/, "");
  if (stripped === code) throw new Error(`${relative}: the plane refusal declarations were not found`);
  return stripped;
}

/**
 * Step 7B-15J (audit 7B-15I Z08): whether a source file is a React client module — its directive prologue contains
 * "use client" in EITHER quote style (a single-quoted directive is just as real). Read from the text's leading
 * statements (comments and whitespace allowed before them), never from an exact spelling at byte 0.
 */
export function isClientModule(relative: string): boolean {
  const text = readFileSync(path.join(REPOSITORY_ROOT, relative), "utf8");
  const prologue = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*((?:(["'])use [a-z ]+\2;?\s*)+)/.exec(text)?.[1] ?? "";
  return /(["'])use client\1/.test(prologue);
}
