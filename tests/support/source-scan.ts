/**
 * Static source scanning for guard tests: lists repository source files under the given roots and finds
 * forbidden references. Comments are stripped first, so documentation may name what code must not use.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");

const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

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
 * bootstrap variables (as name constants) and the standard AWS credential-chain variables (one closed list). Guards that
 * forbid those names exempt this file only after removing exactly those declarations, so it can refuse them but never
 * read them as an identity source.
 */
export const PLANE_ENVIRONMENT_GUARD = "jobs/plane-environment.ts";

export function codeWithoutPlaneRefusals(relative: string): string {
  const code = codeOf(relative);
  const stripped = code
    .replace(/const AWS_CREDENTIAL_CHAIN_VARIABLES = \[[^\]]*\];/, "")
    .replace(/export const INTEGRATION_AWS_[A-Z_]+_ENV = "INTEGRATION_AWS_[A-Z_]+";/g, "")
    .replace(/export const PLANE_FORBIDDEN_VARIABLES[^\n]*\n[\s\S]*?\n\}\);/, "");
  if (stripped === code) throw new Error(`${relative}: the plane refusal declarations were not found`);
  return stripped;
}
