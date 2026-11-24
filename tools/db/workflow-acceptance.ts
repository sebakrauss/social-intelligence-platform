/**
 * W12-PREP-01 — operator CLI of the shared-dev Comments Workflow acceptance fixture (DEV-PREFLIGHT-01 §8; runbook
 * step 8, W12). Run from the repository root:
 *
 *   npm run db:workflow-acceptance -- fixture                                         PLAN (default): read-only
 *   npm run db:workflow-acceptance -- fixture --apply --confirm <fixture phrase>      hierarchy + 7 conversations, once
 *   npm run db:workflow-acceptance -- reply --kind audience|account [--apply --confirm <reply phrase>]
 *   npm run db:workflow-acceptance -- members --u1 <uuid> --u2 <uuid> [--apply --confirm <members phrase>]
 *   npm run db:workflow-acceptance -- role --u2 <uuid> --from <ROLE> --to <ROLE> [--apply --confirm <role phrase>]
 *   npm run db:workflow-acceptance -- verify --u1 <uuid> --u2 <uuid>                  read-only, always
 *
 * Before anything connects: the arguments are parsed (anything unexpected → exit 2, nothing runs) and the target is
 * proven to be exactly social-intelligence-dev-v2 (tools/db/dev-fixture-guard.ts; otherwise exit 1). Then the operation
 * runs inside vitest (the same module resolution as the managed suites), whose global setup re-parses the arguments and
 * re-checks the target, the migration ledger and the worker login role before connecting. No delete or reset mode
 * exists; every write is permanent (PO acceptance, W12-UNBLOCK-01 §3B).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { devFixtureTargetProblems } from "./dev-fixture-guard.ts";
import { checkTarget, EXPECTED_PROJECT_LABEL, loadEnvironment, ROOT } from "./environment.ts";
import { parseWorkflowAcceptanceArguments, WORKFLOW_ACCEPTANCE_ARGS_VARIABLE } from "./workflow-acceptance-guard.ts";

const args = process.argv.slice(2);
const parsed = parseWorkflowAcceptanceArguments(args);
if ("error" in parsed) {
  console.log(`workflow acceptance REFUSED (nothing ran): ${parsed.error}`);
  console.log("usage: npm run db:workflow-acceptance -- fixture|reply|members|role|verify [flags] [--apply --confirm <phrase>]");
  process.exit(2);
}

const env = loadEnvironment();
const report = checkTarget(env, { migration: true, runtime: ["worker"] });
console.log(`W12 workflow acceptance — ${parsed.operation.command} — mode ${parsed.operation.mode.toUpperCase()} — expected target ${EXPECTED_PROJECT_LABEL}`);
for (const line of report.lines) console.log(line);
const problems = devFixtureTargetProblems(env, report);
if (problems.length > 0) {
  for (const problem of problems) console.log(`  REFUSED: ${problem}`);
  console.log("workflow acceptance REFUSED (nothing connected)");
  process.exit(1);
}

const result = spawnSync(path.join(ROOT, "node_modules/.bin/vitest"), ["run", "--config", "vitest.workflow-acceptance.config.ts"], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, [WORKFLOW_ACCEPTANCE_ARGS_VARIABLE]: JSON.stringify(args) },
});
process.exit(result.status ?? 1);
