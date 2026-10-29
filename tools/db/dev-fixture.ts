/**
 * Step H7-B1b-0 — operator CLI of the shared-dev deterministic Classification acceptance fixture
 * (tests/db/dev-fixtures/classification-acceptance.ts). Run from the repository root:
 *
 *   npm run db:dev-fixture                                                              PLAN (default): read-only
 *   npm run db:dev-fixture -- --apply --confirm-dev-fixture <DEV_FIXTURE_CONFIRMATION>   creates / verifies it once
 *
 * Before anything connects: the arguments are parsed (anything unexpected → exit 2, nothing runs) and the target is
 * proven to be exactly social-intelligence-dev-v2 (tools/db/dev-fixture-guard.ts; otherwise exit 1). Then the fixture
 * runs inside vitest (the same module resolution as the managed suites), whose global setup re-checks the target, the
 * migration ledger and the worker login role before connecting. No delete or reset mode exists.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  DEV_FIXTURE_CONFIRMATION,
  DEV_FIXTURE_CONFIRMATION_VARIABLE,
  DEV_FIXTURE_MODE_VARIABLE,
  devFixtureTargetProblems,
  parseDevFixtureArguments,
} from "./dev-fixture-guard.ts";
import { checkTarget, EXPECTED_PROJECT_LABEL, loadEnvironment, ROOT } from "./environment.ts";

const parsed = parseDevFixtureArguments(process.argv.slice(2));
if ("error" in parsed) {
  console.log(`dev fixture REFUSED (nothing ran): ${parsed.error}`);
  console.log("usage: npm run db:dev-fixture [-- --apply --confirm-dev-fixture <phrase>]");
  process.exit(2);
}

const env = loadEnvironment();
const report = checkTarget(env, { migration: true, runtime: ["worker"] });
console.log(`H7 classification acceptance fixture — mode ${parsed.mode.toUpperCase()} — expected target ${EXPECTED_PROJECT_LABEL}`);
for (const line of report.lines) console.log(line);
const problems = devFixtureTargetProblems(env, report);
if (problems.length > 0) {
  for (const problem of problems) console.log(`  REFUSED: ${problem}`);
  console.log("dev fixture REFUSED (nothing connected)");
  process.exit(1);
}

const result = spawnSync(path.join(ROOT, "node_modules/.bin/vitest"), ["run", "--config", "vitest.dev-fixture.config.ts"], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    [DEV_FIXTURE_MODE_VARIABLE]: parsed.mode,
    [DEV_FIXTURE_CONFIRMATION_VARIABLE]: parsed.mode === "apply" ? DEV_FIXTURE_CONFIRMATION : "",
  },
});
process.exit(result.status ?? 1);
