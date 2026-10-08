/**
 * Execution-plane guards (Step 7E.4B.3). Two Trigger.dev projects, split by credential-opening capability:
 *
 *   MAIN          trigger.config.ts → jobs/trigger/main         relay, sweepers, Move saga (6 tasks)
 *   INTEGRATION   trigger.integration.config.ts → jobs/trigger/integration   the only opener tasks (2 tasks)
 *
 * These prove the split statically: explicit planes in the registry, disjoint discovery, the TRANSITIVE import graph of
 * each plane (the opener never reachable from main; the system database and delivery never reachable from integration),
 * the persisted plane — never the registry — selecting the runtime, and the cross-project credentials' confinement.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { cruise, type ICruiseOptions, type ICruiseResult } from "dependency-cruiser";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";
import { describe, expect, it } from "vitest";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { outboxRuns } from "@/platform/db";
import { codeOf, codeWithoutForbiddenList, findReferences, sourceFiles, WEB_ENVIRONMENT_GUARD } from "../support/source-scan";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const depcruise = require(path.join(root, ".dependency-cruiser.cjs")) as { options: ICruiseOptions };

const MAIN_TASKS = ["outbox.relay", "outbox.dispatch_sweep", "outbox.outcome_sweep", "connections.move.release_source", "connections.move.activate_destination", "connections.move.reject_destination"];
const INTEGRATION_TASKS = ["connections.discover_assets", "capability.evaluate_account"];
const PLANE_DIRS = { main: "jobs/trigger/main", integration: "jobs/trigger/integration" } as const;
const OPENER = /^(jobs\/connections\.ts|platform\/crypto\/credentials\/(open|local-opener|local-keyring|aead|aws-kms-unwrapper|aws-kms-opener)\.ts)$/;
const MAIN_ONLY = /^(jobs\/main-runtime\.ts|jobs\/moves\.ts|platform\/outbox\/delivery\.ts|platform\/db\/(system-scope|outbox-delivery)\.ts)$/;

/** Task ids declared by the task files of one plane directory (wrapper calls and direct task definitions). */
function discoveredTasks(dir: string): string[] {
  const ids: string[] = [];
  for (const file of sourceFiles([dir])) {
    const code = codeOf(file);
    for (const match of code.matchAll(/define(?:Tenant|TenantStep)Task\(PRODUCTION_TASKS, "([^"]+)"/g)) ids.push(match[1] ?? "");
    for (const match of code.matchAll(/\btask\(\{\s*id: "([^"]+)"/g)) ids.push(match[1] ?? "");
  }
  return ids.sort();
}

/** Every repository module transitively imported from one plane's task directory. */
async function reachable(dir: string): Promise<string[]> {
  const result = await cruise([dir], { ...depcruise.options, validate: false }, undefined, { tsConfig: extractTSConfig(path.join(root, "tsconfig.json")) });
  return (result.output as ICruiseResult).modules.map((module) => module.source).filter((source) => !source.includes("node_modules")).sort();
}

describe("registry: every task declares its plane explicitly", () => {
  it("exactly the six main and the two integration tasks, by explicit declaration", () => {
    expect(PRODUCTION_TASKS.tasks.map((task) => task.name).sort()).toEqual([...MAIN_TASKS, ...INTEGRATION_TASKS].sort());
    for (const task of PRODUCTION_TASKS.tasks) expect(task.executionPlane, task.name).toBe(INTEGRATION_TASKS.includes(task.name) ? "integration" : "main");
    expect(Object.entries(PRODUCTION_TASKS.unboundRoutes).filter(([, plane]) => plane === "integration").map(([name]) => name).sort()).toEqual([...INTEGRATION_TASKS].sort());
    // Declared literally, once per task — never inferred from a name, directory or scope.
    expect(codeOf("jobs/registry.ts").match(/executionPlane: "(main|integration)"/g)).toHaveLength(PRODUCTION_TASKS.tasks.length);
  });

  it("no routing by string prefix anywhere in the routing path", () => {
    for (const file of ["jobs/registry.ts", "platform/jobs/registry.ts", "platform/jobs/planes.ts", "platform/outbox/delivery.ts", "platform/db/outbox-delivery.ts", "jobs/runtime.ts", "jobs/main-runtime.ts"]) {
      expect(codeOf(file), file).not.toMatch(/\.startsWith\(|\.endsWith\(|\bconnections\.\*|split\("\."\)/);
    }
  });
});

describe("discovery: one config per plane, disjoint task directories", () => {
  it("each config discovers exactly its plane's directory and pins Node 22", () => {
    const main = codeOf("trigger.config.ts");
    const integration = codeOf("trigger.integration.config.ts");
    expect(main.match(/dirs:\s*\[([^\]]*)\]/)?.[1]).toBe('"./jobs/trigger/main"');
    expect(integration.match(/dirs:\s*\[([^\]]*)\]/)?.[1]).toBe('"./jobs/trigger/integration"');
    for (const config of [main, integration]) expect(config).toMatch(/runtime: "node-22",/);
  });

  it("the plane directories declare disjoint task sets whose union is exactly the registry", () => {
    const main = discoveredTasks(PLANE_DIRS.main);
    const integration = discoveredTasks(PLANE_DIRS.integration);
    expect(main).toEqual([...MAIN_TASKS].sort());
    expect(integration).toEqual([...INTEGRATION_TASKS].sort());
    expect(main.filter((task) => integration.includes(task))).toEqual([]);
    for (const task of main) expect(PRODUCTION_TASKS.get(task)?.executionPlane, task).toBe("main");
    for (const task of integration) expect(PRODUCTION_TASKS.get(task)?.executionPlane, task).toBe("integration");
    // Shared helpers (define.ts, queues.ts) sit outside both discovered directories and declare no task.
    expect(readdirSync(path.join(root, "jobs/trigger")).filter((entry) => entry.endsWith(".ts")).sort()).toEqual(["define.ts", "queues.ts"]);
  });
});

describe("transitive import graphs of the two planes", () => {
  it("the main plane never reaches the CredentialOpener composition or any opening primitive", async () => {
    const modules = await reachable(PLANE_DIRS.main);
    expect(modules).toContain("jobs/moves.ts");
    expect(modules).toContain("platform/outbox/delivery.ts");
    expect(modules.filter((source) => OPENER.test(source))).toEqual([]);
  }, 60_000);

  it("the integration plane reaches the opener only through jobs/connections.ts and never the system DB, delivery or Move saga", async () => {
    const modules = await reachable(PLANE_DIRS.integration);
    expect(modules).toContain("jobs/connections.ts");
    expect(modules).toContain("platform/crypto/credentials/aws-kms-opener.ts");
    expect(modules.filter((source) => MAIN_ONLY.test(source))).toEqual([]);
    const code = modules.filter((source) => /^(jobs|platform|server|modules)\//.test(source)).map((source) => codeOf(source)).join("\n");
    expect(code).not.toMatch(/createRuntimeDatabaseFromEnv\(\s*"system"/);
  }, 60_000);
});

describe("the persisted plane selects the runtime; no cross-plane fallback", () => {
  const delivery = codeOf("platform/outbox/delivery.ts");

  it("dispatch and run lookup index the runtimes by the row's persisted plane only", () => {
    expect(delivery.match(/deps\.runtimes\[row\.executionPlane\]\.enqueue\(/g)).toHaveLength(1);
    expect(delivery.match(/deps\.runtimes\[row\.executionPlane\]\.getRun\(/g)).toHaveLength(1);
    expect(delivery.match(/\.getRun\(/g)).toHaveLength(1);
    expect(delivery).not.toMatch(/runtimes\.(main|integration)|runtimes\["|runtimes\[definition/);
  });

  it("the claim binds from the registry routes in the same statement and returns the persisted plane", () => {
    const store = codeOf("platform/db/outbox-delivery.ts");
    expect(store).toMatch(/execution_plane = coalesce\(o\.execution_plane, \$\{routes\}::jsonb ->> o\.topic\)/);
    expect(store).toMatch(/returning[\s\S]*o\.execution_plane`\);/);
  });

  it("system.outbox_runs stays plane-free; the plane lives on the logical delivery (0011); no 0012 exists", () => {
    expect(Object.keys(outboxRuns)).not.toContain("executionPlane");
    expect(readdirSync(path.join(root, "db/migrations")).filter((file) => file.startsWith("0012"))).toEqual([]);
  });
});

describe("cross-project credentials", () => {
  const NAMES = /\bTRIGGER_(INTEGRATION_TASK_OPERATOR_KEY|MAIN_RELAY_TRIGGER_KEY|INTEGRATION_PROJECT_REF)\b/;
  const RUNTIME = ["app", "ui", "server", "platform", "jobs", "modules", "integrations", "domain", "proxy.ts", "next.config.ts", "trigger.config.ts"];

  it("named only by the per-plane contract and the integration config, refused by the hosted web, unknown to the web otherwise", () => {
    const users = findReferences(sourceFiles(RUNTIME).filter((file) => file !== WEB_ENVIRONMENT_GUARD), [NAMES]).map(([file]) => file);
    expect(users).toEqual(["jobs/plane-environment.ts"]);
    expect(codeOf("trigger.integration.config.ts")).toMatch(/process\.env\["TRIGGER_INTEGRATION_PROJECT_REF"\]/);
    expect(NAMES.test(codeWithoutForbiddenList(WEB_ENVIRONMENT_GUARD))).toBe(false);
    expect(readFileSync(path.join(root, WEB_ENVIRONMENT_GUARD), "utf8")).toMatch(/"TRIGGER_INTEGRATION_TASK_OPERATOR_KEY",\s*"TRIGGER_MAIN_RELAY_TRIGGER_KEY",\s*"TRIGGER_INTEGRATION_PROJECT_REF",/);
  });

  it("no global SDK configuration: every Trigger.dev client is an explicit instance with an explicit credential", () => {
    const adapter = codeOf("platform/jobs/trigger-dev.ts");
    expect(adapter).not.toMatch(/\bconfigure\(/);
    expect(adapter.match(/new TriggerClient\(/g)).toHaveLength(1);
    expect(findReferences(sourceFiles(RUNTIME), [/\bconfigure\(\{/, /\bauth\.withAuth\(/])).toEqual([]);
    // The cross-project runtimes read only their own named key, never TRIGGER_SECRET_KEY.
    for (const [file, fn] of [["jobs/runtime.ts", "mainRemoteFromIntegration"], ["jobs/main-runtime.ts", "integrationRemoteFromMain"]] as const) {
      const body = codeOf(file).split(`export function ${fn}(`)[1]?.split(/\nexport /)[0] ?? "";
      expect(body, fn).not.toMatch(/TRIGGER_SECRET_KEY/);
      expect(body, fn).toMatch(/branch: "none"/);
      expect(body, fn).toMatch(/crossPlanePin\(release\)/);
    }
  });

  it("no worker AWS identity yet: no STS client, no AssumeRole, no bootstrap credential names in the jobs planes", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect({ ...manifest.dependencies, ...manifest.devDependencies }["@aws-sdk/client-sts"]).toBeUndefined();
    expect(findReferences(sourceFiles(["jobs", "trigger.config.ts", "trigger.integration.config.ts"]), [/AssumeRole|client-sts|STSClient/, /BOOTSTRAP_|CREDENTIAL_KMS_WORKER/i, /\bAWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)\b/])).toEqual([]);
  });
});
