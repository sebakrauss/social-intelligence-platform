/**
 * RECOVERY-TOOLING-01 / -02 — the pure recovery planner: approved-source evidence parsing, the recovery id (one per
 * approved attempt, never the known-good SHA), the INTEGRATION → INTELLIGENCE → MAIN plan and its invariants, strict
 * parsing of the CLI's read-only MCP output, classification of the deploy's answer, per-plane verification (version,
 * inventory, fingerprint), runtime / web / database compatibility, continuation and the final state.
 */
import { describe, expect, it } from "vitest";
import {
  KNOWN_WORKER_WEB_INCOMPATIBILITIES,
  PLANE_TASK_DIRECTORIES,
  RECOVERY_ORDER,
  RecoveryPlanError,
  assertRecoveryPlanInvariants,
  assessRecoveryIdentity,
  assessWebCompatibility,
  buildRecoveryPlan,
  classifyRecoveryDeploy,
  deployListPeriod,
  inventoryProblems,
  migrationsAfter,
  parseCurrentWorker,
  parseDeployList,
  parseRecoveryEvidence,
  parseReleaseEvidence,
  parseRunCount,
  parseWorkerCreations,
  proposeRecoveryId,
  provenPairingValue,
  recoveryConfirmation,
  recoveryIdProblems,
  recoveryOutcome,
  resolvePlaneIntents,
  runtimeProblems,
  verifyConfirmedDeployment,
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
const RID = `recovery-${KNOWN_GOOD.slice(0, 12)}-20261122T110000Z`;
const plan = (schema: "v2" | "v3" = "v3"): RecoveryPlan => buildRecoveryPlan({ knownGoodSha: KNOWN_GOOD, recoveryId: RID, release: release(schema), projectRefs: REFS, emptyEnvFile: "/tmp/x/empty" });
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
  it("is INTEGRATION, INTELLIGENCE, then MAIN (the release order) — each the release unit's argv with the recovery id as the one external id", () => {
    const built = plan();
    expect(built.steps.map((step) => step.plane)).toEqual(["integration", "intelligence", "main"]);
    expect(RECOVERY_ORDER).toEqual(["integration", "intelligence", "main"]);
    expect(built).toMatchObject({ knownGoodSha: KNOWN_GOOD, recoveryId: RID });
    for (const step of built.steps) {
      expect(step.argv.slice(0, 11)).toEqual(["deploy", "--config", step.config, "--project-ref", REFS[step.plane], "--env", "prod", "--external-id", RID, "--env-file", "/tmp/x/empty"]);
      expect(step.argv).not.toContain(KNOWN_GOOD);
      expect(step.argv).toEqual(expect.arrayContaining(["--depot-build", "--skip-update-check", "--skip-sync-env-vars", "--skip-telemetry"]));
      expect(step.argv).not.toContain("promote");
      expect(step.taskDirectory).toBe(PLANE_TASK_DIRECTORIES[step.plane]);
      expect(step.knownGoodVersion).toBe(KNOWN_GOOD_VERSION);
    }
    expect(built.steps.map((step) => step.expectedTasks)).toEqual([10, 1, 11]);
  });

  it("refuses an unapproved commit, a malformed SHA and any project that is not the approved release's", () => {
    expect(() => buildRecoveryPlan({ knownGoodSha: BAD, recoveryId: RID, release: release(), projectRefs: REFS, emptyEnvFile: "/x" })).toThrow(/not the release SHA of the named ALIGNED release/);
    expect(() => buildRecoveryPlan({ knownGoodSha: "HEAD", recoveryId: RID, release: release(), projectRefs: REFS, emptyEnvFile: "/x" })).toThrow(RecoveryPlanError);
    expect(() => buildRecoveryPlan({ knownGoodSha: KNOWN_GOOD, recoveryId: RID, release: release(), projectRefs: { ...REFS, intelligence: "proj_someotherprojectxx" }, emptyEnvFile: "/x" })).toThrow(/--intelligence-project-ref is not the intelligence project of the approved release/);
    expect(() => buildRecoveryPlan({ knownGoodSha: KNOWN_GOOD, recoveryId: RID, release: release(), projectRefs: { ...REFS, main: REFS.integration }, emptyEnvFile: "/x" })).toThrow(/--main-project-ref/);
    expect(() => buildRecoveryPlan({ knownGoodSha: KNOWN_GOOD, recoveryId: RID, release: release(), projectRefs: { ...REFS, main: "not-a-ref" }, emptyEnvFile: "/x" })).toThrow(/must be a project reference/);
    expect(() => buildRecoveryPlan({ knownGoodSha: KNOWN_GOOD, recoveryId: RID, release: release(), projectRefs: REFS, emptyEnvFile: " " })).toThrow(/empty env file/);
  });

  it("03B regression: the known-good SHA (or any SHA, or an id of another source) is never the deployment id", () => {
    for (const recoveryId of [KNOWN_GOOD, BAD, `recovery-${BAD.slice(0, 12)}-20261122T110000Z`, "recovery-latest", undefined]) {
      expect(() => buildRecoveryPlan({ knownGoodSha: KNOWN_GOOD, recoveryId, release: release(), projectRefs: REFS, emptyEnvFile: "/x" }), String(recoveryId)).toThrow(/recovery id must be recovery-/);
    }
    const good = plan();
    // A plan tampered back to the known-good SHA as external id (the RECOVERY-TOOLING-01 argv) is refused before execution.
    expect(() => {
      assertRecoveryPlanInvariants({ ...good, steps: good.steps.map((step) => ({ ...step, argv: step.argv.map((token) => (token === RID ? KNOWN_GOOD : token)) })) });
    }).toThrow(/external id must be the recovery id \(never the known-good SHA/);
    expect(() => {
      assertRecoveryPlanInvariants({ ...good, recoveryId: KNOWN_GOOD });
    }).toThrow(/never a commit SHA/);
  });

  it("the invariants reject a reordered plan, another environment, a forbidden flag, a promote and a second external id", () => {
    const good = plan();
    const tamper = (index: number, argv: (current: readonly string[]) => readonly string[]): RecoveryPlan => ({ ...good, steps: good.steps.map((step, at) => (at === index ? { ...step, argv: argv(step.argv) } : step)) });
    expect(() => {
      assertRecoveryPlanInvariants({ ...good, steps: [...good.steps].reverse() });
    }).toThrow(/INTEGRATION, INTELLIGENCE, then MAIN/);
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
      assertRecoveryPlanInvariants(tamper(2, (argv) => [...argv, "--external-id", RID]));
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
  const main = () => at(plan().steps, 2);
  const worker = (version: string, options: Parameters<typeof currentWorkerText>[2] = {}) => parseCurrentWorker(currentWorkerText(version, "main", options));

  it("PASS: the new version is active, the inventory is the known-good one, the fingerprint equals the baseline", () => {
    const result = verifyRecoveredPlane(main(), { versionBefore: "20261122.1", deployedVersion: "20261122.2", deployOutput: deployOutput("20261122.2", 11, BASELINE.main), worker: worker("20261122.2") });
    expect(result).toEqual({ problems: [], contentHash: BASELINE.main, fingerprint: "MATCH" });
  });

  it("no recorded baseline: verified on version and inventory only (NO_BASELINE), the observed fingerprint is kept", () => {
    const step = at(plan("v2").steps, 2);
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
      schema: "wrenkind.trigger-recovery.v2",
      knownGoodSha: KNOWN_GOOD,
      recoveryId: RID,
      releaseEvidence: EVIDENCE_NAME,
      finalState: "STOPPED_PARTIAL",
      planes: RECOVERY_ORDER.map((plane, index) => ({
        plane,
        projectRef: REFS[plane],
        argv: ["deploy", "--project-ref", REFS[plane], "--env", "prod", "--external-id", RID],
        state: states[index]?.[0],
        versionBefore: "20261122.1",
        resultingVersion: states[index]?.[1],
        fingerprint: states[index]?.[2],
        observedWorkers: states[index]?.[0] === "DEPLOY_UNKNOWN" ? [{ version: "20261122.3", contentHash: BASELINE[plane] }] : [],
      })),
      ...overrides,
    });
  const NAME = `2026-11-22T120000000Z-${KNOWN_GOOD.slice(0, 12)}.json`;

  it("a stopped recovery of the same source continues: recovered planes are only re-verified, the others need expectations", () => {
    const parsed = parseRecoveryEvidence(NAME, recoveryRecord([["RECOVERED", "20261122.2", "MATCH"], ["DEPLOY_FAILED", null, null], ["NOT_STARTED", null, null]]), plan());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.prior.recoveryId).toBe(RID);
    const intents = resolvePlaneIntents(plan(), { intelligence: "20261122.1", main: "20261122.1" }, parsed.prior);
    expect(intents).toEqual({ ok: true, intents: [
      { plane: "integration", mode: "verify_recovered", recoveredVersion: "20261122.2", fingerprint: "MATCH" },
      { plane: "intelligence", mode: "deploy", expectedBefore: "20261122.1", outcomeUnseen: true, observedWorkers: [] },
      { plane: "main", mode: "deploy", expectedBefore: "20261122.1", outcomeUnseen: false, observedWorkers: [] },
    ] });
    expect(resolvePlaneIntents(plan(), { integration: "20261122.9", intelligence: "20261122.1", main: "20261122.1" }, parsed.prior)).toMatchObject({ ok: false });
    expect(resolvePlaneIntents(plan(), { intelligence: "20261122.1" }, parsed.prior)).toEqual({ ok: false, problems: ["--expect-main-version is required (the active version shown by the plan)"] });
    // A plan under another recovery id never continues this attempt.
    const other = buildRecoveryPlan({ knownGoodSha: KNOWN_GOOD, recoveryId: `recovery-${KNOWN_GOOD.slice(0, 12)}-20261122T113000Z`, release: release(), projectRefs: REFS, emptyEnvFile: "/x" });
    expect(resolvePlaneIntents(other, { intelligence: "20261122.1", main: "20261122.1" }, parsed.prior)).toMatchObject({ ok: false, problems: ["the plan's recovery id is not the continued attempt's"] });
  });

  it("an interrupted plane (DEPLOY_UNKNOWN) keeps the fingerprints its build log reported; ending states and v1 records are never continued", () => {
    const parsed = parseRecoveryEvidence(NAME, recoveryRecord([["RECOVERED", "20261122.2", "MATCH"], ["DEPLOY_UNKNOWN", null, null], ["NOT_STARTED", null, null]]), plan());
    if (!parsed.ok) throw new Error(parsed.problems.join("; "));
    const intents = resolvePlaneIntents(plan(), { intelligence: "20261122.3", main: "20261122.1" }, parsed.prior);
    expect(intents.ok ? intents.intents[1] : undefined).toEqual({ plane: "intelligence", mode: "deploy", expectedBefore: "20261122.3", outcomeUnseen: true, observedWorkers: [{ version: "20261122.3", contentHash: BASELINE.intelligence }] });
    for (const ending of ["RECOVERY_ID_IN_USE", "VERIFICATION_FAILED"]) {
      expect(JSON.stringify(parseRecoveryEvidence(NAME, recoveryRecord([["RECOVERED", "20261122.2", "MATCH"], [ending, null, null], ["NOT_STARTED", null, null]]), plan())), ending).toMatch(/this recovery attempt cannot be continued/);
    }
    const v1 = JSON.parse(recoveryRecord([["DEPLOY_UNKNOWN", null, null], ["NOT_STARTED", null, null], ["NOT_STARTED", null, null]])) as Record<string, unknown>;
    v1["schema"] = "wrenkind.trigger-recovery.v1";
    expect(parseRecoveryEvidence(NAME, JSON.stringify(v1), plan())).toEqual({ ok: false, problems: [expect.stringMatching(/v1 recovery record deployed under the known-good SHA, which the provider never rebuilds/) as unknown] });
    // The record's recovery id must be well-formed, bound to the source and in every recorded argv.
    expect(parseRecoveryEvidence(NAME, recoveryRecord([["NOT_STARTED", null, null], ["NOT_STARTED", null, null], ["NOT_STARTED", null, null]], { recoveryId: KNOWN_GOOD }), plan())).toMatchObject({ ok: false });
    const mixed = JSON.parse(recoveryRecord([["NOT_STARTED", null, null], ["NOT_STARTED", null, null], ["NOT_STARTED", null, null]])) as { planes: { argv: string[] }[] };
    at(mixed.planes, 2).argv = ["deploy", "--external-id", KNOWN_GOOD];
    expect(JSON.stringify(parseRecoveryEvidence(NAME, JSON.stringify(mixed), plan()))).toMatch(/main: the recorded deploy is not under the record's recovery id/);
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
    expect(recoveryOutcome([entry("main", "DEPLOY_FAILED"), entry("intelligence", "RECOVERED"), entry("integration", "RECOVERED")])).toEqual({ finalState: "STOPPED_PARTIAL", recoveredPlanes: ["integration", "intelligence"], unrecoveredPlanes: ["main"] });
    expect(recoveryOutcome([entry("main", "DEPLOY_FAILED"), entry("intelligence", "NOT_STARTED"), entry("integration", "NOT_STARTED")]).finalState).toBe("STOPPED_NOTHING_RECOVERED");
  });
});

describe("RECOVERY-TOOLING-02: the recovery id and the deploy's answer", () => {
  const NOW = new Date("2026-11-22T12:00:00.000Z");
  /** The CLI 4.7.2 answer captured in RECOVERY-REHEARSAL-03B (synthetic SHA), for an external id the project already holds. */
  const ALREADY_DEPLOYED = (version: string, externalId: string, current: boolean) =>
    [
      "◇  Successfully built code",
      "│",
      "▲  Warning: Environment variables were not synced because nothing was built.",
      "│  ",
      `│           If your environment variables have changed, deploy again with --force --external-id ${externalId} to rebuild this id and sync them.`,
      "│",
      ...(current ? [] : ["▲  Warning: This version is not the current deployment.", "│  ", "│           Promote it from the dashboard, or deploy again with --force to build a new version.", "│"]),
      `└  Version ${version} was already deployed for --external-id ${externalId} — nothing to build `,
      "View deployment",
      "https://cloud.example.invalid/projects/v3/proj_synthetic/deployments/abc",
    ].join("\n");
  const step = { expectedTasks: 11 };
  const ok = (output: string) => ({ exitCode: 0, output, timedOut: false, interrupted: false });

  it("a proposed id is bound to its source and its time; never a SHA; never in the future", () => {
    expect(proposeRecoveryId(KNOWN_GOOD, new Date("2026-11-22T14:48:46.399Z"))).toBe(`recovery-${KNOWN_GOOD.slice(0, 12)}-20261122T144846Z`);
    expect(recoveryIdProblems(proposeRecoveryId(KNOWN_GOOD, NOW), KNOWN_GOOD, NOW)).toEqual([]);
    expect(recoveryIdProblems(KNOWN_GOOD, KNOWN_GOOD, NOW).join()).toMatch(/must be recovery-/);
    expect(recoveryIdProblems(`recovery-${BAD.slice(0, 12)}-20261122T110000Z`, KNOWN_GOOD, NOW)).toEqual(["the recovery id names another known-good commit"]);
    expect(recoveryIdProblems(`recovery-${KNOWN_GOOD.slice(0, 12)}-20261122T120400Z`, KNOWN_GOOD, NOW)).toEqual([]); // within the clock-skew allowance
    expect(recoveryIdProblems(`recovery-${KNOWN_GOOD.slice(0, 12)}-20261122T121000Z`, KNOWN_GOOD, NOW)).toEqual(["the recovery id's time lies in the future"]);
    expect(recoveryIdProblems(`recovery-${KNOWN_GOOD.slice(0, 12)}-20260230T000000Z`, KNOWN_GOOD, NOW)).toEqual(["the recovery id's time is not a valid UTC time"]);
    expect(recoveryIdProblems(undefined, KNOWN_GOOD, NOW)).toEqual(["the recovery id is missing"]);
  });

  it("identity: NEW (proposed or given), CONTINUES (the record's id only), REFUSED (spent, another attempt's, a later record exists, changed on continuation)", () => {
    const proposed = proposeRecoveryId(KNOWN_GOOD, NOW);
    const none = () => [];
    const base = { knownGoodSha: KNOWN_GOOD, proposed, now: NOW };
    expect(assessRecoveryIdentity({ ...base, given: undefined, prior: undefined, uses: none })).toEqual({ kind: "NEW", recoveryId: proposed, proposed: true });
    expect(assessRecoveryIdentity({ ...base, given: RID, prior: undefined, uses: none })).toEqual({ kind: "NEW", recoveryId: RID, proposed: false });
    const spent = () => [{ fileName: "2026-11-22T110500000Z-x.json", kind: "recovery" as const, finalState: "RECOVERED" }];
    expect(assessRecoveryIdentity({ ...base, given: RID, prior: undefined, uses: spent })).toMatchObject({ kind: "REFUSED", reason: expect.stringMatching(/already used by a completed recovery/) as unknown });
    const unfinished = () => [{ fileName: "2026-11-22T110500000Z-x.json", kind: "recovery" as const, finalState: "STOPPED_PARTIAL" }];
    expect(assessRecoveryIdentity({ ...base, given: RID, prior: undefined, uses: unfinished })).toMatchObject({ kind: "REFUSED", reason: expect.stringMatching(/belongs to an earlier, unfinished attempt/) as unknown });
    const prior = { fileName: "2026-11-22T110500000Z-x.json", recoveryId: RID };
    expect(assessRecoveryIdentity({ ...base, given: undefined, prior, uses: unfinished })).toEqual({ kind: "CONTINUES", recoveryId: RID, fileName: prior.fileName });
    expect(assessRecoveryIdentity({ ...base, given: RID, prior, uses: unfinished })).toMatchObject({ kind: "CONTINUES" });
    expect(assessRecoveryIdentity({ ...base, given: proposed, prior, uses: unfinished })).toMatchObject({ kind: "REFUSED", reason: expect.stringMatching(/a continuation never changes it/) as unknown });
    const chain = () => [...unfinished(), { fileName: "2026-11-22T111500000Z-x.json", kind: "recovery" as const, finalState: "STOPPED_PARTIAL" }];
    expect(assessRecoveryIdentity({ ...base, given: undefined, prior, uses: chain })).toMatchObject({ kind: "REFUSED", reason: "a later record of this recovery attempt exists: continue 2026-11-22T111500000Z-x.json instead" });
    expect(assessRecoveryIdentity({ ...base, given: undefined, prior, uses: () => [...unfinished(), ...spent().map((use) => ({ ...use, fileName: "2026-11-22T112000000Z-x.json" }))] })).toMatchObject({ kind: "REFUSED", reason: expect.stringMatching(/already used by a completed recovery/) as unknown });
  });

  it("03B regression: 'already deployed … nothing to build' with exit 0 is EXISTING (never PASS), current or not", () => {
    expect(classifyRecoveryDeploy(step, ok(ALREADY_DEPLOYED("20261122.1", KNOWN_GOOD, false)))).toEqual({ state: "EXISTING", version: "20261122.1", externalId: KNOWN_GOOD, current: false });
    expect(classifyRecoveryDeploy(step, ok(ALREADY_DEPLOYED("20261122.4", RID, true)))).toEqual({ state: "EXISTING", version: "20261122.4", externalId: RID, current: true });
    // With ANSI colour codes, as a terminal CLI may print them.
    expect(classifyRecoveryDeploy(step, ok(`\x1b[1m${ALREADY_DEPLOYED("20261122.4", RID, true)}\x1b[0m`))).toMatchObject({ state: "EXISTING", version: "20261122.4" });
  });

  it("the other answers: a real new deploy is PASS; nothing parseable, both answers at once, interrupt, timeout and a non-zero exit are never PASS", () => {
    expect(classifyRecoveryDeploy(step, ok(deployOutput("20261122.5", 11, BASELINE.main)))).toEqual({ state: "PASS", version: "20261122.5", taskCount: 11 });
    expect(classifyRecoveryDeploy(step, ok("│\n└  \n"))).toEqual({ state: "UNKNOWN", reason: "unreadable_output" });
    expect(classifyRecoveryDeploy(step, ok(`${deployOutput("20261122.5", 11)}${ALREADY_DEPLOYED("20261122.4", RID, true)}`))).toEqual({ state: "UNKNOWN", reason: "unreadable_output" });
    expect(classifyRecoveryDeploy(step, ok(`${ALREADY_DEPLOYED("20261122.4", RID, true)}\n${ALREADY_DEPLOYED("20261122.3", RID, true)}`))).toEqual({ state: "UNKNOWN", reason: "unreadable_output" });
    expect(classifyRecoveryDeploy(step, { ...ok(ALREADY_DEPLOYED("20261122.4", RID, true)), interrupted: true })).toEqual({ state: "UNKNOWN", reason: "interrupted" });
    expect(classifyRecoveryDeploy(step, { exitCode: null, output: "", timedOut: true, interrupted: false })).toEqual({ state: "UNKNOWN", reason: "timeout" });
    expect(classifyRecoveryDeploy(step, { exitCode: 1, output: ALREADY_DEPLOYED("20261122.4", RID, true), timedOut: false, interrupted: false })).toEqual({ state: "FAILED", reason: "exit_code" });
    expect(classifyRecoveryDeploy(step, ok(deployOutput("20261122.5", 10)))).toMatchObject({ state: "UNKNOWN", reason: "task_count_mismatch" });
  });

  it("an interrupted deploy's build log keeps every (version, fingerprint) it reported", () => {
    expect(parseWorkerCreations(`${deployOutput("20261122.5", 11, BASELINE.main)}${deployOutput("20261122.5", 11, BASELINE.main)}`)).toEqual([{ version: "20261122.5", contentHash: BASELINE.main }]);
    expect(parseWorkerCreations("nothing here")).toEqual([]);
  });

  it("adopting a deployment the provider confirms under the recovery id: current, the provider's current worker, the plane's inventory, the observed fingerprint", () => {
    const main = at(plan().steps, 2);
    const worker = parseCurrentWorker(currentWorkerText("20261122.4", "main"));
    const observedWorkers = [{ version: "20261122.4", contentHash: BASELINE.main }];
    expect(verifyConfirmedDeployment(main, { existingVersion: "20261122.4", current: true, worker, observedWorkers })).toEqual({ problems: [], contentHash: BASELINE.main, fingerprint: "MATCH" });
    expect(verifyConfirmedDeployment(main, { existingVersion: "20261122.4", current: false, worker, observedWorkers }).problems.join()).toMatch(/is not the current one/);
    expect(verifyConfirmedDeployment(main, { existingVersion: "20261122.4", current: true, worker: parseCurrentWorker(currentWorkerText("20261122.9", "main")), observedWorkers }).problems.join()).toMatch(/active version is 20261122\.9/);
    expect(verifyConfirmedDeployment(main, { existingVersion: "20261122.4", current: true, worker, observedWorkers: [] }).problems.join()).toMatch(/was not observed by the interrupted deploy/);
    expect(verifyConfirmedDeployment(main, { existingVersion: "20261122.4", current: true, worker, observedWorkers: [{ version: "20261122.3", contentHash: BASELINE.main }] }).problems.join()).toMatch(/was not observed/);
    expect(verifyConfirmedDeployment(main, { existingVersion: "20261122.4", current: true, worker, observedWorkers: [{ version: "20261122.4", contentHash: "d".repeat(32) }] }).problems.join()).toMatch(/differs from the known-good/);
    expect(verifyConfirmedDeployment(at(plan("v2").steps, 2), { existingVersion: "20261122.4", current: true, worker, observedWorkers: [] })).toMatchObject({ problems: [], fingerprint: "NO_BASELINE" });
  });
});
