/**
 * The ONLY supported Trigger.dev production release path (Step 7G-H5.5-P2-F2): both execution planes, as one release
 * unit, from one captured commit. Plan: tools/trigger/release-pair.ts. Run from the repository root:
 *
 *   npm run trigger:release -- --cli <absolute path to the pinned trigger CLI> \
 *     --integration-project-ref <proj_…> --main-project-ref <proj_…>                       DRY RUN (default): no deploy
 *   … --execute --confirm-paired-release                                                     deploys INTEGRATION, then MAIN
 *
 * Git identity: repository root, clean worktree, HEAD captured, `git fetch origin main`, HEAD unchanged and equal to
 * origin/main → RELEASE_SHA, frozen for the whole run. Before EACH plane the identity is re-checked (fresh fetch); any
 * drift stops the release. INTEGRATION must pass (exit 0, version, exactly its task count) before MAIN starts.
 *
 * Never: an automatic retry, rollback or redeploy; reading `.env*` or any environment loader; passing environment
 * variables to the CLI beyond PATH and HOME (the CLI's own login lives under HOME) plus TERM=dumb, CI=1, NO_COLOR=1;
 * syncing or listing variables; printing a secret. Every CLI line is redacted before it is shown or recorded. An
 * --execute run that reaches the deploy phase writes ONE create-exclusive evidence record under
 * .wrenkind-local/evidence/trigger-release-pair/ (operator-local, git- and Vercel-excluded).
 *
 * The external id Trigger.dev stores is not re-readable with this tooling; ALIGNED means: one captured SHA, both argv
 * built from it, both planes PASS, git identity unchanged — nothing more is claimed.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_PLANES,
  ReleasePlanError,
  assertPlanInvariants,
  buildReleasePlan,
  checkHelperBuilds,
  evaluatePlaneResult,
  redactReleaseOutput,
  redactedTail,
  sanitizeArgv,
  type FinalState,
  type PlaneOutcome,
  type PlannedDeploy,
  type ReleasePlan,
} from "./release-pair.ts";

export const EVIDENCE_DIRECTORY = ".wrenkind-local/evidence/trigger-release-pair";
export const DEFAULT_PLANE_TIMEOUT_MS = 30 * 60 * 1000;
export const INTERRUPT_GRACE_MS = 15_000;
const TOOL = "tools/trigger/deploy-release-pair.ts";

export interface ReleaseOptions {
  readonly cli: string;
  readonly integrationProjectRef: string;
  readonly mainProjectRef: string;
  readonly execute: boolean;
  readonly timeoutMs: number;
}

export interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
}

export interface DeployResult {
  readonly exitCode: number | null;
  readonly output: string;
  readonly timedOut: boolean;
  readonly interrupted: boolean;
}

/** Everything with an effect, injected (tests use fakes; main() wires the real ones). */
export interface ReleaseDependencies {
  readonly repositoryRoot: string;
  readonly git: (args: readonly string[]) => GitResult;
  readonly fileExists: (relativePath: string) => boolean;
  readonly readFile: (relativePath: string) => Uint8Array | undefined;
  readonly cliIsExecutable: (cliPath: string) => boolean;
  /** A fresh, empty, 0600 env file the tool controls, and its removal. */
  readonly createEmptyEnvFile: () => { readonly path: string; readonly cleanup: () => void };
  readonly spawnDeploy: (cli: string, argv: readonly string[], timeoutMs: number) => Promise<DeployResult>;
  /** True once the operator has interrupted (Ctrl-C) the run. */
  readonly interrupted: () => boolean;
  /** Create-exclusive write; refuses to overwrite. Returns the written path. */
  readonly writeEvidence: (fileName: string, contents: string) => string;
  /** True when the evidence directory is git-ignored and Vercel-excluded (it must never be committed or uploaded). */
  readonly evidenceLocationIsLocalOnly: () => boolean;
  readonly now: () => Date;
  readonly log: (line: string) => void;
}

export type RunResult =
  | { readonly kind: "usage"; readonly message: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "dry_run"; readonly plan: ReleasePlan }
  | { readonly kind: "released"; readonly finalState: FinalState; readonly evidencePath: string | undefined };

export const exitCodeFor = (result: RunResult): number =>
  result.kind === "usage" ? 2 : result.kind === "refused" ? 1 : result.kind === "dry_run" ? 0 : result.finalState === "ALIGNED" ? 0 : 1;

// ── Arguments ───────────────────────────────────────────────────────────────────────────────────────────────

const VALUE_FLAGS = new Set(["--cli", "--integration-project-ref", "--main-project-ref", "--timeout-minutes"]);
const BOOLEAN_FLAGS = new Set(["--execute", "--confirm-paired-release"]);

export function parseArguments(args: readonly string[]): ReleaseOptions | { readonly error: string } {
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
  const cli = values.get("--cli");
  const integrationProjectRef = values.get("--integration-project-ref");
  const mainProjectRef = values.get("--main-project-ref");
  if (cli === undefined || integrationProjectRef === undefined || mainProjectRef === undefined) {
    return { error: "required: --cli <absolute path> --integration-project-ref <proj_…> --main-project-ref <proj_…>" };
  }
  const execute = booleans.has("--execute");
  if (execute !== booleans.has("--confirm-paired-release")) return { error: "--execute and --confirm-paired-release must be given together" };
  const minutes = values.get("--timeout-minutes");
  const timeoutMs = minutes === undefined ? DEFAULT_PLANE_TIMEOUT_MS : Number(minutes) * 60 * 1000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 120 * 60 * 1000) return { error: "--timeout-minutes must be an integer from 1 to 120" };
  return { cli, integrationProjectRef, mainProjectRef, execute, timeoutMs };
}

// ── Git identity ────────────────────────────────────────────────────────────────────────────────────────────

const gitValue = (deps: ReleaseDependencies, args: readonly string[]): string | undefined => {
  const result = deps.git(args);
  return result.ok ? result.stdout.trim() : undefined;
};

/** Clean worktree, HEAD == origin/main == `sha` after a fresh fetch. `reason` names the first failed condition. */
export function identityHolds(deps: ReleaseDependencies, sha: string): { readonly ok: boolean; readonly reason?: string } {
  if (gitValue(deps, ["status", "--porcelain"]) !== "") return { ok: false, reason: "worktree is not clean" };
  if (gitValue(deps, ["rev-parse", "HEAD"]) !== sha) return { ok: false, reason: "HEAD moved" };
  if (!deps.git(["fetch", "origin", "main"]).ok) return { ok: false, reason: "git fetch origin main failed" };
  if (gitValue(deps, ["rev-parse", "HEAD"]) !== sha) return { ok: false, reason: "HEAD moved" };
  if (gitValue(deps, ["rev-parse", "origin/main"]) !== sha) return { ok: false, reason: "origin/main moved" };
  return { ok: true };
}

/** The precheck: repository, worktree, fetch, RELEASE_SHA capture, configs, refs, helper builds. */
function precheck(options: ReleaseOptions, deps: ReleaseDependencies): { readonly sha: string } | { readonly refused: string } {
  const top = gitValue(deps, ["rev-parse", "--show-toplevel"]);
  if (top === undefined || top !== deps.repositoryRoot) return { refused: "not run from the canonical repository root" };
  if (gitValue(deps, ["status", "--porcelain"]) !== "") return { refused: "worktree is not clean" };
  const initial = gitValue(deps, ["rev-parse", "HEAD"]);
  if (initial === undefined) return { refused: "HEAD unreadable" };
  if (!deps.git(["fetch", "origin", "main"]).ok) return { refused: "git fetch origin main failed" };
  if (gitValue(deps, ["rev-parse", "HEAD"]) !== initial) return { refused: "HEAD changed during the fetch" };
  if (gitValue(deps, ["rev-parse", "origin/main"]) !== initial) return { refused: "HEAD is not origin/main (push or pull first)" };
  if (gitValue(deps, ["status", "--porcelain"]) !== "") return { refused: "worktree is not clean" };
  for (const definition of RELEASE_PLANES) if (!deps.fileExists(definition.config)) return { refused: `${definition.config} not found` };
  if (!path.isAbsolute(options.cli) || !deps.cliIsExecutable(options.cli)) return { refused: "--cli must be the absolute path of an executable trigger CLI" };
  const helpers = checkHelperBuilds(deps.readFile);
  if (!helpers.ok) return { refused: `signing helper builds not ready: ${helpers.problems.join("; ")}` };
  return { sha: initial };
}

// ── Run ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface PlaneRecord {
  readonly plane: string;
  readonly config: string;
  readonly argv: readonly string[];
  readonly expectedTasks: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly interrupted: boolean;
  readonly outcome: PlaneOutcome;
  readonly outputTail: readonly string[];
}

export async function runPairedRelease(options: ReleaseOptions, deps: ReleaseDependencies): Promise<RunResult> {
  const checked = precheck(options, deps);
  if ("refused" in checked) return { kind: "refused", reason: checked.refused };
  const releaseSha = checked.sha; // frozen: never recalculated below
  const envFile = deps.createEmptyEnvFile();
  try {
    let plan: ReleasePlan;
    try {
      plan = buildReleasePlan({ releaseSha, integrationProjectRef: options.integrationProjectRef, mainProjectRef: options.mainProjectRef, emptyEnvFile: envFile.path });
    } catch (error) {
      if (error instanceof ReleasePlanError) return { kind: "refused", reason: error.message };
      throw error;
    }
    deps.log(`RELEASE_SHA ${releaseSha} (captured once; HEAD == origin/main; worktree clean)`);
    plan.steps.forEach((step, index) => {
      deps.log(`plan ${String(index + 1)}/${String(plan.steps.length)} ${step.plane}: trigger ${sanitizeArgv(step.argv).join(" ")}  [expects ${String(step.expectedTasks)} tasks]`);
    });
    if (!options.execute) {
      deps.log("DRY RUN: nothing deployed. Re-run with --execute --confirm-paired-release to release both planes.");
      return { kind: "dry_run", plan };
    }
    if (!deps.evidenceLocationIsLocalOnly()) return { kind: "refused", reason: `${EVIDENCE_DIRECTORY} must be git-ignored and Vercel-excluded` };
    return await deployPlan(plan, options, deps);
  } finally {
    envFile.cleanup();
  }
}

async function deployPlan(plan: ReleasePlan, options: ReleaseOptions, deps: ReleaseDependencies): Promise<RunResult> {
  assertPlanInvariants(plan);
  const started = deps.now();
  const records: PlaneRecord[] = [];
  const checks: { readonly before: string; readonly ok: boolean; readonly reason?: string }[] = [];
  let finalState: FinalState = "ALIGNED";

  for (const step of plan.steps) {
    if (deps.interrupted()) {
      finalState = "INTERRUPTED";
      break;
    }
    const identity = identityHolds(deps, plan.releaseSha);
    checks.push({ before: step.plane, ...identity });
    if (!identity.ok) {
      finalState = "STOP_GIT_DRIFT";
      deps.log(`STOP_GIT_DRIFT before ${step.plane}: ${identity.reason ?? "identity changed"} — nothing more is deployed`);
      break;
    }
    deps.log(`deploying ${step.plane} …`);
    const startedAt = deps.now().toISOString();
    const result = await deps.spawnDeploy(options.cli, step.argv, options.timeoutMs);
    const outcome = evaluatePlaneResult(step, result);
    records.push(record(step, startedAt, deps.now().toISOString(), result, outcome));
    deps.log(`${step.plane}: ${describe(outcome)}`);
    if (outcome.state === "PASS") continue;
    finalState = result.interrupted || deps.interrupted() ? "INTERRUPTED" : outcome.state === "UNKNOWN" ? "STOP_VERIFICATION_UNKNOWN" : step.plane === "integration" ? "STOP_INTEGRATION_FAILED" : "STOP_MAIN_FAILED";
    break;
  }
  if (finalState === "ALIGNED") {
    const identity = identityHolds(deps, plan.releaseSha);
    checks.push({ before: "final", ...identity });
    if (!identity.ok) finalState = "STOP_GIT_DRIFT";
  }

  const evidence = {
    schema: "wrenkind.trigger-release-pair.v1",
    tool: TOOL,
    startedAt: started.toISOString(),
    finishedAt: deps.now().toISOString(),
    releaseSha: plan.releaseSha,
    environment: plan.environment,
    planeOrder: plan.steps.map((step) => step.plane),
    sameReleaseShaInEveryArgv: plan.steps.every((step) => step.argv.includes(plan.releaseSha)),
    identityChecks: checks,
    planes: records,
    planesNotStarted: plan.steps.filter((step) => !records.some((entry) => entry.plane === step.plane)).map((step) => step.plane),
    finalState,
    limitation: "The external id Trigger.dev stored is not re-readable with this tooling (getWorkerByTag returns none); ALIGNED rests on one captured SHA, identical argv, both planes PASS and unchanged git identity.",
    policy: "No automatic retry, rollback or redeploy. After STOP_MAIN_FAILED, INTEGRATION may already run the new release while MAIN still pins the old one: re-run this tool for the same commit once the cause is fixed.",
  };
  // Defense in depth: the record is redacted as a whole, even though every field is already non-secret.
  const contents = redactReleaseOutput(JSON.stringify(evidence, null, 2));
  const evidencePath = deps.writeEvidence(`${started.toISOString().replace(/[:.]/g, "")}-${plan.releaseSha.slice(0, 12)}.json`, `${contents}\n`);
  deps.log(`${finalState} — evidence: ${evidencePath}`);
  return { kind: "released", finalState, evidencePath };
}

function record(step: PlannedDeploy, startedAt: string, finishedAt: string, result: DeployResult, outcome: PlaneOutcome): PlaneRecord {
  return {
    plane: step.plane,
    config: step.config,
    argv: sanitizeArgv(step.argv),
    expectedTasks: step.expectedTasks,
    startedAt,
    finishedAt,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    interrupted: result.interrupted,
    outcome,
    outputTail: redactedTail(result.output),
  };
}

function describe(outcome: PlaneOutcome): string {
  if (outcome.state === "PASS") return `PASS version ${outcome.version}, ${String(outcome.taskCount)} tasks`;
  if (outcome.state === "FAILED") return "FAILED (non-zero exit)";
  return `UNKNOWN (${outcome.reason}${outcome.taskCount === undefined ? "" : `: ${String(outcome.taskCount)} tasks`})`;
}

// ── Real dependencies ───────────────────────────────────────────────────────────────────────────────────────

const REPOSITORY_ROOT = realpathSync(path.resolve(import.meta.dirname, "../.."));

let activeChild: ChildProcess | undefined;
let operatorInterrupted = false;

/** The CLI's whole environment: PATH and HOME (its own login profile lives there) and three fixed values. */
export function sterileEnvironment(source: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  return { PATH: source["PATH"] ?? "", HOME: source["HOME"] ?? "", TERM: "dumb", CI: "1", NO_COLOR: "1" };
}

function realDependencies(): ReleaseDependencies {
  return {
    repositoryRoot: REPOSITORY_ROOT,
    git: (args) => {
      const result = spawnSync("git", [...args], { cwd: REPOSITORY_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { ok: result.status === 0, stdout: result.stdout };
    },
    fileExists: (relativePath) => existsSync(path.join(REPOSITORY_ROOT, relativePath)),
    readFile: (relativePath) => {
      try {
        return new Uint8Array(readFileSync(path.join(REPOSITORY_ROOT, relativePath)));
      } catch {
        return undefined;
      }
    },
    cliIsExecutable: (cliPath) => {
      try {
        accessSync(cliPath, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    createEmptyEnvFile: () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "trigger-release-pair-"));
      const file = path.join(directory, "empty-env-file");
      writeFileSync(file, "", { mode: 0o600, flag: "wx" });
      return {
        path: file,
        cleanup: () => {
          rmSync(directory, { recursive: true, force: true });
        },
      };
    },
    spawnDeploy: (cli, argv, timeoutMs) =>
      new Promise((resolve) => {
        const chunks: string[] = [];
        let timedOut = false;
        // Exactly the sterile set (no NODE_ENV or anything else is inherited); the cast only satisfies the global ProcessEnv type.
        const env = sterileEnvironment(process.env) as NodeJS.ProcessEnv;
        const child = spawn(cli, [...argv], { cwd: REPOSITORY_ROOT, env, stdio: ["ignore", "pipe", "pipe"], shell: false });
        activeChild = child;
        const onData = (data: Buffer): void => {
          const text = data.toString();
          chunks.push(text);
          process.stdout.write(redactReleaseOutput(text));
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        const stop = (): void => {
          child.kill("SIGINT");
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          }, INTERRUPT_GRACE_MS).unref();
        };
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, timeoutMs);
        child.on("close", (code) => {
          clearTimeout(timer);
          activeChild = undefined;
          resolve({ exitCode: code, output: chunks.join(""), timedOut, interrupted: operatorInterrupted });
        });
        child.on("error", () => {
          clearTimeout(timer);
          activeChild = undefined;
          resolve({ exitCode: null, output: chunks.join(""), timedOut, interrupted: operatorInterrupted });
        });
      }),
    interrupted: () => operatorInterrupted,
    writeEvidence: (fileName, contents) => {
      const directory = path.join(REPOSITORY_ROOT, EVIDENCE_DIRECTORY);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, fileName);
      writeFileSync(file, contents, { mode: 0o600, flag: "wx" });
      return path.relative(REPOSITORY_ROOT, file);
    },
    evidenceLocationIsLocalOnly: () => {
      const probe = `${EVIDENCE_DIRECTORY}/probe.json`;
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
  const parsed = parseArguments(process.argv.slice(2));
  if ("error" in parsed) {
    console.log(`USAGE: ${parsed.error}`);
    process.exit(2);
  }
  process.on("SIGINT", () => {
    operatorInterrupted = true;
    console.log("INTERRUPT received: forwarding to the CLI; no further plane will start.");
    activeChild?.kill("SIGINT");
  });
  const result = await runPairedRelease(parsed, realDependencies());
  if (result.kind === "refused") console.log(`REFUSED: ${result.reason}. Nothing was deployed.`);
  process.exit(exitCodeFor(result));
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
