/**
 * Paired Trigger.dev release guards (Step 7G-H5.5-P2-F2). Every SUPPORTED production release path in this repository is
 * the paired tool (`npm run trigger:release` → tools/trigger/deploy-release-pair.ts): both planes, INTEGRATION then MAIN,
 * one captured commit as the external id of both. No package script, operator document, workflow or config comment
 * teaches a single-plane production deploy; the TA-Q-31 Preview deploy stays the one documented exception and can never
 * name `prod` or an external id. The tool itself reads no env file, syncs or shows no variable, never forces, imports no
 * Trigger.dev runtime, holds no project ref or secret, and gives the CLI a sterile environment.
 *
 * Out of scope on purpose: an operator typing a raw CLI command outside the repository; approved source documents under
 * docs/ (never edited here); jobs/ as a whole (only the INTEGRATION build extension's deploy-path comment is scanned).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectSecrets } from "@/domain/secret-patterns";
import { RELEASE_PLANES, buildReleasePlan } from "../../tools/trigger/release-pair.ts";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../support/source-scan";

const TOOL = "tools/trigger/deploy-release-pair.ts";
const PLANNER = "tools/trigger/release-pair.ts";
const TOOL_FILES = [TOOL, PLANNER];
const raw = (relative: string): string => readFileSync(path.join(REPOSITORY_ROOT, relative), "utf8");
const RELEASE_DOCUMENTING_JOBS_FILE = "jobs/build/aws-signing-helper-extension.ts";

/** Markdown and YAML files under a root (the shared source walker lists code only). */
function documentsUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(path.join(REPOSITORY_ROOT, relative))) {
      const child = path.join(relative, entry);
      if (statSync(path.join(REPOSITORY_ROOT, child)).isDirectory()) walk(child);
      else if (/\.(md|ya?ml)$/.test(entry)) out.push(child);
    }
  };
  walk(root);
  return out.sort();
}

/** Operator-facing surfaces that could teach a deploy: README, package.json, deploy configs, design runbooks, workflows, tools. */
const releaseSurfaces = (): string[] => [
  "README.md",
  "package.json",
  "trigger.config.ts",
  "trigger.integration.config.ts",
  ...documentsUnder("design"),
  ...documentsUnder(".github"),
  ...sourceFiles(["tools"]).filter((file) => !TOOL_FILES.includes(file)),
  // The one jobs/ file whose header documents the deploy path (the INTEGRATION build extension). jobs/ is not scanned
  // as a whole: only this exact file, so its comment can never teach a single-plane production deploy again.
  RELEASE_DOCUMENTING_JOBS_FILE,
];

/** The one documented non-production deploy form (TA-Q-31 validation window). */
const PREVIEW_EXCEPTION = "deploy --env preview --branch <name>";
const SINGLE_PLANE_DEPLOY = [/\btrigger(?:\.dev@[\d.]+)?\s+deploy\b/, /\bdeploy\s+--(?!env preview --branch <name>)/];

describe("the only supported Trigger.dev production release path is the paired tool", () => {
  it("package.json exposes exactly ONE release script, trigger:release → the paired tool; no per-plane deploy script", () => {
    const scripts = (JSON.parse(raw("package.json")) as { scripts: Record<string, string> }).scripts;
    expect(Object.keys(scripts).filter((name) => /trigger|deploy|release/i.test(name))).toEqual(["trigger:release"]);
    expect(scripts["trigger:release"]).toBe("node tools/trigger/deploy-release-pair.ts");
    const touching = Object.entries(scripts).filter(([, command]) => /deploy|release-pair|trigger\.dev@/i.test(command)).map(([name]) => name);
    expect(touching).toEqual(["trigger:release"]);
  });

  it("no operator surface teaches a single-plane deploy; the Preview deploy is the only exception and never names prod or an external id", () => {
    const offenders: string[] = [];
    for (const file of releaseSurfaces()) {
      raw(file).split("\n").forEach((line, index) => {
        if (SINGLE_PLANE_DEPLOY.some((pattern) => pattern.test(line))) offenders.push(`${file}:${String(index + 1)}: ${line.trim()}`);
        if (line.includes("--env preview") && (/--external-id|--env prod|\bprod\b/.test(line))) offenders.push(`${file}:${String(index + 1)} preview with prod/external id`);
      });
    }
    expect(offenders).toEqual([]);
    expect(raw("README.md")).toContain(PREVIEW_EXCEPTION);
  });

  it("the production release documents point to the paired tool", () => {
    const readme = raw("README.md");
    for (const phrase of ["npm run trigger:release", "INTEGRATION first, then MAIN", "dry run by default", "--execute --confirm-paired-release", ".wrenkind-local/evidence/trigger-release-pair/", "STOP_MAIN_FAILED", "web-only commit"]) {
      expect(readme, phrase).toContain(phrase);
    }
    expect(raw("design/phase-7e/aws-authorization/README.md")).toContain("npm run trigger:release");
    for (const config of ["trigger.config.ts", "trigger.integration.config.ts", RELEASE_DOCUMENTING_JOBS_FILE]) expect(raw(config), config).toContain("npm run trigger:release");
  });
});

describe("the paired plan", () => {
  it("is exactly INTEGRATION then MAIN, each with its config, both with ONE external id", () => {
    expect(RELEASE_PLANES.map((plane) => [plane.plane, plane.config])).toEqual([["integration", "trigger.integration.config.ts"], ["main", "trigger.config.ts"]]);
    const sha = "a".repeat(40);
    const plan = buildReleasePlan({ releaseSha: sha, integrationProjectRef: "proj_aaaaaaaa1", mainProjectRef: "proj_bbbbbbbb2", emptyEnvFile: "/tmp/x" });
    const ids = plan.steps.map((step) => step.argv[step.argv.indexOf("--external-id") + 1]);
    expect(ids).toEqual([sha, sha]);
    for (const step of plan.steps) expect(step.argv).toEqual(expect.arrayContaining(["--env", "prod", "--depot-build", "--skip-sync-env-vars", "--skip-update-check", "--skip-telemetry", "--env-file"]));
  });
});

describe("the tool's source contract", () => {
  /** Code without comments, and without the planner's own closed list of forbidden flags (which must name them). */
  const code = (file: string): string => codeOf(file).replace(/export const FORBIDDEN_FLAGS = \[[^\]]*\] as const;/, "");

  it("imports only node built-ins, its planner, the shared secret patterns and the helper pins — no Trigger.dev, no env loader", () => {
    const imports = (file: string) => [...codeOf(file).matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");
    for (const specifier of imports(TOOL)) expect(specifier, `${TOOL} → ${specifier}`).toMatch(/^(node:[a-z_/]+|\.\/release-pair\.ts)$/);
    for (const specifier of imports(PLANNER)) expect(specifier, `${PLANNER} → ${specifier}`).toMatch(/^(node:crypto|\.\.\/\.\.\/domain\/secret-patterns\.ts|\.\.\/\.\.\/jobs\/aws-signing-helper\.ts)$/);
  });

  it.each(TOOL_FILES)("%s: no env file, env loader, value listing, env sync or pull, force, Trigger.dev SDK, project ref or secret", (file) => {
    const source = code(file);
    expect(source).not.toMatch(/\.env\.local|["'`]\.env["'`]|dotenv|parseEnv|loadEnvironment|tools\/db\/environment/);
    expect(source).not.toMatch(/--show-values|show-values|env\s+pull|env-pull|syncEnvVars|--sync-env-vars["']/);
    // The CLI's --force flag (the planner's invariants also reject it in every argv); rmSync's own `force` is unrelated.
    expect(source).not.toMatch(/["'`]--force["'`]/);
    expect(source).not.toMatch(/@trigger\.dev/);
    expect(source).not.toMatch(/proj_[a-z0-9]{8,}/);
    expect(source).not.toMatch(/TRIGGER_SECRET_KEY|TRIGGER_ACCESS_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|INTEGRATION_AWS_/);
    expect(detectSecrets(raw(file))).toEqual([]);
  });

  it("the CLI child gets a sterile environment, no shell and no stdin; process.env is read only for PATH and HOME", () => {
    const source = codeOf(TOOL);
    expect(source).toMatch(/return \{ PATH: source\["PATH"\] \?\? "", HOME: source\["HOME"\] \?\? "", TERM: "dumb", CI: "1", NO_COLOR: "1" \};/);
    expect(source).toMatch(/const env = sterileEnvironment\(process\.env\) as NodeJS\.ProcessEnv;/);
    expect(source).toMatch(/spawn\(cli, \[\.\.\.argv\], \{ cwd: REPOSITORY_ROOT, env, stdio: \["ignore", "pipe", "pipe"\], shell: false \}\)/);
    expect([...source.matchAll(/process\.env\b(?!\))/g)]).toEqual([]);
    expect([...source.matchAll(/spawn\(/g)]).toHaveLength(1);
    expect(source).not.toMatch(/\.\.\.process\.env/);
  });

  it("evidence is create-exclusive under the approved operator-local directory, which stays out of git and Vercel", () => {
    const source = codeOf(TOOL);
    expect(source).toMatch(/export const EVIDENCE_DIRECTORY = "\.wrenkind-local\/evidence\/trigger-release-pair";/);
    expect(source).toMatch(/writeFileSync\(file, contents, \{ mode: 0o600, flag: "wx" \}\)/);
    expect(raw(".vercelignore").split("\n")).toContain("/.wrenkind-local/");
  });

  it("no --only / --resume-sha partial path exists (MAIN failure is STOP_MAIN_FAILED, never an automatic retry)", () => {
    expect(codeOf(TOOL)).not.toMatch(/--only|--resume-sha|resumeSha|retry\(/);
  });
});

describe("the dependency boundary exception is exactly the planner → the helper pins", () => {
  const load = createRequire(import.meta.url);
  const rules = (load(path.join(REPOSITORY_ROOT, ".dependency-cruiser.cjs")) as { forbidden: { name: string; from: Record<string, string>; to: Record<string, string> }[] }).forbidden;
  const rule = (name: string) => rules.find((entry) => entry.name === name);

  it("jobs-are-entry-points exempts only the fetch tool and the planner (never tools/ as a whole)", () => {
    expect(rule("jobs-are-entry-points")?.from).toEqual({ pathNot: "^(jobs/|tests/|tools/trigger/fetch-aws-signing-helper\\.ts$|tools/trigger/release-pair\\.ts$)" });
  });

  it("the planner may read only jobs/aws-signing-helper.ts", () => {
    expect(rule("release-pair-reads-pins-only")).toMatchObject({
      severity: "error",
      from: { path: "^tools/trigger/release-pair\\.ts$" },
      to: { path: "^jobs/", pathNot: "^jobs/aws-signing-helper\\.ts$" },
    });
  });
});
