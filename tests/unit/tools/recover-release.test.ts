/**
 * RECOVERY-TOOLING-01 — the recovery operator with every effect faked: git (repository and the prepared worktree), files,
 * the CLI version, the CLI's READ-ONLY MCP server (current worker, deployments, run counts) and the deploy spawn. Proves
 * PLAN ONLY by default (nothing spawned, nothing written), every refusal before a deploy, the MAIN → INTELLIGENCE →
 * INTEGRATION order from the worktree, per-plane verification (version, inventory, fingerprint), stop-at-first-failure
 * with an honest partial record, explicit continuation with fresh verification, and redacted evidence.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AWS_SIGNING_HELPER_ARTIFACTS, awsSigningHelperRelativePath } from "../../../jobs/aws-signing-helper.ts";
import type * as HelperPins from "../../../jobs/aws-signing-helper.ts";
import type { DeployResult } from "../../../tools/trigger/deploy-release-pair.ts";
import { exitCodeFor, parseRecoveryArguments, runRecovery, type InspectCall, type RecoveryDependencies, type RecoveryOptions } from "../../../tools/trigger/recover-release.ts";
import type { ReleasePlane } from "../../../tools/trigger/release-pair.ts";
import { RECOVERY_EVIDENCE_DIRECTORY, provenPairingValue, recoveryConfirmation } from "../../../tools/trigger/recovery-plan.ts";
import { BAD, BASELINE, EVIDENCE_NAME, KNOWN_GOOD, KNOWN_GOOD_VERSION, REFS, TASKS, currentWorkerText, deployListText, deployOutput, releaseRecord, runListText } from "./recovery-fixtures.ts";

vi.mock("../../../jobs/aws-signing-helper.ts", async (original) => {
  const actual = await original<typeof HelperPins>();
  const bytes = (directory: string) => new TextEncoder().encode(`synthetic ${directory}`);
  return { ...actual, AWS_SIGNING_HELPER_ARTIFACTS: actual.AWS_SIGNING_HELPER_ARTIFACTS.map((artifact) => ({ ...artifact, sha256: createHash("sha256").update(bytes(artifact.directory)).digest("hex") })) };
});

const ROOT = "/work/social-intelligence-platform";
const WORKTREE = "/work/wrenkind-recovery-0a1b2c3d";
const CLI = "/work/social-intelligence-platform/.wrenkind-local/tools/trigger-cli/node_modules/.bin/trigger";
const BAD_VERSION = "20261122.1";
const TOOL_HEAD = "1".repeat(40);
const ORIGIN = "2".repeat(40);
const WEB_OLD = "3".repeat(40);
const WEB_NEW = "4".repeat(40);
/** Linear history, oldest first. */
const HISTORY = [WEB_OLD, KNOWN_GOOD, WEB_NEW, ORIGIN, TOOL_HEAD];
const SECRET = "tr_" + "prod_" + "Q".repeat(24);
/** A synthetic credential-bearing URL, assembled so the repository's own secret scan never sees one literally. */
const CREDENTIAL_URL = ["postgres", "://", "user", ":", "pw", "@", "db.example.invalid:6543/postgres"].join("");
const PLANES: readonly ReleasePlane[] = ["main", "intelligence", "integration"];

type DeploySpec =
  | { readonly kind: "ok"; readonly hash?: string | undefined; readonly activate?: boolean; readonly tasks?: number; readonly extra?: string; readonly inventory?: Parameters<typeof currentWorkerText>[2] }
  | { readonly kind: "fail" }
  | { readonly kind: "timeout" };

interface Provider {
  current: string;
  versions: number;
  deploys: { version: string; status: string }[];
  inventory: Parameters<typeof currentWorkerText>[2];
}

function harness(overrides: { schema?: "v2" | "v3"; deploys?: Partial<Record<ReleasePlane, DeploySpec[]>>; webPaths?: string[]; workerLacksProjection?: boolean } & Record<string, unknown> = {}) {
  const state = {
    files: new Map<string, string | Uint8Array>(),
    wtHead: KNOWN_GOOD,
    wtStatus: "",
    wtBranch: false,
    wtCommon: `${ROOT}/.git`,
    wtEntries: ["package.json", "package-lock.json", "node_modules", ".env.example"],
    helperPinsSame: true,
    helpersPresent: true,
    cliVersion: "4.7.2" as string | undefined,
    sdk: "4.7.2",
    ancestorOfOrigin: true,
    contractDiff: "",
    migrations: { known: ["db/migrations/0033_mutation_intent_state_transition_guard.sql"], newer: ["db/migrations/0033_mutation_intent_state_transition_guard.sql", "db/migrations/0034_workflow_core.sql"] },
    webPaths: overrides.webPaths ?? [],
    workerLacksProjection: overrides.workerLacksProjection ?? true,
    providers: Object.fromEntries(PLANES.map((plane) => [REFS[plane], { current: BAD_VERSION, versions: 1, deploys: [{ version: BAD_VERSION, status: "DEPLOYED" }, { version: KNOWN_GOOD_VERSION, status: "DEPLOYED" }], inventory: {} } satisfies Provider])) as Record<string, Provider>,
    deploySpecs: Object.fromEntries(PLANES.map((plane) => [REFS[plane], [...(overrides.deploys?.[plane] ?? [{ kind: "ok" }])]])) as Record<string, DeploySpec[]>,
    spawns: [] as { argv: readonly string[]; cwd: string }[],
    inspected: [] as { ref: string; tools: string[] }[],
    evidence: new Map<string, string>(),
    logs: [] as string[],
    interruptAfterSpawns: Infinity,
    localOnly: true,
    envFiles: [] as { cleaned: boolean }[],
    /** Called after each deploy (simulate something else changing a plane). */
    afterDeploy: undefined as ((ref: string) => void) | undefined,
  };
  state.files.set(`${ROOT}/.wrenkind-local/evidence/trigger-release-pair/${EVIDENCE_NAME}`, releaseRecord({ schema: overrides.schema ?? "v3" }));
  const helperFiles = new Map(AWS_SIGNING_HELPER_ARTIFACTS.map((artifact) => [`${WORKTREE}/${awsSigningHelperRelativePath(artifact)}`, new TextEncoder().encode(`synthetic ${artifact.directory}`)]));
  const ancestor = (a: string, b: string) => {
    if (b === "origin/main" && a === KNOWN_GOOD) return state.ancestorOfOrigin;
    const ia = HISTORY.indexOf(a);
    const ib = HISTORY.indexOf(b === "origin/main" ? ORIGIN : b);
    return ia >= 0 && ib >= 0 && ia <= ib;
  };
  const git = (cwd: string, args: readonly string[]) => {
    const key = args.join(" ");
    const ok = (stdout = "") => ({ ok: true, stdout });
    const no = { ok: false, stdout: "" };
    if (cwd === ROOT) {
      if (key === "rev-parse --show-toplevel") return ok(`${ROOT}\n`);
      if (key === "rev-parse HEAD") return ok(`${TOOL_HEAD}\n`);
      if (key === "fetch origin main") return ok();
      if (key === "rev-parse origin/main") return ok(`${ORIGIN}\n`);
      if (key === `cat-file -e ${KNOWN_GOOD}^{commit}`) return ok();
      if (key === "rev-parse --path-format=absolute --git-common-dir") return ok(`${ROOT}/.git\n`);
      if (args[0] === "merge-base") return ancestor(args[2] ?? "", args[3] ?? "") ? ok() : no;
      if (key === `diff --quiet ${KNOWN_GOOD} HEAD -- jobs/aws-signing-helper.ts`) return state.helperPinsSame ? ok() : no;
      if (args[0] === "diff" && args[1] === "--name-only") return ok(state.contractDiff);
      if (args[0] === "cat-file" && args[1] === "-e") {
        const [sha, file] = (args[2] ?? "").split(":");
        if (file === "modules/workflow/persistence/projection-store.ts" && sha === KNOWN_GOOD) return state.workerLacksProjection ? no : ok();
        return sha !== KNOWN_GOOD && state.webPaths.includes(file ?? "") ? ok() : no;
      }
      if (args[0] === "ls-tree") return ok(`${(args[2] === KNOWN_GOOD ? state.migrations.known : state.migrations.newer).join("\n")}\n`);
      return no;
    }
    if (cwd === WORKTREE) {
      if (key === "rev-parse --show-toplevel") return ok(`${WORKTREE}\n`);
      if (key === "rev-parse --path-format=absolute --git-common-dir") return ok(`${state.wtCommon}\n`);
      if (key === "rev-parse HEAD") return ok(`${state.wtHead}\n`);
      if (key === "symbolic-ref -q HEAD") return state.wtBranch ? ok("refs/heads/main\n") : no;
      if (key === "status --porcelain") return ok(state.wtStatus);
      return no;
    }
    return no;
  };
  const text = (value: string | Uint8Array | undefined) => (value === undefined ? undefined : typeof value === "string" ? new TextEncoder().encode(value) : value);
  const deps: RecoveryDependencies = {
    repositoryRoot: ROOT,
    git,
    realpath: (p) => (p === WORKTREE || p === ROOT || p.startsWith("/work/") ? p : undefined),
    fileExists: (p) => p.startsWith(`${WORKTREE}/`) && ["trigger.config.ts", "trigger.integration.config.ts", "trigger.intelligence.config.ts", "package-lock.json", "node_modules/.package-lock.json"].includes(p.slice(WORKTREE.length + 1)),
    readFile: (p) => {
      if (p === `${WORKTREE}/package.json`) return text(JSON.stringify({ dependencies: { "@trigger.dev/sdk": state.sdk }, engines: { node: "22.x" } }));
      if (helperFiles.has(p)) return state.helpersPresent ? helperFiles.get(p) : undefined;
      if (p.startsWith(`${ROOT}/${RECOVERY_EVIDENCE_DIRECTORY}/`)) return text(state.evidence.get(p.slice(`${ROOT}/${RECOVERY_EVIDENCE_DIRECTORY}/`.length)));
      return text(state.files.get(p));
    },
    listDirectory: (p) => {
      if (p === WORKTREE) return state.wtEntries;
      if (p === `${ROOT}/.wrenkind-local/evidence/trigger-release-pair`) return [...state.files.keys()].filter((key) => key.startsWith(`${p}/`)).map((key) => key.slice(p.length + 1));
      if (p === `${ROOT}/${RECOVERY_EVIDENCE_DIRECTORY}`) return [...state.evidence.keys()];
      return undefined;
    },
    cliIsExecutable: (cli) => cli === CLI,
    cliVersion: () => state.cliVersion,
    createEmptyEnvFile: () => {
      const entry = { cleaned: false };
      state.envFiles.push(entry);
      return { path: `/tmp/fake-${String(state.envFiles.length)}/empty-env-file`, cleanup: () => (entry.cleaned = true) };
    },
    inspect: (_cli, ref, calls: readonly InspectCall[]) => {
      state.inspected.push({ ref, tools: calls.map((call) => call.tool) });
      const provider = state.providers[ref];
      return Promise.resolve(calls.map((call) => {
        if (provider === undefined) return undefined;
        const plane = PLANES.find((entry) => REFS[entry] === ref) ?? "main";
        if (call.tool === "get_current_worker") return currentWorkerText(provider.current, plane, provider.inventory);
        if (call.tool === "list_deploys") return deployListText(provider.deploys);
        return runListText(0);
      }));
    },
    spawnDeploy: (_cli, argv, cwd) => {
      state.spawns.push({ argv, cwd });
      const ref = argv[argv.indexOf("--project-ref") + 1] ?? "";
      const plane = PLANES.find((entry) => REFS[entry] === ref) ?? "main";
      const provider = state.providers[ref];
      if (provider === undefined) throw new Error(`no synthetic project ${ref}`);
      const spec = state.deploySpecs[ref]?.shift() ?? { kind: "fail" };
      let result: DeployResult;
      if (spec.kind === "fail") result = { exitCode: 1, output: "Error: build failed\n", timedOut: false, interrupted: false };
      else if (spec.kind === "timeout") result = { exitCode: null, output: "", timedOut: true, interrupted: false };
      else {
        provider.versions += 1;
        const version = `20261122.${String(provider.versions)}`;
        provider.deploys.unshift({ version, status: "DEPLOYED" });
        if (spec.activate !== false) provider.current = version;
        provider.inventory = spec.inventory ?? {};
        result = { exitCode: 0, output: `${spec.extra ?? ""}${deployOutput(version, spec.tasks ?? TASKS[plane], "hash" in spec ? spec.hash : BASELINE[plane])}`, timedOut: false, interrupted: false };
      }
      state.afterDeploy?.(ref);
      return Promise.resolve(result);
    },
    interrupted: () => state.spawns.length >= state.interruptAfterSpawns,
    writeEvidence: (name, contents) => {
      if (state.evidence.has(name)) throw new Error("EEXIST");
      state.evidence.set(name, contents);
      return `${RECOVERY_EVIDENCE_DIRECTORY}/${name}`;
    },
    evidenceLocationIsLocalOnly: () => state.localOnly,
    now: (() => {
      let clock = Date.parse("2026-11-22T12:00:00.000Z");
      return () => new Date((clock += 1000));
    })(),
    log: (line) => state.logs.push(line),
  };
  return { state, deps };
}

const PLAN_ONLY: RecoveryOptions = {
  cli: CLI,
  knownGood: KNOWN_GOOD,
  releaseEvidence: EVIDENCE_NAME,
  worktree: WORKTREE,
  projectRefs: REFS,
  webRelease: WEB_OLD,
  provenWebPairing: undefined,
  acceptUnrecordedFingerprint: false,
  continueFrom: undefined,
  expectations: {},
  apply: false,
  attestIngestionPaused: false,
  attestWebRelayPin: false,
  timeoutMs: 60_000,
};
const APPLY: RecoveryOptions = { ...PLAN_ONLY, apply: true, attestIngestionPaused: true, attestWebRelayPin: true, expectations: { main: BAD_VERSION, intelligence: BAD_VERSION, integration: BAD_VERSION } };
const lastEvidence = (h: ReturnType<typeof harness>) => JSON.parse([...h.state.evidence.values()].at(-1) ?? "{}") as Record<string, unknown> & { planes: { plane: string; state: string; resultingVersion: string | null; fingerprint: string | null; problems: string[]; contentHash: string | null }[] };
const deployedPlanes = (h: ReturnType<typeof harness>) => h.state.spawns.map((spawn) => spawn.argv[spawn.argv.indexOf("--config") + 1]);
const READ_ONLY_TOOLS = new Set(["get_current_worker", "list_deploys", "list_runs"]);
const providerOf = (h: ReturnType<typeof harness>, plane: ReleasePlane): Provider => {
  const provider = h.state.providers[REFS[plane]];
  if (provider === undefined) throw new Error(`no synthetic project for ${plane}`);
  return provider;
};
const firstRecord = (h: ReturnType<typeof harness>): string => {
  const [name] = h.state.evidence.keys();
  if (name === undefined) throw new Error("no recovery record");
  return name;
};

describe("arguments", () => {
  const base = ["--cli", CLI, "--known-good", KNOWN_GOOD, "--release-evidence", EVIDENCE_NAME, "--worktree", WORKTREE, "--main-project-ref", REFS.main, "--intelligence-project-ref", REFS.intelligence, "--integration-project-ref", REFS.integration, "--web-release", WEB_OLD];

  it("PLAN ONLY by default; every identity is required; SHAs must be full", () => {
    expect(parseRecoveryArguments(base)).toMatchObject({ apply: false, knownGood: KNOWN_GOOD, projectRefs: REFS });
    expect(parseRecoveryArguments(base.slice(2))).toEqual({ error: "required: --cli" });
    expect(parseRecoveryArguments(base.map((token) => (token === KNOWN_GOOD ? KNOWN_GOOD.slice(0, 12) : token)))).toMatchObject({ error: expect.stringMatching(/--known-good must be a full/) as unknown });
    expect(parseRecoveryArguments(base.map((token) => (token === WEB_OLD ? "dpl_HT6ETxMo" : token)))).toMatchObject({ error: expect.stringMatching(/--web-release/) as unknown });
    expect(parseRecoveryArguments([...base, "--only", "main"])).toEqual({ error: "unknown argument: --only" });
    expect(parseRecoveryArguments([...base, "--force"])).toEqual({ error: "unknown argument: --force" });
  });

  it("missing confirmation: --apply needs the exact phrase for THIS commit and the ingestion-pause attestation", () => {
    expect(parseRecoveryArguments([...base, "--apply", "--attest-ingestion-paused", "--attest-web-relay-pin"])).toMatchObject({ error: expect.stringMatching(/--confirm-recovery with the exact phrase/) as unknown });
    expect(parseRecoveryArguments([...base, "--apply", "--attest-ingestion-paused", "--confirm-recovery", "recover-trigger-planes-to-000000000000"])).toMatchObject({ error: expect.stringMatching(/exact phrase/) as unknown });
    expect(parseRecoveryArguments([...base, "--apply", "--confirm-recovery", recoveryConfirmation(KNOWN_GOOD)])).toMatchObject({ error: expect.stringMatching(/--attest-ingestion-paused/) as unknown });
    expect(parseRecoveryArguments([...base, "--confirm-recovery", recoveryConfirmation(KNOWN_GOOD)])).toEqual({ error: "--confirm-recovery is only valid with --apply" });
    expect(parseRecoveryArguments([...base, "--apply", "--attest-ingestion-paused", "--confirm-recovery", recoveryConfirmation(KNOWN_GOOD)])).toMatchObject({ error: expect.stringMatching(/--attest-web-relay-pin/) as unknown });
    expect(parseRecoveryArguments([...base, "--attest-web-relay-pin"])).toEqual({ error: "--attest-web-relay-pin is only valid with --apply" });
    expect(parseRecoveryArguments([...base, "--apply", "--attest-ingestion-paused", "--attest-web-relay-pin", "--confirm-recovery", recoveryConfirmation(KNOWN_GOOD)])).toMatchObject({ apply: true, attestIngestionPaused: true, attestWebRelayPin: true });
  });
});

describe("PLAN ONLY", () => {
  it("valid three-plane plan: sanitized plan printed, only read-only provider calls, nothing deployed or written", async () => {
    const h = harness();
    const result = await runRecovery({ ...PLAN_ONLY, expectations: APPLY.expectations }, h.deps);
    expect(result).toMatchObject({ kind: "plan_only", blockers: [] });
    expect(exitCodeFor(result)).toBe(0);
    expect(h.state.spawns).toEqual([]);
    expect(h.state.evidence.size).toBe(0);
    expect(h.state.inspected.map((entry) => entry.ref)).toEqual([REFS.main, REFS.intelligence, REFS.integration]);
    expect(h.state.inspected.flatMap((entry) => entry.tools).every((tool) => READ_ONLY_TOOLS.has(tool))).toBe(true);
    const plan = h.state.logs.join("\n");
    for (const phrase of ["MAIN → INTELLIGENCE → INTEGRATION", KNOWN_GOOD, REFS.main, REFS.intelligence, REFS.integration, `active ${BAD_VERSION}`, `known-good ${KNOWN_GOOD_VERSION} (DEPLOYED)`, "expects 11 tasks under jobs/trigger/main/", "0034_workflow_core.sql", recoveryConfirmation(KNOWN_GOOD), "PLAN ONLY: nothing deployed"]) expect(plan, phrase).toContain(phrase);
    expect(plan).toContain("<tool-empty-env-file>");
    expect(plan).not.toContain("/tmp/fake-");
    expect(h.state.envFiles.every((entry) => entry.cleaned)).toBe(true);
  });

  it("without expectations the plan lists what an apply would need, and still deploys nothing", async () => {
    const h = harness();
    const result = await runRecovery(PLAN_ONLY, h.deps);
    expect(result.kind).toBe("plan_only");
    if (result.kind !== "plan_only") return;
    expect(result.blockers).toEqual(["--expect-main-version is required (the active version shown by the plan)", "--expect-intelligence-version is required (the active version shown by the plan)", "--expect-integration-version is required (the active version shown by the plan)"]);
    expect(h.state.spawns).toEqual([]);
  });
});

describe("refusals before anything deploys", () => {
  const refused = async (mutate: (h: ReturnType<typeof harness>) => void, options: Partial<RecoveryOptions> = {}, message?: RegExp) => {
    const h = harness();
    mutate(h);
    const result = await runRecovery({ ...APPLY, confirm: undefined, ...options } as RecoveryOptions, h.deps);
    expect(result.kind).toBe("refused");
    if (message !== undefined) expect(JSON.stringify(result)).toMatch(message);
    expect(h.state.spawns).toEqual([]);
    expect(h.state.evidence.size).toBe(0);
    return result;
  };

  it("unknown or unapproved source commit: not in origin/main, not the evidence's SHA, not a commit here", async () => {
    await refused((h) => (h.state.ancestorOfOrigin = false), {}, /not in origin\/main's history/);
    await refused(() => undefined, { knownGood: WEB_NEW }, /(not in this repository|not the release SHA)/);
  });

  it("missing or unapproved release evidence", async () => {
    await refused((h) => {
      h.state.files.clear();
    }, {}, /release evidence not found/);
    await refused(() => undefined, { releaseEvidence: "../../etc/passwd" }, /bare file name/);
    await refused((h) => h.state.files.set(`${ROOT}/.wrenkind-local/evidence/trigger-release-pair/${EVIDENCE_NAME}`, releaseRecord({ mutate: (record) => (record["finalState"] = "STOP_INTEGRATION_FAILED") })), {}, /not ALIGNED/);
  });

  it("wrong project identity (any project not in the approved release)", async () => {
    await refused(() => undefined, { projectRefs: { ...REFS, integration: "proj_unapprovedtestref01" } }, /--integration-project-ref is not the integration project of the approved release/);
  });

  it("wrong environment (the approved release was not prod)", async () => {
    await refused((h) => h.state.files.set(`${ROOT}/.wrenkind-local/evidence/trigger-release-pair/${EVIDENCE_NAME}`, releaseRecord({ mutate: (record) => (record["environment"] = "staging") })), {}, /environment is not prod/);
  });

  it("source SHA mismatch and an unprepared worktree: other HEAD, on a branch, dirty, another repository, inside the checkout, env files, no npm ci", async () => {
    await refused((h) => (h.state.wtHead = WEB_NEW), {}, /not checked out at the known-good commit/);
    await refused((h) => (h.state.wtBranch = true), {}, /must be detached/);
    await refused((h) => (h.state.wtStatus = "?? stray.txt\n"), {}, /not clean/);
    await refused((h) => (h.state.wtCommon = "/elsewhere/.git"), {}, /object store differs/);
    await refused(() => undefined, { worktree: `${ROOT}/sub` }, /separate sibling directory/);
    await refused(() => undefined, { worktree: "relative/path" }, /absolute path/);
    await refused((h) => h.state.wtEntries.push(".env.local"), {}, /environment files \(\.env\.local\)/);
    const h = harness();
    const original = h.deps.fileExists;
    const result = await runRecovery(APPLY, { ...h.deps, fileExists: (p) => !p.endsWith("node_modules/.package-lock.json") && original(p) });
    expect(JSON.stringify(result)).toMatch(/run npm ci there/);
  });

  it("missing signing-helper prerequisites: builds absent, or pins that differ from the known-good commit", async () => {
    await refused((h) => (h.state.helpersPresent = false), {}, /signing-helper builds are not ready/);
    await refused((h) => (h.state.helperPinsSame = false), {}, /signing-helper pins of the known-good commit differ/);
  });

  it("runtime mismatch: the CLI is not the known-good SDK version", async () => {
    await refused((h) => (h.state.cliVersion = "4.8.0"), {}, /CLI is 4\.8\.0/);
    await refused(() => undefined, { cli: "/usr/bin/false" }, /executable trigger CLI/);
  });

  it("unexpected active version: the plane is not on the version the operator approved", async () => {
    await refused(() => undefined, { expectations: { ...APPLY.expectations, intelligence: "20261121.7" } }, /intelligence: the active version is 20261122\.1, the operator expects 20261121\.7/);
  });

  it("incompatible web: a Workflow web beside the pre-Workflow worker requires the web rollback first (no attestation helps)", async () => {
    const h = harness({ webPaths: ["modules/workflow/persistence/read-store.ts"] });
    h.state.contractDiff = "db/migrations/0034_workflow_core.sql\n";
    const result = await runRecovery({ ...APPLY, webRelease: WEB_NEW, provenWebPairing: provenPairingValue(WEB_NEW, KNOWN_GOOD) }, h.deps);
    expect(result.kind).toBe("refused");
    expect(JSON.stringify(result)).toMatch(/web rollback required first — workflow-0034/);
    expect(h.state.spawns).toEqual([]);
  });

  it("incompatible database contract: a newer web with migrations the worker predates needs a rollback or the exact proven-pairing attestation", async () => {
    const h = harness();
    h.state.contractDiff = "db/migrations/0032_reply_in_flight_admission.sql\n";
    expect(await runRecovery({ ...APPLY, webRelease: WEB_NEW }, h.deps)).toMatchObject({ kind: "refused" });
    expect(h.state.spawns).toEqual([]);
    const attested = harness();
    attested.state.contractDiff = "db/migrations/0032_reply_in_flight_admission.sql\n";
    expect(await runRecovery({ ...APPLY, webRelease: WEB_NEW, provenWebPairing: provenPairingValue(WEB_NEW, KNOWN_GOOD) }, attested.deps)).toMatchObject({ kind: "recovery", finalState: "RECOVERED" });
    expect(lastEvidence(attested)["webVerdict"]).toMatchObject({ kind: "COMPATIBLE_ATTESTED" });
  });

  it("the known-good deployment must still be DEPLOYED on every plane (MAIN-first pins to it)", async () => {
    await refused((h) => (providerOf(h, "integration").deploys = [{ version: BAD_VERSION, status: "DEPLOYED" }]), {}, /integration: the known-good deployment 20261113\.1 is not listed as DEPLOYED/);
  });

  it("nothing to recover when every plane already runs the known-good deployment", async () => {
    await refused((h) => {
      for (const plane of PLANES) providerOf(h, plane).current = KNOWN_GOOD_VERSION;
    }, { expectations: { main: KNOWN_GOOD_VERSION, intelligence: KNOWN_GOOD_VERSION, integration: KNOWN_GOOD_VERSION } }, /nothing to recover/);
  });

  it("a v2 approved release (no fingerprints) needs the explicit --accept-unrecorded-fingerprint", async () => {
    const h = harness({ schema: "v2" });
    expect(JSON.stringify(await runRecovery(APPLY, h.deps))).toMatch(/recorded no content fingerprint for main, intelligence, integration/);
    expect(h.state.spawns).toEqual([]);
  });

  it("the evidence location must be local-only", async () => {
    await refused((h) => (h.state.localOnly = false), {}, /git-ignored and Vercel-excluded/);
  });
});

describe("apply", () => {
  it("successful sequential recovery: MAIN, INTELLIGENCE, INTEGRATION from the worktree, each verified before the next", async () => {
    const h = harness();
    const result = await runRecovery(APPLY, h.deps);
    expect(result).toMatchObject({ kind: "recovery", finalState: "RECOVERED" });
    expect(exitCodeFor(result)).toBe(0);
    expect(deployedPlanes(h)).toEqual(["trigger.config.ts", "trigger.intelligence.config.ts", "trigger.integration.config.ts"]);
    for (const spawn of h.state.spawns) {
      expect(spawn.cwd).toBe(WORKTREE);
      expect(spawn.argv[spawn.argv.indexOf("--external-id") + 1]).toBe(KNOWN_GOOD);
      expect(spawn.argv[spawn.argv.indexOf("--env") + 1]).toBe("prod");
      expect(spawn.argv).not.toContain("promote");
    }
    const evidence = lastEvidence(h);
    expect(evidence).toMatchObject({ schema: "wrenkind.trigger-recovery.v1", knownGoodSha: KNOWN_GOOD, releaseEvidence: EVIDENCE_NAME, recoveryOrder: ["main", "intelligence", "integration"], finalState: "RECOVERED", recoveredPlanes: ["main", "intelligence", "integration"], unrecoveredPlanes: [], stopReason: null, continues: null });
    expect(evidence["attestations"]).toEqual({ ingestionPaused: true, webRelayPin: true, provenWebPairing: false, acceptUnrecordedFingerprint: false });
    expect(evidence["startingVersions"]).toEqual({ main: BAD_VERSION, intelligence: BAD_VERSION, integration: BAD_VERSION });
    expect(evidence.planes.map((plane) => [plane.plane, plane.state, plane.resultingVersion, plane.fingerprint])).toEqual([["main", "RECOVERED", "20261122.2", "MATCH"], ["intelligence", "RECOVERED", "20261122.2", "MATCH"], ["integration", "RECOVERED", "20261122.2", "MATCH"]]);
    expect([...h.state.evidence.keys()][0]).toMatch(new RegExp(`^2026-11-22T\\d{9}Z-${KNOWN_GOOD.slice(0, 12)}\\.json$`));
    expect(h.state.inspected.flatMap((entry) => entry.tools).every((tool) => READ_ONLY_TOOLS.has(tool))).toBe(true);
    // A fresh plan now attributes each active version to this recovery record, per PROJECT (versions repeat across projects).
    h.state.logs.length = 0;
    await runRecovery(PLAN_ONLY, h.deps);
    const name = firstRecord(h);
    expect(h.state.logs.filter((line) => line.includes(`active 20261122.2 = ${KNOWN_GOOD.slice(0, 12)} (recovery ${name})`))).toHaveLength(3);
  });

  it("the plan attributes an active version only to a record of the SAME project (versions repeat across projects)", async () => {
    const h = harness();
    // Another project's release produced the same version number as the active one here: it is not this plane's release.
    const otherName = `2026-11-21T000000000Z-${BAD.slice(0, 12)}.json`;
    h.state.files.set(`${ROOT}/.wrenkind-local/evidence/trigger-release-pair/${otherName}`, releaseRecord({ sha: BAD, version: BAD_VERSION, refs: { main: "proj_unrelatedmainaaaaaa", intelligence: "proj_unrelatedintelaaaaa", integration: "proj_unrelatedintegaaaaa" } }));
    await runRecovery(PLAN_ONLY, h.deps);
    expect(h.state.logs.filter((line) => line.includes(`active ${BAD_VERSION} (no local record)`))).toHaveLength(3);
    expect(h.state.logs.join("\n")).not.toContain(otherName);
    // The same version recorded for THESE projects is attributed.
    const same = harness();
    same.state.files.set(`${ROOT}/.wrenkind-local/evidence/trigger-release-pair/${otherName}`, releaseRecord({ sha: BAD, version: BAD_VERSION }));
    await runRecovery(PLAN_ONLY, same.deps);
    expect(same.state.logs.filter((line) => line.includes(`active ${BAD_VERSION} = ${BAD.slice(0, 12)} (release ${otherName})`))).toHaveLength(3);
  });

  it("v2 baseline accepted explicitly → RECOVERED_FINGERPRINT_UNVERIFIED (never plain RECOVERED); the observed fingerprints are recorded", async () => {
    const h = harness({ schema: "v2" });
    const result = await runRecovery({ ...APPLY, acceptUnrecordedFingerprint: true }, h.deps);
    expect(result).toMatchObject({ kind: "recovery", finalState: "RECOVERED_FINGERPRINT_UNVERIFIED" });
    const evidence = lastEvidence(h);
    expect(evidence.planes.map((plane) => plane.fingerprint)).toEqual(["NO_BASELINE", "NO_BASELINE", "NO_BASELINE"]);
    expect(evidence.planes.map((plane) => plane.contentHash)).toEqual([BASELINE.main, BASELINE.intelligence, BASELINE.integration]);
  });

  it.each([
    ["first (MAIN)", "main", "STOPPED_NOTHING_RECOVERED", [], ["main", "intelligence", "integration"], 1],
    ["second (INTELLIGENCE)", "intelligence", "STOPPED_PARTIAL", ["main"], ["intelligence", "integration"], 2],
    ["third (INTEGRATION)", "integration", "STOPPED_PARTIAL", ["main", "intelligence"], ["integration"], 3],
  ] as const)("failure on the %s plane: stop there, no retry, later planes never start, the record is honest", async (_label, failing, finalState, recovered, unrecovered, spawns) => {
    const h = harness({ deploys: { [failing]: [{ kind: "fail" }, { kind: "ok" }] } });
    const result = await runRecovery(APPLY, h.deps);
    expect(result).toMatchObject({ kind: "recovery", finalState });
    expect(exitCodeFor(result)).toBe(1);
    expect(h.state.spawns).toHaveLength(spawns);
    const evidence = lastEvidence(h);
    expect(evidence).toMatchObject({ recoveredPlanes: recovered, unrecoveredPlanes: unrecovered });
    expect(evidence.planes.find((plane) => plane.plane === failing)?.state).toBe("DEPLOY_FAILED");
    expect(String(evidence["stopReason"])).toMatch(new RegExp(`^${failing}: DEPLOY_FAILED`));
    // The failed plane is still on its previous version: nothing was restored or retried.
    expect(providerOf(h, failing).current).toBe(BAD_VERSION);
  });

  it("a deploy that times out is UNKNOWN, never a success", async () => {
    const h = harness({ deploys: { intelligence: [{ kind: "timeout" }] } });
    expect(await runRecovery(APPLY, h.deps)).toMatchObject({ finalState: "STOPPED_PARTIAL" });
    expect(lastEvidence(h).planes[1]).toMatchObject({ state: "DEPLOY_UNKNOWN" });
  });

  it("partially completed recovery and safe continuation: recovered MAIN is re-verified fresh (not redeployed), the rest deploys", async () => {
    const h = harness({ deploys: { intelligence: [{ kind: "fail" }, { kind: "ok" }] } });
    await runRecovery(APPLY, h.deps);
    const first = firstRecord(h);
    expect(lastEvidence(h)).toMatchObject({ finalState: "STOPPED_PARTIAL", recoveredPlanes: ["main"] });
    h.state.spawns.length = 0;
    // Plan first (fresh state), then apply with the expectations the plan shows; MAIN needs none (recorded as recovered).
    const planned = await runRecovery({ ...PLAN_ONLY, continueFrom: first, expectations: { intelligence: BAD_VERSION, integration: BAD_VERSION } }, h.deps);
    expect(planned).toMatchObject({ kind: "plan_only", blockers: [] });
    const result = await runRecovery({ ...APPLY, continueFrom: first, expectations: { intelligence: BAD_VERSION, integration: BAD_VERSION } }, h.deps);
    expect(result).toMatchObject({ kind: "recovery", finalState: "RECOVERED" });
    expect(deployedPlanes(h)).toEqual(["trigger.intelligence.config.ts", "trigger.integration.config.ts"]);
    const evidence = lastEvidence(h);
    expect(evidence).toMatchObject({ continues: first, recoveredPlanes: ["main", "intelligence", "integration"] });
    expect(evidence.planes.map((plane) => plane.state)).toEqual(["ALREADY_RECOVERED", "RECOVERED", "RECOVERED"]);
  });

  it("continuation refuses when a plane recorded as recovered has since changed (investigate, never overwrite)", async () => {
    const h = harness({ deploys: { intelligence: [{ kind: "fail" }] } });
    await runRecovery(APPLY, h.deps);
    const first = firstRecord(h);
    providerOf(h, "main").current = "20261122.7";
    const result = await runRecovery({ ...APPLY, continueFrom: first, expectations: { intelligence: BAD_VERSION, integration: BAD_VERSION } }, h.deps);
    expect(JSON.stringify(result)).toMatch(/main: recorded as recovered to 20261122\.2, but 20261122\.7 is active now/);
    expect(h.state.spawns).toHaveLength(2);
  });

  it("unexpected active version during the apply: a plane changed after the plan → stop before deploying it", async () => {
    const h = harness();
    h.state.afterDeploy = (ref) => {
      if (ref === REFS.main) providerOf(h, "intelligence").current = "20261122.5";
    };
    expect(await runRecovery(APPLY, h.deps)).toMatchObject({ finalState: "STOPPED_PARTIAL" });
    expect(deployedPlanes(h)).toEqual(["trigger.config.ts"]);
    expect(lastEvidence(h).planes[1]).toMatchObject({ state: "UNEXPECTED_ACTIVE_VERSION", problems: ["active 20261122.5, expected 20261122.1"] });
  });

  it("unexpected active version after the deploy: the provider does not run the version this recovery created → VERIFICATION_FAILED", async () => {
    const h = harness({ deploys: { main: [{ kind: "ok", activate: false }] } });
    expect(await runRecovery(APPLY, h.deps)).toMatchObject({ finalState: "STOPPED_NOTHING_RECOVERED" });
    expect(lastEvidence(h).planes[0]?.problems.join()).toMatch(/active version is 20261122\.1, not 20261122\.2 created by this recovery/);
  });

  it("mismatched task inventory: a deploy that reports another count is UNKNOWN; a provider inventory of another plane fails verification", async () => {
    const count = harness({ deploys: { intelligence: [{ kind: "ok", tasks: 2 }] } });
    expect(await runRecovery(APPLY, count.deps)).toMatchObject({ finalState: "STOPPED_PARTIAL" });
    expect(lastEvidence(count).planes[1]).toMatchObject({ state: "DEPLOY_UNKNOWN" });
    const foreign = harness({ deploys: { main: [{ kind: "ok", inventory: { directory: "jobs/trigger/integration" } }] } });
    expect(await runRecovery(APPLY, foreign.deps)).toMatchObject({ finalState: "STOPPED_NOTHING_RECOVERED" });
    expect(lastEvidence(foreign).planes[0]?.problems.join()).toMatch(/outside jobs\/trigger\/main\//);
  });

  it("content fingerprint mismatch (or unreadable while recorded) stops the recovery at that plane", async () => {
    const mismatch = harness({ deploys: { integration: [{ kind: "ok", hash: "e".repeat(32) }] } });
    expect(await runRecovery(APPLY, mismatch.deps)).toMatchObject({ finalState: "STOPPED_PARTIAL" });
    expect(lastEvidence(mismatch).planes[2]).toMatchObject({ state: "VERIFICATION_FAILED" });
    const unreadable = harness({ deploys: { main: [{ kind: "ok", hash: undefined }] } });
    expect(await runRecovery(APPLY, unreadable.deps)).toMatchObject({ finalState: "STOPPED_NOTHING_RECOVERED" });
  });

  it("worktree drift between planes stops before the next deploy", async () => {
    const h = harness();
    h.state.afterDeploy = () => {
      h.state.wtStatus = " M jobs/trigger/main/delivery.ts\n";
    };
    expect(await runRecovery(APPLY, h.deps)).toMatchObject({ finalState: "STOPPED_PARTIAL" });
    expect(h.state.spawns).toHaveLength(1);
    expect(lastEvidence(h).planes[1]).toMatchObject({ state: "NOT_STARTED", problems: ["the worktree is no longer clean"] });
  });

  it("operator interrupt: no further plane starts; partial is recorded as partial", async () => {
    const h = harness();
    h.state.interruptAfterSpawns = 1;
    expect(await runRecovery(APPLY, h.deps)).toMatchObject({ finalState: "STOPPED_PARTIAL" });
    expect(h.state.spawns).toHaveLength(1);
    expect(lastEvidence(h).planes.map((plane) => plane.state)).toEqual(["RECOVERED", "NOT_STARTED", "NOT_STARTED"]);
  });

  it("evidence is redacted: a credential in the CLI output never reaches the record", async () => {
    const h = harness({ deploys: { main: [{ kind: "ok", extra: `debug ${SECRET} ${CREDENTIAL_URL}\n` }] } });
    await runRecovery(APPLY, h.deps);
    const raw = [...h.state.evidence.values()].join("\n");
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(["user", ":", "pw@"].join(""));
    expect(h.state.logs.join("\n")).not.toContain(SECRET);
  });
});
