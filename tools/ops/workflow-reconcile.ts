/**
 * WORKFLOW-WF-2C — operator CLI: reconcile one workspace's Workflow work items (missing items, stale activity; Done items
 * that may have missed a reopen are REPORTED, never changed). DRY RUN by default. Run from the repository root:
 *
 *   npm run ops:workflow-reconcile -- --database-url-env <VAR> --workspace <uuid> [--batch 100] [--after <uuid>] [--max-batches <n>] [--run <id>] [--apply]
 *   npm run ops:workflow-reconcile -- --target development --database-url-env DATABASE_WORKER_URL --workspace <uuid> …
 *                                     [--apply --confirm-dev-reconcile <DEV_RECONCILE_CONFIRMATION>]
 *
 * Before anything connects: the arguments are parsed (anything unexpected → exit 2) and the target is fenced
 * (tools/ops/workflow-reconcile-command.ts: a loopback host by default; with `--target development` exactly the pinned
 * social-intelligence-dev-v2 worker login, TLS-verified → otherwise exit 1). Then the run happens
 * inside vitest (the application's module resolution, as tools/db/dev-fixture.ts does), whose operator file re-checks
 * both before connecting. No .env file is read; no secret is printed. Output: one JSON line per committed batch, then
 * the run's report (counts: inspected · created · repaired · unchanged · failed · review; ids only).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describeReconcileTarget, parseReconcileCommand, RECONCILE_PARAMETERS_VARIABLE, reconcileTargetProblems } from "./workflow-reconcile-command.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const parsed = parseReconcileCommand(process.argv.slice(2));
if (!parsed.ok) {
  console.log(`REFUSED: ${parsed.problem}. Nothing was contacted.`);
  process.exit(2);
}
const problems = reconcileTargetProblems(process.env[parsed.command.databaseUrlEnv], parsed.command.target, process.env);
if (problems.length > 0) {
  for (const problem of problems) console.log(`REFUSED: ${problem}. Nothing was contacted.`);
  process.exit(1);
}
console.log(`Workflow reconciliation — ${parsed.command.apply ? "APPLY" : "DRY RUN"} — workspace ${parsed.command.workspaceId} — batch ${String(parsed.command.batchSize)} — target: ${describeReconcileTarget(parsed.command)}`);
const result = spawnSync(path.join(ROOT, "node_modules/.bin/vitest"), ["run", "--config", "vitest.workflow-reconcile.config.ts"], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, [RECONCILE_PARAMETERS_VARIABLE]: JSON.stringify(process.argv.slice(2)) },
});
process.exit(result.status ?? 1);
