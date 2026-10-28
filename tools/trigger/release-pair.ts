/**
 * The paired Trigger.dev release (Step 7G-H5.5-P2-F2): PURE planning, parsing and redaction for
 * tools/trigger/deploy-release-pair.ts. No I/O, no process, no network, no Trigger.dev SDK.
 *
 * The two execution planes are ONE release unit. MAIN pins every cross-plane trigger to its own external deployment id
 * (platform/jobs/release.ts `crossPlanePin`, jobs/main-runtime.ts) and INTEGRATION pins its relay wake-ups the same way
 * (jobs/runtime.ts), so both planes must be deployed from the SAME source commit with the SAME `--external-id`.
 * A release is therefore exactly:
 *
 *   1. INTEGRATION   deploy --config trigger.integration.config.ts …   (the credential-opening tasks; the helper image)
 *   2. MAIN          deploy --config trigger.config.ts …               (relay, sweepers, Move saga)
 *
 * both with `--env prod --external-id <RELEASE_SHA> --depot-build --env-file <empty> --skip-update-check
 * --skip-sync-env-vars --skip-telemetry`, where RELEASE_SHA is captured ONCE by the executor and never recalculated.
 * Project references are operator input (flags), never committed and never read from an env file.
 *
 * What a successful run proves, and what it does not: both deploy invocations received the identical captured SHA,
 * both CLIs exited 0 and reported a version and the expected number of detected tasks, and the git identity did not
 * change in between. The external id Trigger.dev stored is NOT re-readable with the tooling this project uses
 * (`getWorkerByTag` returns no external id), so the tool never claims to have read it back.
 */
import { createHash } from "node:crypto";
import { SECRET_PATTERNS } from "../../domain/secret-patterns.ts";
import { AWS_SIGNING_HELPER_ARTIFACTS, awsSigningHelperRelativePath, type AwsSigningHelperArtifact } from "../../jobs/aws-signing-helper.ts";

export type ReleasePlane = "integration" | "main";

export interface PlaneDefinition {
  readonly plane: ReleasePlane;
  readonly config: string;
  /** The executor flag that supplies this plane's project reference. */
  readonly projectRefFlag: "--integration-project-ref" | "--main-project-ref";
  /** Detected tasks the CLI must report for this plane (task files under jobs/trigger/<plane>); anything else fails closed. */
  readonly expectedTasks: number;
}

/** The closed release table, in deploy order. INTEGRATION first, then MAIN — never reordered, never one alone. */
export const RELEASE_PLANES: readonly PlaneDefinition[] = Object.freeze([
  Object.freeze({ plane: "integration", config: "trigger.integration.config.ts", projectRefFlag: "--integration-project-ref", expectedTasks: 7 }),
  Object.freeze({ plane: "main", config: "trigger.config.ts", projectRefFlag: "--main-project-ref", expectedTasks: 8 }),
] as const);

/** The only environment a paired release targets. Preview (TA-Q-31) is a separate, documented exception. */
export const RELEASE_ENVIRONMENT = "prod";

/** Shown instead of the temporary empty env file's real path in plans and evidence. */
export const EMPTY_ENV_FILE_LABEL = "<tool-empty-env-file>";

/** Flags every plane receives, after its own --config/--project-ref (the safety contract). */
export const COMMON_SAFETY_FLAGS = ["--depot-build", "--skip-update-check", "--skip-sync-env-vars", "--skip-telemetry"] as const;

/** Flags no release argv may ever contain. */
export const FORBIDDEN_FLAGS = ["--show-values", "--force", "--env-pull", "--sync-env-vars", "--branch", "--dry-run"] as const;

export class ReleasePlanError extends Error {
  override readonly name = "ReleasePlanError";
}

const RELEASE_SHA = /^[0-9a-f]{40}$/;
const PROJECT_REF = /^proj_[a-z0-9]{8,64}$/;

export const isReleaseSha = (value: unknown): value is string => typeof value === "string" && RELEASE_SHA.test(value);
export const isProjectRef = (value: unknown): value is string => typeof value === "string" && PROJECT_REF.test(value);

export interface PlannedDeploy {
  readonly plane: ReleasePlane;
  readonly config: string;
  readonly projectRef: string;
  readonly expectedTasks: number;
  /** Full CLI argv (after the CLI executable). */
  readonly argv: readonly string[];
}

export interface ReleasePlan {
  readonly releaseSha: string;
  readonly environment: typeof RELEASE_ENVIRONMENT;
  readonly steps: readonly PlannedDeploy[];
}

/** The exact argv of one plane's deploy. */
export function deployArgv(definition: PlaneDefinition, input: { readonly projectRef: string; readonly releaseSha: string; readonly emptyEnvFile: string }): readonly string[] {
  return Object.freeze([
    "deploy",
    "--config",
    definition.config,
    "--project-ref",
    input.projectRef,
    "--env",
    RELEASE_ENVIRONMENT,
    "--external-id",
    input.releaseSha,
    "--env-file",
    input.emptyEnvFile,
    ...COMMON_SAFETY_FLAGS,
  ]);
}

/**
 * The release plan: both planes, in order, built from ONE release SHA. Fails closed on an invalid SHA, a missing,
 * malformed or shared project reference, or an empty env-file path.
 */
export function buildReleasePlan(input: {
  readonly releaseSha: unknown;
  readonly integrationProjectRef: unknown;
  readonly mainProjectRef: unknown;
  readonly emptyEnvFile: string;
}): ReleasePlan {
  if (!isReleaseSha(input.releaseSha)) throw new ReleasePlanError("release SHA must be 40 lower-case hex characters");
  if (!isProjectRef(input.integrationProjectRef)) throw new ReleasePlanError("--integration-project-ref must be a project reference (proj_…)");
  if (!isProjectRef(input.mainProjectRef)) throw new ReleasePlanError("--main-project-ref must be a project reference (proj_…)");
  if (input.integrationProjectRef === input.mainProjectRef) throw new ReleasePlanError("the two planes must be different projects");
  if (input.emptyEnvFile.trim() === "") throw new ReleasePlanError("an empty env file controlled by the tool is required");
  const releaseSha = input.releaseSha;
  const refs: Readonly<Record<ReleasePlane, string>> = { integration: input.integrationProjectRef, main: input.mainProjectRef };
  const steps = RELEASE_PLANES.map((definition): PlannedDeploy => ({
    plane: definition.plane,
    config: definition.config,
    projectRef: refs[definition.plane],
    expectedTasks: definition.expectedTasks,
    argv: deployArgv(definition, { projectRef: refs[definition.plane], releaseSha, emptyEnvFile: input.emptyEnvFile }),
  }));
  assertPlanInvariants({ releaseSha, environment: RELEASE_ENVIRONMENT, steps });
  return Object.freeze({ releaseSha, environment: RELEASE_ENVIRONMENT, steps: Object.freeze(steps) });
}

/** Re-checks a plan before it is executed: order, one SHA in both argv, prod only, safety flags present, nothing forbidden. */
export function assertPlanInvariants(plan: ReleasePlan): void {
  const fail = (reason: string): never => {
    throw new ReleasePlanError(`release plan invariant violated: ${reason}`);
  };
  if (plan.steps.length !== RELEASE_PLANES.length) fail("exactly two planes");
  plan.steps.forEach((step, index) => {
    const definition = RELEASE_PLANES[index] ?? fail("unknown plane");
    if (step.plane !== definition.plane || step.config !== definition.config) fail("plane order is INTEGRATION then MAIN");
    const value = (flag: string): string | undefined => {
      const at = step.argv.indexOf(flag);
      return at < 0 ? undefined : step.argv[at + 1];
    };
    if (step.argv[0] !== "deploy") fail("argv must start with deploy");
    if (value("--config") !== definition.config) fail(`${step.plane} config`);
    if (value("--project-ref") !== step.projectRef) fail(`${step.plane} project ref`);
    if (value("--env") !== RELEASE_ENVIRONMENT) fail(`${step.plane} environment`);
    if (value("--external-id") !== plan.releaseSha) fail(`${step.plane} external id must be the release SHA`);
    if ((value("--env-file") ?? "") === "") fail(`${step.plane} empty env file`);
    for (const flag of COMMON_SAFETY_FLAGS) if (!step.argv.includes(flag)) fail(`${step.plane} missing ${flag}`);
    for (const flag of FORBIDDEN_FLAGS) if (step.argv.includes(flag)) fail(`${step.plane} contains ${flag}`);
    if (step.argv.filter((token) => token === "--external-id").length !== 1) fail(`${step.plane} exactly one external id`);
  });
  const [integration, main] = plan.steps;
  if (integration?.projectRef === main?.projectRef) fail("distinct project references");
}

/** The argv as it may be shown or recorded: the temporary file path is replaced by a label. */
export function sanitizeArgv(argv: readonly string[]): readonly string[] {
  return argv.map((token, index) => (argv[index - 1] === "--env-file" ? EMPTY_ENV_FILE_LABEL : token));
}

// ── CLI output ──────────────────────────────────────────────────────────────────────────────────────────────

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const DEPLOYED = /Version (\S+) deployed with (\d+) detected tasks?/g;
const SUCCESS = /Successfully deployed version (\S+)/g;
const VERSION = /^\d{8}\.\d+$/;

export interface ParsedDeployOutput {
  readonly version: string;
  readonly taskCount: number;
}

/**
 * The version and detected task count the CLI reported, or undefined when the output is missing, malformed or
 * ambiguous (several different versions/counts). A "Successfully deployed version X" line, when present, must agree.
 */
export function parseDeployOutput(output: string): ParsedDeployOutput | undefined {
  const text = output.replace(ANSI, "");
  const deployed = [...text.matchAll(DEPLOYED)].map((match) => ({ version: match[1] ?? "", taskCount: Number(match[2]) }));
  const distinct = new Set(deployed.map((entry) => `${entry.version}/${String(entry.taskCount)}`));
  if (deployed.length === 0 || distinct.size !== 1) return undefined;
  const [first] = deployed;
  if (first === undefined || !VERSION.test(first.version) || !Number.isInteger(first.taskCount)) return undefined;
  const successes = new Set([...text.matchAll(SUCCESS)].map((match) => match[1]));
  if (successes.size > 1 || (successes.size === 1 && !successes.has(first.version))) return undefined;
  return { version: first.version, taskCount: first.taskCount };
}

export type PlaneOutcome =
  | { readonly state: "PASS"; readonly version: string; readonly taskCount: number }
  | { readonly state: "FAILED"; readonly reason: "exit_code" }
  | { readonly state: "UNKNOWN"; readonly reason: "timeout" | "interrupted" | "unreadable_output" | "task_count_mismatch"; readonly version?: string; readonly taskCount?: number };

/** One plane's verdict: PASS only with exit code 0, a parseable version and EXACTLY the expected task count. */
export function evaluatePlaneResult(step: Pick<PlannedDeploy, "expectedTasks">, result: { readonly exitCode: number | null; readonly output: string; readonly timedOut: boolean; readonly interrupted: boolean }): PlaneOutcome {
  if (result.interrupted) return { state: "UNKNOWN", reason: "interrupted" };
  if (result.timedOut) return { state: "UNKNOWN", reason: "timeout" };
  if (result.exitCode !== 0) return { state: "FAILED", reason: "exit_code" };
  const parsed = parseDeployOutput(result.output);
  if (parsed === undefined) return { state: "UNKNOWN", reason: "unreadable_output" };
  if (parsed.taskCount !== step.expectedTasks) return { state: "UNKNOWN", reason: "task_count_mismatch", version: parsed.version, taskCount: parsed.taskCount };
  return { state: "PASS", version: parsed.version, taskCount: parsed.taskCount };
}

export const FINAL_STATES = ["ALIGNED", "STOP_INTEGRATION_FAILED", "STOP_MAIN_FAILED", "STOP_VERIFICATION_UNKNOWN", "STOP_GIT_DRIFT", "INTERRUPTED"] as const;
export type FinalState = (typeof FINAL_STATES)[number];

// ── Redaction ───────────────────────────────────────────────────────────────────────────────────────────────

const EXTRA_REDACTIONS: readonly RegExp[] = [
  /\btr_[a-z]+_[A-Za-z0-9]{4,}/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@'"`]+:[^\s@'"`]+@\S+/gi,
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g,
  /\b(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)\s*[=:]\s*\S+/gi,
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,
];

/** Output safe to print or record: ANSI stripped; every credential shape (shared + extra patterns) replaced. */
export function redactReleaseOutput(text: string): string {
  let out = text.replace(ANSI, "");
  for (const pattern of EXTRA_REDACTIONS) out = out.replace(pattern, "<redacted>");
  for (const { pattern } of SECRET_PATTERNS) out = out.replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`), "<redacted>");
  return out;
}

/** The last `lines` lines of redacted output (bounded evidence). */
export function redactedTail(text: string, lines = 40): readonly string[] {
  return redactReleaseOutput(text)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-lines);
}

// ── Helper prerequisites (INTEGRATION image) ────────────────────────────────────────────────────────────────

export interface HelperCheck {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * The pinned AWS signing helper builds (jobs/aws-signing-helper.ts) are present with their exact SHA-256 — checked
 * BEFORE any deploy, so a missing or altered build stops the release early. The image-build integrity layer remains
 * the enforcement boundary; this is the operator-visible precheck. `readFile` returns the file bytes or undefined.
 */
export function checkHelperBuilds(
  readFile: (relativePath: string) => Uint8Array | undefined,
  artifacts: readonly AwsSigningHelperArtifact[] = AWS_SIGNING_HELPER_ARTIFACTS,
): HelperCheck {
  const problems: string[] = [];
  if (artifacts.length === 0) problems.push("no pinned signing-helper builds");
  for (const artifact of artifacts) {
    const relative = awsSigningHelperRelativePath(artifact);
    const bytes = readFile(relative);
    if (bytes === undefined) problems.push(`${relative} missing (run: node tools/trigger/fetch-aws-signing-helper.ts)`);
    else if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) problems.push(`${relative} digest mismatch (re-run the fetch tool)`);
  }
  return { ok: problems.length === 0, problems };
}
