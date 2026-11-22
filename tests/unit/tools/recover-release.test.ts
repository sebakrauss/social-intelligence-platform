/**
 * RECOVERY-TOOLING-01 / -02 / -03 — the recovery operator with every effect faked: git (repository and the prepared worktree),
 * files, the CLI version, the CLI's READ-ONLY MCP server (current worker, deployments, run counts) and the deploy spawn,
 * which simulates the provider's real external-id semantics (RECOVERY-REHEARSAL-03B): a deploy under an id the project
 * already holds builds NOTHING, exits 0 and says "Version … was already deployed for --external-id … — nothing to build".
 * Proves PLAN ONLY by default (nothing spawned, nothing written), every refusal before a deploy, the INTEGRATION →
 * INTELLIGENCE → MAIN order from the worktree under ONE recovery id (never the known-good SHA), per-plane verification
 * (version, inventory, fingerprint), stop-at-first-failure with an honest partial record, explicit continuation under the
 * same id with fresh verification, and redacted evidence.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AWS_SIGNING_HELPER_ARTIFACTS, awsSigningHelperRelativePath } from "../../../jobs/aws-signing-helper.ts";
import type * as HelperPins from "../../../jobs/aws-signing-helper.ts";
import type { DeployResult } from "../../../tools/trigger/deploy-release-pair.ts";
import { exitCodeFor, parseRecoveryArguments, runRecovery, type InspectCall, type RecoveryDependencies, type RecoveryOptions } from "../../../tools/trigger/recover-release.ts";
import type { ReleasePlane } from "../../../tools/trigger/release-pair.ts";
import { RECOVERY_EVIDENCE_DIRECTORY, provenPairingValue, recoveryConfirmation } from "../../../tools/trigger/recovery-plan.ts";
import { crossPlanePin, jobRelease } from "../../../platform/jobs/release.ts";
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
const PLANES: readonly ReleasePlane[] = ["integration", "intelligence", "main"];
/** This attempt's recovery id (the harness clock starts at 2026-11-22T12:00:00Z). */
const RID = `recovery-${KNOWN_GOOD.slice(0, 12)}-20261122T110000Z`;

type DeploySpec =
  | { readonly kind: "ok"; readonly hash?: string | undefined; readonly activate?: boolean; readonly tasks?: number; readonly extra?: string; readonly inventory?: Parameters<typeof currentWorkerText>[2] }
  | { readonly kind: "fail" }
  | { readonly kind: "timeout" }
  /** The operator's Ctrl-C during the build. `lands`: the provider finishes and activates it anyway. `hash`: the worker line seen before the interrupt (undefined = not seen). */
  | { readonly kind: "interrupt"; readonly lands: boolean; readonly hash?: string | undefined; readonly orphan?: string }
  /** Exit 0 and nothing the CLI normally prints: no version, no task count. */
  | { readonly kind: "silent" }
  /** Exit 0 reporting the version that was already active (nothing new). */
  | { readonly kind: "same_version" };

interface Provider {
  current: string;
  versions: number;
  deploys: { version: string; status: string; shortCode?: string }[];
  inventory: Parameters<typeof currentWorkerText>[2];
  /** External id → version: the provider never rebuilds an id it holds (RECOVERY-REHEARSAL-03B). */
  byId: Map<string, string>;
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
    providers: Object.fromEntries(PLANES.map((plane) => [REFS[plane], { current: BAD_VERSION, versions: 1, deploys: [{ version: BAD_VERSION, status: "DEPLOYED" }, { version: KNOWN_GOOD_VERSION, status: "DEPLOYED" }], inventory: {}, byId: new Map([[KNOWN_GOOD, KNOWN_GOOD_VERSION], [BAD, BAD_VERSION]]) } satisfies Provider])) as Record<string, Provider>,
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
    /** Called before each read-only MCP session answers (simulate a deployment appearing between reads). */
    beforeInspect: undefined as ((ref: string, tools: readonly string[]) => void) | undefined,
    /** A project's raw list_deploys answer, replacing the synthetic one (undefined = the call failed). */
    deployListOverride: new Map<string, string | undefined>(),
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
      state.beforeInspect?.(ref, calls.map((call) => call.tool));
      const provider = state.providers[ref];
      return Promise.resolve(calls.map((call) => {
        if (provider === undefined) return undefined;
        const plane = PLANES.find((entry) => REFS[entry] === ref) ?? "main";
        if (call.tool === "get_current_worker") return currentWorkerText(provider.current, plane, provider.inventory);
        if (call.tool === "list_deploys") return state.deployListOverride.has(ref) ? state.deployListOverride.get(ref) : deployListText(provider.deploys);
        return runListText(0);
      }));
    },
    spawnDeploy: (_cli, argv, cwd) => {
      state.spawns.push({ argv, cwd });
      const ref = argv[argv.indexOf("--project-ref") + 1] ?? "";
      const plane = PLANES.find((entry) => REFS[entry] === ref) ?? "main";
      const provider = state.providers[ref];
      if (provider === undefined) throw new Error(`no synthetic project ${ref}`);
      const externalId = argv[argv.indexOf("--external-id") + 1] ?? "";
      const held = provider.byId.get(externalId);
      const queued = state.deploySpecs[ref]?.shift();
      const spec: DeploySpec = queued ?? { kind: "fail" };
      const create = (activate: boolean) => {
        provider.versions += 1;
        const version = `20261122.${String(provider.versions)}`;
        provider.deploys.unshift({ version, status: "DEPLOYED" });
        provider.byId.set(externalId, version);
        if (activate) provider.current = version;
        return version;
      };
      let result: DeployResult;
      if (held !== undefined && queued?.kind !== "fail" && queued?.kind !== "timeout") {
        // The provider's answer for an id it already holds: nothing is built, exit 0 (the CLI code path seen in 03B).
        const notCurrent = held === provider.current ? "" : "▲  Warning: This version is not the current deployment.\n│  Promote it from the dashboard, or deploy again with --force to build a new version.\n";
        result = { exitCode: 0, output: `◇  Successfully built code\n▲  Warning: Environment variables were not synced because nothing was built.\n${notCurrent}└  Version ${held} was already deployed for --external-id ${externalId} — nothing to build \n`, timedOut: false, interrupted: false };
      } else if (spec.kind === "fail") result = { exitCode: 1, output: "Error: build failed\n", timedOut: false, interrupted: false };
      else if (spec.kind === "timeout") result = { exitCode: null, output: "", timedOut: true, interrupted: false };
      else if (spec.kind === "silent") result = { exitCode: 0, output: "│\n└  \n", timedOut: false, interrupted: false };
      else if (spec.kind === "same_version") result = { exitCode: 0, output: deployOutput(provider.current, TASKS[plane], BASELINE[plane]), timedOut: false, interrupted: false };
      else if (spec.kind === "interrupt") {
        state.interruptAfterSpawns = state.spawns.length;
        let version = spec.lands ? create(true) : `20261122.${String(provider.versions + 1)}`;
        if (!spec.lands && spec.orphan !== undefined) {
          // RECOVERY-REHEARSAL-03C: the server keeps the interrupted deployment (it consumed the version number), never active.
          provider.versions += 1;
          version = `20261122.${String(provider.versions)}`;
          provider.deploys.unshift({ version, status: spec.orphan, shortCode: "k8hqb03l" });
        }
        const seen = "hash" in spec ? spec.hash : BASELINE[plane];
        const line = seen === undefined ? "" : `#19 1.1 {"message":"Background worker created","buildPlatform":"linux/amd64","targetPlatform":"linux/amd64","createResponse":{"id":"worker_synthetic","version":"${version}","contentHash":"${seen}","warnings":[]}}\n`;
        result = { exitCode: null, output: `◇  Successfully built code\n${line}`, timedOut: false, interrupted: true };
      } else {
        const version = create(spec.activate !== false);
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
  recoveryId: undefined,
  expectations: {},
  apply: false,
  attestIngestionPaused: false,
  attestWebRelayPin: false,
  timeoutMs: 60_000,
};
const APPLY: RecoveryOptions = { ...PLAN_ONLY, apply: true, recoveryId: RID, attestIngestionPaused: true, attestWebRelayPin: true, expectations: { main: BAD_VERSION, intelligence: BAD_VERSION, integration: BAD_VERSION } };
const lastEvidence = (h: ReturnType<typeof harness>) => JSON.parse([...h.state.evidence.values()].at(-1) ?? "{}") as Record<string, unknown> & { planes: { plane: string; state: string; resultingVersion: string | null; fingerprint: string | null; problems: string[]; contentHash: string | null; provenance: string | null; observedWorkers: { version: string; contentHash: string }[]; argv: string[] }[] };
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
    expect(parseRecoveryArguments([...base, "--apply", "--attest-ingestion-paused", "--attest-web-relay-pin", "--confirm-recovery", recoveryConfirmation(KNOWN_GOOD)])).toMatchObject({ error: expect.stringMatching(/--apply needs --recovery-id/) as unknown });
    expect(parseRecoveryArguments([...base, "--apply", "--attest-ingestion-paused", "--attest-web-relay-pin", "--confirm-recovery", recoveryConfirmation(KNOWN_GOOD), "--recovery-id", RID])).toMatchObject({ apply: true, recoveryId: RID, attestIngestionPaused: true, attestWebRelayPin: true });
  });

  it("the recovery id is never free text: its exact form, never a commit SHA; PLAN ONLY may omit it (the plan proposes one)", () => {
    expect(parseRecoveryArguments(base)).toMatchObject({ recoveryId: undefined });
    for (const bad of [KNOWN_GOOD, `recovery-${KNOWN_GOOD.slice(0, 12)}`, `recovery-${KNOWN_GOOD.slice(0, 12)}-2026-11-22T11:00:00Z`, `${RID} `, "latest"]) {
      expect(parseRecoveryArguments([...base, "--recovery-id", bad]), bad).toMatchObject({ error: expect.stringMatching(/--recovery-id must be recovery-/) as unknown });
    }
  });
});

describe("PLAN ONLY", () => {
  it("valid three-plane plan: sanitized plan printed, only read-only provider calls, nothing deployed or written", async () => {
    const h = harness();
    const result = await runRecovery({ ...PLAN_ONLY, recoveryId: RID, expectations: APPLY.expectations }, h.deps);
    expect(result).toMatchObject({ kind: "plan_only", blockers: [] });
    expect(exitCodeFor(result)).toBe(0);
    expect(h.state.spawns).toEqual([]);
    expect(h.state.evidence.size).toBe(0);
    expect(h.state.inspected.map((entry) => entry.ref)).toEqual([REFS.integration, REFS.intelligence, REFS.main]);
    expect(h.state.inspected.flatMap((entry) => entry.tools).every((tool) => READ_ONLY_TOOLS.has(tool))).toBe(true);
    const plan = h.state.logs.join("\n");
    for (const phrase of ["INTEGRATION → INTELLIGENCE → MAIN", `recovery id:        ${RID} — NEW (given`, "never the known-good SHA", "not deployed by this attempt (eligible: the deploy creates it)", `--external-id ${RID}`, KNOWN_GOOD, REFS.main, REFS.intelligence, REFS.integration, `active ${BAD_VERSION}`, `known-good ${KNOWN_GOOD_VERSION} (DEPLOYED)`, "expects 11 tasks under jobs/trigger/main/", "0034_workflow_core.sql", recoveryConfirmation(KNOWN_GOOD), "PLAN ONLY: nothing deployed"]) expect(plan, phrase).toContain(phrase);
    expect(plan).toContain("<tool-empty-env-file>");
    expect(plan).not.toContain("/tmp/fake-");
    expect(h.state.envFiles.every((entry) => entry.cleaned)).toBe(true);
  });

  it("without expectations the plan lists what an apply would need, and still deploys nothing", async () => {
    const h = harness();
    const result = await runRecovery(PLAN_ONLY, h.deps);
    expect(result.kind).toBe("plan_only");
    if (result.kind !== "plan_only") return;
    // A fresh plan proposes a NEW recovery id (from the clock) that an apply needs back explicitly.
    expect(result.blockers[0]).toMatch(new RegExp(`^--recovery-id recovery-${KNOWN_GOOD.slice(0, 12)}-20261122T1200\\d{2}Z is required \\(the new recovery id this plan proposes`));
    expect(result.blockers.slice(1)).toEqual(["--expect-integration-version is required (the active version shown by the plan)", "--expect-intelligence-version is required (the active version shown by the plan)", "--expect-main-version is required (the active version shown by the plan)"]);
    expect(h.state.logs.join("\n")).toMatch(/— NEW \(proposed by this plan; an apply needs it back with --recovery-id\)/);
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
    expect(JSON.stringify(await runRecovery(APPLY, h.deps))).toMatch(/recorded no content fingerprint for integration, intelligence, main/);
    expect(h.state.spawns).toEqual([]);
  });

  it("the evidence location must be local-only", async () => {
    await refused((h) => (h.state.localOnly = false), {}, /git-ignored and Vercel-excluded/);
  });
});

describe("apply", () => {
  it("successful sequential recovery: INTEGRATION, INTELLIGENCE, MAIN from the worktree under ONE recovery id, each verified before the next", async () => {
    const h = harness();
    const result = await runRecovery(APPLY, h.deps);
    expect(result).toMatchObject({ kind: "recovery", finalState: "RECOVERED" });
    expect(exitCodeFor(result)).toBe(0);
    expect(deployedPlanes(h)).toEqual(["trigger.integration.config.ts", "trigger.intelligence.config.ts", "trigger.config.ts"]);
    for (const spawn of h.state.spawns) {
      expect(spawn.cwd).toBe(WORKTREE);
      expect(spawn.argv[spawn.argv.indexOf("--external-id") + 1]).toBe(RID);
      expect(spawn.argv).not.toContain(KNOWN_GOOD);
      expect(spawn.argv).not.toContain("--force");
      expect(spawn.argv[spawn.argv.indexOf("--env") + 1]).toBe("prod");
      expect(spawn.argv).not.toContain("promote");
    }
    const evidence = lastEvidence(h);
    expect(evidence).toMatchObject({ schema: "wrenkind.trigger-recovery.v2", knownGoodSha: KNOWN_GOOD, recoveryId: RID, releaseEvidence: EVIDENCE_NAME, recoveryOrder: ["integration", "intelligence", "main"], finalState: "RECOVERED", recoveredPlanes: ["integration", "intelligence", "main"], unrecoveredPlanes: [], stopReason: null, continues: null });
    expect(evidence["attestations"]).toEqual({ ingestionPaused: true, webRelayPin: true, provenWebPairing: false, acceptUnrecordedFingerprint: false });
    expect(evidence["startingVersions"]).toEqual({ main: BAD_VERSION, intelligence: BAD_VERSION, integration: BAD_VERSION });
    expect(evidence.planes.map((plane) => [plane.plane, plane.state, plane.resultingVersion, plane.fingerprint, plane.provenance])).toEqual([["integration", "RECOVERED", "20261122.2", "MATCH", "created"], ["intelligence", "RECOVERED", "20261122.2", "MATCH", "created"], ["main", "RECOVERED", "20261122.2", "MATCH", "created"]]);
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
    expect(evidence.planes.map((plane) => plane.contentHash)).toEqual([BASELINE.integration, BASELINE.intelligence, BASELINE.main]);
  });

  it.each([
    ["first (INTEGRATION)", "integration", "STOPPED_NOTHING_RECOVERED", [], ["integration", "intelligence", "main"], 1],
    ["second (INTELLIGENCE)", "intelligence", "STOPPED_PARTIAL", ["integration"], ["intelligence", "main"], 2],
    ["third (MAIN)", "main", "STOPPED_PARTIAL", ["integration", "intelligence"], ["main"], 3],
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

  it("partially completed recovery and safe continuation: recovered INTEGRATION is re-verified fresh (not redeployed), the rest deploys under the SAME id", async () => {
    const h = harness({ deploys: { intelligence: [{ kind: "fail" }, { kind: "ok" }] } });
    await runRecovery(APPLY, h.deps);
    const first = firstRecord(h);
    expect(lastEvidence(h)).toMatchObject({ finalState: "STOPPED_PARTIAL", recoveredPlanes: ["integration"] });
    h.state.spawns.length = 0;
    // Plan first (fresh state), then apply with the expectations the plan shows; INTEGRATION needs none (recorded as recovered).
    const planned = await runRecovery({ ...PLAN_ONLY, continueFrom: first, expectations: { intelligence: BAD_VERSION, main: BAD_VERSION } }, h.deps);
    expect(planned).toMatchObject({ kind: "plan_only", blockers: [] });
    expect(h.state.logs.join("\n")).toContain(`recovery id:        ${RID} — the continued attempt's (${first}); a continuation never mints a new id`);
    const result = await runRecovery({ ...APPLY, continueFrom: first, expectations: { intelligence: BAD_VERSION, main: BAD_VERSION } }, h.deps);
    expect(result).toMatchObject({ kind: "recovery", finalState: "RECOVERED" });
    expect(deployedPlanes(h)).toEqual(["trigger.intelligence.config.ts", "trigger.config.ts"]);
    expect(h.state.spawns.every((spawn) => spawn.argv[spawn.argv.indexOf("--external-id") + 1] === RID)).toBe(true);
    const evidence = lastEvidence(h);
    expect(evidence).toMatchObject({ continues: first, recoveryId: RID, recoveredPlanes: ["integration", "intelligence", "main"] });
    expect(evidence.planes.map((plane) => plane.state)).toEqual(["ALREADY_RECOVERED", "RECOVERED", "RECOVERED"]);
  });

  it("continuation refuses when a plane recorded as recovered has since changed (investigate, never overwrite)", async () => {
    const h = harness({ deploys: { intelligence: [{ kind: "fail" }] } });
    await runRecovery(APPLY, h.deps);
    const first = firstRecord(h);
    providerOf(h, "integration").current = "20261122.7";
    const result = await runRecovery({ ...APPLY, continueFrom: first, expectations: { intelligence: BAD_VERSION, main: BAD_VERSION } }, h.deps);
    expect(JSON.stringify(result)).toMatch(/integration: recorded as recovered to 20261122\.2, but 20261122\.7 is active now/);
    expect(h.state.spawns).toHaveLength(2);
  });

  it("unexpected active version during the apply: a plane changed after the plan → stop before deploying it", async () => {
    const h = harness();
    h.state.afterDeploy = (ref) => {
      if (ref === REFS.integration) providerOf(h, "intelligence").current = "20261122.5";
    };
    expect(await runRecovery(APPLY, h.deps)).toMatchObject({ finalState: "STOPPED_PARTIAL" });
    expect(deployedPlanes(h)).toEqual(["trigger.integration.config.ts"]);
    expect(lastEvidence(h).planes[1]).toMatchObject({ state: "UNEXPECTED_ACTIVE_VERSION", problems: ["active 20261122.5, expected 20261122.1"] });
  });

  it("unexpected active version after the deploy: the provider does not run the version this recovery created → VERIFICATION_FAILED", async () => {
    const h = harness({ deploys: { integration: [{ kind: "ok", activate: false }] } });
    expect(await runRecovery(APPLY, h.deps)).toMatchObject({ finalState: "STOPPED_NOTHING_RECOVERED" });
    expect(lastEvidence(h).planes[0]?.problems.join()).toMatch(/active version is 20261122\.1, not 20261122\.2 created by this recovery/);
  });

  it("mismatched task inventory: a deploy that reports another count is UNKNOWN; a provider inventory of another plane fails verification", async () => {
    const count = harness({ deploys: { intelligence: [{ kind: "ok", tasks: 2 }] } });
    expect(await runRecovery(APPLY, count.deps)).toMatchObject({ finalState: "STOPPED_PARTIAL" });
    expect(lastEvidence(count).planes[1]).toMatchObject({ state: "DEPLOY_UNKNOWN" });
    const foreign = harness({ deploys: { integration: [{ kind: "ok", inventory: { directory: "jobs/trigger/main" } }] } });
    expect(await runRecovery(APPLY, foreign.deps)).toMatchObject({ finalState: "STOPPED_NOTHING_RECOVERED" });
    expect(lastEvidence(foreign).planes[0]?.problems.join()).toMatch(/outside jobs\/trigger\/integration\//);
  });

  it("content fingerprint mismatch (or unreadable while recorded) stops the recovery at that plane", async () => {
    const mismatch = harness({ deploys: { main: [{ kind: "ok", hash: "e".repeat(32) }] } });
    expect(await runRecovery(APPLY, mismatch.deps)).toMatchObject({ finalState: "STOPPED_PARTIAL" });
    expect(lastEvidence(mismatch).planes[2]).toMatchObject({ state: "VERIFICATION_FAILED" });
    const unreadable = harness({ deploys: { integration: [{ kind: "ok", hash: undefined }] } });
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

/**
 * RECOVERY-TOOLING-02 — the deployment identity. RECOVERY-REHEARSAL-03B: the provider never rebuilds an external id it
 * already holds; a deploy under it exits 0, builds nothing and changes nothing. The recovery therefore deploys under a
 * NEW recovery id per approved attempt, and any "already deployed … nothing to build" answer is never a recovery.
 */
describe("RECOVERY-TOOLING-02: the recovery id", () => {
  const recordName = (h: ReturnType<typeof harness>, index: number): string => {
    const name = [...h.state.evidence.keys()][index];
    if (name === undefined) throw new Error(`no recovery record ${String(index)}`);
    return name;
  };

  it("03B regression: the known-good SHA is never the deployment id (the provider would answer 'nothing to build' on every plane)", async () => {
    const h = harness({ deploys: { main: [{ kind: "ok" }, { kind: "ok" }] } });
    // The harness provider behaves like Trigger.dev: the known-good id is held on every plane, so deploying it builds nothing.
    const probe = await h.deps.spawnDeploy(CLI, ["deploy", "--config", "trigger.config.ts", "--project-ref", REFS.main, "--env", "prod", "--external-id", KNOWN_GOOD], WORKTREE, 60_000);
    expect(probe).toMatchObject({ exitCode: 0 });
    expect(probe.output).toContain(`Version ${KNOWN_GOOD_VERSION} was already deployed for --external-id ${KNOWN_GOOD} — nothing to build`);
    h.state.spawns.length = 0;
    expect(await runRecovery(APPLY, h.deps)).toMatchObject({ kind: "recovery", finalState: "RECOVERED" });
    expect(h.state.spawns.map((spawn) => spawn.argv[spawn.argv.indexOf("--external-id") + 1])).toEqual([RID, RID, RID]);
    for (const plane of PLANES) expect(providerOf(h, plane).byId.get(RID)).toBe(providerOf(h, plane).current);
  });

  it.each([false, true])("a deploy answered 'already deployed … nothing to build' (exit 0, current=%s) is RECOVERY_ID_IN_USE: never a recovery, the plane unchanged, the attempt ends", async (current) => {
    const h = harness();
    const integration = providerOf(h, "integration");
    // A deployment under this recovery id that no local record explains (another checkout, a lost record).
    integration.byId.set(RID, current ? BAD_VERSION : "20261121.9");
    const deploysBefore = integration.deploys.length;
    const result = await runRecovery(APPLY, h.deps);
    expect(result).toMatchObject({ kind: "recovery", finalState: "STOPPED_NOTHING_RECOVERED" });
    expect(exitCodeFor(result)).toBe(1);
    expect(h.state.spawns).toHaveLength(1);
    const evidence = lastEvidence(h);
    expect(evidence.planes[0]).toMatchObject({ plane: "integration", state: "RECOVERY_ID_IN_USE", resultingVersion: null, fingerprint: null });
    expect(evidence.planes[0]?.problems.join()).toMatch(/nothing was built and the plane is unchanged/);
    expect(evidence.planes.slice(1).map((plane) => plane.state)).toEqual(["NOT_STARTED", "NOT_STARTED"]);
    expect(integration.current).toBe(BAD_VERSION);
    expect(integration.deploys).toHaveLength(deploysBefore);
    // That attempt cannot be continued: a new attempt needs a new id.
    expect(JSON.stringify(await runRecovery({ ...APPLY, continueFrom: firstRecord(h) }, h.deps))).toMatch(/RECOVERY_ID_IN_USE — this recovery attempt cannot be continued/);
  });

  it("the exact 03B continuation is refused: a v1 record (deployed under the known-good SHA) is never continued, and nothing reports 'every prerequisite met'", async () => {
    const h = harness();
    const name = `2026-11-22T144846399Z-${KNOWN_GOOD.slice(0, 12)}.json`;
    const argv = (config: string, ref: string) => ["deploy", "--config", config, "--project-ref", ref, "--env", "prod", "--external-id", KNOWN_GOOD];
    h.state.evidence.set(name, JSON.stringify({
      schema: "wrenkind.trigger-recovery.v1", knownGoodSha: KNOWN_GOOD, releaseEvidence: EVIDENCE_NAME, finalState: "STOPPED_NOTHING_RECOVERED",
      planes: [
        { plane: "main", projectRef: REFS.main, argv: argv("trigger.config.ts", REFS.main), state: "DEPLOY_UNKNOWN", resultingVersion: null, fingerprint: null },
        { plane: "intelligence", projectRef: REFS.intelligence, argv: argv("trigger.intelligence.config.ts", REFS.intelligence), state: "NOT_STARTED", resultingVersion: null, fingerprint: null },
        { plane: "integration", projectRef: REFS.integration, argv: argv("trigger.integration.config.ts", REFS.integration), state: "NOT_STARTED", resultingVersion: null, fingerprint: null },
      ],
    }));
    const result = await runRecovery({ ...PLAN_ONLY, continueFrom: name, expectations: APPLY.expectations }, h.deps);
    expect(result.kind).toBe("refused");
    expect(JSON.stringify(result)).toMatch(/v1 recovery record deployed under the known-good SHA, which the provider never rebuilds/);
    expect(h.state.logs.join("\n")).not.toMatch(/Every apply prerequisite is met/);
    expect(h.state.spawns).toEqual([]);
  });

  it("an id of a completed recovery is spent; an id of an unfinished attempt is never re-entered fresh (continue it, or a new id)", async () => {
    const done = harness();
    await runRecovery(APPLY, done.deps);
    const after = { main: "20261122.2", intelligence: "20261122.2", integration: "20261122.2" };
    done.state.spawns.length = 0;
    expect(JSON.stringify(await runRecovery({ ...APPLY, expectations: after }, done.deps))).toMatch(/already used by a completed recovery/);
    expect(done.state.spawns).toEqual([]);

    const stopped = harness({ deploys: { intelligence: [{ kind: "fail" }] } });
    await runRecovery(APPLY, stopped.deps);
    const first = firstRecord(stopped);
    stopped.state.spawns.length = 0;
    const fresh = await runRecovery({ ...APPLY, expectations: { integration: "20261122.2", intelligence: BAD_VERSION, main: BAD_VERSION } }, stopped.deps);
    expect(JSON.stringify(fresh)).toContain(`belongs to an earlier, unfinished attempt (${first}): continue it with --continue ${first}, or start a new attempt with a new id`);
    expect(stopped.state.spawns).toEqual([]);
    // PLAN ONLY shows the same refusal as a blocker instead of planning a fresh deploy under it.
    const plan = await runRecovery({ ...PLAN_ONLY, recoveryId: RID }, stopped.deps);
    expect(plan.kind === "plan_only" ? plan.blockers[0] : "").toMatch(/^recovery id: recovery id .* belongs to an earlier, unfinished attempt/);
  });

  it("a continuation keeps its attempt's id: another --recovery-id is refused; it never proposes a new one; only the latest record of the attempt continues", async () => {
    const h = harness({ deploys: { intelligence: [{ kind: "fail" }, { kind: "ok" }], main: [{ kind: "fail" }, { kind: "ok" }] } });
    await runRecovery(APPLY, h.deps);
    const first = recordName(h, 0);
    const other = `recovery-${KNOWN_GOOD.slice(0, 12)}-20261122T113000Z`;
    expect(JSON.stringify(await runRecovery({ ...APPLY, recoveryId: other, continueFrom: first, expectations: { intelligence: BAD_VERSION, main: BAD_VERSION } }, h.deps))).toMatch(/is not the recovery id of the continued attempt/);
    h.state.logs.length = 0;
    await runRecovery({ ...PLAN_ONLY, continueFrom: first }, h.deps);
    expect(h.state.logs.join("\n")).not.toMatch(/proposed by this plan/);
    // Continue once (MAIN fails this time): a second record of the same attempt.
    await runRecovery({ ...APPLY, continueFrom: first, expectations: { intelligence: BAD_VERSION, main: BAD_VERSION } }, h.deps);
    const second = recordName(h, 1);
    expect(lastEvidence(h)).toMatchObject({ continues: first, recoveryId: RID, finalState: "STOPPED_PARTIAL", recoveredPlanes: ["integration", "intelligence"] });
    expect(JSON.stringify(await runRecovery({ ...APPLY, continueFrom: first, expectations: { main: BAD_VERSION } }, h.deps))).toContain(`a later record of this recovery attempt exists: continue ${second} instead`);
    expect(await runRecovery({ ...APPLY, continueFrom: second, expectations: { main: BAD_VERSION } }, h.deps)).toMatchObject({ finalState: "RECOVERED" });
  });

  it("refuses a recovery id for another known-good commit, a future id, and an apply without one", async () => {
    const h = harness();
    expect(JSON.stringify(await runRecovery({ ...APPLY, recoveryId: "recovery-ffffffffffff-20261122T110000Z" }, h.deps))).toMatch(/names another known-good commit|recovery id must be recovery-/);
    expect(JSON.stringify(await runRecovery({ ...APPLY, recoveryId: `recovery-${KNOWN_GOOD.slice(0, 12)}-20261123T000000Z` }, h.deps))).toMatch(/lies in the future/);
    expect(JSON.stringify(await runRecovery({ ...APPLY, recoveryId: `recovery-${KNOWN_GOOD.slice(0, 12)}-20261322T000000Z` }, h.deps))).toMatch(/not a valid UTC time/);
    expect(h.state.spawns).toEqual([]);
  });

  it("interrupted during INTELLIGENCE, the deploy did not land: honest partial record; the continuation deploys INTELLIGENCE and MAIN under the same id, INTEGRATION is not redeployed", async () => {
    const h = harness({ deploys: { intelligence: [{ kind: "interrupt", lands: false }, { kind: "ok" }] } });
    expect(await runRecovery(APPLY, h.deps)).toMatchObject({ finalState: "STOPPED_PARTIAL" });
    const first = firstRecord(h);
    const evidence = lastEvidence(h);
    expect(evidence.planes.map((plane) => plane.state)).toEqual(["RECOVERED", "DEPLOY_UNKNOWN", "NOT_STARTED"]);
    expect(evidence.planes[1]?.observedWorkers).toEqual([{ version: "20261122.2", contentHash: BASELINE.intelligence }]);
    expect(h.state.spawns).toHaveLength(2);
    h.state.interruptAfterSpawns = Infinity;
    h.state.spawns.length = 0;
    h.state.logs.length = 0;
    expect(await runRecovery({ ...PLAN_ONLY, continueFrom: first, expectations: { intelligence: BAD_VERSION, main: BAD_VERSION } }, h.deps)).toMatchObject({ blockers: [] });
    expect(h.state.logs.join("\n")).toMatch(/UNCERTAIN — the earlier deploy \(DEPLOY_UNKNOWN\) may have created it\. The apply adopts it only if/);
    expect(await runRecovery({ ...APPLY, continueFrom: first, expectations: { intelligence: BAD_VERSION, main: BAD_VERSION } }, h.deps)).toMatchObject({ finalState: "RECOVERED" });
    expect(deployedPlanes(h)).toEqual(["trigger.intelligence.config.ts", "trigger.config.ts"]);
    expect(lastEvidence(h).planes.map((plane) => [plane.state, plane.provenance])).toEqual([["ALREADY_RECOVERED", null], ["RECOVERED", "created"], ["RECOVERED", "created"]]);
  });

  it("interrupted during INTELLIGENCE, the deploy DID land: the plan flags the ambiguity; the provider confirms the current deployment holds the id → adopted with the observed fingerprint, never rebuilt", async () => {
    const h = harness({ deploys: { intelligence: [{ kind: "interrupt", lands: true }, { kind: "ok" }] } });
    await runRecovery(APPLY, h.deps);
    const first = firstRecord(h);
    const intelligence = providerOf(h, "intelligence");
    expect(intelligence.current).toBe("20261122.2");
    h.state.interruptAfterSpawns = Infinity;
    h.state.logs.length = 0;
    // Fresh state: the active version changed since the interrupted deploy → AMBIGUOUS until the provider answers.
    expect(await runRecovery({ ...PLAN_ONLY, continueFrom: first, expectations: { intelligence: "20261122.2", main: BAD_VERSION } }, h.deps)).toMatchObject({ blockers: [] });
    expect(h.state.logs.join("\n")).toMatch(/the active version changed since \(20261122\.1 → 20261122\.2\): AMBIGUOUS until the provider answers/);
    const versions = intelligence.versions;
    expect(await runRecovery({ ...APPLY, continueFrom: first, expectations: { intelligence: "20261122.2", main: BAD_VERSION } }, h.deps)).toMatchObject({ finalState: "RECOVERED" });
    expect(intelligence.versions).toBe(versions);
    expect(lastEvidence(h).planes[1]).toMatchObject({ state: "RECOVERED", resultingVersion: "20261122.2", fingerprint: "MATCH", contentHash: BASELINE.intelligence, provenance: "confirmed_existing" });
  });

  it.each([
    ["was never observed (interrupted before the worker line)", undefined, /was not observed by the interrupted deploy; it cannot be adopted/],
    ["differs from the known-good one", "e".repeat(32), /content fingerprint e{32} differs/],
  ])("a landed interrupted deploy whose fingerprint %s is not adopted: VERIFICATION_FAILED, and the attempt ends", async (_label, hash, message) => {
    const h = harness({ deploys: { intelligence: [{ kind: "interrupt", lands: true, hash }] } });
    await runRecovery(APPLY, h.deps);
    const first = firstRecord(h);
    h.state.interruptAfterSpawns = Infinity;
    expect(await runRecovery({ ...APPLY, continueFrom: first, expectations: { intelligence: "20261122.2", main: BAD_VERSION } }, h.deps)).toMatchObject({ finalState: "STOPPED_PARTIAL" });
    expect(lastEvidence(h).planes[1]).toMatchObject({ state: "VERIFICATION_FAILED" });
    expect(lastEvidence(h).planes[1]?.problems.join()).toMatch(message);
    expect(JSON.stringify(await runRecovery({ ...APPLY, continueFrom: recordName(h, 1), expectations: { intelligence: "20261122.2", main: BAD_VERSION } }, h.deps))).toMatch(/VERIFICATION_FAILED — this recovery attempt cannot be continued/);
  });

  it("exit 0 with no new deployment is never a recovery: nothing parseable → DEPLOY_UNKNOWN; the previous version reported → VERIFICATION_FAILED", async () => {
    const silent = harness({ deploys: { integration: [{ kind: "silent" }] } });
    expect(await runRecovery(APPLY, silent.deps)).toMatchObject({ finalState: "STOPPED_NOTHING_RECOVERED" });
    expect(lastEvidence(silent).planes[0]).toMatchObject({ state: "DEPLOY_UNKNOWN", problems: ["deploy result unreadable_output; read the plane fresh before any continuation"] });
    const same = harness({ deploys: { integration: [{ kind: "same_version" }] } });
    expect(await runRecovery(APPLY, same.deps)).toMatchObject({ finalState: "STOPPED_NOTHING_RECOVERED" });
    expect(lastEvidence(same).planes[0]?.problems.join()).toMatch(/reported the previous version 20261122\.1, not a new one/);
  });

  it("cross-plane pinning: while MAIN runs the release recovered from, its pins still resolve there; recovered MAIN pins the recovery id, which both other planes already hold", async () => {
    const h = harness();
    const pinOf = (externalId: string) => {
      const pin = crossPlanePin(jobRelease({ environmentType: "PRODUCTION", externalDeploymentId: externalId }));
      return pin.allowed ? pin.externalDeploymentId : undefined;
    };
    const atMainDeploy: Record<string, string | undefined>[] = [];
    h.state.afterDeploy = (ref) => {
      if (ref === REFS.intelligence) {
        // INTEGRATION and INTELLIGENCE are recovered, MAIN is not: MAIN's triggers still name the bad release, which still exists there.
        const pin = pinOf(BAD) ?? "";
        atMainDeploy.push({ integration: providerOf(h, "integration").byId.get(pin), intelligence: providerOf(h, "intelligence").byId.get(pin), recoveryOnTargets: providerOf(h, "integration").byId.get(RID) });
      }
    };
    expect(await runRecovery(APPLY, h.deps)).toMatchObject({ finalState: "RECOVERED" });
    expect(atMainDeploy).toEqual([{ integration: BAD_VERSION, intelligence: BAD_VERSION, recoveryOnTargets: "20261122.2" }]);
    // Recovered MAIN (external id = the recovery id) pins every cross-plane trigger to it, held by the CURRENT deployment of both targets.
    const pin = pinOf(RID) ?? "";
    expect(pin).toBe(RID);
    for (const plane of ["integration", "intelligence"] as const) expect(providerOf(h, plane).byId.get(pin)).toBe(providerOf(h, plane).current);
    // A web pinned to the known-good SHA reaches the original known-good deployments (same source), still DEPLOYED.
    for (const plane of PLANES) expect(providerOf(h, plane).byId.get(KNOWN_GOOD)).toBe(KNOWN_GOOD_VERSION);
    // The development environment is never pinned; an unidentified deployed run is refused.
    expect(crossPlanePin(jobRelease({ environmentType: "DEVELOPMENT", externalDeploymentId: undefined }))).toEqual({ allowed: true, externalDeploymentId: undefined });
    expect(crossPlanePin(jobRelease({ environmentType: "PRODUCTION", externalDeploymentId: undefined }))).toEqual({ allowed: false });
  });
});

/**
 * RECOVERY-TOOLING-03 — RECOVERY-REHEARSAL-03C finding G1: an interrupted CLI does not cancel its server-side deployment.
 * The provider kept the interrupted INTELLIGENCE build BUILDING (~15 min, then TIMED_OUT) while every current worker looked
 * healthy, and PLAN ONLY --continue said "Every apply prerequisite is met". No plan or apply may proceed while any
 * deployment of an approved destination project is not terminal, unreadable or listed incompletely.
 */
describe("RECOVERY-TOOLING-03: remote deployments in progress", () => {
  const PREREQUISITES_MET = "Every apply prerequisite is met";
  const building = (h: ReturnType<typeof harness>, plane: ReleasePlane, status = "BUILDING", shortCode = "k8hqb03l") => {
    const provider = providerOf(h, plane);
    provider.versions += 1;
    provider.deploys.unshift({ version: `20261122.${String(provider.versions)}`, status, shortCode });
    return `20261122.${String(provider.versions)}`;
  };
  const setStatus = (h: ReturnType<typeof harness>, plane: ReleasePlane, shortCode: string, status: string) => {
    const entry = providerOf(h, plane).deploys.find((deploy) => deploy.shortCode === shortCode);
    if (entry === undefined) throw new Error(`no deployment ${shortCode}`);
    entry.status = status;
  };
  const planWith = { ...PLAN_ONLY, recoveryId: RID, expectations: APPLY.expectations };

  it.each(PLANES)("a BUILDING deployment on %s blocks PLAN ONLY and APPLY (the plane, deployment, version, status and required action are named)", async (plane) => {
    const h = harness();
    const version = building(h, plane);
    const planned = await runRecovery(planWith, h.deps);
    expect(planned.kind).toBe("plan_only");
    if (planned.kind !== "plan_only") return;
    expect(planned.blockers).toHaveLength(1);
    const [blocker] = planned.blockers;
    for (const phrase of [`${plane}: project ${REFS[plane]}`, `deployment k8hqb03l v${version} BUILDING is NOT terminal`, "recovery cannot proceed while a remote deployment is unresolved", "wait for a terminal outcome (DEPLOYED, FAILED, CANCELED or TIMED_OUT)", "plan again with fresh metadata", "never cancel or force it"]) expect(blocker, phrase).toContain(phrase);
    const log = h.state.logs.join("\n");
    expect(log).not.toContain(PREREQUISITES_MET);
    expect(log).toContain(`UNRESOLVED — k8hqb03l v${version} BUILDING: not terminal (blocks)`);
    const applied = await runRecovery(APPLY, h.deps);
    expect(applied).toMatchObject({ kind: "refused", reason: "apply prerequisites are not met; nothing was deployed" });
    expect(h.state.spawns).toEqual([]);
    expect(h.state.evidence.size).toBe(0);
  });

  it.each(["PENDING", "INSTALLING", "DEPLOYING"])("every current worker is healthy and on the expected version, but another deployment is %s: blocked (a healthy worker never proves no build is in progress)", async (status) => {
    const h = harness();
    building(h, "main", status, "zz9abcde");
    for (const plane of PLANES) expect(providerOf(h, plane).current).toBe(BAD_VERSION);
    const planned = await runRecovery(planWith, h.deps);
    expect(planned).toMatchObject({ kind: "plan_only", blockers: [expect.stringContaining(`deployment zz9abcde v20261122.2 ${status} is NOT terminal`) as unknown] });
    expect(h.state.logs.join("\n")).not.toContain(PREREQUISITES_MET);
  });

  it("03C regression: interrupted during INTELLIGENCE, the provider keeps BUILDING → the continuation plan and apply block; once TIMED_OUT a fresh plan proceeds, INTEGRATION is not redeployed, INTELLIGENCE gets a NEW build", async () => {
    const h = harness({ deploys: { intelligence: [{ kind: "interrupt", lands: false, orphan: "BUILDING" }, { kind: "ok" }] } });
    expect(await runRecovery(APPLY, h.deps)).toMatchObject({ finalState: "STOPPED_PARTIAL" });
    const first = firstRecord(h);
    expect(lastEvidence(h).planes.map((plane) => plane.state)).toEqual(["RECOVERED", "DEPLOY_UNKNOWN", "NOT_STARTED"]);
    expect(providerOf(h, "intelligence").current).toBe(BAD_VERSION);
    h.state.interruptAfterSpawns = Infinity;
    h.state.spawns.length = 0;
    h.state.logs.length = 0;
    const continuation = { continueFrom: first, expectations: { intelligence: BAD_VERSION, main: BAD_VERSION } };
    // Exactly the 03C state: INTELLIGENCE's current worker is healthy and unchanged; its interrupted deployment is still BUILDING.
    const planned = await runRecovery({ ...PLAN_ONLY, ...continuation }, h.deps);
    expect(planned).toMatchObject({ kind: "plan_only", blockers: [expect.stringMatching(/^intelligence: project .*deployment k8hqb03l v20261122\.2 BUILDING is NOT terminal/) as unknown] });
    expect(h.state.logs.join("\n")).not.toContain(PREREQUISITES_MET);
    expect(await runRecovery({ ...APPLY, ...continuation }, h.deps)).toMatchObject({ kind: "refused" });
    expect(h.state.spawns).toEqual([]);
    expect(h.state.evidence.size).toBe(1);
    // The provider times it out: terminal, never a worker. A NEW read-only assessment (fresh metadata) may proceed.
    setStatus(h, "intelligence", "k8hqb03l", "TIMED_OUT");
    h.state.logs.length = 0;
    expect(await runRecovery({ ...PLAN_ONLY, ...continuation }, h.deps)).toMatchObject({ kind: "plan_only", blockers: [] });
    const log = h.state.logs.join("\n");
    expect(log).toContain(PREREQUISITES_MET);
    expect(log).toContain("terminal and never a worker (not a recovery): k8hqb03l v20261122.2 TIMED_OUT");
    expect(await runRecovery({ ...APPLY, ...continuation }, h.deps)).toMatchObject({ kind: "recovery", finalState: "RECOVERED" });
    expect(deployedPlanes(h)).toEqual(["trigger.intelligence.config.ts", "trigger.config.ts"]);
    expect(lastEvidence(h).planes.map((plane) => [plane.plane, plane.state, plane.resultingVersion, plane.provenance])).toEqual([["integration", "ALREADY_RECOVERED", "20261122.2", null], ["intelligence", "RECOVERED", "20261122.3", "created"], ["main", "RECOVERED", "20261122.2", "created"]]);
  });

  it("a FAILED (or CANCELED) terminal deployment never masquerades as recovered: it does not block, the plan says so, and the plane is deployed and verified", async () => {
    for (const status of ["FAILED", "CANCELED"]) {
      const h = harness({ deploys: { intelligence: [{ kind: "interrupt", lands: false, orphan: "BUILDING" }, { kind: "ok" }] } });
      await runRecovery(APPLY, h.deps);
      const first = firstRecord(h);
      setStatus(h, "intelligence", "k8hqb03l", status);
      h.state.interruptAfterSpawns = Infinity;
      h.state.spawns.length = 0;
      h.state.logs.length = 0;
      const continuation = { continueFrom: first, expectations: { intelligence: BAD_VERSION, main: BAD_VERSION } };
      expect(await runRecovery({ ...PLAN_ONLY, ...continuation }, h.deps)).toMatchObject({ blockers: [] });
      expect(h.state.logs.join("\n")).toContain(`terminal and never a worker (not a recovery): k8hqb03l v20261122.2 ${status}`);
      expect(await runRecovery({ ...APPLY, ...continuation }, h.deps)).toMatchObject({ finalState: "RECOVERED" });
      expect(lastEvidence(h).planes[1]).toMatchObject({ state: "RECOVERED", resultingVersion: "20261122.3", provenance: "created" });
    }
  });

  it("unreadable, unknown-status, malformed or truncated deployment metadata: refuse (absence of an active build is never assumed)", async () => {
    const cases: [string, (h: ReturnType<typeof harness>) => void, RegExp][] = [
      ["the call failed", (h) => h.state.deployListOverride.set(REFS.intelligence, undefined), /intelligence: project .*: the deployment list could not be read; the absence of an in-progress deployment is not established/],
      ["a status this tool does not know", (h) => building(h, "main", "SUSPENDED", "q1w2e3r4"), /main: project .*: deployment q1w2e3r4 v20261122\.2 SUSPENDED has a status this tool does not recognize \(treated as in progress\)/],
      ["the header and entries disagree", (h) => h.state.deployListOverride.set(REFS.integration, "Found 3 deployments\n\n- code0 | v20261122.1 | DEPLOYED | x"), /integration: project .*: the deployment list could not be read/],
      ["an unparseable status line", (h) => h.state.deployListOverride.set(REFS.integration, "Found 1 deployment\n\n- code0 | v20261122.1 | building | x"), /integration: project .*: the deployment list could not be read/],
      ["more pages than were read", (h) => h.state.deployListOverride.set(REFS.main, deployListText(providerOf(h, "main").deploys, { morePages: true })), /main: project .*: the deployment list is truncated \(2 listed, more pages exist\); the absence of an in-progress deployment is not established/],
    ];
    for (const [label, mutate, message] of cases) {
      const h = harness();
      mutate(h);
      const planned = await runRecovery(planWith, h.deps);
      expect(planned.kind, label).toBe("plan_only");
      expect(JSON.stringify(planned), label).toMatch(message);
      expect(h.state.logs.join("\n"), label).not.toContain(PREREQUISITES_MET);
      expect(await runRecovery(APPLY, h.deps), label).toMatchObject({ kind: "refused" });
      expect(h.state.spawns, label).toEqual([]);
    }
  });

  it("an active build on the listing is reported even when the list is also truncated", async () => {
    const h = harness();
    building(h, "integration");
    h.state.deployListOverride.set(REFS.integration, deployListText(providerOf(h, "integration").deploys, { morePages: true }));
    expect(await runRecovery(planWith, h.deps)).toMatchObject({ blockers: [expect.stringContaining("deployment k8hqb03l v20261122.2 BUILDING is NOT terminal") as unknown] });
  });

  it("a deployment that appears after PLAN ONLY is caught by the apply: refused by its own fresh read, or stopped before the first deploy", async () => {
    const after = harness();
    expect(await runRecovery(planWith, after.deps)).toMatchObject({ blockers: [] });
    building(after, "main");
    expect(await runRecovery(APPLY, after.deps)).toMatchObject({ kind: "refused" });
    expect(after.state.spawns).toEqual([]);
    // Appears after the apply's own plan read, before the first plane: the fresh check before INTEGRATION stops it.
    const race = harness();
    let deployLists = 0;
    race.state.beforeInspect = (_ref, tools) => {
      if (tools.includes("list_deploys")) deployLists += 1;
      if (deployLists === 3 && tools.includes("list_deploys") && _ref === REFS.main) building(race, "intelligence");
    };
    expect(await runRecovery(APPLY, race.deps)).toMatchObject({ kind: "recovery", finalState: "STOPPED_NOTHING_RECOVERED" });
    expect(race.state.spawns).toEqual([]);
    const evidence = lastEvidence(race);
    expect(evidence.planes.map((plane) => plane.state)).toEqual(["NOT_STARTED", "NOT_STARTED", "NOT_STARTED"]);
    expect(evidence.planes[0]?.problems.join()).toMatch(/intelligence: project .*deployment k8hqb03l v20261122\.2 BUILDING is NOT terminal/);
    expect(evidence["stopReason"]).toMatch(/^integration: NOT_STARTED — intelligence: project /);
  });

  it("a deployment that appears between planes stops before the next deploy; the recovered plane stays recovered (partial, honestly)", async () => {
    const h = harness();
    h.state.afterDeploy = (ref) => {
      if (ref === REFS.integration) building(h, "main", "PENDING", "p0p0p0p0");
    };
    expect(await runRecovery(APPLY, h.deps)).toMatchObject({ finalState: "STOPPED_PARTIAL" });
    expect(deployedPlanes(h)).toEqual(["trigger.integration.config.ts"]);
    const evidence = lastEvidence(h);
    expect(evidence.planes.map((plane) => plane.state)).toEqual(["RECOVERED", "NOT_STARTED", "NOT_STARTED"]);
    expect(evidence.planes[1]?.problems.join()).toMatch(/main: project .*deployment p0p0p0p0 v20261122\.2 PENDING is NOT terminal/);
    expect(h.state.logs.join("\n")).toMatch(/STOP before INTELLIGENCE: main: project /);
    // The fresh checks ran on all three projects before every plane that started.
    expect(h.state.logs.filter((line) => line.startsWith("remote deployments: none in progress on any approved project"))).toEqual(["remote deployments: none in progress on any approved project (read fresh before INTEGRATION)"]);
  });

  it("a continuation stopped by the guard carries the recovered plane and the unseen deploy forward, so the next continuation neither redeploys INTEGRATION nor loses the adoption evidence", async () => {
    const h = harness({ deploys: { intelligence: [{ kind: "interrupt", lands: false, orphan: "BUILDING" }, { kind: "ok" }] } });
    await runRecovery(APPLY, h.deps);
    const first = firstRecord(h);
    setStatus(h, "intelligence", "k8hqb03l", "TIMED_OUT");
    h.state.interruptAfterSpawns = Infinity;
    h.state.spawns.length = 0;
    const continuation = { expectations: { intelligence: BAD_VERSION, main: BAD_VERSION } };
    // A build appears on MAIN after the continuation's own plan read, before its first plane.
    let lists = 0;
    h.state.beforeInspect = (ref, tools) => {
      if (tools.includes("list_deploys")) lists += 1;
      // The 4th list is the apply's first fresh check (INTEGRATION), after the plan read all three projects.
      if (lists === 4 && ref === REFS.integration && tools.includes("list_deploys")) building(h, "main", "BUILDING", "m4m4m4m4");
    };
    expect(await runRecovery({ ...APPLY, ...continuation, continueFrom: first }, h.deps)).toMatchObject({ finalState: "STOPPED_PARTIAL" });
    expect(h.state.spawns).toEqual([]);
    const second = [...h.state.evidence.keys()][1] ?? "";
    const stopped = lastEvidence(h);
    expect(stopped.planes.map((plane) => [plane.state, plane.resultingVersion])).toEqual([["RECOVERED", "20261122.2"], ["DEPLOY_UNKNOWN", null], ["NOT_STARTED", null]]);
    expect(stopped.planes[0]?.problems.join()).toContain(`not attempted in this run: RECOVERED carried from ${first} (not re-verified here)`);
    expect(stopped.planes[1]?.observedWorkers).toEqual([{ version: "20261122.2", contentHash: BASELINE.intelligence }]);
    // MAIN's build finishes; the next continuation (from the NEW record) re-verifies INTEGRATION and deploys the rest.
    h.state.beforeInspect = undefined;
    setStatus(h, "main", "m4m4m4m4", "FAILED");
    expect(await runRecovery({ ...PLAN_ONLY, ...continuation, continueFrom: second }, h.deps)).toMatchObject({ blockers: [] });
    expect(await runRecovery({ ...APPLY, ...continuation, continueFrom: second }, h.deps)).toMatchObject({ finalState: "RECOVERED" });
    expect(deployedPlanes(h)).toEqual(["trigger.intelligence.config.ts", "trigger.config.ts"]);
    expect(lastEvidence(h).planes.map((plane) => plane.state)).toEqual(["ALREADY_RECOVERED", "RECOVERED", "RECOVERED"]);
  });

  it("a zero-exit no-op is still never a recovery, and only read-only tools are used by the guard", async () => {
    const h = harness({ deploys: { integration: [{ kind: "silent" }] } });
    expect(await runRecovery(APPLY, h.deps)).toMatchObject({ finalState: "STOPPED_NOTHING_RECOVERED" });
    expect(lastEvidence(h).planes[0]).toMatchObject({ state: "DEPLOY_UNKNOWN" });
    expect(h.state.inspected.flatMap((entry) => entry.tools).every((tool) => READ_ONLY_TOOLS.has(tool))).toBe(true);
    // Plan (3 projects) + the fresh check before INTEGRATION (3 projects).
    expect(h.state.inspected.filter((entry) => entry.tools.includes("list_deploys")).map((entry) => entry.ref)).toEqual([...PLANES.map((plane) => REFS[plane]), ...PLANES.map((plane) => REFS[plane])]);
  });
});
