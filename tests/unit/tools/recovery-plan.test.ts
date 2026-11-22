/**
 * RECOVERY-TOOLING-01 — the pure recovery planner: approved-source evidence parsing, the MAIN → INTELLIGENCE →
 * INTEGRATION plan and its invariants, strict parsing of the CLI's read-only MCP output, per-plane verification
 * (version, inventory, fingerprint), runtime / web / database compatibility, continuation and the final state.
 */
import { describe, expect, it } from "vitest";
import {
  KNOWN_WORKER_WEB_INCOMPATIBILITIES,
  PLANE_TASK_DIRECTORIES,
  RECOVERY_ORDER,
  RecoveryPlanError,
  assertRecoveryPlanInvariants,
  assessWebCompatibility,
  buildRecoveryPlan,
  deployListPeriod,
  inventoryProblems,
  migrationsAfter,
  parseCurrentWorker,
  parseDeployList,
  parseRecoveryEvidence,
  parseReleaseEvidence,
  parseRunCount,
  provenPairingValue,
  recoveryConfirmation,
  recoveryOutcome,
  resolvePlaneIntents,
  runtimeProblems,
  verifyRecoveredPlane,
  type KnownGoodRelease,
  type RecoveryPlan,
} from "../../../tools/trigger/recovery-plan.ts";
import { parseWorkerContentHash } from "../../../tools/trigger/release-pair.ts";
import { BAD, BASELINE, EVIDENCE_NAME, KNOWN_GOOD, KNOWN_GOOD_VERSION, REFS, currentWorkerText, deployListText, deployOutput, releaseRecord, runListText } from "./recovery-fixtures.ts";

const release = (schema: "v2" | "v3" = "v3"): KnownGoodRelease => {
  const parsed = parseReleaseEvidence(EVIDENCE_NAME, releaseRecord({ schema }));
  if (!parsed.ok) throw new Error(parsed.problems.join("; "));
  return parsed.release;
};
const plan = (schema: "v2" | "v3" = "v3"): RecoveryPlan => buildRecoveryPlan({ knownGoodSha: KNOWN_GOOD, release: release(schema), projectRefs: REFS, emptyEnvFile: "/tmp/x/empty" });
/** The element at `index`, or a test failure (no non-null assertions). */
function at<T>(items: readonly T[] | undefined, index: number): T {
  const item = items?.[index];
  if (item === undefined) throw new Error(`no element ${String(index)}`);
  return item;
}
const planesOf = <T,>(record: Record<string, unknown>): T[] => record["planes"] as T[];
const problemsOf = (raw: string, name = EVIDENCE_NAME): readonly string[] => {
  const parsed = parseReleaseEvidence(name, raw);
  return parsed.ok ? [] : parsed.problems;
};

describe("approved source: the release evidence", () => {
  it("an ALIGNED three-plane prod record is the known-good release (v3 with fingerprints, v2 without)", () => {
    const v3 = release("v3");
    expect(v3.releaseSha).toBe(KNOWN_GOOD);
    expect(v3.planes.main).toMatchObject({ projectRef: REFS.main, version: KNOWN_GOOD_VERSION, taskCount: 11, contentHash: BASELINE.main });
    expect(v3.planes.integration.taskCount).toBe(10);
    expect(release("v2").planes.intelligence.contentHash).toBeNull();
  });

  it.each([
    ["not ALIGNED", (record: Record<string, unknown>) => {
      record["finalState"] = "STOP_MAIN_FAILED";
    }, /not ALIGNED/],
    ["another tool", (record: Record<string, unknown>) => {
      record["tool"] = "tools/other.ts";
    }, /not written by the release tool/],
    ["another environment", (record: Record<string, unknown>) => {
      record["environment"] = "staging";
    }, /environment is not prod/],
    ["a plane not started", (record: Record<string, unknown>) => {
      record["planesNotStarted"] = ["main"];
    }, /not started/],
    ["a failed identity check", (record: Record<string, unknown>) => {
      record["identityChecks"] = [{ ok: true }, { ok: false }, { ok: true }, { ok: true }];
    }, /identity checks/],
    ["an unknown schema", (record: Record<string, unknown>) => {
      record["schema"] = "wrenkind.trigger-release-pair.v9";
    }, /unknown release evidence schema/],
    ["a reordered release", (record: Record<string, unknown>) => {
      record["planeOrder"] = ["main", "intelligence", "integration"];
    }, /plane order/],
    ["a plane that did not pass", (record: Record<string, unknown>) => {
      at(planesOf<{ outcome: unknown }>(record), 2).outcome = { state: "FAILED", reason: "exit_code" };
    }, /main: the plane did not PASS/],
    ["another external id in an argv", (record: Record<string, unknown>) => {
      at(planesOf<{ argv: string[] }>(record), 0).argv[8] = BAD;
    }, /integration: the external id is not the release SHA/],
    ["a non-prod argv", (record: Record<string, unknown>) => {
      at(planesOf<{ argv: string[] }>(record), 1).argv[6] = "staging";
    }, /intelligence: environment is not prod/],
  ])("refuses %s", (_label, mutate, message) => {
    expect(problemsOf(releaseRecord({ mutate })).join(" | ")).toMatch(message);
  });

  it("refuses a malformed file name, a name of another SHA, non-JSON, shared projects and a v2 record carrying fingerprints", () => {
    expect(problemsOf(releaseRecord(), "../trigger-release-pair/x.json").join()).toMatch(/bare file name/);
    expect(problemsOf(releaseRecord(), `2026-11-13T000143765Z-${BAD.slice(0, 12)}.json`).join()).toMatch(/does not match the release SHA/);
    expect(problemsOf("{not json")).toEqual(["the release evidence is not JSON"]);
    expect(problemsOf(releaseRecord({ refs: { intelligence: REFS.main } })).join()).toMatch(/three different projects/);
    expect(problemsOf(releaseRecord({ schema: "v2", mutate: (record) => {
      at(planesOf<Record<string, unknown>>(record), 0)["contentHash"] = "a".repeat(32);
    } })).join()).toMatch(/v2 record cannot carry/);
  });
});

describe("the recovery plan", () => {
  it("is MAIN, INTELLIGENCE, then INTEGRATION — each the release unit's argv with the known-good SHA as the one external id", () => {
    const built = plan();
    expect(built.steps.map((step) => step.plane)).toEqual(["main", "intelligence", "integration"]);
    expect(RECOVERY_ORDER).toEqual(["main", "intelligence", "integration"]);
    for (const step of built.steps) {
      expect(step.argv.slice(0, 11)).toEqual(["deploy", "--config", step.config, "--project-ref", REFS[step.plane], "--env", "prod", "--external-id", KNOWN_GOOD, "--env-file", "/tmp/x/empty"]);
      expect(step.argv).toEqual(expect.arrayContaining(["--depot-build", "--skip-update-check", "--skip-sync-env-vars", "--skip-telemetry"]));
      expect(step.argv).not.toContain("promote");
      expect(step.taskDirectory).toBe(PLANE_TASK_DIRECTORIES[step.plane]);
      expect(step.knownGoodVersion).toBe(KNOWN_GOOD_VERSION);
    }
    expect(built.steps.map((step) => step.expectedTasks)).toEqual([11, 1, 10]);
  });

  it("refuses an unapproved commit, a malformed SHA and any project that is not the approved release's", () => {
    expect(() => buildRecoveryPlan({ knownGoodSha: BAD, release: release(), projectRefs: REFS, emptyEnvFile: "/x" })).toThrow(/not the release SHA of the named ALIGNED release/);
    expect(() => buildRecoveryPlan({ knownGoodSha: "HEAD", release: release(), projectRefs: REFS, emptyEnvFile: "/x" })).toThrow(RecoveryPlanError);
    expect(() => buildRecoveryPlan({ knownGoodSha: KNOWN_GOOD, release: release(), projectRefs: { ...REFS, intelligence: "proj_someotherprojectxx" }, emptyEnvFile: "/x" })).toThrow(/--intelligence-project-ref is not the intelligence project of the approved release/);
    expect(() => buildRecoveryPlan({ knownGoodSha: KNOWN_GOOD, release: release(), projectRefs: { ...REFS, main: REFS.integration }, emptyEnvFile: "/x" })).toThrow(/--main-project-ref/);
    expect(() => buildRecoveryPlan({ knownGoodSha: KNOWN_GOOD, release: release(), projectRefs: { ...REFS, main: "not-a-ref" }, emptyEnvFile: "/x" })).toThrow(/must be a project reference/);
    expect(() => buildRecoveryPlan({ knownGoodSha: KNOWN_GOOD, release: release(), projectRefs: REFS, emptyEnvFile: " " })).toThrow(/empty env file/);
  });

  it("the invariants reject a reordered plan, another environment, a forbidden flag, a promote and a second external id", () => {
    const good = plan();
    const tamper = (index: number, argv: (current: readonly string[]) => readonly string[]): RecoveryPlan => ({ ...good, steps: good.steps.map((step, at) => (at === index ? { ...step, argv: argv(step.argv) } : step)) });
    expect(() => {
      assertRecoveryPlanInvariants({ ...good, steps: [...good.steps].reverse() });
    }).toThrow(/MAIN, INTELLIGENCE, then INTEGRATION/);
    expect(() => {
      assertRecoveryPlanInvariants(tamper(0, (argv) => argv.map((token) => (token === "prod" ? "staging" : token))));
    }).toThrow(/environment/);
    expect(() => {
      assertRecoveryPlanInvariants(tamper(1, (argv) => [...argv, "--force"]));
    }).toThrow(/--force/);
    expect(() => {
      assertRecoveryPlanInvariants(tamper(2, (argv) => [...argv, "promote"]));
    }).toThrow(/promote/);
    expect(() => {
      assertRecoveryPlanInvariants(tamper(2, (argv) => [...argv, "--external-id", KNOWN_GOOD]));
    }).toThrow(/exactly one external id/);
    expect(() => {
      assertRecoveryPlanInvariants(tamper(0, (argv) => argv.filter((token) => token !== "--skip-sync-env-vars")));
    }).toThrow(/missing --skip-sync-env-vars/);
  });

  it("the apply confirmation names the known-good commit", () => {
    expect(recoveryConfirmation(KNOWN_GOOD)).toBe(`recover-trigger-planes-to-${KNOWN_GOOD.slice(0, 12)}`);
  });
});

describe("read-only provider output (the CLI's MCP text), parsed strictly", () => {
  it("current worker: version, SDK and every task with its file", () => {
    const worker = parseCurrentWorker(currentWorkerText("20261122.3", "main"));
    expect(worker).toMatchObject({ version: "20261122.3", sdkVersion: "4.7.2" });
    expect(worker?.tasks).toHaveLength(11);
    expect(worker?.tasks[0]).toEqual({ slug: "main.task_0", filePath: "jobs/trigger/main/file-0.ts" });
    expect(parseCurrentWorker(currentWorkerText("20261122.3", "main").replace("has 11 tasks", "has 12 tasks"))).toBeUndefined();
    expect(parseCurrentWorker("Error: unauthorized")).toBeUndefined();
    expect(parseCurrentWorker("Current worker for staging is 20261122.3 using 4.7.2 of the SDK.")).toBeUndefined();
  });

  it("deploy list and run counts", () => {
    expect(parseDeployList(deployListText([{ version: "20261122.1", status: "DEPLOYED" }, { version: KNOWN_GOOD_VERSION, status: "DEPLOYED" }]))?.entries.map((entry) => entry.version)).toEqual(["20261122.1", KNOWN_GOOD_VERSION]);
    expect(parseDeployList("Found 3 deployments\n\n- a | v1 | DEPLOYED | x")).toBeUndefined();
    expect(parseRunCount(runListText(0))).toEqual({ count: 0, morePages: false });
    expect(parseRunCount(`${runListText(2)}\nPagination: Next page available →`)).toEqual({ count: 2, morePages: true });
    expect(parseRunCount("nope")).toBeUndefined();
  });

  it("the fingerprint is read only for the deployed version, and never when ambiguous", () => {
    expect(parseWorkerContentHash(deployOutput("20261122.4", 11, "a".repeat(32)), "20261122.4")).toBe("a".repeat(32));
    expect(parseWorkerContentHash(deployOutput("20261122.4", 11, "a".repeat(32)), "20261122.5")).toBeUndefined();
    expect(parseWorkerContentHash(deployOutput("20261122.4", 11), "20261122.4")).toBeUndefined();
    const twice = `${deployOutput("20261122.4", 11, "a".repeat(32))}${deployOutput("20261122.4", 11, "b".repeat(32))}`;
    expect(parseWorkerContentHash(twice, "20261122.4")).toBeUndefined();
  });

  it("the deploy-list window reaches back to the known-good release", () => {
    expect(deployListPeriod("2026-11-13T00:03:09.832Z", new Date("2026-11-22T12:00:00Z"))).toBe("12d");
  });
});

describe("per-plane verification after a deploy", () => {
  const main = () => at(plan().steps, 0);
  const worker = (version: string, options: Parameters<typeof currentWorkerText>[2] = {}) => parseCurrentWorker(currentWorkerText(version, "main", options));

  it("PASS: the new version is active, the inventory is the known-good one, the fingerprint equals the baseline", () => {
    const result = verifyRecoveredPlane(main(), { versionBefore: "20261122.1", deployedVersion: "20261122.2", deployOutput: deployOutput("20261122.2", 11, BASELINE.main), worker: worker("20261122.2") });
    expect(result).toEqual({ problems: [], contentHash: BASELINE.main, fingerprint: "MATCH" });
  });

  it("no recorded baseline: verified on version and inventory only (NO_BASELINE), the observed fingerprint is kept", () => {
    const step = at(plan("v2").steps, 0);
    expect(verifyRecoveredPlane(step, { versionBefore: "20261122.1", deployedVersion: "20261122.2", deployOutput: deployOutput("20261122.2", 11, "9".repeat(32)), worker: worker("20261122.2") })).toEqual({ problems: [], contentHash: "9".repeat(32), fingerprint: "NO_BASELINE" });
  });

  it.each([
    ["a fingerprint mismatch", { deployOutput: deployOutput("20261122.2", 11, "f".repeat(32)) }, /content fingerprint f+ differs from the known-good/],
    ["an unreadable fingerprint with a recorded baseline", { deployOutput: deployOutput("20261122.2", 11) }, /could not be read from the deploy output/],
    ["another active version", { worker: parseCurrentWorker(currentWorkerText("20261122.9", "main")) }, /active version is 20261122\.9, not 20261122\.2/],
    ["an unreadable current worker", { worker: undefined }, /could not be read after the deploy/],
    ["the previous version reported again", { versionBefore: "20261122.2" }, /not a new one/],
    ["a short inventory", { worker: parseCurrentWorker(currentWorkerText("20261122.2", "main", { count: 10 })) }, /10 tasks registered, the known-good release has 11/],
    ["another plane's code", { worker: parseCurrentWorker(currentWorkerText("20261122.2", "main", { directory: "jobs/trigger/integration" })) }, /outside jobs\/trigger\/main\//],
    ["duplicate task identifiers", { worker: parseCurrentWorker(currentWorkerText("20261122.2", "main", { duplicate: true })) }, /duplicate task identifiers/],
  ])("STOP on %s", (_label, override, message) => {
    const observed = { versionBefore: "20261122.1", deployedVersion: "20261122.2", deployOutput: deployOutput("20261122.2", 11, BASELINE.main), worker: worker("20261122.2"), ...override };
    const result = verifyRecoveredPlane(main(), observed);
    expect(result.problems.join(" | ")).toMatch(message);
    expect(result.fingerprint).toBeNull();
  });

  it("inventory problems are empty only for the plane's own complete inventory", () => {
    const current = worker("20261122.2");
    if (current === undefined) throw new Error("unparsed worker");
    expect(inventoryProblems(main(), current)).toEqual([]);
  });
});

describe("runtime, web and database compatibility", () => {
  it("the deploying CLI must equal the known-good SDK pin, on Node 22", () => {
    expect(runtimeProblems({ cliVersion: "4.7.2", knownGoodSdkVersion: "4.7.2", knownGoodNodeEngine: "22.x" })).toEqual([]);
    expect(runtimeProblems({ cliVersion: "4.8.0", knownGoodSdkVersion: "4.7.2", knownGoodNodeEngine: "22.x" }).join()).toMatch(/CLI is 4\.8\.0; the known-good commit pins the SDK at 4\.7\.2/);
    expect(runtimeProblems({ cliVersion: "4.7.2", knownGoodSdkVersion: "^4.7.2", knownGoodNodeEngine: "22.x" }).join()).toMatch(/exact version/);
    expect(runtimeProblems({ cliVersion: undefined, knownGoodSdkVersion: "4.7.2", knownGoodNodeEngine: "20.x" })).toHaveLength(2);
  });

  const WEB = "9".repeat(40);
  const assess = (overrides: Partial<Parameters<typeof assessWebCompatibility>[0]> = {}) =>
    assessWebCompatibility({ webSha: WEB, knownGoodSha: KNOWN_GOOD, relation: "web_newer", changedContractPaths: [], pathExists: () => true, provenPairing: undefined, ...overrides });

  it("compatible: the same commit, an older web, or a newer web with no worker-contract change", () => {
    expect(assess({ relation: "equal" }).kind).toBe("COMPATIBLE");
    expect(assess({ relation: "web_older" }).kind).toBe("COMPATIBLE");
    expect(assess().kind).toBe("COMPATIBLE");
  });

  it("a newer web with changed migrations needs a web rollback — or the attestation of that EXACT in-service pairing", () => {
    const changed = { changedContractPaths: ["db/migrations/0032_reply_in_flight_admission.sql", "db/migrations/0033_mutation_intent_state_transition_guard.sql"] };
    const required = assess(changed);
    expect(required.kind).toBe("REQUIRES_WEB_ROLLBACK");
    expect(JSON.stringify(required)).toContain(`--proven-web-pairing ${provenPairingValue(WEB, KNOWN_GOOD)}`);
    expect(assess({ ...changed, provenPairing: provenPairingValue(WEB, BAD) }).kind).toBe("REQUIRES_WEB_ROLLBACK");
    expect(assess({ ...changed, provenPairing: provenPairingValue(WEB, KNOWN_GOOD) }).kind).toBe("COMPATIBLE_ATTESTED");
  });

  it("workflow-0034: a Workflow web beside a pre-Workflow worker always requires the web rollback first — no attestation admits it", () => {
    const [rule] = KNOWN_WORKER_WEB_INCOMPATIBILITIES;
    expect(rule?.id).toBe("workflow-0034");
    const pathExists = (sha: string, file: string) => (sha === WEB ? true : file !== "modules/workflow/persistence/projection-store.ts");
    const verdict = assess({ pathExists, changedContractPaths: ["db/migrations/0034_workflow_core.sql"], provenPairing: provenPairingValue(WEB, KNOWN_GOOD) });
    expect(verdict.kind).toBe("REQUIRES_WEB_ROLLBACK");
    expect(JSON.stringify(verdict)).toMatch(/vanish from every Inbox/);
  });

  it("unrelated histories and a malformed web SHA are refused", () => {
    expect(assess({ relation: "unrelated" }).kind).toBe("REFUSED");
    expect(assess({ webSha: "dpl_HT6ETxMo" }).kind).toBe("REFUSED");
  });

  it("lists the migrations the known-good worker predates (forward-only; nothing is rolled back)", () => {
    const old = ["db/migrations/0033_mutation_intent_state_transition_guard.sql"];
    expect(migrationsAfter(old, [...old, "db/migrations/0034_workflow_core.sql", "db/migrations/README.md"])).toEqual(["db/migrations/0034_workflow_core.sql"]);
  });
});

describe("continuation and the final state", () => {
  const recoveryRecord = (states: readonly [string, string | null, string | null][], overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      schema: "wrenkind.trigger-recovery.v1",
      knownGoodSha: KNOWN_GOOD,
      releaseEvidence: EVIDENCE_NAME,
      finalState: "STOPPED_PARTIAL",
      planes: RECOVERY_ORDER.map((plane, index) => ({ plane, projectRef: REFS[plane], state: states[index]?.[0], resultingVersion: states[index]?.[1], fingerprint: states[index]?.[2] })),
      ...overrides,
    });
  const NAME = `2026-11-22T120000000Z-${KNOWN_GOOD.slice(0, 12)}.json`;

  it("a stopped recovery of the same source continues: recovered planes are only re-verified, the others need expectations", () => {
    const parsed = parseRecoveryEvidence(NAME, recoveryRecord([["RECOVERED", "20261122.2", "MATCH"], ["DEPLOY_FAILED", null, null], ["NOT_STARTED", null, null]]), plan());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const intents = resolvePlaneIntents(plan(), { intelligence: "20261122.1", integration: "20261122.1" }, parsed.prior);
    expect(intents).toEqual({ ok: true, intents: [
      { plane: "main", mode: "verify_recovered", recoveredVersion: "20261122.2", fingerprint: "MATCH" },
      { plane: "intelligence", mode: "deploy", expectedBefore: "20261122.1" },
      { plane: "integration", mode: "deploy", expectedBefore: "20261122.1" },
    ] });
    expect(resolvePlaneIntents(plan(), { main: "20261122.9", intelligence: "20261122.1", integration: "20261122.1" }, parsed.prior)).toMatchObject({ ok: false });
    expect(resolvePlaneIntents(plan(), { intelligence: "20261122.1" }, parsed.prior)).toEqual({ ok: false, problems: ["--expect-integration-version is required (the active version shown by the plan)"] });
  });

  it("refuses to continue a completed recovery, another source, other projects or a malformed record", () => {
    const states: [string, string | null, string | null][] = [["RECOVERED", "20261122.2", "MATCH"], ["RECOVERED", "20261122.2", "MATCH"], ["RECOVERED", "20261122.2", "MATCH"]];
    expect(parseRecoveryEvidence(NAME, recoveryRecord(states, { finalState: "RECOVERED" }), plan())).toMatchObject({ ok: false });
    expect(parseRecoveryEvidence(NAME, recoveryRecord(states, { knownGoodSha: BAD }), plan())).toMatchObject({ ok: false });
    const otherProject = JSON.parse(recoveryRecord(states)) as { planes: { projectRef: string }[] };
    at(otherProject.planes, 0).projectRef = "proj_someotherprojectxx";
    expect(parseRecoveryEvidence(NAME, JSON.stringify(otherProject), plan())).toMatchObject({ ok: false });
    expect(parseRecoveryEvidence(NAME, recoveryRecord([["RECOVERED", null, "MATCH"], ["NOT_STARTED", null, null], ["NOT_STARTED", null, null]]), plan())).toMatchObject({ ok: false });
    expect(parseRecoveryEvidence("../x.json", recoveryRecord(states), plan())).toMatchObject({ ok: false });
  });

  it("only three recovered planes are a success; any partial result is a stop", () => {
    const entry = (plane: "main" | "intelligence" | "integration", state: "RECOVERED" | "DEPLOY_FAILED" | "NOT_STARTED" | "ALREADY_RECOVERED", fingerprint: "MATCH" | "NO_BASELINE" | null = state === "RECOVERED" || state === "ALREADY_RECOVERED" ? "MATCH" : null) => ({ plane, state, fingerprint });
    expect(recoveryOutcome([entry("main", "RECOVERED"), entry("intelligence", "ALREADY_RECOVERED"), entry("integration", "RECOVERED")]).finalState).toBe("RECOVERED");
    expect(recoveryOutcome([entry("main", "RECOVERED"), entry("intelligence", "RECOVERED", "NO_BASELINE"), entry("integration", "RECOVERED")]).finalState).toBe("RECOVERED_FINGERPRINT_UNVERIFIED");
    expect(recoveryOutcome([entry("main", "RECOVERED"), entry("intelligence", "RECOVERED"), entry("integration", "DEPLOY_FAILED")])).toEqual({ finalState: "STOPPED_PARTIAL", recoveredPlanes: ["main", "intelligence"], unrecoveredPlanes: ["integration"] });
    expect(recoveryOutcome([entry("main", "DEPLOY_FAILED"), entry("intelligence", "NOT_STARTED"), entry("integration", "NOT_STARTED")]).finalState).toBe("STOPPED_NOTHING_RECOVERED");
  });
});
