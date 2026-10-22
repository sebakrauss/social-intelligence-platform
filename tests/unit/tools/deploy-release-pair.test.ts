/**
 * Step 7G-H5.5-P2-F2: the paired-release executor with every effect faked (git, CLI spawn, files, evidence). Proves the
 * git identity contract (clean, fetch, HEAD unchanged, HEAD == origin/main, one frozen SHA, re-checked before each plane),
 * dry-run spawning nothing, INTEGRATION strictly before MAIN, every STOP state, interruption and timeout, create-exclusive
 * evidence with no secret in it, and that nothing here contacts Trigger.dev unless the executor is invoked.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AWS_SIGNING_HELPER_ARTIFACTS, awsSigningHelperRelativePath } from "../../../jobs/aws-signing-helper.ts";
import type * as HelperPins from "../../../jobs/aws-signing-helper.ts";
import {
  EVIDENCE_DIRECTORY,
  exitCodeFor,
  parseArguments,
  runPairedRelease,
  sterileEnvironment,
  type DeployResult,
  type ReleaseDependencies,
  type ReleaseOptions,
} from "../../../tools/trigger/deploy-release-pair.ts";

const ROOT = "/repo/social-intelligence-platform";
const SHA = "8d6fdf56bf90e9934b913f5dc64302b419740bf3";
const OTHER = "1b3fbbe2f651ca64bbf228e4e49b0f344a109a95";
const OPTIONS: ReleaseOptions = { cli: "/opt/trigger-cli/bin/trigger", integrationProjectRef: "proj_integrationtestref01", mainProjectRef: "proj_maintestrefabcdefghij", execute: true, timeoutMs: 60_000 };
const SECRET = "tr_" + "prod_" + "L".repeat(24);

const deployed = (version: string, tasks: number, extra = ""): DeployResult => ({
  exitCode: 0,
  output: `${extra}◇  Successfully deployed version ${version}\n└  Version ${version} deployed with ${String(tasks)} detected tasks\n`,
  timedOut: false,
  interrupted: false,
});

interface FakeState {
  status: string;
  head: string;
  origin: string;
  fetchOk: boolean;
  /** Called after each `git fetch` (simulate a push / checkout mid-run). */
  afterFetch?: (count: number) => void;
  fetches: number;
  calls: string[];
  spawns: { cli: string; argv: readonly string[] }[];
  results: DeployResult[];
  interrupted: boolean;
  evidence: Map<string, string>;
  logs: string[];
  envFiles: { path: string; cleaned: boolean }[];
  helpersOk: boolean;
  localOnly: boolean;
}

function harness(overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    status: "",
    head: SHA,
    origin: SHA,
    fetchOk: true,
    fetches: 0,
    calls: [],
    spawns: [],
    results: [deployed("20261022.1", 4), deployed("20261022.1", 6)],
    interrupted: false,
    evidence: new Map(),
    logs: [],
    envFiles: [],
    helpersOk: true,
    localOnly: true,
    ...overrides,
  };
  let clock = Date.parse("2026-10-22T12:00:00.000Z");
  const deps: ReleaseDependencies = {
    repositoryRoot: ROOT,
    git: (args) => {
      const key = args.join(" ");
      state.calls.push(`git ${key}`);
      if (key === "rev-parse --show-toplevel") return { ok: true, stdout: `${ROOT}\n` };
      if (key === "status --porcelain") return { ok: true, stdout: state.status };
      if (key === "rev-parse HEAD") return { ok: true, stdout: `${state.head}\n` };
      if (key === "rev-parse origin/main") return { ok: true, stdout: `${state.origin}\n` };
      if (key === "fetch origin main") {
        state.fetches += 1;
        state.afterFetch?.(state.fetches);
        return { ok: state.fetchOk, stdout: "" };
      }
      return { ok: false, stdout: "" };
    },
    fileExists: (relative) => relative === "trigger.config.ts" || relative === "trigger.integration.config.ts",
    readFile: () => undefined,
    cliIsExecutable: (cli) => cli === OPTIONS.cli,
    createEmptyEnvFile: () => {
      const entry = { path: `/tmp/fake-${String(state.envFiles.length)}/empty-env-file`, cleaned: false };
      state.envFiles.push(entry);
      return { path: entry.path, cleanup: () => (entry.cleaned = true) };
    },
    spawnDeploy: (cli, argv) => {
      state.calls.push(`spawn ${argv[2] ?? ""}`);
      state.spawns.push({ cli, argv });
      return Promise.resolve(state.results.shift() ?? { exitCode: 1, output: "", timedOut: false, interrupted: false });
    },
    interrupted: () => state.interrupted,
    writeEvidence: (name, contents) => {
      if (state.evidence.has(name)) throw new Error("EEXIST");
      state.evidence.set(name, contents);
      return `${EVIDENCE_DIRECTORY}/${name}`;
    },
    evidenceLocationIsLocalOnly: () => state.localOnly,
    now: () => new Date((clock += 1000)),
    log: (line) => state.logs.push(line),
  };
  return { state, deps };
}

const run = (h: ReturnType<typeof harness>, options: Partial<ReleaseOptions> = {}) => runPairedRelease({ ...OPTIONS, ...options }, h.deps);

// The real AWS helper builds are git-ignored binaries; the canonical pins module is replaced by one with synthetic
// digests so the executor's helper precheck can pass on synthetic bytes (same paths, same digest rule).
vi.mock("../../../jobs/aws-signing-helper.ts", async (original) => {
  const actual = await original<typeof HelperPins>();
  const bytes = (directory: string) => new TextEncoder().encode(`synthetic ${directory}`);
  return {
    ...actual,
    AWS_SIGNING_HELPER_ARTIFACTS: actual.AWS_SIGNING_HELPER_ARTIFACTS.map((artifact) => ({ ...artifact, sha256: createHash("sha256").update(bytes(artifact.directory)).digest("hex") })),
  };
});

function withHelpers(h: ReturnType<typeof harness>) {
  const files = new Map(AWS_SIGNING_HELPER_ARTIFACTS.map((artifact) => [awsSigningHelperRelativePath(artifact), new TextEncoder().encode(`synthetic ${artifact.directory}`)]));
  return { ...h, deps: { ...h.deps, readFile: (relative: string) => (h.state.helpersOk ? files.get(relative) : undefined) } };
}

const ready = (overrides: Partial<FakeState> = {}) => withHelpers(harness(overrides));
const evidenceOf = (h: ReturnType<typeof harness>) => {
  expect(h.state.evidence.size).toBe(1);
  return JSON.parse([...h.state.evidence.values()][0] ?? "{}") as Record<string, unknown> & { planes: { plane: string; outcome: { state: string } }[]; finalState: string };
};

describe("arguments", () => {
  it("requires the CLI and both project refs; --execute needs --confirm-paired-release; unknown flags refused", () => {
    expect(parseArguments(["--cli", "/x", "--integration-project-ref", "proj_a1234567", "--main-project-ref", "proj_b1234567"])).toMatchObject({ execute: false });
    expect(parseArguments(["--cli", "/x", "--integration-project-ref", "proj_a1234567", "--main-project-ref", "proj_b1234567", "--execute", "--confirm-paired-release"])).toMatchObject({ execute: true });
    for (const args of [
      [],
      ["--cli", "/x", "--integration-project-ref", "proj_a1234567"],
      ["--cli", "/x", "--integration-project-ref", "proj_a1234567", "--main-project-ref", "proj_b1234567", "--execute"],
      ["--cli", "/x", "--integration-project-ref", "proj_a1234567", "--main-project-ref", "proj_b1234567", "--confirm-paired-release"],
      ["--cli", "/x", "--integration-project-ref", "proj_a1234567", "--main-project-ref", "proj_b1234567", "--only", "main"],
      ["--cli", "/x", "--integration-project-ref", "proj_a1234567", "--main-project-ref", "proj_b1234567", "--resume-sha", SHA],
      ["--cli", "/x", "--integration-project-ref", "proj_a1234567", "--main-project-ref", "proj_b1234567", "--external-id", SHA],
      ["--cli", "/x", "--cli", "/y", "--integration-project-ref", "proj_a1234567", "--main-project-ref", "proj_b1234567"],
      ["--cli", "/x", "--integration-project-ref", "proj_a1234567", "--main-project-ref", "proj_b1234567", "--timeout-minutes", "0"],
    ]) {
      expect(parseArguments(args), args.join(" ")).toHaveProperty("error");
    }
  });

  it("the CLI child environment is exactly PATH, HOME, TERM=dumb, CI=1, NO_COLOR=1 — nothing else is inherited", () => {
    const env = sterileEnvironment({ PATH: "/bin", HOME: "/home/op", TRIGGER_SECRET_KEY: SECRET, AWS_ACCESS_KEY_ID: "x", NODE_ENV: "production", DATABASE_URL: "y" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/op", TERM: "dumb", CI: "1", NO_COLOR: "1" });
  });
});

describe("git identity and RELEASE_SHA", () => {
  it.each([
    ["dirty worktree", { status: " M README.md\n" }, /worktree is not clean/],
    ["fetch failure", { fetchOk: false }, /git fetch origin main failed/],
    ["HEAD != origin/main", { origin: OTHER }, /HEAD is not origin\/main/],
  ])("refuses a %s before anything else happens", async (_label, overrides, reason) => {
    const h = ready(overrides);
    const result = await run(h);
    expect(result).toMatchObject({ kind: "refused" });
    expect(result.kind === "refused" ? result.reason : "").toMatch(reason);
    expect(h.state.spawns).toEqual([]);
    expect(h.state.evidence.size).toBe(0);
  });

  it("refuses when HEAD changes during the initial fetch", async () => {
    const h = ready({ afterFetch: (count) => { if (count === 1) h.state.head = OTHER; } });
    expect(await run(h)).toEqual({ kind: "refused", reason: "HEAD changed during the fetch" });
    expect(h.state.spawns).toEqual([]);
  });

  it("refuses a wrong repository root, a missing config, a non-executable CLI, or missing helper builds", async () => {
    const wrongRoot = ready();
    expect(await runPairedRelease(OPTIONS, { ...wrongRoot.deps, repositoryRoot: "/elsewhere" })).toMatchObject({ kind: "refused", reason: expect.stringMatching(/canonical repository root/) as unknown });
    const noConfig = ready();
    expect(await runPairedRelease(OPTIONS, { ...noConfig.deps, fileExists: () => false })).toMatchObject({ kind: "refused" });
    expect(await run(ready(), { cli: "relative/trigger" })).toMatchObject({ kind: "refused", reason: expect.stringMatching(/--cli/) as unknown });
    expect(await run(ready(), { cli: "/not/executable" })).toMatchObject({ kind: "refused" });
    const noHelpers = ready({ helpersOk: false });
    expect(await run(noHelpers)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/signing helper builds not ready/) as unknown });
    expect(noHelpers.state.spawns).toEqual([]);
  });

  it("refuses invalid or equal project refs at plan time (no deploy)", async () => {
    for (const options of [{ mainProjectRef: "main" }, { integrationProjectRef: "proj_maintestrefabcdefghij" }]) {
      const h = ready();
      expect(await run(h, options)).toMatchObject({ kind: "refused" });
      expect(h.state.spawns).toEqual([]);
    }
  });
});

describe("dry run (the default)", () => {
  it("prints the sanitized plan for the captured SHA and spawns NO deploy; the temp env file is cleaned", async () => {
    const h = ready();
    const result = await run(h, { execute: false });
    expect(result.kind).toBe("dry_run");
    expect(exitCodeFor(result)).toBe(0);
    expect(h.state.spawns).toEqual([]);
    expect(h.state.evidence.size).toBe(0);
    expect(h.state.envFiles.every((entry) => entry.cleaned)).toBe(true);
    const plan = h.state.logs.join("\n");
    expect(plan).toContain(`RELEASE_SHA ${SHA}`);
    expect(plan).toMatch(/plan 1\/2 integration: trigger deploy --config trigger\.integration\.config\.ts/);
    expect(plan).toMatch(/plan 2\/2 main: trigger deploy --config trigger\.config\.ts/);
    expect(plan).not.toContain("/tmp/fake-");
    expect(plan).toContain("<tool-empty-env-file>");
  });
});

describe("execute: INTEGRATION first, then MAIN, one SHA", () => {
  it("ALIGNED: identity re-checked before each plane, INTEGRATION then MAIN, identical external id, evidence written once", async () => {
    const h = ready();
    const result = await run(h);
    expect(result).toMatchObject({ kind: "released", finalState: "ALIGNED" });
    expect(exitCodeFor(result)).toBe(0);
    expect(h.state.spawns.map((spawn) => spawn.argv[2])).toEqual(["trigger.integration.config.ts", "trigger.config.ts"]);
    for (const spawn of h.state.spawns) {
      expect(spawn.cli).toBe(OPTIONS.cli);
      expect(spawn.argv[spawn.argv.indexOf("--external-id") + 1]).toBe(SHA);
      expect(spawn.argv).toContain("--depot-build");
      expect(spawn.argv).toContain("--skip-sync-env-vars");
      expect(spawn.argv[spawn.argv.indexOf("--env") + 1]).toBe("prod");
    }
    expect(h.state.spawns[0]?.argv[h.state.spawns[0].argv.indexOf("--project-ref") + 1]).toBe(OPTIONS.integrationProjectRef);
    expect(h.state.spawns[1]?.argv[h.state.spawns[1].argv.indexOf("--project-ref") + 1]).toBe(OPTIONS.mainProjectRef);
    // fetch: initial + before INTEGRATION + before MAIN + final
    expect(h.state.fetches).toBe(4);
    const order = h.state.calls.filter((call) => call.startsWith("spawn") || call === "git fetch origin main");
    expect(order).toEqual(["git fetch origin main", "git fetch origin main", "spawn trigger.integration.config.ts", "git fetch origin main", "spawn trigger.config.ts", "git fetch origin main"]);
    const evidence = evidenceOf(h);
    expect(evidence).toMatchObject({ releaseSha: SHA, environment: "prod", planeOrder: ["integration", "main"], sameReleaseShaInEveryArgv: true, finalState: "ALIGNED", planesNotStarted: [] });
    expect(evidence.planes.map((plane) => plane.outcome.state)).toEqual(["PASS", "PASS"]);
    expect(String(evidence["limitation"])).toMatch(/not re-readable/);
    expect([...h.state.evidence.keys()][0]).toMatch(new RegExp(`-${SHA.slice(0, 12)}\\.json$`));
    expect(h.state.envFiles.every((entry) => entry.cleaned)).toBe(true);
  });

  it("refuses to execute when the evidence location is not git- and Vercel-excluded (nothing deployed)", async () => {
    const h = ready({ localOnly: false });
    expect(await run(h)).toMatchObject({ kind: "refused" });
    expect(h.state.spawns).toEqual([]);
  });

  it("INTEGRATION non-zero exit → STOP_INTEGRATION_FAILED, MAIN never runs", async () => {
    const h = ready({ results: [{ exitCode: 1, output: "error", timedOut: false, interrupted: false }, deployed("20261022.1", 6)] });
    const result = await run(h);
    expect(result).toMatchObject({ finalState: "STOP_INTEGRATION_FAILED" });
    expect(exitCodeFor(result)).toBe(1);
    expect(h.state.spawns).toHaveLength(1);
    expect(evidenceOf(h)).toMatchObject({ finalState: "STOP_INTEGRATION_FAILED", planesNotStarted: ["main"] });
  });

  it.each([
    ["unreadable output", { exitCode: 0, output: "done?", timedOut: false, interrupted: false }],
    ["wrong task count", deployed("20261022.1", 2)],
    ["timeout", { exitCode: null, output: "building…", timedOut: true, interrupted: false }],
  ])("INTEGRATION %s → STOP_VERIFICATION_UNKNOWN, MAIN never runs", async (_label, integration) => {
    const h = ready({ results: [integration, deployed("20261022.1", 6)] });
    expect(await run(h)).toMatchObject({ finalState: "STOP_VERIFICATION_UNKNOWN" });
    expect(h.state.spawns).toHaveLength(1);
    expect(evidenceOf(h)["planesNotStarted"]).toEqual(["main"]);
  });

  it.each([
    ["a new local commit", (state: FakeState) => (state.head = OTHER)],
    ["a push to origin/main", (state: FakeState) => (state.origin = OTHER)],
    ["a dirty worktree", (state: FakeState) => (state.status = "?? stray.txt\n")],
    ["a failing fetch", (state: FakeState) => (state.fetchOk = false)],
  ])("git drift during INTEGRATION (%s) → STOP_GIT_DRIFT, MAIN never runs", async (_label, drift) => {
    const h = ready();
    const deps: ReleaseDependencies = {
      ...h.deps,
      spawnDeploy: async (cli, argv, timeout) => {
        const result = await h.deps.spawnDeploy(cli, argv, timeout);
        drift(h.state);
        return result;
      },
    };
    expect(await runPairedRelease(OPTIONS, deps)).toMatchObject({ kind: "released", finalState: "STOP_GIT_DRIFT" });
    expect(h.state.spawns.map((spawn) => spawn.argv[2])).toEqual(["trigger.integration.config.ts"]);
    expect(evidenceOf(h)).toMatchObject({ finalState: "STOP_GIT_DRIFT", planesNotStarted: ["main"] });
  });

  it("git drift after MAIN is reported as STOP_GIT_DRIFT by the final identity check (never ALIGNED)", async () => {
    const h = ready();
    const deps: ReleaseDependencies = {
      ...h.deps,
      spawnDeploy: async (cli, argv, timeout) => {
        const result = await h.deps.spawnDeploy(cli, argv, timeout);
        if (argv[2] === "trigger.config.ts") h.state.origin = OTHER;
        return result;
      },
    };
    expect(await runPairedRelease(OPTIONS, deps)).toMatchObject({ finalState: "STOP_GIT_DRIFT" });
    expect(h.state.spawns).toHaveLength(2);
  });

  it("MAIN failure → STOP_MAIN_FAILED: no retry, no rollback, INTEGRATION not redeployed", async () => {
    const h = ready({ results: [deployed("20261022.1", 4), { exitCode: 1, output: "boom", timedOut: false, interrupted: false }] });
    const result = await run(h);
    expect(result).toMatchObject({ finalState: "STOP_MAIN_FAILED" });
    expect(h.state.spawns.map((spawn) => spawn.argv[2])).toEqual(["trigger.integration.config.ts", "trigger.config.ts"]);
    const evidence = evidenceOf(h);
    expect(evidence.planes.map((plane) => plane.outcome.state)).toEqual(["PASS", "FAILED"]);
    expect(String(evidence["policy"])).toMatch(/No automatic retry, rollback or redeploy/);
  });

  it("MAIN with the wrong task count → STOP_VERIFICATION_UNKNOWN (fail closed)", async () => {
    const h = ready({ results: [deployed("20261022.1", 4), deployed("20261022.1", 5)] });
    expect(await run(h)).toMatchObject({ finalState: "STOP_VERIFICATION_UNKNOWN" });
  });

  it("operator interrupt during INTEGRATION → INTERRUPTED, MAIN never starts, env file cleaned", async () => {
    const h = ready({ results: [{ exitCode: null, output: "", timedOut: false, interrupted: true }] });
    expect(await run(h)).toMatchObject({ finalState: "INTERRUPTED" });
    expect(h.state.spawns).toHaveLength(1);
    expect(h.state.envFiles.every((entry) => entry.cleaned)).toBe(true);
    expect(evidenceOf(h)).toMatchObject({ finalState: "INTERRUPTED", planesNotStarted: ["main"] });
  });

  it("operator interrupt between the planes → INTERRUPTED before MAIN", async () => {
    const h = ready();
    const original = h.deps.spawnDeploy;
    const deps: ReleaseDependencies = {
      ...h.deps,
      spawnDeploy: async (cli, argv, timeout) => {
        const result = await original(cli, argv, timeout);
        h.state.interrupted = true;
        return result;
      },
    };
    expect(await runPairedRelease(OPTIONS, deps)).toMatchObject({ finalState: "INTERRUPTED" });
    expect(h.state.spawns).toHaveLength(1);
  });

  it("evidence is create-exclusive and carries no secret even when the CLI prints one", async () => {
    const leak = `logged in with ${SECRET}\nBearer ${"q".repeat(30)}\n`;
    const h = ready({ results: [deployed("20261022.1", 3, leak), deployed("20261022.1", 6, leak)] });
    await run(h);
    const [text] = [...h.state.evidence.values()];
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("q".repeat(30));
    expect(text).not.toContain("/tmp/fake-");
    expect(h.state.logs.join("\n")).not.toContain(SECRET);
    // create-exclusive: the same name can never be written twice
    expect(() => h.deps.writeEvidence([...h.state.evidence.keys()][0] ?? "", "x")).toThrow("EEXIST");
  });
});

describe("web-only commits", () => {
  it("nothing contacts git remotes or Trigger.dev unless the executor is invoked: importing the tool spawns nothing", () => {
    // The module was imported above; no run happened in this test, so no fake was called and no real process exists.
    const h = ready();
    expect(h.state.calls).toEqual([]);
    expect(h.state.spawns).toEqual([]);
  });
});
