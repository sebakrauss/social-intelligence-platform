/**
 * RECOVERY-TOOLING-01 — the guarded three-plane Trigger.dev FORWARD RECOVERY operator. Pure planning and verification:
 * tools/trigger/recovery-plan.ts. It redeploys the source of a previously ALIGNED release (the approved known-good
 * commit) to MAIN, INTELLIGENCE and INTEGRATION as NEW versions — never a promote of an older version, never a history
 * rewrite, never the web, never the database. Run from the repository root (the working checkout):
 *
 *   npm run trigger:recover -- --cli <absolute path to the pinned trigger CLI> \
 *     --known-good <40-hex SHA> --release-evidence <ALIGNED record file name> \
 *     --worktree <absolute path of the prepared, detached recovery worktree at the known-good SHA> \
 *     --main-project-ref <proj_…> --intelligence-project-ref <proj_…> --integration-project-ref <proj_…> \
 *     --web-release <40-hex SHA of the in-service web deployment> [--proven-web-pairing <web SHA>:<known-good SHA>] \
 *     [--accept-unrecorded-fingerprint] [--continue <recovery record file name>]                PLAN ONLY (default)
 *
 *   … --expect-main-version <v> --expect-intelligence-version <v> --expect-integration-version <v> \
 *     --attest-ingestion-paused --attest-web-relay-pin --apply --confirm-recovery recover-trigger-planes-to-<sha12>
 *                                                                                                the explicit apply
 *
 * PLAN ONLY reads (git, the approved evidence, the worktree, and the CLI's own READ-ONLY MCP server for each plane's
 * current worker, deployments and run counts) and prints a sanitized plan; it deploys nothing. The apply re-verifies
 * everything, then per plane in order: worktree identity, the plane's active version == the operator's expectation, one
 * deploy, then the provider's current worker (version, inventory) and the content fingerprint. The FIRST unexpected
 * result stops the run: no automatic retry, no automatic restore of a changed plane. One create-exclusive record is
 * written under .wrenkind-local/evidence/trigger-recovery/; a stopped run is continued only explicitly (--continue),
 * with every plane's state read fresh.
 *
 * The CLI child gets the release tool's sterile environment (PATH, HOME, TERM, CI, NO_COLOR); no .env file is read; no
 * variable is synced, pulled or shown; every CLI line is redacted before it is printed or recorded.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVIDENCE_DIRECTORY as RELEASE_EVIDENCE_DIRECTORY, INTERRUPT_GRACE_MS, sterileEnvironment, type DeployResult, type GitResult } from "./deploy-release-pair.ts";
import { RELEASE_PLANES, checkHelperBuilds, evaluatePlaneResult, redactReleaseOutput, redactedTail, sanitizeArgv, type ReleasePlane } from "./release-pair.ts";
import {
  QUEUE_SNAPSHOT_STATUSES,
  RECOVERY_EVIDENCE_DIRECTORY,
  RECOVERY_ORDER,
  RECOVERY_SCHEMA,
  RecoveryPlanError,
  WORKER_CONTRACT_PATHS,
  assertRecoveryPlanInvariants,
  assessWebCompatibility,
  buildRecoveryPlan,
  deployListPeriod,
  inventoryProblems,
  isEvidenceFileName,
  isWorkerVersion,
  migrationsAfter,
  parseCurrentWorker,
  parseDeployList,
  parseRecoveryEvidence,
  parseReleaseEvidence,
  parseRunCount,
  recoveryConfirmation,
  recoveryOutcome,
  resolvePlaneIntents,
  runtimeProblems,
  verifyRecoveredPlane,
  type CommitRelation,
  type FingerprintStatus,
  type KnownGoodRelease,
  type PlaneIntent,
  type PlaneRecoveryState,
  type PriorRecovery,
  type RecoveryFinalState,
  type RecoveryPlan,
  type RecoveryStep,
  type WebVerdict,
  type WorkerInventory,
} from "./recovery-plan.ts";

export const DEFAULT_PLANE_TIMEOUT_MS = 30 * 60 * 1000;
export const INSPECT_TIMEOUT_MS = 120_000;
const TOOL = "tools/trigger/recover-release.ts";

export interface RecoveryOptions {
  readonly cli: string;
  readonly knownGood: string;
  readonly releaseEvidence: string;
  readonly worktree: string;
  readonly projectRefs: Readonly<Record<ReleasePlane, string>>;
  readonly webRelease: string;
  readonly provenWebPairing: string | undefined;
  readonly acceptUnrecordedFingerprint: boolean;
  readonly continueFrom: string | undefined;
  readonly expectations: Readonly<Partial<Record<ReleasePlane, string>>>;
  readonly apply: boolean;
  readonly attestIngestionPaused: boolean;
  /** The in-service web's relay-nudge pin (TRIGGER_EXTERNAL_DEPLOYMENT_ID) is absent or the known-good SHA (checked by the operator). */
  readonly attestWebRelayPin: boolean;
  readonly timeoutMs: number;
}

/** One read-only call to the CLI's MCP server, bound to one project, environment prod. */
export type InspectCall =
  | { readonly tool: "get_current_worker" }
  | { readonly tool: "list_deploys"; readonly period: string }
  | { readonly tool: "list_runs"; readonly status: (typeof QUEUE_SNAPSHOT_STATUSES)[number] };

/** Everything with an effect, injected (tests use fakes; main() wires the real ones). Paths are absolute. */
export interface RecoveryDependencies {
  readonly repositoryRoot: string;
  readonly git: (cwd: string, args: readonly string[]) => GitResult;
  readonly realpath: (absolutePath: string) => string | undefined;
  readonly fileExists: (absolutePath: string) => boolean;
  readonly readFile: (absolutePath: string) => Uint8Array | undefined;
  readonly listDirectory: (absolutePath: string) => readonly string[] | undefined;
  readonly cliIsExecutable: (cli: string) => boolean;
  /** The version of the trigger.dev package the CLI executable belongs to. */
  readonly cliVersion: (cli: string) => string | undefined;
  readonly createEmptyEnvFile: () => { readonly path: string; readonly cleanup: () => void };
  /** READ-ONLY: the CLI's MCP server in --readonly mode; one text result per call (undefined = the call failed). */
  readonly inspect: (cli: string, projectRef: string, calls: readonly InspectCall[]) => Promise<readonly (string | undefined)[]>;
  readonly spawnDeploy: (cli: string, argv: readonly string[], cwd: string, timeoutMs: number) => Promise<DeployResult>;
  readonly interrupted: () => boolean;
  /** Create-exclusive write under the recovery evidence directory; refuses to overwrite. Returns the written path. */
  readonly writeEvidence: (fileName: string, contents: string) => string;
  /** True when the recovery evidence directory is git-ignored and Vercel-excluded. */
  readonly evidenceLocationIsLocalOnly: () => boolean;
  readonly now: () => Date;
  readonly log: (line: string) => void;
}

export interface PlaneState {
  readonly plane: ReleasePlane;
  readonly worker: WorkerInventory;
  /** The record (release or recovery) that created the active version, when local evidence names it. */
  readonly recordedAs: string | undefined;
  readonly knownGoodDeployment: "DEPLOYED" | "MISSING" | "UNREADABLE";
  readonly queue: Readonly<Record<string, string>>;
}

export type RecoveryResult =
  | { readonly kind: "usage"; readonly message: string }
  | { readonly kind: "refused"; readonly reason: string; readonly problems: readonly string[] }
  | { readonly kind: "plan_only"; readonly plan: RecoveryPlan; readonly blockers: readonly string[] }
  | { readonly kind: "recovery"; readonly finalState: RecoveryFinalState; readonly evidencePath: string };

export const exitCodeFor = (result: RecoveryResult): number => {
  if (result.kind === "usage") return 2;
  if (result.kind === "refused") return 1;
  if (result.kind === "plan_only") return 0;
  return result.finalState === "RECOVERED" || result.finalState === "RECOVERED_FINGERPRINT_UNVERIFIED" ? 0 : 1;
};

// ── Arguments ───────────────────────────────────────────────────────────────────────────────────────────────

const VALUE_FLAGS = new Set([
  "--cli", "--known-good", "--release-evidence", "--worktree",
  "--main-project-ref", "--intelligence-project-ref", "--integration-project-ref",
  "--web-release", "--proven-web-pairing", "--continue",
  "--expect-main-version", "--expect-intelligence-version", "--expect-integration-version",
  "--confirm-recovery", "--timeout-minutes",
]);
const BOOLEAN_FLAGS = new Set(["--apply", "--attest-ingestion-paused", "--attest-web-relay-pin", "--accept-unrecorded-fingerprint"]);
const SHA = /^[0-9a-f]{40}$/;

export function parseRecoveryArguments(args: readonly string[]): RecoveryOptions | { readonly error: string } {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] ?? "";
    if (BOOLEAN_FLAGS.has(flag)) {
      if (booleans.has(flag)) return { error: `${flag} given twice` };
      booleans.add(flag);
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) return { error: `unknown argument: ${flag}` };
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value` };
    if (values.has(flag)) return { error: `${flag} given twice` };
    values.set(flag, value);
    index += 1;
  }
  const required = ["--cli", "--known-good", "--release-evidence", "--worktree", "--main-project-ref", "--intelligence-project-ref", "--integration-project-ref", "--web-release"];
  const missing = required.filter((flag) => !values.has(flag));
  if (missing.length > 0) return { error: `required: ${missing.join(" ")}` };
  const knownGood = values.get("--known-good") ?? "";
  if (!SHA.test(knownGood)) return { error: "--known-good must be a full 40-character lower-case commit SHA" };
  const webRelease = values.get("--web-release") ?? "";
  if (!SHA.test(webRelease)) return { error: "--web-release must be the full 40-character commit SHA of the in-service web deployment" };
  const apply = booleans.has("--apply");
  const confirmation = values.get("--confirm-recovery");
  if (!apply && confirmation !== undefined) return { error: "--confirm-recovery is only valid with --apply" };
  if (apply && confirmation !== recoveryConfirmation(knownGood)) return { error: "--apply needs --confirm-recovery with the exact phrase for this known-good commit (recover-trigger-planes-to-<first 12 of the SHA>)" };
  if (!apply && booleans.has("--attest-ingestion-paused")) return { error: "--attest-ingestion-paused is only valid with --apply" };
  if (apply && !booleans.has("--attest-ingestion-paused")) return { error: "--apply needs --attest-ingestion-paused (ingestion is paused for every platform and read back, per the runbook)" };
  if (!apply && booleans.has("--attest-web-relay-pin")) return { error: "--attest-web-relay-pin is only valid with --apply" };
  if (apply && !booleans.has("--attest-web-relay-pin")) {
    return { error: "--apply needs --attest-web-relay-pin (the in-service web's TRIGGER_EXTERNAL_DEPLOYMENT_ID is absent or the known-good SHA; otherwise its relay nudges keep waking the previous release)" };
  }
  const minutes = values.get("--timeout-minutes");
  const timeoutMs = minutes === undefined ? DEFAULT_PLANE_TIMEOUT_MS : Number(minutes) * 60 * 1000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 120 * 60 * 1000) return { error: "--timeout-minutes must be an integer from 1 to 120" };
  const expectations: Partial<Record<ReleasePlane, string>> = {};
  for (const plane of RECOVERY_ORDER) {
    const value = values.get(`--expect-${plane}-version`);
    if (value !== undefined) expectations[plane] = value;
  }
  return {
    cli: values.get("--cli") ?? "",
    knownGood,
    releaseEvidence: values.get("--release-evidence") ?? "",
    worktree: values.get("--worktree") ?? "",
    projectRefs: { main: values.get("--main-project-ref") ?? "", intelligence: values.get("--intelligence-project-ref") ?? "", integration: values.get("--integration-project-ref") ?? "" },
    webRelease,
    provenWebPairing: values.get("--proven-web-pairing"),
    acceptUnrecordedFingerprint: booleans.has("--accept-unrecorded-fingerprint"),
    continueFrom: values.get("--continue"),
    expectations,
    apply,
    attestIngestionPaused: booleans.has("--attest-ingestion-paused"),
    attestWebRelayPin: booleans.has("--attest-web-relay-pin"),
    timeoutMs,
  };
}

// ── Prechecks (each returns the problems; empty = passed) ───────────────────────────────────────────────────

const gitValue = (deps: RecoveryDependencies, cwd: string, args: readonly string[]): string | undefined => {
  const result = deps.git(cwd, args);
  return result.ok ? result.stdout.trim() : undefined;
};
const decode = (bytes: Uint8Array | undefined): string | undefined => (bytes === undefined ? undefined : new TextDecoder().decode(bytes));

/** The prepared recovery worktree: a separate, detached, clean worktree of THIS repository at the known-good commit, installed. */
export function worktreeProblems(options: { readonly worktree: string; readonly knownGood: string }, deps: RecoveryDependencies): string[] {
  if (!path.isAbsolute(options.worktree)) return ["--worktree must be an absolute path"];
  const worktree = deps.realpath(options.worktree);
  if (worktree === undefined) return ["--worktree does not exist (prepare it per the runbook: git worktree add --detach)"];
  const root = deps.repositoryRoot;
  if (worktree === root || worktree.startsWith(`${root}${path.sep}`) || root.startsWith(`${worktree}${path.sep}`)) return ["--worktree must be a separate sibling directory, never the working checkout or a directory around or inside it"];
  const problems: string[] = [];
  if (gitValue(deps, worktree, ["rev-parse", "--show-toplevel"]) !== worktree) problems.push("--worktree is not the top of a git worktree");
  const common = (cwd: string) => gitValue(deps, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const own = common(root);
  if (own === undefined || common(worktree) !== own) problems.push("--worktree is not a worktree of this repository (its object store differs)");
  if (gitValue(deps, worktree, ["rev-parse", "HEAD"]) !== options.knownGood) problems.push("the worktree is not checked out at the known-good commit");
  if (deps.git(worktree, ["symbolic-ref", "-q", "HEAD"]).ok) problems.push("the worktree is on a branch; it must be detached (never commit from it)");
  if (gitValue(deps, worktree, ["status", "--porcelain"]) !== "") problems.push("the worktree is not clean");
  for (const definition of RELEASE_PLANES) if (!deps.fileExists(path.join(worktree, definition.config))) problems.push(`${definition.config} missing in the worktree`);
  if (!deps.fileExists(path.join(worktree, "package-lock.json"))) problems.push("package-lock.json missing in the worktree");
  if (!deps.fileExists(path.join(worktree, "node_modules", ".package-lock.json"))) problems.push("dependencies are not installed in the worktree (run npm ci there)");
  // Environment files are never read; their mere presence refuses the worktree (only the value-free example may exist).
  const envFiles = (deps.listDirectory(worktree) ?? []).filter((name) => /^\.env(?!\.example$)/.test(name));
  if (envFiles.length > 0) problems.push(`the worktree holds environment files (${envFiles.join(", ")}); nothing may be copied into it`);
  return problems;
}

/** Commit relation of the in-service web to the known-good worker commit. */
function relationOf(deps: RecoveryDependencies, webSha: string, knownGood: string): CommitRelation {
  if (webSha === knownGood) return "equal";
  if (deps.git(deps.repositoryRoot, ["merge-base", "--is-ancestor", webSha, knownGood]).ok) return "web_older";
  if (deps.git(deps.repositoryRoot, ["merge-base", "--is-ancestor", knownGood, webSha]).ok) return "web_newer";
  return "unrelated";
}

const lsMigrations = (deps: RecoveryDependencies, revision: string): readonly string[] =>
  (gitValue(deps, deps.repositoryRoot, ["ls-tree", "--name-only", revision, "db/migrations/"]) ?? "").split("\n").filter((line) => line !== "");

/**
 * Every (project, version) that local evidence (release and recovery records) attributes to a commit — keyed by the
 * PROJECT, since version numbers repeat across projects. Display only: it never decides anything.
 */
function recordedVersions(deps: RecoveryDependencies): Map<string, string> {
  const out = new Map<string, string>();
  const scan = (directory: string, recovery: boolean): void => {
    for (const name of deps.listDirectory(path.join(deps.repositoryRoot, directory)) ?? []) {
      if (!isEvidenceFileName(name)) continue;
      try {
        const record = JSON.parse(decode(deps.readFile(path.join(deps.repositoryRoot, directory, name))) ?? "null") as { releaseSha?: unknown; knownGoodSha?: unknown; planes?: unknown };
        const sha = recovery ? record.knownGoodSha : record.releaseSha;
        if (typeof sha !== "string" || !Array.isArray(record.planes)) continue;
        for (const plane of record.planes as { projectRef?: unknown; argv?: unknown; outcome?: { state?: unknown; version?: unknown }; resultingVersion?: unknown }[]) {
          const version = recovery ? plane.resultingVersion : plane.outcome?.state === "PASS" ? plane.outcome.version : undefined;
          const argv = Array.isArray(plane.argv) ? (plane.argv as unknown[]) : [];
          const projectRef = recovery ? plane.projectRef : argv[argv.indexOf("--project-ref") + 1];
          if (typeof projectRef === "string" && isWorkerVersion(version)) out.set(`${projectRef}/${version}`, `${sha.slice(0, 12)} (${recovery ? "recovery" : "release"} ${name})`);
        }
      } catch {
        // An unreadable record attributes nothing.
      }
    }
  };
  scan(RELEASE_EVIDENCE_DIRECTORY, false);
  scan(RECOVERY_EVIDENCE_DIRECTORY, true);
  return out;
}

/** One plane's provider state, read through the read-only MCP server. Undefined when the current worker is unreadable. */
async function readPlane(deps: RecoveryDependencies, cli: string, step: RecoveryStep, period: string, recorded: Map<string, string>): Promise<PlaneState | undefined> {
  const calls: InspectCall[] = [{ tool: "get_current_worker" }, { tool: "list_deploys", period }, ...QUEUE_SNAPSHOT_STATUSES.map((status) => ({ tool: "list_runs" as const, status }))];
  const results = await deps.inspect(cli, step.projectRef, calls);
  const worker = parseCurrentWorker(results[0] ?? "");
  if (worker === undefined) return undefined;
  const deploys = parseDeployList(results[1] ?? "");
  const knownGood = deploys?.entries.find((entry) => entry.version === step.knownGoodVersion);
  const queue: Record<string, string> = {};
  QUEUE_SNAPSHOT_STATUSES.forEach((status, index) => {
    const count = parseRunCount(results[index + 2] ?? "");
    queue[status] = count === undefined ? "unreadable" : `${String(count.count)}${count.morePages ? "+" : ""}`;
  });
  return {
    plane: step.plane,
    worker,
    recordedAs: recorded.get(`${step.projectRef}/${worker.version}`),
    knownGoodDeployment: deploys === undefined ? "UNREADABLE" : knownGood?.status === "DEPLOYED" ? "DEPLOYED" : "MISSING",
    queue,
  };
}

async function readCurrentWorker(deps: RecoveryDependencies, cli: string, projectRef: string): Promise<WorkerInventory | undefined> {
  const [text] = await deps.inspect(cli, projectRef, [{ tool: "get_current_worker" }]);
  return parseCurrentWorker(text ?? "");
}

// ── Run ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface Context {
  readonly plan: RecoveryPlan;
  readonly release: KnownGoodRelease;
  readonly releaseEvidenceSha256: string;
  readonly toolCommit: string;
  readonly originMain: string;
  readonly worktree: string;
  readonly web: WebVerdict;
  readonly migrationsAfterKnownGood: readonly string[];
  readonly prior: PriorRecovery | undefined;
  readonly states: readonly PlaneState[];
  readonly blockers: readonly string[];
  readonly intents: readonly PlaneIntent[] | undefined;
}

const refuse = (reason: string, problems: readonly string[] = []): RecoveryResult => ({ kind: "refused", reason, problems });

export async function runRecovery(options: RecoveryOptions, deps: RecoveryDependencies): Promise<RecoveryResult> {
  const root = deps.repositoryRoot;
  // 1. The repository and the approved source.
  if (gitValue(deps, root, ["rev-parse", "--show-toplevel"]) !== root) return refuse("not run from the canonical repository root");
  const toolCommit = gitValue(deps, root, ["rev-parse", "HEAD"]);
  if (toolCommit === undefined) return refuse("HEAD unreadable");
  if (!deps.git(root, ["fetch", "origin", "main"]).ok) return refuse("git fetch origin main failed");
  const originMain = gitValue(deps, root, ["rev-parse", "origin/main"]);
  if (originMain === undefined) return refuse("origin/main unreadable");
  if (!deps.git(root, ["cat-file", "-e", `${options.knownGood}^{commit}`]).ok) return refuse("the known-good commit is not in this repository");
  if (!deps.git(root, ["merge-base", "--is-ancestor", options.knownGood, "origin/main"]).ok) return refuse("the known-good commit is not in origin/main's history (an unpushed or rewritten commit is never a recovery source)");

  // 2. The approved release evidence.
  if (!isEvidenceFileName(options.releaseEvidence)) return refuse("--release-evidence must be the bare file name of a release record");
  const evidenceBytes = deps.readFile(path.join(root, RELEASE_EVIDENCE_DIRECTORY, options.releaseEvidence));
  if (evidenceBytes === undefined) return refuse(`release evidence not found in ${RELEASE_EVIDENCE_DIRECTORY}`);
  const parsed = parseReleaseEvidence(options.releaseEvidence, decode(evidenceBytes) ?? "");
  if (!parsed.ok) return refuse("the release evidence is not an approved ALIGNED release", parsed.problems);
  const release = parsed.release;
  if (release.releaseSha !== options.knownGood) return refuse("--known-good is not the release SHA of the named ALIGNED release evidence");

  // 3. The prepared worktree, the runtime and the signing-helper builds of the known-good commit.
  const worktreeIssues = worktreeProblems(options, deps);
  if (worktreeIssues.length > 0) return refuse("the recovery worktree is not ready", worktreeIssues);
  const worktree = deps.realpath(options.worktree) ?? options.worktree;
  if (!path.isAbsolute(options.cli) || !deps.cliIsExecutable(options.cli)) return refuse("--cli must be the absolute path of an executable trigger CLI");
  let manifest: { dependencies?: Record<string, string>; engines?: Record<string, string> } = {};
  try {
    manifest = JSON.parse(decode(deps.readFile(path.join(worktree, "package.json"))) ?? "{}") as typeof manifest;
  } catch {
    return refuse("the worktree's package.json is unreadable");
  }
  const runtime = runtimeProblems({ cliVersion: deps.cliVersion(options.cli), knownGoodSdkVersion: manifest.dependencies?.["@trigger.dev/sdk"], knownGoodNodeEngine: manifest.engines?.["node"] });
  if (runtime.length > 0) return refuse("runtime compatibility", runtime);
  if (!deps.git(root, ["diff", "--quiet", options.knownGood, "HEAD", "--", "jobs/aws-signing-helper.ts"]).ok) {
    return refuse("the signing-helper pins of the known-good commit differ from this checkout's; this tool verifies only identical pins");
  }
  const helpers = checkHelperBuilds((relative) => deps.readFile(path.join(worktree, relative)));
  if (!helpers.ok) return refuse("the worktree's signing-helper builds are not ready (run node tools/trigger/fetch-aws-signing-helper.ts in the worktree)", helpers.problems);

  const envFile = deps.createEmptyEnvFile();
  try {
    let plan: RecoveryPlan;
    try {
      plan = buildRecoveryPlan({ knownGoodSha: options.knownGood, release, projectRefs: options.projectRefs, emptyEnvFile: envFile.path });
    } catch (error) {
      if (error instanceof RecoveryPlanError) return refuse(error.message);
      throw error;
    }

    // 4. A previous, unfinished recovery of the same source (explicit continuation only).
    let prior: PriorRecovery | undefined;
    if (options.continueFrom !== undefined) {
      const raw = isEvidenceFileName(options.continueFrom) ? decode(deps.readFile(path.join(root, RECOVERY_EVIDENCE_DIRECTORY, options.continueFrom))) : undefined;
      if (raw === undefined) return refuse(`--continue: recovery record not found in ${RECOVERY_EVIDENCE_DIRECTORY}`);
      const continued = parseRecoveryEvidence(options.continueFrom, raw, plan);
      if (!continued.ok) return refuse("--continue: the record cannot be continued", continued.problems);
      prior = continued.prior;
    }

    // 5. Web and database compatibility (from git; the tool has no Vercel or database access).
    const relation = relationOf(deps, options.webRelease, options.knownGood);
    const changed = relation === "web_newer" ? (gitValue(deps, root, ["diff", "--name-only", options.knownGood, options.webRelease, "--", ...WORKER_CONTRACT_PATHS]) ?? "").split("\n").filter((line) => line !== "") : [];
    const web = assessWebCompatibility({
      webSha: options.webRelease,
      knownGoodSha: options.knownGood,
      relation,
      changedContractPaths: changed,
      pathExists: (sha, file) => deps.git(root, ["cat-file", "-e", `${sha}:${file}`]).ok,
      provenPairing: options.provenWebPairing,
    });
    const knownGoodMigrations = lsMigrations(deps, options.knownGood);
    const newest = [...new Set([...lsMigrations(deps, "origin/main"), ...lsMigrations(deps, "HEAD"), ...(relation === "unrelated" ? [] : lsMigrations(deps, options.webRelease))])];
    const migrationsAfterKnownGood = migrationsAfter(knownGoodMigrations, newest);

    // 6. Every plane's current state, read-only.
    const period = deployListPeriod(release.finishedAt, deps.now());
    const recorded = recordedVersions(deps);
    const states: PlaneState[] = [];
    for (const step of plan.steps) {
      const state = await readPlane(deps, options.cli, step, period, recorded);
      if (state === undefined) return refuse(`${step.plane}: the current worker could not be read (read-only MCP)`);
      states.push(state);
    }

    // 7. What would block an apply.
    const blockers: string[] = [];
    if (web.kind === "REFUSED") blockers.push(`web: ${web.reason}`);
    if (web.kind === "REQUIRES_WEB_ROLLBACK") blockers.push(...web.reasons.map((reason) => `web rollback required first — ${reason}`));
    for (const state of states) {
      if (state.knownGoodDeployment !== "DEPLOYED") blockers.push(`${state.plane}: the known-good deployment ${plan.steps.find((step) => step.plane === state.plane)?.knownGoodVersion ?? "?"} is ${state.knownGoodDeployment === "MISSING" ? "not listed as DEPLOYED" : "unreadable"}; recovered MAIN pins to it, so the MAIN-first order is not proven safe`);
    }
    const unrecorded = plan.steps.filter((step) => step.baselineContentHash === null).map((step) => step.plane);
    if (unrecorded.length > 0 && !options.acceptUnrecordedFingerprint) blockers.push(`the approved release recorded no content fingerprint for ${unrecorded.join(", ")} (evidence ${release.schema}); pass --accept-unrecorded-fingerprint to recover with inventory-only verification (the final state will say so)`);
    if (prior === undefined && states.every((state) => state.worker.version === plan.steps.find((step) => step.plane === state.plane)?.knownGoodVersion)) {
      blockers.push("every plane already runs the known-good release's own deployment; there is nothing to recover");
    }
    const resolved = resolvePlaneIntents(plan, options.expectations, prior);
    if (!resolved.ok) blockers.push(...resolved.problems);
    else {
      for (const intent of resolved.intents) {
        const state = states.find((entry) => entry.plane === intent.plane);
        const active = state?.worker.version;
        if (intent.mode === "deploy" && active !== intent.expectedBefore) blockers.push(`${intent.plane}: the active version is ${active ?? "?"}, the operator expects ${intent.expectedBefore}`);
        if (intent.mode === "verify_recovered" && active !== intent.recoveredVersion) blockers.push(`${intent.plane}: recorded as recovered to ${intent.recoveredVersion}, but ${active ?? "?"} is active now (something else changed it: investigate)`);
      }
    }

    const context: Context = {
      plan, release, releaseEvidenceSha256: createHash("sha256").update(evidenceBytes).digest("hex"), toolCommit, originMain, worktree, web, migrationsAfterKnownGood, prior, states, blockers,
      intents: resolved.ok ? resolved.intents : undefined,
    };
    for (const line of planLines(options, context)) deps.log(line);

    if (!options.apply) {
      deps.log(blockers.length === 0 ? "PLAN ONLY: nothing deployed. Every apply prerequisite is met." : `PLAN ONLY: nothing deployed. An apply would be refused until: ${blockers.join(" | ")}`);
      return { kind: "plan_only", plan, blockers };
    }
    if (blockers.length > 0 || context.intents === undefined) return refuse("apply prerequisites are not met; nothing was deployed", blockers);
    if (!deps.evidenceLocationIsLocalOnly()) return refuse(`${RECOVERY_EVIDENCE_DIRECTORY} must be git-ignored and Vercel-excluded`);
    return await applyRecovery(options, deps, context, context.intents);
  } finally {
    envFile.cleanup();
  }
}

// ── Plan display (sanitized: no path, credential or environment value) ─────────────────────────────────────

function planLines(options: RecoveryOptions, context: Context): string[] {
  const { plan, release, states } = context;
  const lines: string[] = [];
  lines.push("THREE-PLANE TRIGGER.DEV FORWARD RECOVERY — PLAN");
  lines.push(`  current source:     checkout HEAD ${context.toolCommit.slice(0, 12)} · origin/main ${context.originMain.slice(0, 12)}`);
  lines.push(`  approved known-good: ${plan.knownGoodSha} (ALIGNED release, evidence ${release.fileName}, ${release.schema}, sha256 ${context.releaseEvidenceSha256.slice(0, 16)}…)`);
  lines.push(`  source:             detached worktree at the known-good commit (clean, npm ci, signing-helper builds verified); environment ${plan.environment}`);
  lines.push("  order:              MAIN → INTELLIGENCE → INTEGRATION (cross-plane triggers pin the known-good external id, already deployed on every plane)");
  for (const step of plan.steps) {
    const state = states.find((entry) => entry.plane === step.plane);
    lines.push(`  ${step.plane.toUpperCase()}: project ${step.projectRef} · active ${state?.worker.version ?? "?"}${state?.recordedAs === undefined ? " (no local record)" : ` = ${state.recordedAs}`} · known-good ${step.knownGoodVersion} (${state?.knownGoodDeployment ?? "?"})`);
    lines.push(`      expects ${String(step.expectedTasks)} tasks under ${step.taskDirectory} · fingerprint baseline ${step.baselineContentHash ?? "NOT RECORDED"} · runs ${Object.entries(state?.queue ?? {}).map(([status, count]) => `${status} ${count}`).join(", ")}`);
    lines.push(`      trigger ${sanitizeArgv(step.argv).join(" ")}`);
  }
  if (context.prior !== undefined) lines.push(`  continues:          ${context.prior.fileName} (${context.prior.finalState}); recorded-recovered planes are re-verified, not redeployed`);
  lines.push(`  runtime:            CLI = known-good @trigger.dev/sdk; Node 22; the deploy reads only the tool's empty env file; task payload contracts are those of the known-good commit`);
  lines.push(`  web:                ${options.webRelease.slice(0, 12)} — ${context.web.kind}${context.web.kind === "COMPATIBLE" || context.web.kind === "COMPATIBLE_ATTESTED" || context.web.kind === "REFUSED" ? `: ${context.web.reason}` : ""}`);
  lines.push(`  database:           never rolled back. Migrations newer than the known-good commit: ${context.migrationsAfterKnownGood.length === 0 ? "none" : context.migrationsAfterKnownGood.map((name) => path.basename(name)).join(", ")} — they must stay additive for the older worker (verify with the runbook)`);
  lines.push("  approvals:          PO approval of this plan · ingestion paused and read back (--attest-ingestion-paused) · web rolled back first when required · the web's relay-nudge pin TRIGGER_EXTERNAL_DEPLOYMENT_ID absent or the known-good SHA (--attest-web-relay-pin) · --expect-<plane>-version for every plane deployed · --apply --confirm-recovery " + recoveryConfirmation(plan.knownGoodSha));
  lines.push("  verification:       per plane, before the next: exit 0, new version, known-good task count; provider current worker = that version; inventory in the plane's own directory; fingerprint = baseline (when recorded)");
  lines.push("  afterwards:         runs on the previous versions drain (EXECUTING/QUEUED/DELAYED watched), ingestion resumed, Workflow: reconcile before any re-forward of the web");
  return lines.map((line) => redactReleaseOutput(line));
}

// ── Apply ───────────────────────────────────────────────────────────────────────────────────────────────────

interface PlaneRecord {
  readonly plane: ReleasePlane;
  readonly projectRef: string;
  readonly config: string;
  readonly argv: readonly string[];
  readonly knownGoodVersion: string;
  readonly expectedTasks: number;
  readonly baselineContentHash: string | null;
  readonly intent: PlaneIntent["mode"] | "none";
  readonly versionBefore: string | null;
  readonly state: PlaneRecoveryState;
  readonly resultingVersion: string | null;
  readonly contentHash: string | null;
  readonly fingerprint: FingerprintStatus | null;
  readonly problems: readonly string[];
  readonly deploy: { readonly exitCode: number | null; readonly timedOut: boolean; readonly interrupted: boolean; readonly startedAt: string; readonly finishedAt: string; readonly outputTail: readonly string[] } | null;
}

async function applyRecovery(options: RecoveryOptions, deps: RecoveryDependencies, context: Context, intents: readonly PlaneIntent[]): Promise<RecoveryResult> {
  const { plan } = context;
  assertRecoveryPlanInvariants(plan);
  const started = deps.now();
  const records: PlaneRecord[] = [];
  // Mutated inside the per-plane closure (an object, so the control-flow analysis does not narrow it to null).
  const run: { stopReason: string | null } = { stopReason: null };

  const base = (step: RecoveryStep, intent: PlaneIntent | undefined) => ({
    plane: step.plane, projectRef: step.projectRef, config: step.config, argv: sanitizeArgv(step.argv), knownGoodVersion: step.knownGoodVersion,
    expectedTasks: step.expectedTasks, baselineContentHash: step.baselineContentHash, intent: intent?.mode ?? ("none" as const),
  });

  for (const step of plan.steps) {
    const intent = intents.find((entry) => entry.plane === step.plane);
    const stop = (state: PlaneRecoveryState, versionBefore: string | null, problems: readonly string[], extra: Partial<PlaneRecord> = {}): void => {
      records.push({ ...base(step, intent), versionBefore, state, resultingVersion: null, contentHash: null, fingerprint: null, problems, deploy: null, ...extra });
      run.stopReason = `${step.plane}: ${state}${problems.length > 0 ? ` — ${problems.join("; ")}` : ""}`;
      deps.log(`STOP at ${step.plane.toUpperCase()}: ${state}. Nothing further is deployed; no plane is restored automatically.`);
    };
    if (run.stopReason !== null || intent === undefined) {
      records.push({ ...base(step, intent), versionBefore: null, state: "NOT_STARTED", resultingVersion: null, contentHash: null, fingerprint: null, problems: [], deploy: null });
      continue;
    }
    if (deps.interrupted()) {
      stop("NOT_STARTED", null, ["operator interrupt"]);
      continue;
    }
    const identity = worktreeIdentityProblems(deps, context.worktree, plan.knownGoodSha);
    if (identity.length > 0) {
      stop("NOT_STARTED", null, identity);
      continue;
    }
    const before = await readCurrentWorker(deps, options.cli, step.projectRef);
    if (before === undefined) {
      stop("UNEXPECTED_ACTIVE_VERSION", null, ["the current worker could not be read before this plane"]);
      continue;
    }
    if (intent.mode === "verify_recovered") {
      const problems = before.version === intent.recoveredVersion ? inventoryProblems(step, before) : [`active ${before.version} is not the recorded recovered ${intent.recoveredVersion}`];
      if (problems.length > 0) stop(before.version === intent.recoveredVersion ? "VERIFICATION_FAILED" : "UNEXPECTED_ACTIVE_VERSION", before.version, problems);
      else {
        records.push({ ...base(step, intent), versionBefore: before.version, state: "ALREADY_RECOVERED", resultingVersion: before.version, contentHash: null, fingerprint: intent.fingerprint, problems: [], deploy: null });
        deps.log(`${step.plane}: ALREADY_RECOVERED ${before.version} (re-verified fresh; not redeployed)`);
      }
      continue;
    }
    if (before.version !== intent.expectedBefore) {
      stop("UNEXPECTED_ACTIVE_VERSION", before.version, [`active ${before.version}, expected ${intent.expectedBefore}`]);
      continue;
    }

    deps.log(`deploying the known-good commit to ${step.plane.toUpperCase()} (active ${before.version}) …`);
    const startedAt = deps.now().toISOString();
    const result = await deps.spawnDeploy(options.cli, step.argv, context.worktree, options.timeoutMs);
    const finishedAt = deps.now().toISOString();
    const deploy = { exitCode: result.exitCode, timedOut: result.timedOut, interrupted: result.interrupted, startedAt, finishedAt, outputTail: redactedTail(result.output) };
    const outcome = evaluatePlaneResult(step, result);
    if (outcome.state === "FAILED") {
      stop("DEPLOY_FAILED", before.version, ["the deploy exited non-zero; the provider keeps the previous version active"], { deploy });
      continue;
    }
    if (outcome.state === "UNKNOWN") {
      stop("DEPLOY_UNKNOWN", before.version, [`deploy result ${outcome.reason}; read the plane fresh before any continuation`], { deploy, resultingVersion: outcome.version ?? null });
      continue;
    }
    const after = await readCurrentWorker(deps, options.cli, step.projectRef);
    const verification = verifyRecoveredPlane(step, { versionBefore: before.version, deployedVersion: outcome.version, deployOutput: result.output, worker: after });
    if (verification.problems.length > 0) {
      stop("VERIFICATION_FAILED", before.version, verification.problems, { deploy, resultingVersion: outcome.version, contentHash: verification.contentHash });
      continue;
    }
    records.push({ ...base(step, intent), versionBefore: before.version, state: "RECOVERED", resultingVersion: outcome.version, contentHash: verification.contentHash, fingerprint: verification.fingerprint, problems: [], deploy });
    deps.log(`${step.plane}: RECOVERED ${before.version} → ${outcome.version} (fingerprint ${verification.fingerprint ?? "?"})`);
  }

  const outcome = recoveryOutcome(records);
  const queueAfter: Record<string, Readonly<Record<string, string>>> = {};
  for (const step of plan.steps) {
    const results = await deps.inspect(options.cli, step.projectRef, QUEUE_SNAPSHOT_STATUSES.map((status) => ({ tool: "list_runs" as const, status })));
    queueAfter[step.plane] = Object.fromEntries(QUEUE_SNAPSHOT_STATUSES.map((status, index) => {
      const count = parseRunCount(results[index] ?? "");
      return [status, count === undefined ? "unreadable" : `${String(count.count)}${count.morePages ? "+" : ""}`];
    }));
  }

  const evidence = {
    schema: RECOVERY_SCHEMA,
    tool: TOOL,
    startedAt: started.toISOString(),
    finishedAt: deps.now().toISOString(),
    knownGoodSha: plan.knownGoodSha,
    releaseEvidence: plan.releaseEvidence,
    releaseEvidenceSchema: context.release.schema,
    releaseEvidenceSha256: context.releaseEvidenceSha256,
    toolCommit: context.toolCommit,
    originMain: context.originMain,
    continues: context.prior?.fileName ?? null,
    environment: plan.environment,
    recoveryOrder: plan.steps.map((step) => step.plane),
    webRelease: options.webRelease,
    webVerdict: context.web,
    migrationsAfterKnownGood: context.migrationsAfterKnownGood,
    attestations: { ingestionPaused: options.attestIngestionPaused, webRelayPin: options.attestWebRelayPin, provenWebPairing: options.provenWebPairing !== undefined, acceptUnrecordedFingerprint: options.acceptUnrecordedFingerprint },
    startingVersions: Object.fromEntries(context.states.map((state) => [state.plane, state.worker.version])),
    queueBefore: Object.fromEntries(context.states.map((state) => [state.plane, state.queue])),
    queueAfter,
    planes: records,
    finalState: outcome.finalState,
    recoveredPlanes: outcome.recoveredPlanes,
    unrecoveredPlanes: outcome.unrecoveredPlanes,
    stopReason: run.stopReason,
    warnings: [
      ...(context.web.kind === "COMPATIBLE_ATTESTED" ? [`web pairing admitted by operator attestation: ${context.web.reason}`] : []),
      ...(outcome.finalState === "RECOVERED_FINGERPRINT_UNVERIFIED" ? ["at least one plane had no recorded known-good fingerprint: inventory-only verification"] : []),
      ...(context.migrationsAfterKnownGood.length > 0 ? [`the known-good worker predates migrations ${context.migrationsAfterKnownGood.join(", ")}: forward-only schema, never rolled back`] : []),
      "runs started on the previous versions finish there; delayed and queued runs start on the recovered versions; watch them drain",
    ],
    policy: "No automatic retry, restore or reorder. A stopped recovery leaves recovered planes recovered and the rest on their previous versions; it is continued only with --continue <this record>, after a fresh plan.",
  };
  const contents = redactReleaseOutput(JSON.stringify(evidence, null, 2));
  const evidencePath = deps.writeEvidence(`${started.toISOString().replace(/[:.]/g, "")}-${plan.knownGoodSha.slice(0, 12)}.json`, `${contents}\n`);
  deps.log(`${outcome.finalState} — recovered: ${outcome.recoveredPlanes.join(", ") || "none"}; not recovered: ${outcome.unrecoveredPlanes.join(", ") || "none"} — evidence: ${evidencePath}`);
  return { kind: "recovery", finalState: outcome.finalState, evidencePath };
}

/** Before every plane: the worktree is still the clean, detached known-good checkout. */
function worktreeIdentityProblems(deps: RecoveryDependencies, worktree: string, knownGood: string): string[] {
  const problems: string[] = [];
  if (gitValue(deps, worktree, ["rev-parse", "HEAD"]) !== knownGood) problems.push("the worktree HEAD moved");
  if (gitValue(deps, worktree, ["status", "--porcelain"]) !== "") problems.push("the worktree is no longer clean");
  return problems;
}

// ── Real dependencies ───────────────────────────────────────────────────────────────────────────────────────

const REPOSITORY_ROOT = realpathSync(path.resolve(import.meta.dirname, "../.."));

let activeChild: ChildProcess | undefined;
let operatorInterrupted = false;

/** The trigger.dev package version of a CLI executable (its realpath's nearest trigger.dev package.json). */
function cliPackageVersion(cli: string): string | undefined {
  try {
    let directory = path.dirname(realpathSync(cli));
    for (let depth = 0; depth < 8; depth += 1) {
      const manifest = path.join(directory, "package.json");
      if (existsSync(manifest)) {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown; version?: unknown };
        if (parsed.name === "trigger.dev" && typeof parsed.version === "string") return parsed.version;
      }
      directory = path.dirname(directory);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** A minimal JSON-RPC client for the CLI's own MCP server, started --readonly and bound to ONE project, from an empty directory. */
function inspectWithMcp(cli: string, projectRef: string, calls: readonly InspectCall[]): Promise<readonly (string | undefined)[]> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "trigger-recovery-inspect-"));
  const env = sterileEnvironment(process.env) as NodeJS.ProcessEnv;
  const child = spawn(cli, ["mcp", "--project-ref", projectRef, "--readonly", "--skip-telemetry", "--log-level", "error"], { cwd: directory, env, stdio: ["pipe", "pipe", "ignore"], shell: false });
  let buffer = "";
  let nextId = 1;
  const waiting = new Map<number, (message: { result?: { content?: { text?: string }[]; isError?: boolean } } | undefined) => void>();
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line.startsWith("{")) continue;
      try {
        const message = JSON.parse(line) as { id?: number; result?: { content?: { text?: string }[]; isError?: boolean } };
        if (message.id !== undefined) {
          waiting.get(message.id)?.(message);
          waiting.delete(message.id);
        }
      } catch {
        // Not a protocol line.
      }
    }
  });
  const request = (method: string, params: unknown) =>
    new Promise<{ result?: { content?: { text?: string }[]; isError?: boolean } } | undefined>((resolve) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve(undefined);
      }, INSPECT_TIMEOUT_MS);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  child.on("close", () => {
    for (const resolve of waiting.values()) resolve(undefined);
    waiting.clear();
  });
  return (async () => {
    try {
      const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "wrenkind-trigger-recovery", version: "1" } });
      if (init === undefined) return calls.map(() => undefined);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const out: (string | undefined)[] = [];
      for (const call of calls) {
        const args = call.tool === "get_current_worker"
          ? { projectRef, environment: "prod" }
          : call.tool === "list_deploys"
            ? { projectRef, environment: "prod", period: call.period, limit: 100 }
            : { projectRef, environment: "prod", status: call.status, limit: 100 };
        const response = await request("tools/call", { name: call.tool, arguments: args });
        out.push(response?.result === undefined || response.result.isError === true ? undefined : (response.result.content ?? []).map((part) => part.text ?? "").join("\n"));
      }
      return out;
    } finally {
      child.kill("SIGTERM");
      rmSync(directory, { recursive: true, force: true });
    }
  })();
}

function realDependencies(): RecoveryDependencies {
  return {
    repositoryRoot: REPOSITORY_ROOT,
    git: (cwd, args) => {
      const result = spawnSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { ok: result.status === 0, stdout: result.stdout };
    },
    realpath: (absolutePath) => {
      try {
        return realpathSync(absolutePath);
      } catch {
        return undefined;
      }
    },
    fileExists: (absolutePath) => existsSync(absolutePath),
    readFile: (absolutePath) => {
      try {
        return new Uint8Array(readFileSync(absolutePath));
      } catch {
        return undefined;
      }
    },
    listDirectory: (absolutePath) => {
      try {
        return readdirSync(absolutePath);
      } catch {
        return undefined;
      }
    },
    cliIsExecutable: (cli) => {
      try {
        accessSync(cli, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    cliVersion: cliPackageVersion,
    createEmptyEnvFile: () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "trigger-recovery-"));
      const file = path.join(directory, "empty-env-file");
      writeFileSync(file, "", { mode: 0o600, flag: "wx" });
      return {
        path: file,
        cleanup: () => {
          rmSync(directory, { recursive: true, force: true });
        },
      };
    },
    inspect: inspectWithMcp,
    spawnDeploy: (cli, argv, cwd, timeoutMs) =>
      new Promise((resolve) => {
        const chunks: string[] = [];
        let timedOut = false;
        const env = sterileEnvironment(process.env) as NodeJS.ProcessEnv;
        const child = spawn(cli, [...argv], { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: false });
        activeChild = child;
        const onData = (data: Buffer): void => {
          const text = data.toString();
          chunks.push(text);
          process.stdout.write(redactReleaseOutput(text));
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGINT");
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          }, INTERRUPT_GRACE_MS).unref();
        }, timeoutMs);
        const finish = (code: number | null): void => {
          clearTimeout(timer);
          activeChild = undefined;
          resolve({ exitCode: code, output: chunks.join(""), timedOut, interrupted: operatorInterrupted });
        };
        child.on("close", finish);
        child.on("error", () => {
          finish(null);
        });
      }),
    interrupted: () => operatorInterrupted,
    writeEvidence: (fileName, contents) => {
      const directory = path.join(REPOSITORY_ROOT, RECOVERY_EVIDENCE_DIRECTORY);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, fileName);
      writeFileSync(file, contents, { mode: 0o600, flag: "wx" });
      return path.relative(REPOSITORY_ROOT, file);
    },
    evidenceLocationIsLocalOnly: () => {
      const probe = `${RECOVERY_EVIDENCE_DIRECTORY}/probe.json`;
      const ignored = spawnSync("git", ["check-ignore", "-q", probe], { cwd: REPOSITORY_ROOT, stdio: "ignore" }).status === 0;
      const vercelIgnore = existsSync(path.join(REPOSITORY_ROOT, ".vercelignore")) ? readFileSync(path.join(REPOSITORY_ROOT, ".vercelignore"), "utf8").split(/\r?\n/) : [];
      return ignored && vercelIgnore.includes("/.wrenkind-local/");
    },
    now: () => new Date(),
    log: (line) => {
      console.log(redactReleaseOutput(line));
    },
  };
}

async function main(): Promise<void> {
  const parsed = parseRecoveryArguments(process.argv.slice(2));
  if ("error" in parsed) {
    console.log(`USAGE: ${parsed.error}`);
    process.exit(2);
  }
  process.on("SIGINT", () => {
    operatorInterrupted = true;
    console.log("INTERRUPT received: forwarding to the CLI; no further plane will start.");
    activeChild?.kill("SIGINT");
  });
  const result = await runRecovery(parsed, realDependencies());
  if (result.kind === "refused") console.log(redactReleaseOutput(`REFUSED: ${result.reason}.${result.problems.length > 0 ? ` ${result.problems.join("; ")}.` : ""} Nothing was deployed by this step.`));
  process.exit(exitCodeFor(result));
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
