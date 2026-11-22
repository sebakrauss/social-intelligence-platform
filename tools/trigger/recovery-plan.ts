/**
 * RECOVERY-TOOLING-01 / RECOVERY-TOOLING-02 — the guarded three-plane Trigger.dev FORWARD RECOVERY: PURE planning,
 * parsing and verification for tools/trigger/recover-release.ts. No I/O, no process, no network, no Trigger.dev SDK.
 *
 * Mechanism (proven in TRIGGER-RECOVERY-REHEARSAL-02): an older version is never promoted (the server refuses it).
 * Recovery redeploys the source of a previously ALIGNED release — the approved known-good commit — to every plane as a
 * NEW version, with the release unit's deploy argv (tools/trigger/release-pair.ts `deployArgv`: prod, ONE external id, the
 * tool's empty env file, the safety flags). A failed deploy leaves that plane on its previous version (verified).
 *
 * Two identities (RECOVERY-TOOLING-02, after RECOVERY-REHEARSAL-03B):
 *   - the SOURCE is the known-good commit SHA: immutable, checked against the ALIGNED release record, the detached
 *     worktree and origin/main — never replaced;
 *   - the DEPLOYMENT identity is a RECOVERY ID `recovery-<sha12>-<UTC yyyymmddThhmmssZ>`, unique to one explicitly
 *     approved recovery attempt and shared by its three planes. It can never be the known-good SHA: Trigger.dev never
 *     rebuilds an external id that is already deployed — the CLI answers "Version … was already deployed for
 *     --external-id … — nothing to build", exits 0 and leaves the plane as it was (RECOVERY-REHEARSAL-03B), and every
 *     plane already holds the known-good release's own deployment under that SHA. `--force` is never used.
 *
 * Approved source and destinations — never operator free text:
 *   the known-good SHA must be the releaseSha of an ALIGNED record written by the release tool
 *   (.wrenkind-local/evidence/trigger-release-pair/), and the three destination projects must be EXACTLY that record's.
 *
 * Order INTEGRATION → INTELLIGENCE → MAIN (the release order), from the real job dependencies:
 *   - a running worker pins every trigger into another plane to ITS OWN deployment's external id
 *     (ctx.deployment.externalId → platform/jobs/release.ts `crossPlanePin`), never to a plane's current version;
 *   - MAIN triggers INTEGRATION and INTELLIGENCE; INTEGRATION wakes MAIN's relay; INTELLIGENCE triggers nothing; schedules
 *     exist only in MAIN; the web nudges only MAIN (unpinned, or pinned by TRIGGER_EXTERNAL_DEPLOYMENT_ID);
 *   - so INTEGRATION and INTELLIGENCE receive work only through pins. Recovered under the recovery id, they get none
 *     until MAIN runs it: while MAIN is still on the release being recovered from, its triggers stay pinned to that
 *     release (a partial recovery changes no behaviour); once MAIN is recovered LAST, its pins name the recovery id, which
 *     already exists in both other planes, so nothing waits for a missing deployment.
 *
 * A plane is RECOVERED only when: the deploy created a new version with exactly the known-good task count (or, in an
 * explicit continuation, the provider confirms that the plane's CURRENT deployment already holds this attempt's recovery
 * id after an interrupted deploy); the provider's current worker is that version; its task inventory has the known-good
 * count, no duplicate, and every task in that plane's own task directory; and its content fingerprint equals the
 * recorded known-good one (when recorded — release evidence before schema v3 has none: the operator must accept that
 * explicitly and the final state says so). A zero exit that created nothing is never a recovery.
 */
import {
  COMMON_SAFETY_FLAGS,
  FORBIDDEN_FLAGS,
  RELEASE_ENVIRONMENT,
  RELEASE_PLANES,
  deployArgv,
  evaluatePlaneResult,
  isProjectRef,
  isReleaseSha,
  parseDeployOutput,
  parseWorkerContentHash,
  type PlaneDefinition,
  type PlaneOutcome,
  type ReleasePlane,
} from "./release-pair.ts";

export const RECOVERY_ORDER: readonly ReleasePlane[] = Object.freeze(["integration", "intelligence", "main"] as const);

/** Where each plane's tasks live (the `dirs` of its trigger config); a task reported elsewhere is a wrong deployment. */
export const PLANE_TASK_DIRECTORIES: Readonly<Record<ReleasePlane, string>> = Object.freeze({
  integration: "jobs/trigger/integration/",
  intelligence: "jobs/trigger/intelligence/",
  main: "jobs/trigger/main/",
});

export const RECOVERY_EVIDENCE_DIRECTORY = ".wrenkind-local/evidence/trigger-recovery";
export const RECOVERY_SCHEMA = "wrenkind.trigger-recovery.v2";
/** RECOVERY-TOOLING-01 records: deployed under the known-good SHA (never rebuilt by the provider); readable, never continued. */
export const LEGACY_RECOVERY_SCHEMA = "wrenkind.trigger-recovery.v1";
export const RELEASE_TOOL = "tools/trigger/deploy-release-pair.ts";
export const RELEASE_EVIDENCE_SCHEMAS = ["wrenkind.trigger-release-pair.v2", "wrenkind.trigger-release-pair.v3"] as const;

/** The exact phrase an apply needs; it names the known-good commit, so a confirmation never carries over to another. */
export const recoveryConfirmation = (knownGoodSha: string): string => `recover-trigger-planes-to-${knownGoodSha.slice(0, 12)}`;

export class RecoveryPlanError extends Error {
  override readonly name = "RecoveryPlanError";
}

// ── The recovery deployment identity (RECOVERY-TOOLING-02) ──────────────────────────────────────────────────

/** `recovery-<first 12 of the known-good SHA>-<UTC yyyymmddThhmmssZ>`: never a commit SHA, always bound to its source. */
const RECOVERY_ID = /^recovery-([0-9a-f]{12})-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
/** How far a recovery id's time may lie ahead of the operator's clock (clock skew only; a future id is never valid). */
export const RECOVERY_ID_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const isRecoveryIdFormat = (value: unknown): value is string => typeof value === "string" && RECOVERY_ID.test(value);

/** A NEW recovery id for one attempt, minted only by a fresh plan (never by a continuation). */
export function proposeRecoveryId(knownGoodSha: string, now: Date): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
  return `recovery-${knownGoodSha.slice(0, 12)}-${stamp}`;
}

/** Why `id` cannot name a recovery attempt of `knownGoodSha` at `now` (empty = well-formed, bound and not in the future). */
export function recoveryIdProblems(id: unknown, knownGoodSha: string, now: Date): string[] {
  if (typeof id !== "string") return ["the recovery id is missing"];
  const match = RECOVERY_ID.exec(id);
  if (match === null) return ["the recovery id must be recovery-<first 12 of the known-good SHA>-<UTC yyyymmddThhmmssZ> (as the plan proposes it)"];
  const problems: string[] = [];
  if (id === knownGoodSha || isReleaseSha(id)) problems.push("the recovery id can never be a commit SHA");
  if (match[1] !== knownGoodSha.slice(0, 12)) problems.push("the recovery id names another known-good commit");
  const [, , year, month, day, hour, minute, second] = match;
  const at = Date.parse(`${year ?? ""}-${month ?? ""}-${day ?? ""}T${hour ?? ""}:${minute ?? ""}:${second ?? ""}Z`);
  if (Number.isNaN(at) || new Date(at).toISOString().slice(0, 19) !== `${year ?? ""}-${month ?? ""}-${day ?? ""}T${hour ?? ""}:${minute ?? ""}:${second ?? ""}`) problems.push("the recovery id's time is not a valid UTC time");
  else if (at > now.getTime() + RECOVERY_ID_CLOCK_SKEW_MS) problems.push("the recovery id's time lies in the future");
  return problems;
}

/** Where a recovery id already appears in local evidence (release or recovery records). */
export interface RecoveryIdUse {
  readonly fileName: string;
  readonly kind: "release" | "recovery";
  readonly finalState: string | null;
}

export type RecoveryIdentity =
  | { readonly kind: "NEW"; readonly recoveryId: string; readonly proposed: boolean }
  | { readonly kind: "CONTINUES"; readonly recoveryId: string; readonly fileName: string }
  | { readonly kind: "REFUSED"; readonly recoveryId: string; readonly reason: string };

/**
 * The deployment identity of this run. A continuation uses the continued record's recovery id — never a new one, never
 * another — and only from the LATEST record of that attempt. A fresh run uses the operator's id (or, PLAN ONLY, a new
 * proposed one), which no local release or recovery record may already use: an id used by a completed recovery is
 * spent, and one used by an unfinished attempt is continued explicitly or replaced by a new attempt, never re-entered
 * fresh. (The provider's own external ids are not readable with the read-only tooling; a deploy under an id the provider
 * already holds builds nothing and is classified as RECOVERY_ID_IN_USE — the plane is left as it was.)
 */
export function assessRecoveryIdentity(input: {
  readonly knownGoodSha: string;
  readonly given: string | undefined;
  readonly proposed: string;
  readonly prior: Pick<PriorRecovery, "fileName" | "recoveryId"> | undefined;
  readonly uses: (recoveryId: string) => readonly RecoveryIdUse[];
  readonly now: Date;
}): RecoveryIdentity {
  const prior = input.prior;
  if (prior !== undefined) {
    const recoveryId = prior.recoveryId;
    if (input.given !== undefined && input.given !== recoveryId) return { kind: "REFUSED", recoveryId, reason: `--recovery-id ${input.given} is not the recovery id of the continued attempt (${recoveryId}); a continuation never changes it` };
    const uses = input.uses(recoveryId);
    const completed = uses.find((use) => use.kind === "recovery" && (use.finalState === "RECOVERED" || use.finalState === "RECOVERED_FINGERPRINT_UNVERIFIED"));
    if (completed !== undefined) return { kind: "REFUSED", recoveryId, reason: `recovery id ${recoveryId} was already used by a completed recovery (${completed.fileName})` };
    if (uses.some((use) => use.kind === "release")) return { kind: "REFUSED", recoveryId, reason: `recovery id ${recoveryId} appears in a release record` };
    const later = uses.filter((use) => use.fileName > prior.fileName).map((use) => use.fileName).sort();
    if (later.length > 0) return { kind: "REFUSED", recoveryId, reason: `a later record of this recovery attempt exists: continue ${later.at(-1) ?? ""} instead` };
    return { kind: "CONTINUES", recoveryId, fileName: prior.fileName };
  }
  const recoveryId = input.given ?? input.proposed;
  const problems = recoveryIdProblems(recoveryId, input.knownGoodSha, input.now);
  if (problems.length > 0) return { kind: "REFUSED", recoveryId, reason: problems.join("; ") };
  const uses = input.uses(recoveryId);
  const completed = uses.find((use) => use.kind === "recovery" && (use.finalState === "RECOVERED" || use.finalState === "RECOVERED_FINGERPRINT_UNVERIFIED"));
  if (completed !== undefined) return { kind: "REFUSED", recoveryId, reason: `recovery id ${recoveryId} was already used by a completed recovery (${completed.fileName}); a new attempt needs a new id` };
  if (uses.length > 0) {
    const latest = uses.map((use) => use.fileName).sort().at(-1) ?? "";
    return { kind: "REFUSED", recoveryId, reason: `recovery id ${recoveryId} belongs to an earlier, unfinished attempt (${latest}): continue it with --continue ${latest}, or start a new attempt with a new id` };
  }
  return { kind: "NEW", recoveryId, proposed: input.given === undefined };
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
  /** The immutable source: the known-good commit (worktree HEAD, release record, origin/main ancestry). */
  readonly knownGoodSha: string;
  /** The deployment identity: the ONE external id of every recovered plane (never the known-good SHA). */
  readonly recoveryId: string;
  readonly releaseEvidence: string;
  readonly environment: typeof RELEASE_ENVIRONMENT;
  readonly steps: readonly RecoveryStep[];
}

/**
 * The plan: the three planes in recovery order, each redeploying the known-good commit under the attempt's recovery id
 * to EXACTLY the project the approved release used. The operator's project refs are a cross-check, never a source.
 */
export function buildRecoveryPlan(input: {
  readonly knownGoodSha: unknown;
  readonly recoveryId: unknown;
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
  if (!isRecoveryIdFormat(input.recoveryId) || input.recoveryId.slice("recovery-".length, "recovery-".length + 12) !== knownGoodSha.slice(0, 12)) {
    throw new RecoveryPlanError("the recovery id must be recovery-<first 12 of the known-good SHA>-<UTC time>");
  }
  const recoveryId = input.recoveryId;
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
      // The release unit's argv, with the recovery id as its ONE external id (the source is the worktree at the known-good SHA).
      argv: deployArgv(definition, { projectRef: known.projectRef, releaseSha: recoveryId, emptyEnvFile: input.emptyEnvFile }),
    });
  });
  const plan: RecoveryPlan = Object.freeze({ knownGoodSha, recoveryId, releaseEvidence: input.release.fileName, environment: RELEASE_ENVIRONMENT, steps: Object.freeze(steps) });
  assertRecoveryPlanInvariants(plan);
  return plan;
}

/** Re-checked before execution: the recovery order, the recovery id as the one external id (never a SHA), prod only, the safety flags. */
export function assertRecoveryPlanInvariants(plan: RecoveryPlan): void {
  const fail = (reason: string): never => {
    throw new RecoveryPlanError(`recovery plan invariant violated: ${reason}`);
  };
  if (!isReleaseSha(plan.knownGoodSha)) fail("known-good SHA");
  if (!isRecoveryIdFormat(plan.recoveryId) || isReleaseSha(plan.recoveryId) || plan.recoveryId === plan.knownGoodSha) fail("the recovery id must be a recovery id, never a commit SHA");
  if (plan.recoveryId.slice("recovery-".length, "recovery-".length + 12) !== plan.knownGoodSha.slice(0, 12)) fail("the recovery id must name the known-good commit");
  if (plan.steps.length !== RECOVERY_ORDER.length) fail("exactly three planes");
  plan.steps.forEach((step, index) => {
    if (step.plane !== RECOVERY_ORDER[index]) fail("plane order is INTEGRATION, INTELLIGENCE, then MAIN");
    const definition = definitionOf(step.plane);
    const value = (flag: string): unknown => argValue(step.argv, flag);
    if (step.argv[0] !== "deploy") fail("argv must start with deploy");
    if (step.config !== definition.config || value("--config") !== definition.config) fail(`${step.plane} config`);
    if (value("--project-ref") !== step.projectRef) fail(`${step.plane} project ref`);
    if (value("--env") !== RELEASE_ENVIRONMENT) fail(`${step.plane} environment`);
    if (value("--external-id") !== plan.recoveryId) fail(`${step.plane} external id must be the recovery id (never the known-good SHA, which the provider never rebuilds)`);
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

// ── Remote deployments in progress (RECOVERY-TOOLING-03, after RECOVERY-REHEARSAL-03C finding G1) ──────────────
/*
 * An interrupted CLI does not cancel its server-side deployment: in 03C the provider kept the interrupted INTELLIGENCE
 * build BUILDING for ~15 minutes (then TIMED_OUT) while the plane's current worker looked healthy and unchanged. A
 * recovery must never start or continue a deploy while ANY deployment of an approved destination project is unresolved:
 * it could still build, become current or race a second deployment, and the read-only interface does not reliably say
 * which external id it holds. So every listed deployment counts, current worker or not.
 */

/** Statuses of a deployment that may still build, deploy or become the current deployment (trigger.dev 4.7.2 deployment schemas). */
export const IN_PROGRESS_DEPLOYMENT_STATUSES = ["PENDING", "INSTALLING", "BUILDING", "DEPLOYING"] as const;
/** Terminal statuses: the provider changes them no further. Only DEPLOYED ever became a worker. */
export const TERMINAL_DEPLOYMENT_STATUSES = ["DEPLOYED", "FAILED", "CANCELED", "TIMED_OUT"] as const;

export type DeploymentActivity =
  /** Every listed deployment is terminal and the listing is complete for the window. `unsuccessful`: terminal, never a worker, newer than the active version. */
  | { readonly kind: "CLEAR"; readonly listed: number; readonly unsuccessful: readonly DeploymentEntry[] }
  /** At least one deployment is in progress, or in a status this tool does not know (treated as in progress). */
  | { readonly kind: "UNRESOLVED"; readonly inProgress: readonly DeploymentEntry[]; readonly unrecognized: readonly DeploymentEntry[] }
  /** The listing could not be read or parsed: the absence of an in-progress deployment is not established. */
  | { readonly kind: "UNREADABLE" }
  /** The listing has more pages than were read: the absence of an in-progress deployment is not established. */
  | { readonly kind: "INCOMPLETE"; readonly listed: number };

const versionKey = (version: string): readonly [number, number] => {
  const [day, build] = version.split(".");
  return [Number(day), Number(build)];
};
/** True when worker version `a` is newer than `b` (both YYYYMMDD.N). */
export const isNewerVersion = (a: string, b: string): boolean => {
  const [dayA, buildA] = versionKey(a);
  const [dayB, buildB] = versionKey(b);
  return dayA > dayB || (dayA === dayB && buildA > buildB);
};

/**
 * One project's deployment activity from its `list_deploys` result (undefined = unreadable). Fails closed: an unknown
 * status is unresolved, an unreadable or truncated listing never means "no deployment in progress", and a healthy
 * current worker proves nothing about other deployments.
 */
export function assessDeploymentActivity(list: { readonly entries: readonly DeploymentEntry[]; readonly morePages: boolean } | undefined, activeVersion: string | undefined): DeploymentActivity {
  if (list === undefined) return { kind: "UNREADABLE" };
  const inProgress = list.entries.filter((entry) => (IN_PROGRESS_DEPLOYMENT_STATUSES as readonly string[]).includes(entry.status));
  const known = [...IN_PROGRESS_DEPLOYMENT_STATUSES, ...TERMINAL_DEPLOYMENT_STATUSES] as readonly string[];
  const unrecognized = list.entries.filter((entry) => !known.includes(entry.status));
  if (inProgress.length > 0 || unrecognized.length > 0) return { kind: "UNRESOLVED", inProgress, unrecognized };
  if (list.morePages) return { kind: "INCOMPLETE", listed: list.entries.length };
  const unsuccessful = list.entries.filter((entry) => entry.status !== "DEPLOYED" && (activeVersion === undefined || !isWorkerVersion(entry.version) || !isWorkerVersion(activeVersion) || isNewerVersion(entry.version, activeVersion)));
  return { kind: "CLEAR", listed: list.entries.length, unsuccessful };
}

const describeDeployment = (entry: DeploymentEntry): string => `${entry.shortCode} v${entry.version} ${entry.status}`;

/** Why a recovery cannot proceed on this project now, or undefined when its deployment activity is CLEAR. */
export function deploymentActivityBlocker(plane: ReleasePlane, projectRef: string, activity: DeploymentActivity): string | undefined {
  const where = `${plane}: project ${projectRef}`;
  const action = "recovery cannot proceed while a remote deployment is unresolved (an interrupted CLI does not cancel it; it may still build, become the current deployment or race a new deploy). Inspect it and wait for a terminal outcome (DEPLOYED, FAILED, CANCELED or TIMED_OUT), then plan again with fresh metadata; never cancel or force it from this tool";
  if (activity.kind === "UNRESOLVED") {
    const parts = [
      ...activity.inProgress.map((entry) => `deployment ${describeDeployment(entry)} is NOT terminal`),
      ...activity.unrecognized.map((entry) => `deployment ${describeDeployment(entry)} has a status this tool does not recognize (treated as in progress)`),
    ];
    return `${where}: ${parts.join("; ")} — ${action}`;
  }
  const unestablished = "recovery cannot proceed until the provider's deployments can be read completely and none is in progress; inspect the project's deployments (read-only), wait for every one to be terminal, then plan again with fresh metadata";
  if (activity.kind === "UNREADABLE") return `${where}: the deployment list could not be read; the absence of an in-progress deployment is not established — ${unestablished}`;
  if (activity.kind === "INCOMPLETE") return `${where}: the deployment list is truncated (${String(activity.listed)} listed, more pages exist); the absence of an in-progress deployment is not established — ${unestablished}`;
  return undefined;
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

// ── The deploy's answer, classified (RECOVERY-TOOLING-02) ──────────────────────────────────────────────────

const ANSI_CODES = /\x1b\[[0-9;?]*[A-Za-z]/g;
const EXISTING_DEPLOYMENT = /Version (\d{8}\.\d+) was already deployed for --external-id (\S+) [—–-]+ nothing to build/g;
const NOT_CURRENT = /This version is not the current deployment/;
const WORKER_CREATED_ANY = /"message":"Background worker created"[^\n]*?"createResponse":\{[^{}]*?"version":"(\d{8}\.\d+)"[^{}]*?"contentHash":"([0-9a-f]{32,64})"/g;

export type RecoveryDeployOutcome =
  | PlaneOutcome
  /** The provider already holds a deployment under this external id: NOTHING was built (exit 0). `current`: it is the active one. */
  | { readonly state: "EXISTING"; readonly version: string; readonly externalId: string; readonly current: boolean };

/**
 * A recovery deploy's outcome. Interrupt and timeout are UNKNOWN; a non-zero exit is FAILED; the provider's "already
 * deployed … nothing to build" answer (exit 0) is EXISTING — never a PASS; otherwise the release unit's own verdict (PASS
 * only with a parseable new version and exactly the expected task count). An answer that is both is UNKNOWN.
 */
export function classifyRecoveryDeploy(step: Pick<RecoveryStep, "expectedTasks">, result: { readonly exitCode: number | null; readonly output: string; readonly timedOut: boolean; readonly interrupted: boolean }): RecoveryDeployOutcome {
  if (result.interrupted) return { state: "UNKNOWN", reason: "interrupted" };
  if (result.timedOut) return { state: "UNKNOWN", reason: "timeout" };
  if (result.exitCode !== 0) return { state: "FAILED", reason: "exit_code" };
  const text = result.output.replace(ANSI_CODES, "");
  const existing = [...text.matchAll(EXISTING_DEPLOYMENT)].map((match) => ({ version: match[1] ?? "", externalId: match[2] ?? "" }));
  if (existing.length > 0) {
    const distinct = new Set(existing.map((entry) => `${entry.version}/${entry.externalId}`));
    const [first] = existing;
    if (distinct.size !== 1 || first === undefined || parseDeployOutput(text) !== undefined) return { state: "UNKNOWN", reason: "unreadable_output" };
    return { state: "EXISTING", version: first.version, externalId: first.externalId, current: !NOT_CURRENT.test(text) };
  }
  return evaluatePlaneResult(step, result);
}

/** Every (version, fingerprint) a deploy's build log reported — kept for a deploy whose own outcome is not known. */
export function parseWorkerCreations(output: string): readonly { readonly version: string; readonly contentHash: string }[] {
  const seen = new Map<string, { version: string; contentHash: string }>();
  for (const match of output.replace(ANSI_CODES, "").matchAll(WORKER_CREATED_ANY)) {
    const entry = { version: match[1] ?? "", contentHash: match[2] ?? "" };
    seen.set(`${entry.version}/${entry.contentHash}`, entry);
  }
  return [...seen.values()];
}

/**
 * A continuation's deploy under the SAME recovery id answered EXISTING for a plane whose previous deploy (this attempt's,
 * recorded) had no known outcome: the provider itself states which version holds the recovery id. It is adopted only
 * when that version is the CURRENT one, the provider's current worker is it with the known-good inventory, and its
 * fingerprint — observed in the interrupted deploy's own build log — equals the baseline (when one is recorded).
 */
export function verifyConfirmedDeployment(
  step: Pick<RecoveryStep, "plane" | "expectedTasks" | "taskDirectory" | "baselineContentHash">,
  observed: { readonly existingVersion: string; readonly current: boolean; readonly worker: WorkerInventory | undefined; readonly observedWorkers: readonly { readonly version: string; readonly contentHash: string }[] },
): PlaneVerification {
  const problems: string[] = [];
  if (!observed.current) problems.push(`${step.plane}: the deployment holding the recovery id (${observed.existingVersion}) is not the current one`);
  if (observed.worker === undefined) problems.push(`${step.plane}: the current worker could not be read`);
  else {
    if (observed.worker.version !== observed.existingVersion) problems.push(`${step.plane}: the active version is ${observed.worker.version}, not ${observed.existingVersion} that holds the recovery id`);
    problems.push(...inventoryProblems(step, observed.worker));
  }
  const hashes = new Set(observed.observedWorkers.filter((entry) => entry.version === observed.existingVersion).map((entry) => entry.contentHash));
  const contentHash = hashes.size === 1 ? ([...hashes][0] ?? null) : null;
  let fingerprint: FingerprintStatus | null = null;
  if (step.baselineContentHash === null) fingerprint = "NO_BASELINE";
  else if (contentHash === null) problems.push(`${step.plane}: the fingerprint of ${observed.existingVersion} was not observed by the interrupted deploy; it cannot be adopted (start a new recovery attempt)`);
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

export const PLANE_RECOVERY_STATES = ["RECOVERED", "ALREADY_RECOVERED", "DEPLOY_FAILED", "DEPLOY_UNKNOWN", "RECOVERY_ID_IN_USE", "VERIFICATION_FAILED", "UNEXPECTED_ACTIVE_VERSION", "NOT_STARTED"] as const;
export type PlaneRecoveryState = (typeof PLANE_RECOVERY_STATES)[number];
const DONE: readonly PlaneRecoveryState[] = ["RECOVERED", "ALREADY_RECOVERED"];
/** A deploy ran under the recovery id but its outcome was not seen: the plane MAY hold the recovery id now. */
const OUTCOME_UNSEEN: readonly PlaneRecoveryState[] = ["DEPLOY_FAILED", "DEPLOY_UNKNOWN"];
/** The attempt ends here: investigate, then start a NEW attempt (a new recovery id) — never continue this one. */
const ATTEMPT_ENDING: readonly PlaneRecoveryState[] = ["RECOVERY_ID_IN_USE", "VERIFICATION_FAILED"];
/**
 * A continued plane's state that must survive a run which stops BEFORE that plane (RECOVERY-TOOLING-03): recovered
 * (re-verified by the next continuation, never redeployed) or a deploy without a seen outcome (adoption stays possible).
 */
export const carriesForward = (state: PlaneRecoveryState): boolean => DONE.includes(state) || OUTCOME_UNSEEN.includes(state);

export const RECOVERY_FINAL_STATES = ["RECOVERED", "RECOVERED_FINGERPRINT_UNVERIFIED", "STOPPED_PARTIAL", "STOPPED_NOTHING_RECOVERED"] as const;
export type RecoveryFinalState = (typeof RECOVERY_FINAL_STATES)[number];

export interface ObservedWorker {
  readonly version: string;
  readonly contentHash: string;
}

export interface PriorPlane {
  readonly plane: ReleasePlane;
  readonly state: PlaneRecoveryState;
  readonly versionBefore: string | null;
  readonly resultingVersion: string | null;
  readonly fingerprint: FingerprintStatus | null;
  /** The (version, fingerprint) pairs the plane's deploy reported before its outcome was lost (DEPLOY_FAILED/UNKNOWN). */
  readonly observedWorkers: readonly ObservedWorker[];
}

export interface PriorRecovery {
  readonly fileName: string;
  readonly knownGoodSha: string;
  readonly recoveryId: string;
  readonly releaseEvidence: string;
  readonly projectRefs: Readonly<Record<ReleasePlane, string>>;
  readonly finalState: RecoveryFinalState;
  readonly planes: Readonly<Record<ReleasePlane, PriorPlane>>;
}

const isObservedWorker = (value: unknown): value is ObservedWorker => isObject(value) && isWorkerVersion(value["version"]) && typeof value["contentHash"] === "string" && CONTENT_HASH.test(value["contentHash"]);

/**
 * A previous recovery record this run may continue, or why not. Only an unfinished v2 attempt of the SAME source, release
 * evidence and projects, whose recovery id is well-formed, bound to that source and in every plane's argv; never an
 * attempt that ended on an id already in use or a failed verification (those need a new attempt), and never a v1 record
 * (RECOVERY-TOOLING-01 deployed under the known-good SHA, which the provider never rebuilds — RECOVERY-REHEARSAL-03B).
 */
export function parseRecoveryEvidence(fileName: string, raw: string, plan: RecoveryPlan): { readonly ok: true; readonly prior: PriorRecovery } | { readonly ok: false; readonly problems: readonly string[] } {
  if (!isEvidenceFileName(fileName)) return { ok: false, problems: ["--continue must name a recovery record by its bare file name"] };
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return { ok: false, problems: ["the recovery record is not JSON"] };
  }
  if (isObject(record) && record["schema"] === LEGACY_RECOVERY_SCHEMA) {
    return { ok: false, problems: ["a v1 recovery record deployed under the known-good SHA, which the provider never rebuilds (RECOVERY-REHEARSAL-03B); it cannot be continued: start a new recovery attempt"] };
  }
  if (!isObject(record) || record["schema"] !== RECOVERY_SCHEMA) return { ok: false, problems: ["not a recovery record"] };
  const problems: string[] = [];
  if (record["knownGoodSha"] !== plan.knownGoodSha) problems.push("the recovery record is for another known-good commit");
  if (record["releaseEvidence"] !== plan.releaseEvidence) problems.push("the recovery record names other release evidence");
  const recoveryId = record["recoveryId"];
  if (!isRecoveryIdFormat(recoveryId) || recoveryId.slice("recovery-".length, "recovery-".length + 12) !== plan.knownGoodSha.slice(0, 12)) problems.push("the recovery record has no valid recovery id for this known-good commit");
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
      const argv = entry["argv"];
      if (!Array.isArray(argv) || argValue(argv, "--external-id") !== recoveryId) problems.push(`${plane}: the recorded deploy is not under the record's recovery id`);
      const state = entry["state"];
      const resulting = entry["resultingVersion"];
      const fingerprint = entry["fingerprint"];
      const before = entry["versionBefore"];
      const observed = entry["observedWorkers"];
      if (typeof state !== "string" || !(PLANE_RECOVERY_STATES as readonly string[]).includes(state)) {
        problems.push(`${plane}: unknown state`);
        return;
      }
      if (ATTEMPT_ENDING.includes(state as PlaneRecoveryState)) problems.push(`${plane}: ${state} — this recovery attempt cannot be continued; investigate, then start a new attempt with a new recovery id`);
      const done = DONE.includes(state as PlaneRecoveryState);
      if (done && !isWorkerVersion(resulting)) problems.push(`${plane}: a recovered plane must record its resulting version`);
      if (done && fingerprint !== "MATCH" && fingerprint !== "NO_BASELINE") problems.push(`${plane}: a recovered plane must record its fingerprint status`);
      if (observed !== undefined && !(Array.isArray(observed) && observed.every(isObservedWorker))) problems.push(`${plane}: malformed observed workers`);
      parsed[plane] = {
        plane,
        state: state as PlaneRecoveryState,
        versionBefore: isWorkerVersion(before) ? before : null,
        resultingVersion: done && isWorkerVersion(resulting) ? resulting : null,
        fingerprint: done && (fingerprint === "MATCH" || fingerprint === "NO_BASELINE") ? fingerprint : null,
        observedWorkers: Array.isArray(observed) ? observed.filter(isObservedWorker) : [],
      };
    });
  }
  const complete = RECOVERY_ORDER.every((plane) => parsed[plane] !== undefined && refs[plane] !== undefined);
  if (problems.length > 0 || !complete || !isRecoveryIdFormat(recoveryId)) return { ok: false, problems: problems.length > 0 ? problems : ["the recovery record is incomplete"] };
  return {
    ok: true,
    prior: {
      fileName,
      knownGoodSha: plan.knownGoodSha,
      recoveryId,
      releaseEvidence: plan.releaseEvidence,
      projectRefs: refs as Record<ReleasePlane, string>,
      finalState: finalState as RecoveryFinalState,
      planes: parsed as Record<ReleasePlane, PriorPlane>,
    },
  };
}

export type PlaneIntent =
  | {
      readonly plane: ReleasePlane;
      readonly mode: "deploy";
      readonly expectedBefore: string;
      /**
       * This attempt already deployed here without seeing the outcome: if the provider answers that the CURRENT deployment
       * holds the recovery id, it is verified and adopted (never rebuilt); otherwise it is deployed normally.
       */
      readonly outcomeUnseen: boolean;
      readonly observedWorkers: readonly ObservedWorker[];
    }
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
  if (prior !== undefined && prior.recoveryId !== plan.recoveryId) problems.push("the plan's recovery id is not the continued attempt's");
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
    else {
      const outcomeUnseen = before !== undefined && OUTCOME_UNSEEN.includes(before.state);
      intents.push({ plane: step.plane, mode: "deploy", expectedBefore: expected, outcomeUnseen, observedWorkers: outcomeUnseen ? before.observedWorkers : [] });
    }
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
