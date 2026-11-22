/**
 * RECOVERY-TOOLING-01 — synthetic fixtures for the recovery planner and operator tests: release-tool evidence records,
 * provider (CLI MCP) text outputs and deploy outputs, in the exact formats the real tools produce. Synthetic project
 * identities only; nothing here names a real project.
 */
import type { ReleasePlane } from "../../../tools/trigger/release-pair.ts";

export const KNOWN_GOOD = "ff5269ceec39ff6f4e41dcd94afdd127f2e7d92a".replace(/^ff5269ce/, "0a1b2c3d");
export const BAD = "bad0".repeat(10);
export const REFS: Readonly<Record<ReleasePlane, string>> = { main: "proj_maintestrefabcdefghij", intelligence: "proj_intelligencetestref1", integration: "proj_integrationtestref01" };
export const KNOWN_GOOD_VERSION = "20261113.1";
export const TASKS: Readonly<Record<ReleasePlane, number>> = { integration: 10, intelligence: 1, main: 11 };
export const BASELINE: Readonly<Record<ReleasePlane, string>> = { main: "1".repeat(32), intelligence: "2".repeat(32), integration: "3".repeat(32) };
export const EVIDENCE_NAME = `2026-11-13T000143765Z-${KNOWN_GOOD.slice(0, 12)}.json`;

const CONFIG: Readonly<Record<ReleasePlane, string>> = { integration: "trigger.integration.config.ts", intelligence: "trigger.intelligence.config.ts", main: "trigger.config.ts" };

/** A release-tool evidence record (v2 = no fingerprints, v3 = fingerprints), optionally tampered. */
export function releaseRecord(options: { readonly schema?: "v2" | "v3"; readonly sha?: string; readonly version?: string; readonly refs?: Partial<Record<ReleasePlane, string>>; readonly mutate?: (record: Record<string, unknown>) => void } = {}): string {
  const sha = options.sha ?? KNOWN_GOOD;
  const schema = options.schema ?? "v3";
  const refs = { ...REFS, ...options.refs };
  const planes = (["integration", "intelligence", "main"] as const).map((plane) => ({
    plane,
    config: CONFIG[plane],
    argv: ["deploy", "--config", CONFIG[plane], "--project-ref", refs[plane], "--env", "prod", "--external-id", sha, "--env-file", "<tool-empty-env-file>", "--depot-build", "--skip-update-check", "--skip-sync-env-vars", "--skip-telemetry"],
    expectedTasks: TASKS[plane],
    exitCode: 0,
    outcome: { state: "PASS", version: options.version ?? KNOWN_GOOD_VERSION, taskCount: TASKS[plane] },
    ...(schema === "v3" ? { contentHash: BASELINE[plane] } : {}),
    outputTail: [],
  }));
  const record: Record<string, unknown> = {
    schema: `wrenkind.trigger-release-pair.${schema}`,
    tool: "tools/trigger/deploy-release-pair.ts",
    startedAt: "2026-11-13T00:01:43.765Z",
    finishedAt: "2026-11-13T00:03:09.832Z",
    releaseSha: sha,
    environment: "prod",
    planeOrder: ["integration", "intelligence", "main"],
    sameReleaseShaInEveryArgv: true,
    identityChecks: [{ before: "integration", ok: true }, { before: "intelligence", ok: true }, { before: "main", ok: true }, { before: "final", ok: true }],
    planes,
    planesNotStarted: [],
    finalState: "ALIGNED",
  };
  options.mutate?.(record);
  return JSON.stringify(record);
}

export const DIRECTORY: Readonly<Record<ReleasePlane, string>> = { main: "jobs/trigger/main", intelligence: "jobs/trigger/intelligence", integration: "jobs/trigger/integration" };

/** `get_current_worker` text, exactly as the CLI's MCP server formats it. */
export function currentWorkerText(version: string, plane: ReleasePlane, options: { readonly count?: number; readonly directory?: string; readonly duplicate?: boolean } = {}): string {
  const count = options.count ?? TASKS[plane];
  const directory = options.directory ?? DIRECTORY[plane];
  const tasks = Array.from({ length: count }, (_, index) => `- ${plane}.task_${String(options.duplicate === true ? 0 : index)} in ${directory}/file-${String(index)}.ts`);
  return [
    `Current worker for prod is ${version} using 4.7.2 of the SDK.`,
    `The worker has ${String(count)} tasks registered:`,
    ...tasks,
    "",
    "Use the `get_task_schema` tool with a task slug to get its payload schema.",
    "\n",
    "URLs:",
    "- Runs: https://cloud.example.invalid/runs",
    "\n",
    `You can use the list_runs tool with the version ${version} to get the list of runs for this worker.`,
  ].join("\n");
}

export function deployListText(entries: readonly { readonly version: string; readonly status: string; readonly shortCode?: string }[], options: { readonly morePages?: boolean } = {}): string {
  return [
    `Found ${String(entries.length)} deployment${entries.length === 1 ? "" : "s"}`,
    "",
    ...entries.map((entry, index) => `- ${entry.shortCode ?? `code${String(index)}`} | v${entry.version} | ${entry.status} | ${entry.status === "DEPLOYED" ? "2026-11-13 00:02:00 UTC" : "1970-01-01 00:00:00 UTC"}`),
    ...(options.morePages === true ? ["", "Next page available →"] : []),
  ].join("\n");
}

export const runListText = (count: number): string => (count === 0 ? "Found 0 runs\n\nNo runs found." : [`Found ${String(count)} runs`, "", ...Array.from({ length: count }, (_, index) => `${String(index + 1)}. run_x${String(index)} | task | EXECUTING`)].join("\n"));

/** A deploy's CLI output: the build log's worker line (optional) and the CLI's own success lines. */
export function deployOutput(version: string, tasks: number, contentHash?: string): string {
  const created = contentHash === undefined ? "" : `#19 1.107 {"message":"Background worker created","buildPlatform":"linux/amd64","targetPlatform":"linux/amd64","createResponse":{"id":"worker_synthetic","version":"${version}","contentHash":"${contentHash}","warnings":[]}}\n`;
  return `${created}◇  Successfully deployed version ${version}\n│\n└  Version ${version} deployed with ${String(tasks)} detected task${tasks === 1 ? "" : "s"}\n`;
}
