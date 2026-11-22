/**
 * RECOVERY-REHEARSAL-03A — the source guards' file discovery (tests/support/source-scan.ts) skips exactly one thing: a
 * separate npm package kept as local rehearsal evidence under tools/perf/ (a synthetic Trigger.dev project with its own
 * package.json). Everything else stays in scope: application and release code, tools/perf/ files outside such a package,
 * and a nested package.json anywhere outside tools/perf/. Nothing tracked by git can ever be skipped.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPOSITORY_ROOT, SEPARATE_PACKAGE_EVIDENCE_ROOT, isSeparateEvidencePackage, sourceFiles } from "../support/source-scan";

/** The same walk without the evidence rule (the reference the guard is compared with). */
function unfilteredSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (relative: string): void => {
    const absolute = path.join(REPOSITORY_ROOT, relative);
    if (!existsSync(absolute)) return;
    if (statSync(absolute).isFile()) {
      if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(relative)) out.push(relative);
      return;
    }
    for (const entry of readdirSync(absolute)) if (entry !== "node_modules" && !entry.startsWith(".")) walk(path.join(relative, entry));
  };
  walk(root);
  return out.sort();
}

describe("source guards skip only separate packages kept as local evidence under tools/perf/", () => {
  it("the rule: a directory with its own package.json, under tools/perf/ — nothing else", () => {
    expect(SEPARATE_PACKAGE_EVIDENCE_ROOT).toBe("tools/perf/");
    expect(isSeparateEvidencePackage("tools/perf/workflow-wf1/TRIGGER-ROLLBACK-REHEARSAL-01/synthetic-project", true)).toBe(true);
    expect(isSeparateEvidencePackage("tools/perf/workflow-wf1/TRIGGER-ROLLBACK-REHEARSAL-01/synthetic-project", false)).toBe(false);
    expect(isSeparateEvidencePackage("tools/perf/workflow-wf1", false)).toBe(false);
    for (const elsewhere of ["server/connections", "jobs/trigger/main", "tools/trigger", "tools/perfx/pkg", "tools", "app", "tools/perf"]) {
      expect(isSeparateEvidencePackage(elsewhere, true), elsewhere).toBe(false);
    }
    expect(isSeparateEvidencePackage("tools/perf/../server", true)).toBe(false);
  });

  it("on the real tree, every skipped file lies inside such a package; release and application code are still scanned", () => {
    const scanned = new Set(sourceFiles(["tools"]));
    const skipped = unfilteredSourceFiles("tools").filter((file) => !scanned.has(file));
    for (const file of skipped) {
      expect(file.startsWith(SEPARATE_PACKAGE_EVIDENCE_ROOT), file).toBe(true);
      const segments = file.split("/");
      const packageRoot = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/")).find((directory) => existsSync(path.join(REPOSITORY_ROOT, directory, "package.json")));
      expect(packageRoot, file).toBeDefined();
    }
    for (const file of ["tools/trigger/recover-release.ts", "tools/trigger/deploy-release-pair.ts", "tools/ops/workflow-reconcile.ts", "tools/db/migrations.ts"]) expect(scanned.has(file), file).toBe(true);
    // tools/perf/ files outside a separate package (the WF-1 benchmark harness, when present locally) stay in scope.
    const harness = unfilteredSourceFiles("tools/perf").filter((file) => file.split("/").length === 4);
    for (const file of harness) expect(scanned.has(file), file).toBe(true);
  });

  it("nothing tracked by git can be skipped: no committed package.json exists under tools/perf/", () => {
    const tracked = spawnSync("git", ["ls-files", "--", "tools/perf"], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
    expect(tracked.status).toBe(0);
    expect(tracked.stdout.split("\n").filter((file) => file.endsWith("package.json"))).toEqual([]);
  });
});
