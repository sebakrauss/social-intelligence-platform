/**
 * RECOVERY-TOOLING-01 — the guarded three-plane Trigger.dev FORWARD RECOVERY: PURE planning, parsing and verification for
 * tools/trigger/recover-release.ts. No I/O, no process, no network, no Trigger.dev SDK.
 *
 * Mechanism (proven in TRIGGER-RECOVERY-REHEARSAL-02): an older version is never promoted (the server refuses it).
 * Recovery redeploys the source of a previously ALIGNED release — the approved known-good commit — to every plane as a
 * NEW version, with the same deploy argv the release unit uses (tools/trigger/release-pair.ts `deployArgv`: prod, the
 * known-good SHA as the ONE external id, the tool's empty env file, the safety flags). A failed deploy leaves that plane on
 * its previous version (verified).
 *
 * Approved source and destinations — never operator free text:
 *   the known-good SHA must be the releaseSha of an ALIGNED record written by the release tool
 *   (.wrenkind-local/evidence/trigger-release-pair/), and the three destination projects must be EXACTLY that record's.
 *
 * Order MAIN → INTELLIGENCE → INTEGRATION (the reverse of a release), from the real job dependencies:
 *   - every cross-plane trigger is pinned to the RUNNING release's external id (platform/jobs/release.ts), never to a
 *     plane's "current" version; schedules exist only in MAIN; INTEGRATION and INTELLIGENCE receive work only through
 *     pinned triggers (MAIN's relay and sweepers), and the web nudges only MAIN;
 *   - a release deploys MAIN last because MAIN's NEW external id must already exist in the other planes. A recovery
 *     reuses the known-good external id, under which every plane already holds a deployment (the original ALIGNED one —
 *     checked to still be DEPLOYED before anything starts), so MAIN's recovered runs resolve their pins at once;
 *   - recovering MAIN first therefore routes ALL new MAIN-originated work (schedules, relay, sweepers) to known-good
 *     code in every plane from the first step; INTELLIGENCE (one task, fed only by MAIN) follows; INTEGRATION, the
 *     longest build with the signing-helper image, comes last.
 *
 * A plane is RECOVERED only when: the deploy exited 0 with a new version and exactly the known-good task count; the
 * provider's current worker is that version; its task inventory has the known-good count, no duplicate, and every task
 * in that plane's own task directory; and its content fingerprint equals the recorded known-good one (when recorded —
 * release evidence before schema v3 has none: the operator must accept that explicitly and the final state says so).
 */
import {
  COMMON_SAFETY_FLAGS,
  FORBIDDEN_FLAGS,
  RELEASE_ENVIRONMENT,
  RELEASE_PLANES,
  deployArgv,
  isProjectRef,
  isReleaseSha,
  parseWorkerContentHash,
  type PlaneDefinition,
  type ReleasePlane,
} from "./release-pair.ts";

export const RECOVERY_ORDER: readonly ReleasePlane[] = Object.freeze(["main", "intelligence", "integration"] as const);

/** Where each plane's tasks live (the `dirs` of its trigger config); a task reported elsewhere is a wrong deployment. */
export const PLANE_TASK_DIRECTORIES: Readonly<Record<ReleasePlane, string>> = Object.freeze({
  integration: "jobs/trigger/integration/",
  intelligence: "jobs/trigger/intelligence/",
  main: "jobs/trigger/main/",
});

export const RECOVERY_EVIDENCE_DIRECTORY = ".wrenkind-local/evidence/trigger-recovery";
export const RECOVERY_SCHEMA = "wrenkind.trigger-recovery.v1";
export const RELEASE_TOOL = "tools/trigger/deploy-release-pair.ts";
export const RELEASE_EVIDENCE_SCHEMAS = ["wrenkind.trigger-release-pair.v2", "wrenkind.trigger-release-pair.v3"] as const;

/** The exact phrase an apply needs; it names the known-good commit, so a confirmation never carries over to another. */
export const recoveryConfirmation = (knownGoodSha: string): string => `recover-trigger-planes-to-${knownGoodSha.slice(0, 12)}`;

export class RecoveryPlanError extends Error {
  override readonly name = "RecoveryPlanError";
}

const VERSION = /^\d{8}\.\d+$/;
const CONTENT_HASH = /^[0-9a-f]{32,64}$/;
export const isWorkerVersion = (value: unknown): value is string => typeof value === "string" && VERSION.test(value);

const definitionOf = (plane: ReleasePlane): PlaneDefinition => {
  const definition = RELEASE_PLANES.find((entry) => entry.plane === plane);
  if (definition === undefined) throw new RecoveryPlanError(`unknown plane ${plane}`);
  return definition;
};

// ── The approved known-good release (release-tool evidence) ─────────────────────────────────────────────────

export interface KnownGoodPlane {
  readonly plane: ReleasePlane;
  readonly config: string;
  readonly projectRef: string;
  readonly version: string;
  readonly taskCount: number;
  /** The fingerprint the release recorded (schema v3), or null (schema v2, or unreadable at release time). */
  readonly contentHash: string | null;
}

export interface KnownGoodRelease {
  readonly fileName: string;
  readonly schema: string;
  readonly releaseSha: string;
  readonly finishedAt: string;
  readonly planes: Readonly<Record<ReleasePlane, KnownGoodPlane>>;
}

/** `<ISO timestamp without separators>-<first 12 of the SHA>.json`, a bare file name (no directory, no traversal). */
const EVIDENCE_FILE = /^\d{4}-\d{2}-\d{2}T\d{9}Z-([0-9a-f]{12})\.json$/;
export const isEvidenceFileName = (value: unknown): value is string => typeof value === "string" && EVIDENCE_FILE.test(value);

type Json = Readonly<Record<string, unknown>>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const argValue = (argv: readonly unknown[], flag: string): unknown => {
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : argv[at + 1];
};

/**
 * The known-good release from one release-tool evidence record, or every reason it is not one. Only a record the release
 * tool wrote for a complete, ALIGNED three-plane prod release qualifies; anything partial, ambiguous or malformed is refused.
 */
export function parseReleaseEvidence(fileName: string, raw: string): { readonly ok: true; readonly release: KnownGoodRelease } | { readonly ok: false; readonly problems: readonly string[] } {
  const problems: string[] = [];
  const fileMatch = EVIDENCE_FILE.exec(fileName);
  if (fileMatch === null) return { ok: false, problems: ["the release evidence must be named by its bare file name (<timestamp>-<sha12>.json)"] };
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return { ok: false, problems: ["the release evidence is not JSON"] };
  }
  if (!isObject(record)) return { ok: false, problems: ["the release evidence is not a record"] };
  const schema = record["schema"];
  if (typeof schema !== "string" || !(RELEASE_EVIDENCE_SCHEMAS as readonly string[]).includes(schema)) problems.push("unknown release evidence schema");
  if (record["tool"] !== RELEASE_TOOL) problems.push("the record was not written by the release tool");
  if (record["finalState"] !== "ALIGNED") problems.push("the release was not ALIGNED");
  if (record["environment"] !== RELEASE_ENVIRONMENT) problems.push(`the release environment is not ${RELEASE_ENVIRONMENT}`);
  const releaseSha = record["releaseSha"];
  if (!isReleaseSha(releaseSha)) problems.push("the release SHA is malformed");
  else if (releaseSha.slice(0, 12) !== fileMatch[1]) problems.push("the file name does not match the release SHA");
  if (JSON.stringify(record["planeOrder"]) !== JSON.stringify(RELEASE_PLANES.map((entry) => entry.plane))) problems.push("the plane order is not the release unit's");
  if (record["sameReleaseShaInEveryArgv"] !== true) problems.push("the release SHA was not in every argv");
  if (!Array.isArray(record["planesNotStarted"]) || record["planesNotStarted"].length !== 0) problems.push("a plane was not started");
  const checks = record["identityChecks"];
  if (!Array.isArray(checks) || checks.length !== RELEASE_PLANES.length + 1 || !checks.every((check) => isObject(check) && check["ok"] === true)) problems.push("the git identity checks were not all passed");
  const finishedAt = record["finishedAt"];
  if (typeof finishedAt !== "string" || Number.isNaN(Date.parse(finishedAt))) problems.push("the release finish time is malformed");

  const planes = record["planes"];
  const parsed: Partial<Record<ReleasePlane, KnownGoodPlane>> = {};
  if (!Array.isArray(planes) || planes.length !== RELEASE_PLANES.length) problems.push("the release does not record exactly three planes");
  else {
    RELEASE_PLANES.forEach((definition, index) => {
      const entry: unknown = planes[index];
      const label = definition.plane;
      if (!isObject(entry) || entry["plane"] !== definition.plane || entry["config"] !== definition.config) {
        problems.push(`${label}: not the release unit's plane and config`);
        return;
      }
      const outcome = entry["outcome"];
      const argv = entry["argv"];
      if (!isObject(outcome) || outcome["state"] !== "PASS") {
        problems.push(`${label}: the plane did not PASS`);
        return;
      }
      const version = outcome["version"];
      const taskCount = outcome["taskCount"];
      if (!isWorkerVersion(version)) problems.push(`${label}: version malformed`);
      if (typeof taskCount !== "number" || !Number.isInteger(taskCount) || taskCount < 1) problems.push(`${label}: task count malformed`);
      if (!Array.isArray(argv)) {
        problems.push(`${label}: argv missing`);
        return;
      }
      const projectRef = argValue(argv, "--project-ref");
      if (!isProjectRef(projectRef)) problems.push(`${label}: project ref malformed`);
      if (argValue(argv, "--external-id") !== releaseSha) problems.push(`${label}: the external id is not the release SHA`);
      if (argValue(argv, "--env") !== RELEASE_ENVIRONMENT) problems.push(`${label}: environment is not ${RELEASE_ENVIRONMENT}`);
      if (argValue(argv, "--config") !== definition.config) problems.push(`${label}: config mismatch in argv`);
      const hash = entry["contentHash"];
      let contentHash: string | null = null;
      if (schema === "wrenkind.trigger-release-pair.v3") {
        if (hash !== null && !(typeof hash === "string" && CONTENT_HASH.test(hash))) problems.push(`${label}: content fingerprint malformed`);
        else contentHash = hash;
      } else if (hash !== undefined) problems.push(`${label}: a v2 record cannot carry a content fingerprint`);
      if (isWorkerVersion(version) && typeof taskCount === "number" && isProjectRef(projectRef)) {
        parsed[definition.plane] = Object.freeze({ plane: definition.plane, config: definition.config, projectRef, version, taskCount, contentHash });
      }
    });
  }
  const complete = RELEASE_PLANES.every((definition) => parsed[definition.plane] !== undefined);
  if (complete && new Set(RELEASE_PLANES.map((definition) => parsed[definition.plane]?.projectRef)).size !== RELEASE_PLANES.length) problems.push("the three planes are not three different projects");
  if (problems.length > 0 || !complete || !isReleaseSha(releaseSha) || typeof schema !== "string" || typeof finishedAt !== "string") {
    return { ok: false, problems: problems.length > 0 ? problems : ["the release evidence is incomplete"] };
  }
  const byPlane = parsed as Record<ReleasePlane, KnownGoodPlane>;
  return { ok: true, release: Object.freeze({ fileName, schema, releaseSha, finishedAt, planes: Object.freeze({ ...byPlane }) }) };
}

// ── The recovery plan ───────────────────────────────────────────────────────────────────────────────────────

export interface RecoveryStep {
  readonly plane: ReleasePlane;
  readonly config: string;
  readonly projectRef: string;
  readonly taskDirectory: string;
  /** The known-good release's version on this plane (the original deployment under the known-good external id). */
  readonly knownGoodVersion: string;
  readonly expectedTasks: number;
  readonly baselineContentHash: string | null;
  readonly argv: readonly string[];
}

export interface RecoveryPlan {
  readonly knownGoodSha: string;
  readonly releaseEvidence: string;
  readonly environment: typeof RELEASE_ENVIRONMENT;
  readonly steps: readonly RecoveryStep[];
}

/**
 * The plan: the three planes in recovery order, each redeploying the known-good commit under its own external id to
 * EXACTLY the project the approved release used. The operator's project refs are a cross-check, never a source.
 */
export function buildRecoveryPlan(input: {
  readonly knownGoodSha: unknown;
  readonly release: KnownGoodRelease;
  readonly projectRefs: Readonly<Record<ReleasePlane, unknown>>;
  readonly emptyEnvFile: string;
}): RecoveryPlan {
  if (!isReleaseSha(input.knownGoodSha)) throw new RecoveryPlanError("--known-good must be a full 40-character commit SHA");
  if (input.knownGoodSha !== input.release.releaseSha) throw new RecoveryPlanError("--known-good is not the release SHA of the named ALIGNED release evidence");
  for (const definition of RELEASE_PLANES) {
    const given = input.projectRefs[definition.plane];
    if (!isProjectRef(given)) throw new RecoveryPlanError(`${definition.projectRefFlag} must be a project reference (proj_…)`);
    if (given !== input.release.planes[definition.plane].projectRef) throw new RecoveryPlanError(`${definition.projectRefFlag} is not the ${definition.plane} project of the approved release`);
  }
  if (input.emptyEnvFile.trim() === "") throw new RecoveryPlanError("an empty env file controlled by the tool is required");
  const knownGoodSha = input.knownGoodSha;
  const steps = RECOVERY_ORDER.map((plane): RecoveryStep => {
    const definition = definitionOf(plane);
    const known = input.release.planes[plane];
    return Object.freeze({
      plane,
      config: definition.config,
      projectRef: known.projectRef,
      taskDirectory: PLANE_TASK_DIRECTORIES[plane],
      knownGoodVersion: known.version,
      expectedTasks: known.taskCount,
      baselineContentHash: known.contentHash,
      argv: deployArgv(definition, { projectRef: known.projectRef, releaseSha: knownGoodSha, emptyEnvFile: input.emptyEnvFile }),
    });
  });
  const plan: RecoveryPlan = Object.freeze({ knownGoodSha, releaseEvidence: input.release.fileName, environment: RELEASE_ENVIRONMENT, steps: Object.freeze(steps) });
  assertRecoveryPlanInvariants(plan);
  return plan;
}

/** Re-checked before execution: the recovery order, one known-good external id per argv, prod only, the safety flags. */
export function assertRecoveryPlanInvariants(plan: RecoveryPlan): void {
  const fail = (reason: string): never => {
    throw new RecoveryPlanError(`recovery plan invariant violated: ${reason}`);
  };
  if (!isReleaseSha(plan.knownGoodSha)) fail("known-good SHA");
  if (plan.steps.length !== RECOVERY_ORDER.length) fail("exactly three planes");
  plan.steps.forEach((step, index) => {
    if (step.plane !== RECOVERY_ORDER[index]) fail("plane order is MAIN, INTELLIGENCE, then INTEGRATION");
    const definition = definitionOf(step.plane);
    const value = (flag: string): unknown => argValue(step.argv, flag);
    if (step.argv[0] !== "deploy") fail("argv must start with deploy");
    if (step.config !== definition.config || value("--config") !== definition.config) fail(`${step.plane} config`);
    if (value("--project-ref") !== step.projectRef) fail(`${step.plane} project ref`);
    if (value("--env") !== RELEASE_ENVIRONMENT) fail(`${step.plane} environment`);
    if (value("--external-id") !== plan.knownGoodSha) fail(`${step.plane} external id must be the known-good SHA`);
    if (step.argv.filter((token) => token === "--external-id").length !== 1) fail(`${step.plane} exactly one external id`);
    if (typeof value("--env-file") !== "string" || value("--env-file") === "") fail(`${step.plane} empty env file`);
    for (const flag of COMMON_SAFETY_FLAGS) if (!step.argv.includes(flag)) fail(`${step.plane} missing ${flag}`);
    for (const flag of FORBIDDEN_FLAGS) if (step.argv.includes(flag)) fail(`${step.plane} contains ${flag}`);
    if (step.argv.includes("promote")) fail(`${step.plane} promote is never a recovery`);
  });
  if (new Set(plan.steps.map((step) => step.projectRef)).size !== plan.steps.length) fail("distinct project references");
}

// ── Provider reads (the pinned CLI's own read-only MCP server; text output, parsed strictly) ───────────────

export interface WorkerTask {
  readonly slug: string;
  readonly filePath: string;
}

export interface WorkerInventory {
  readonly version: string;
  readonly sdkVersion: string;
  readonly tasks: readonly WorkerTask[];
}

const CURRENT_WORKER = /^Current worker for prod is (\S+) using (\S+) of the SDK\.$/;
const TASK_HEADER = /^The worker has (\d+) tasks? registered:$/;
const TASK_LINE = /^- (\S+?)(?: \[agent\])? in (\S+)$/;

/** `get_current_worker` → the current prod worker (version, SDK, tasks), or undefined when unreadable or inconsistent. */
export function parseCurrentWorker(text: string): WorkerInventory | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
  const head = CURRENT_WORKER.exec(lines[0] ?? "");
  if (head === null || !isWorkerVersion(head[1])) return undefined;
  const tasks: WorkerTask[] = [];
  const headerAt = lines.findIndex((line) => TASK_HEADER.test(line));
  if (headerAt < 0) return lines.includes("The worker has no tasks registered.") ? { version: head[1], sdkVersion: head[2] ?? "", tasks: [] } : undefined;
  const declared = Number(TASK_HEADER.exec(lines[headerAt] ?? "")?.[1]);
  for (const line of lines.slice(headerAt + 1)) {
    const task = TASK_LINE.exec(line);
    if (task === null) break;
    tasks.push({ slug: task[1] ?? "", filePath: task[2] ?? "" });
  }
  if (tasks.length !== declared) return undefined;
  return { version: head[1], sdkVersion: head[2] ?? "", tasks };
}

export interface DeploymentEntry {
  readonly shortCode: string;
  readonly version: string;
  readonly status: string;
}

const DEPLOY_HEADER = /^Found (\d+) deployments?$/;
const DEPLOY_LINE = /^- (\S+) \| v(\S+) \| ([A-Z_]+) \| /;

/** `list_deploys` → its entries (exactly as many as its header announces), or undefined. */
export function parseDeployList(text: string): { readonly entries: readonly DeploymentEntry[]; readonly morePages: boolean } | undefined {
  const lines = text.split(/\r?\n/);
  const header = DEPLOY_HEADER.exec((lines[0] ?? "").trim());
  if (header === null) return undefined;
  const entries = lines.map((line) => DEPLOY_LINE.exec(line)).filter((match): match is RegExpExecArray => match !== null).map((match) => ({ shortCode: match[1] ?? "", version: match[2] ?? "", status: match[3] ?? "" }));
  if (entries.length !== Number(header[1])) return undefined;
  return { entries, morePages: text.includes("Next page available") };
}

const RUN_HEADER = /^Found (\d+) runs?$/;

/** `list_runs` → how many runs the page holds and whether more exist (a lower bound then), or undefined. */
export function parseRunCount(text: string): { readonly count: number; readonly morePages: boolean } | undefined {
  const header = RUN_HEADER.exec((text.split(/\r?\n/)[0] ?? "").trim());
  return header === null ? undefined : { count: Number(header[1]), morePages: text.includes("Next page available") };
}

/** The run states recorded around a recovery (counts only: identifiers and payloads are never recorded). */
export const QUEUE_SNAPSHOT_STATUSES = ["EXECUTING", "QUEUED", "DELAYED", "PENDING_VERSION", "WAITING"] as const;

/** The deploy-list window that reaches back to the known-good release (whole days, plus margin), as `<n>d`. */
export function deployListPeriod(releaseFinishedAt: string, now: Date): string {
  const days = Math.ceil((now.getTime() - Date.parse(releaseFinishedAt)) / 86_400_000) + 2;
  return `${String(Math.min(Math.max(days, 2), 365))}d`;
}

// ── Verification ────────────────────────────────────────────────────────────────────────────────────────────

/** Inventory problems of a plane's current worker (empty = it is a worker of THIS plane with the known-good count). */
export function inventoryProblems(step: Pick<RecoveryStep, "plane" | "expectedTasks" | "taskDirectory">, worker: WorkerInventory): string[] {
  const problems: string[] = [];
  if (worker.tasks.length !== step.expectedTasks) problems.push(`${step.plane}: ${String(worker.tasks.length)} tasks registered, the known-good release has ${String(step.expectedTasks)}`);
  if (new Set(worker.tasks.map((task) => task.slug)).size !== worker.tasks.length) problems.push(`${step.plane}: duplicate task identifiers`);
  const foreign = worker.tasks.filter((task) => !task.filePath.startsWith(step.taskDirectory));
  if (foreign.length > 0) problems.push(`${step.plane}: ${String(foreign.length)} task(s) outside ${step.taskDirectory} (another plane's code)`);
  return problems;
}

export type FingerprintStatus = "MATCH" | "NO_BASELINE";

export interface PlaneVerification {
  readonly problems: readonly string[];
  readonly contentHash: string | null;
  readonly fingerprint: FingerprintStatus | null;
}

/**
 * After a plane's deploy: the provider's current worker must be the version THIS deploy created (new, not the previous
 * one), with the known-good inventory, and the fingerprint the build reported must equal the recorded known-good one.
 * Without a recorded baseline the fingerprint is recorded but cannot be compared (NO_BASELINE).
 */
export function verifyRecoveredPlane(
  step: Pick<RecoveryStep, "plane" | "expectedTasks" | "taskDirectory" | "baselineContentHash">,
  observed: { readonly versionBefore: string; readonly deployedVersion: string; readonly deployOutput: string; readonly worker: WorkerInventory | undefined },
): PlaneVerification {
  const problems: string[] = [];
  if (observed.deployedVersion === observed.versionBefore) problems.push(`${step.plane}: the deploy reported the previous version ${observed.versionBefore}, not a new one`);
  if (observed.worker === undefined) problems.push(`${step.plane}: the current worker could not be read after the deploy`);
  else {
    if (observed.worker.version !== observed.deployedVersion) problems.push(`${step.plane}: the active version is ${observed.worker.version}, not ${observed.deployedVersion} created by this recovery`);
    problems.push(...inventoryProblems(step, observed.worker));
  }
  const contentHash = parseWorkerContentHash(observed.deployOutput, observed.deployedVersion) ?? null;
  let fingerprint: FingerprintStatus | null = null;
  if (step.baselineContentHash === null) fingerprint = "NO_BASELINE";
  else if (contentHash === null) problems.push(`${step.plane}: the content fingerprint could not be read from the deploy output (the known-good one is recorded)`);
  else if (contentHash !== step.baselineContentHash) problems.push(`${step.plane}: content fingerprint ${contentHash} differs from the known-good ${step.baselineContentHash}`);
  else fingerprint = "MATCH";
  return { problems, contentHash, fingerprint: problems.length === 0 ? fingerprint : null };
}

// ── Runtime, web and database compatibility ─────────────────────────────────────────────────────────────────

/** The deploying CLI must be exactly the Trigger.dev SDK version the known-good commit pins (the release convention). */
export function runtimeProblems(input: { readonly cliVersion: string | undefined; readonly knownGoodSdkVersion: string | undefined; readonly knownGoodNodeEngine: string | undefined }): string[] {
  const problems: string[] = [];
  if (input.knownGoodSdkVersion === undefined || !/^\d+\.\d+\.\d+$/.test(input.knownGoodSdkVersion)) problems.push("the known-good commit does not pin @trigger.dev/sdk to an exact version");
  if (input.cliVersion === undefined) problems.push("the trigger CLI version could not be read");
  else if (input.cliVersion !== input.knownGoodSdkVersion) problems.push(`the trigger CLI is ${input.cliVersion}; the known-good commit pins the SDK at ${input.knownGoodSdkVersion ?? "?"}`);
  if (input.knownGoodNodeEngine !== "22.x") problems.push("the known-good commit does not declare the Node 22 runtime");
  return problems;
}

/** Paths whose difference between two commits can change what the web expects from the workers. */
export const WORKER_CONTRACT_PATHS = ["db/migrations/", "jobs/", "platform/jobs/", "platform/outbox/", "trigger.config.ts", "trigger.integration.config.ts", "trigger.intelligence.config.ts"] as const;

export interface KnownIncompatibility {
  readonly id: string;
  /** Present in the web's commit … */
  readonly webHas: string;
  /** … while absent from the known-good worker's commit. */
  readonly workerLacks: string;
  readonly consequence: string;
}

/**
 * Pairings that are known to break, whatever anyone attests. workflow-0034: the Workflow web lists only conversations that
 * have a work item, in EVERY workspace's Inbox (the Comments allowlist does not gate the classic list); a pre-Workflow
 * worker creates none, so every conversation it ingests disappears from every Inbox. The web must be rolled back first.
 */
export const KNOWN_WORKER_WEB_INCOMPATIBILITIES: readonly KnownIncompatibility[] = Object.freeze([
  Object.freeze({
    id: "workflow-0034",
    webHas: "modules/workflow/persistence/read-store.ts",
    workerLacks: "modules/workflow/persistence/projection-store.ts",
    consequence: "the web lists only conversations with a work item (every workspace's Inbox); this worker creates none, so conversations it ingests vanish from every Inbox",
  }),
]);

export type CommitRelation = "equal" | "web_older" | "web_newer" | "unrelated";

export type WebVerdict =
  | { readonly kind: "COMPATIBLE"; readonly reason: string }
  | { readonly kind: "COMPATIBLE_ATTESTED"; readonly reason: string }
  | { readonly kind: "REQUIRES_WEB_ROLLBACK"; readonly reasons: readonly string[] }
  | { readonly kind: "REFUSED"; readonly reason: string };

/** The exact attestation value for a web/worker pairing that was already in service together. */
export const provenPairingValue = (webSha: string, knownGoodSha: string): string => `${webSha}:${knownGoodSha}`;

/**
 * Whether the in-service web may run beside the recovered worker. A known incompatibility always requires a web rollback
 * first. A web at or before the worker commit is compatible (workers are released before webs). A newer web is compatible
 * when nothing in the worker contract paths changed; otherwise only an operator attestation that this EXACT pairing was
 * already in service (e.g. today's web 97dcaee beside worker ff5269c) admits it — else the web is rolled back first.
 */
export function assessWebCompatibility(input: {
  readonly webSha: string;
  readonly knownGoodSha: string;
  readonly relation: CommitRelation;
  readonly changedContractPaths: readonly string[];
  readonly pathExists: (sha: string, path: string) => boolean;
  readonly provenPairing: string | undefined;
}): WebVerdict {
  if (!isReleaseSha(input.webSha)) return { kind: "REFUSED", reason: "--web-release must be the full commit SHA of the in-service web deployment" };
  if (input.relation === "unrelated") return { kind: "REFUSED", reason: "the web commit and the known-good commit are not on one line of history" };
  const broken = KNOWN_WORKER_WEB_INCOMPATIBILITIES.filter((rule) => input.pathExists(input.webSha, rule.webHas) && !input.pathExists(input.knownGoodSha, rule.workerLacks));
  if (broken.length > 0) return { kind: "REQUIRES_WEB_ROLLBACK", reasons: broken.map((rule) => `${rule.id}: ${rule.consequence}`) };
  if (input.relation === "equal" || input.relation === "web_older") return { kind: "COMPATIBLE", reason: "the web is at or before the known-good worker commit" };
  if (input.changedContractPaths.length === 0) return { kind: "COMPATIBLE", reason: "the web is newer, with no change in the worker contract paths" };
  if (input.provenPairing === provenPairingValue(input.webSha, input.knownGoodSha)) {
    return { kind: "COMPATIBLE_ATTESTED", reason: `the operator attests this exact web/worker pairing was in service together (${String(input.changedContractPaths.length)} contract path(s) differ)` };
  }
  return {
    kind: "REQUIRES_WEB_ROLLBACK",
    reasons: [`the web is newer and ${String(input.changedContractPaths.length)} worker contract path(s) differ (${input.changedContractPaths.slice(0, 5).join(", ")}${input.changedContractPaths.length > 5 ? ", …" : ""}); roll the web back, or attest a proven pairing with --proven-web-pairing ${provenPairingValue(input.webSha, input.knownGoodSha)}`],
  };
}

/** Migrations in `newer` that the known-good commit does not have: possibly applied already; the old worker predates them. */
export function migrationsAfter(knownGood: readonly string[], newer: readonly string[]): readonly string[] {
  const known = new Set(knownGood);
  return newer.filter((name) => /^db\/migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(name) && !known.has(name)).sort();
}

// ── Continuation of an interrupted or stopped recovery ──────────────────────────────────────────────────────

export const PLANE_RECOVERY_STATES = ["RECOVERED", "ALREADY_RECOVERED", "DEPLOY_FAILED", "DEPLOY_UNKNOWN", "VERIFICATION_FAILED", "UNEXPECTED_ACTIVE_VERSION", "NOT_STARTED"] as const;
export type PlaneRecoveryState = (typeof PLANE_RECOVERY_STATES)[number];
const DONE: readonly PlaneRecoveryState[] = ["RECOVERED", "ALREADY_RECOVERED"];

export const RECOVERY_FINAL_STATES = ["RECOVERED", "RECOVERED_FINGERPRINT_UNVERIFIED", "STOPPED_PARTIAL", "STOPPED_NOTHING_RECOVERED"] as const;
export type RecoveryFinalState = (typeof RECOVERY_FINAL_STATES)[number];

export interface PriorPlane {
  readonly plane: ReleasePlane;
  readonly state: PlaneRecoveryState;
  readonly resultingVersion: string | null;
  readonly fingerprint: FingerprintStatus | null;
}

export interface PriorRecovery {
  readonly fileName: string;
  readonly knownGoodSha: string;
  readonly releaseEvidence: string;
  readonly projectRefs: Readonly<Record<ReleasePlane, string>>;
  readonly finalState: RecoveryFinalState;
  readonly planes: Readonly<Record<ReleasePlane, PriorPlane>>;
}

/** A previous recovery record this run may continue, or why not. Only an unfinished recovery of the SAME source and projects. */
export function parseRecoveryEvidence(fileName: string, raw: string, plan: RecoveryPlan): { readonly ok: true; readonly prior: PriorRecovery } | { readonly ok: false; readonly problems: readonly string[] } {
  if (!isEvidenceFileName(fileName)) return { ok: false, problems: ["--continue must name a recovery record by its bare file name"] };
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return { ok: false, problems: ["the recovery record is not JSON"] };
  }
  if (!isObject(record) || record["schema"] !== RECOVERY_SCHEMA) return { ok: false, problems: ["not a recovery record"] };
  const problems: string[] = [];
  if (record["knownGoodSha"] !== plan.knownGoodSha) problems.push("the recovery record is for another known-good commit");
  if (record["releaseEvidence"] !== plan.releaseEvidence) problems.push("the recovery record names other release evidence");
  const finalState = record["finalState"];
  if (finalState === "RECOVERED" || finalState === "RECOVERED_FINGERPRINT_UNVERIFIED") problems.push("that recovery already completed; there is nothing to continue");
  else if (finalState !== "STOPPED_PARTIAL" && finalState !== "STOPPED_NOTHING_RECOVERED") problems.push("the recovery record has no valid final state");
  const planes = record["planes"];
  const refs: Partial<Record<ReleasePlane, string>> = {};
  const parsed: Partial<Record<ReleasePlane, PriorPlane>> = {};
  if (!Array.isArray(planes) || planes.length !== RECOVERY_ORDER.length) problems.push("the recovery record does not hold three planes");
  else {
    RECOVERY_ORDER.forEach((plane, index) => {
      const entry: unknown = planes[index];
      const step = plan.steps[index];
      if (!isObject(entry) || entry["plane"] !== plane || step === undefined) {
        problems.push(`${plane}: not in recovery order`);
        return;
      }
      if (entry["projectRef"] !== step.projectRef) problems.push(`${plane}: the record names another project`);
      else refs[plane] = step.projectRef;
      const state = entry["state"];
      const resulting = entry["resultingVersion"];
      const fingerprint = entry["fingerprint"];
      if (typeof state !== "string" || !(PLANE_RECOVERY_STATES as readonly string[]).includes(state)) {
        problems.push(`${plane}: unknown state`);
        return;
      }
      const done = DONE.includes(state as PlaneRecoveryState);
      if (done && !isWorkerVersion(resulting)) problems.push(`${plane}: a recovered plane must record its resulting version`);
      if (done && fingerprint !== "MATCH" && fingerprint !== "NO_BASELINE") problems.push(`${plane}: a recovered plane must record its fingerprint status`);
      parsed[plane] = {
        plane,
        state: state as PlaneRecoveryState,
        resultingVersion: done && isWorkerVersion(resulting) ? resulting : null,
        fingerprint: done && (fingerprint === "MATCH" || fingerprint === "NO_BASELINE") ? fingerprint : null,
      };
    });
  }
  const complete = RECOVERY_ORDER.every((plane) => parsed[plane] !== undefined && refs[plane] !== undefined);
  if (problems.length > 0 || !complete) return { ok: false, problems: problems.length > 0 ? problems : ["the recovery record is incomplete"] };
  return {
    ok: true,
    prior: {
      fileName,
      knownGoodSha: plan.knownGoodSha,
      releaseEvidence: plan.releaseEvidence,
      projectRefs: refs as Record<ReleasePlane, string>,
      finalState: finalState as RecoveryFinalState,
      planes: parsed as Record<ReleasePlane, PriorPlane>,
    },
  };
}

export type PlaneIntent =
  | { readonly plane: ReleasePlane; readonly mode: "deploy"; readonly expectedBefore: string }
  | { readonly plane: ReleasePlane; readonly mode: "verify_recovered"; readonly recoveredVersion: string; readonly fingerprint: FingerprintStatus };

/**
 * What each plane will do, from the operator's expected current versions (copied from the plan) and an optional prior
 * record. A plane the prior record verified as recovered is only re-verified (its recorded version must still be active);
 * every other plane is deployed, and only from the exact active version the operator expects. Missing or contradictory
 * expectations are problems: nothing is guessed.
 */
export function resolvePlaneIntents(
  plan: RecoveryPlan,
  expectations: Readonly<Partial<Record<ReleasePlane, string>>>,
  prior: PriorRecovery | undefined,
): { readonly ok: true; readonly intents: readonly PlaneIntent[] } | { readonly ok: false; readonly problems: readonly string[] } {
  const problems: string[] = [];
  const intents: PlaneIntent[] = [];
  for (const step of plan.steps) {
    const expected = expectations[step.plane];
    const before = prior?.planes[step.plane];
    if (before !== undefined && DONE.includes(before.state) && before.resultingVersion !== null && before.fingerprint !== null) {
      if (expected !== undefined && expected !== before.resultingVersion) problems.push(`--expect-${step.plane}-version ${expected} contradicts the recorded recovered version ${before.resultingVersion}`);
      intents.push({ plane: step.plane, mode: "verify_recovered", recoveredVersion: before.resultingVersion, fingerprint: before.fingerprint });
      continue;
    }
    if (expected === undefined) problems.push(`--expect-${step.plane}-version is required (the active version shown by the plan)`);
    else if (!isWorkerVersion(expected)) problems.push(`--expect-${step.plane}-version must be a worker version (YYYYMMDD.N)`);
    else intents.push({ plane: step.plane, mode: "deploy", expectedBefore: expected });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, intents };
}

/** The final state: complete only when EVERY plane is recovered; any other mix is a stop, never a success. */
export function recoveryOutcome(planes: readonly { readonly plane: ReleasePlane; readonly state: PlaneRecoveryState; readonly fingerprint: FingerprintStatus | null }[]): {
  readonly finalState: RecoveryFinalState;
  readonly recoveredPlanes: readonly ReleasePlane[];
  readonly unrecoveredPlanes: readonly ReleasePlane[];
} {
  const recoveredPlanes = RECOVERY_ORDER.filter((plane) => planes.some((entry) => entry.plane === plane && DONE.includes(entry.state)));
  const unrecoveredPlanes = RECOVERY_ORDER.filter((plane) => !recoveredPlanes.includes(plane));
  if (unrecoveredPlanes.length > 0) return { finalState: recoveredPlanes.length > 0 ? "STOPPED_PARTIAL" : "STOPPED_NOTHING_RECOVERED", recoveredPlanes, unrecoveredPlanes };
  const unverified = planes.some((entry) => entry.fingerprint !== "MATCH");
  return { finalState: unverified ? "RECOVERED_FINGERPRINT_UNVERIFIED" : "RECOVERED", recoveredPlanes, unrecoveredPlanes };
}
