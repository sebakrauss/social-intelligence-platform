/**
 * Creates (if absent) or validates the long-lived runtime login roles web_login, worker_login and
 * system_login, each granted only its fixed target role (R1, R8).
 * Run: `npm run db:provision-roles` (plan) · `-- --apply` (create/validate) · `-- --apply --rotate` (in-place
 * password rotation of existing roles to the passwords now in the runtime URLs).
 *
 * Passwords come only from the runtime URLs in `.env.local` and are sent as SCRAM verifiers; they are never
 * printed or written anywhere. Nothing is ever dropped or recreated.
 */
import { RUNTIME_KINDS } from "../../platform/db/connection.ts";
import { checkTarget, EXPECTED_PROJECT_LABEL, loadEnvironment, privilegedClient, readCa, runtimePasswords } from "./environment.ts";
import { loginRoleProblems, provisionLoginRoles } from "./provision.ts";

const env = loadEnvironment();
const apply = process.argv.includes("--apply");
const rotate = process.argv.includes("--rotate");
const report = checkTarget(env, { migration: true, runtime: [...RUNTIME_KINDS] });

console.log(`Login role provisioning plan (no secrets) — target ${EXPECTED_PROJECT_LABEL}`);
for (const line of report.lines) console.log(line);
console.log("  web_login → authenticated · worker_login → app_worker · system_login → app_system");
console.log(`  mode: ${apply ? (rotate ? "apply + in-place password rotation" : "apply (create if absent, otherwise validate)") : "plan only"}; role drops NONE`);
if (!report.ok || report.migration === undefined) {
  console.log("REFUSED: configuration incomplete or unsafe. Nothing was contacted.");
  process.exit(1);
}

const client = privilegedClient(report.migration, readCa(env));
try {
  await client.connect();
  if (!apply) {
    for (const kind of RUNTIME_KINDS) {
      const problems = await loginRoleProblems(client, kind);
      console.log(`  ${kind.padEnd(7)} ${problems.length === 0 ? "exists and valid" : problems.join("; ")}`);
    }
    console.log("PLAN ONLY: re-run with --apply.");
  } else {
    const states = await provisionLoginRoles(client, runtimePasswords(env), { rotate });
    for (const state of states) {
      console.log(`  ${state.login.padEnd(13)} ${state.action}${state.problems.length === 0 ? " · valid" : ` · PROBLEMS: ${state.problems.join("; ")}`}`);
    }
    if (states.some((state) => state.problems.length > 0)) process.exitCode = 1;
  }
} catch (error) {
  console.log(`FAILED: ${(error as { code?: string }).code ?? (error instanceof Error ? error.message : "error")}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
