/**
 * Step 7G-H5.5-P2-F2: the paired Trigger.dev release plan (pure). Exactly two planes, INTEGRATION then MAIN, one
 * release SHA in both argv, prod only, the common safety flags, nothing forbidden; deploy-output parsing, the exact
 * task counts, redaction, and the signing-helper precheck. No process, network or Trigger.dev.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AWS_SIGNING_HELPER_ARTIFACTS, awsSigningHelperRelativePath } from "../../../jobs/aws-signing-helper.ts";
import {
  COMMON_SAFETY_FLAGS,
  EMPTY_ENV_FILE_LABEL,
  FORBIDDEN_FLAGS,
  RELEASE_PLANES,
  ReleasePlanError,
  assertPlanInvariants,
  buildReleasePlan,
  checkHelperBuilds,
  evaluatePlaneResult,
  parseDeployOutput,
  redactReleaseOutput,
  redactedTail,
  sanitizeArgv,
  type ReleasePlan,
} from "../../../tools/trigger/release-pair.ts";

const SHA = "1b3fbbe2f651ca64bbf228e4e49b0f344a109a95";
const INTEGRATION_REF = "proj_integrationtestref01";
const MAIN_REF = "proj_maintestrefabcdefghij";
const ENV_FILE = "/tmp/trigger-release-pair-x/empty-env-file";
const plan = (overrides: Partial<Parameters<typeof buildReleasePlan>[0]> = {}): ReleasePlan =>
  buildReleasePlan({ releaseSha: SHA, integrationProjectRef: INTEGRATION_REF, mainProjectRef: MAIN_REF, emptyEnvFile: ENV_FILE, ...overrides });
const flagValue = (argv: readonly string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1];

/** Synthetic credential shapes assembled at runtime: this file never contains a literal secret. */
const synthetic = {
  triggerKey: "tr_" + "prod_" + "S".repeat(24),
  shortTriggerKey: "tr_" + "pat_" + "q".repeat(8),
  jwt: ["eyJ" + "a".repeat(16), "eyJ" + "b".repeat(16), "c".repeat(16)].join("."),
  awsKey: "AKIA" + "X".repeat(16),
  pem: "-----BEGIN " + "PRIVATE KEY-----\nMIIabc\n-----END " + "PRIVATE KEY-----",
  dbUrl: "postgres" + "://user:" + "N0tReal" + "@db.example.test/db",
  bearer: "Bearer " + "z".repeat(32),
};

describe("the closed release table", () => {
  it("is exactly INTEGRATION then MAIN, with their configs and exact task counts", () => {
    expect(RELEASE_PLANES.map((definition) => [definition.plane, definition.config, definition.expectedTasks])).toEqual([
      // Step H6-C3: + ingestion.reconcile_slice (INTEGRATION); + ingestion.reconcile_account, interactions.observed (MAIN).
      // Step H6-E: + ingestion.confirm_interaction (INTEGRATION).
      ["integration", "trigger.integration.config.ts", 7],
      ["main", "trigger.config.ts", 11],
    ]);
    expect(Object.isFrozen(RELEASE_PLANES)).toBe(true);
  });
});

describe("buildReleasePlan", () => {
  it("both planes, in order, from ONE release SHA, with the exact argv", () => {
    const built = plan();
    expect(built.environment).toBe("prod");
    expect(built.steps.map((step) => step.plane)).toEqual(["integration", "main"]);
    const [integration, main] = built.steps;
    expect(integration?.argv).toEqual([
      "deploy", "--config", "trigger.integration.config.ts", "--project-ref", INTEGRATION_REF, "--env", "prod", "--external-id", SHA,
      "--env-file", ENV_FILE, "--depot-build", "--skip-update-check", "--skip-sync-env-vars", "--skip-telemetry",
    ]);
    expect(main?.argv).toEqual([
      "deploy", "--config", "trigger.config.ts", "--project-ref", MAIN_REF, "--env", "prod", "--external-id", SHA,
      "--env-file", ENV_FILE, "--depot-build", "--skip-update-check", "--skip-sync-env-vars", "--skip-telemetry",
    ]);
    expect(new Set(built.steps.map((step) => flagValue(step.argv, "--external-id")))).toEqual(new Set([SHA]));
    for (const step of built.steps) {
      for (const flag of COMMON_SAFETY_FLAGS) expect(step.argv, `${step.plane} ${flag}`).toContain(flag);
      for (const flag of FORBIDDEN_FLAGS) expect(step.argv, `${step.plane} ${flag}`).not.toContain(flag);
      expect(step.argv.filter((token) => token === "--external-id")).toHaveLength(1);
      expect(flagValue(step.argv, "--env-file")).toBe(ENV_FILE);
    }
  });

  it.each([
    ["short SHA", { releaseSha: SHA.slice(0, 12) }],
    ["upper-case SHA", { releaseSha: SHA.toUpperCase() }],
    ["non-hex SHA", { releaseSha: "z".repeat(40) }],
    ["missing SHA", { releaseSha: undefined }],
    ["malformed integration ref", { integrationProjectRef: "integration" }],
    ["malformed main ref", { mainProjectRef: "proj_" }],
    ["ref with injection", { mainProjectRef: "proj_abc --force" }],
    ["missing main ref", { mainProjectRef: undefined }],
    ["equal refs", { mainProjectRef: INTEGRATION_REF }],
    ["empty env file", { emptyEnvFile: " " }],
  ])("refuses %s", (_label, overrides) => {
    expect(() => plan(overrides as Partial<Parameters<typeof buildReleasePlan>[0]>)).toThrow(ReleasePlanError);
  });

  it("the invariant check rejects reordered, single-plane, mixed-SHA, non-prod or flag-stripped plans", () => {
    const built = plan();
    const [integration, main] = built.steps;
    if (integration === undefined || main === undefined) throw new Error("plan");
    const withArgv = (step: typeof main, argv: readonly string[]) => ({ ...step, argv });
    const variants: ReleasePlan[] = [
      { ...built, steps: [main, integration] },
      { ...built, steps: [integration] },
      { ...built, steps: [integration, withArgv(main, main.argv.map((token) => (token === SHA ? "0".repeat(40) : token)))] },
      { ...built, steps: [integration, withArgv(main, main.argv.map((token) => (token === "prod" ? "preview" : token)))] },
      { ...built, steps: [integration, withArgv(main, main.argv.filter((token) => token !== "--depot-build"))] },
      { ...built, steps: [integration, withArgv(main, [...main.argv, "--force"])] },
      { ...built, steps: [integration, withArgv(main, [...main.argv, "--external-id", SHA])] },
      { ...built, steps: [integration, { ...main, projectRef: INTEGRATION_REF, argv: main.argv.map((token) => (token === MAIN_REF ? INTEGRATION_REF : token)) }] },
    ];
    for (const variant of variants) {
      expect(() => {
        assertPlanInvariants(variant);
      }).toThrow(ReleasePlanError);
    }
    expect(() => {
      assertPlanInvariants(built);
    }).not.toThrow();
  });

  it("the temporary env-file path never appears in a shown or recorded argv", () => {
    for (const step of plan().steps) {
      const shown = sanitizeArgv(step.argv);
      expect(shown).not.toContain(ENV_FILE);
      expect(flagValue(shown, "--env-file")).toBe(EMPTY_ENV_FILE_LABEL);
      expect(shown.filter((token) => token !== EMPTY_ENV_FILE_LABEL)).toEqual(step.argv.filter((token) => token !== ENV_FILE));
    }
  });
});

describe("deploy output and the exact task counts", () => {
  const output = (version: string, tasks: number) => `\u001b[32m◇  Successfully deployed version ${version}\u001b[0m\n└  Version ${version} deployed with ${String(tasks)} detected tasks\nView deployment\n`;

  it("parses version and task count (ANSI tolerated); refuses missing, malformed or ambiguous output", () => {
    expect(parseDeployOutput(output("20261021.2", 3))).toEqual({ version: "20261021.2", taskCount: 3 });
    expect(parseDeployOutput("└  Version 20261021.1 deployed with 6 detected tasks")).toEqual({ version: "20261021.1", taskCount: 6 });
    expect(parseDeployOutput("")).toBeUndefined();
    expect(parseDeployOutput("Deployed something")).toBeUndefined();
    expect(parseDeployOutput("Version latest deployed with 3 detected tasks")).toBeUndefined();
    expect(parseDeployOutput(`${output("20261021.2", 3)}${output("20261021.3", 3)}`)).toBeUndefined();
    expect(parseDeployOutput("Successfully deployed version 20261021.9\nVersion 20261021.2 deployed with 3 detected tasks")).toBeUndefined();
  });

  it("PASS only with exit 0, a version and EXACTLY the expected count; everything else is FAILED or UNKNOWN", () => {
    const step = { expectedTasks: 3 };
    const base = { exitCode: 0, output: output("20261021.2", 3), timedOut: false, interrupted: false };
    expect(evaluatePlaneResult(step, base)).toEqual({ state: "PASS", version: "20261021.2", taskCount: 3 });
    expect(evaluatePlaneResult(step, { ...base, exitCode: 1 })).toEqual({ state: "FAILED", reason: "exit_code" });
    expect(evaluatePlaneResult(step, { ...base, exitCode: null })).toEqual({ state: "FAILED", reason: "exit_code" });
    expect(evaluatePlaneResult(step, { ...base, output: "garbage" })).toEqual({ state: "UNKNOWN", reason: "unreadable_output" });
    expect(evaluatePlaneResult(step, { ...base, output: output("20261021.2", 4) })).toMatchObject({ state: "UNKNOWN", reason: "task_count_mismatch", taskCount: 4 });
    expect(evaluatePlaneResult({ expectedTasks: 6 }, { ...base, output: output("20261021.1", 3) })).toMatchObject({ state: "UNKNOWN", reason: "task_count_mismatch" });
    expect(evaluatePlaneResult(step, { ...base, timedOut: true })).toEqual({ state: "UNKNOWN", reason: "timeout" });
    expect(evaluatePlaneResult(step, { ...base, interrupted: true })).toEqual({ state: "UNKNOWN", reason: "interrupted" });
  });
});

describe("redaction", () => {
  it("removes every credential shape, ANSI and e-mail addresses, and keeps the useful lines", () => {
    const text = [
      `key ${synthetic.triggerKey}`,
      `short ${synthetic.shortTriggerKey}`,
      `jwt ${synthetic.jwt}`,
      `aws ${synthetic.awsKey}`,
      synthetic.pem,
      `db ${synthetic.dbUrl}`,
      `auth ${synthetic.bearer}`,
      "api_key=abc123 secret: hunter2",
      "logged in as operator@example.test",
      "\u001b[32m└  Version 20261021.2 deployed with 3 detected tasks\u001b[0m",
    ].join("\n");
    const out = redactReleaseOutput(text);
    for (const value of [...Object.values(synthetic), "abc123", "hunter2", "operator@example.test", "MIIabc", "\u001b["]) expect(out, value).not.toContain(value);
    expect(out).toContain("Version 20261021.2 deployed with 3 detected tasks");
    expect(redactedTail(`${"line\n".repeat(100)}${synthetic.triggerKey}\nlast`, 5)).toEqual(["line", "line", "line", "<redacted>", "last"]);
  });
});

describe("signing-helper precheck (the INTEGRATION image's pinned builds)", () => {
  const bytes = (seed: string) => new TextEncoder().encode(seed);
  const pinned = new Map(AWS_SIGNING_HELPER_ARTIFACTS.map((artifact) => [awsSigningHelperRelativePath(artifact), artifact.sha256]));

  it("by default checks exactly the canonical pins: missing or altered builds are refused", () => {
    const missing = checkHelperBuilds(() => undefined);
    expect(missing.ok).toBe(false);
    expect(missing.problems).toHaveLength(AWS_SIGNING_HELPER_ARTIFACTS.length);
    expect(missing.problems[0]).toMatch(/missing \(run: node tools\/trigger\/fetch-aws-signing-helper\.ts\)/);
    const altered = checkHelperBuilds((relative) => (pinned.has(relative) ? bytes(`not the pinned build ${relative}`) : undefined));
    expect(altered.ok).toBe(false);
    expect(altered.problems.every((problem) => problem.includes("digest mismatch"))).toBe(true);
  });

  it("passes only when EVERY build is present with its exact digest (synthetic artifacts, same path and digest rule)", () => {
    const synthetic = AWS_SIGNING_HELPER_ARTIFACTS.map((artifact) => ({ ...artifact, sha256: createHash("sha256").update(bytes(artifact.directory)).digest("hex") }));
    const files = new Map(synthetic.map((artifact) => [awsSigningHelperRelativePath(artifact), bytes(artifact.directory)]));
    expect(checkHelperBuilds((relative) => files.get(relative), synthetic)).toEqual({ ok: true, problems: [] });
    const [first] = synthetic;
    if (first === undefined) throw new Error("artifacts");
    files.delete(awsSigningHelperRelativePath(first));
    expect(checkHelperBuilds((relative) => files.get(relative), synthetic).ok).toBe(false);
    expect(checkHelperBuilds(() => undefined, []).ok).toBe(false);
  });
});
