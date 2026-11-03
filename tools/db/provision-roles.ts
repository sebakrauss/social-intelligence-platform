/**
 * Creates (if absent) or validates the long-lived runtime login roles web_login, worker_login and
 * system_login of the SELECTED target, each granted only its fixed target role (R1, R8).
 * Run: `npm run db:provision-roles -- --target development` (plan) · `-- --target development --apply`
 * (create/validate) · `-- --target development --apply --rotate` (in-place password rotation of existing roles to the
 * passwords now in the runtime URLs). `--target production` reads only `.env.database-production.local`.
 *
 * The same identity fence as db:migrate runs before any connection (explicit target, complete authority, every URL on
 * the expected project and region, migration role, strict CA). Passwords come only from the target's runtime URLs and
 * are sent as SCRAM verifiers; they are never printed or written anywhere. Nothing is ever dropped or recreated.
 */
import { RUNTIME_KINDS } from "../../platform/db/connection.ts";
import { prepareTarget, privilegedClient, runtimePasswords } from "./environment.ts";
import { loginRoleProblems, provisionLoginRoles } from "./provision.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const rotate = args.includes("--rotate");
const unknown = args.filter((arg, index) => arg !== "--apply" && arg !== "--rotate" && !arg.startsWith("--target") && args[index - 1] !== "--target");
const fence = prepareTarget(args, { migration: true, runtime: [...RUNTIME_KINDS] });

console.log(`Login role provisioning plan (no secrets) — target ${fence.target ?? "none"}`);
for (const line of fence.lines) console.log(line);
console.log("  web_login → authenticated · worker_login → app_worker · system_login → app_system");
console.log(`  mode: ${apply ? (rotate ? "apply + in-place password rotation" : "apply (create if absent, otherwise validate)") : "plan only"}; role drops NONE`);
if (unknown.length > 0) console.log(`  PROBLEM: unknown argument(s): ${unknown.join(" ")}`);
if (rotate && !apply) console.log("  PROBLEM: --rotate is only valid with --apply");
if (!fence.ok || unknown.length > 0 || (rotate && !apply) || fence.report?.migration === undefined) {
  console.log("REFUSED: configuration incomplete or unsafe. Nothing was contacted.");
  process.exit(1);
}
const env = fence.env;

const client = privilegedClient(fence.report.migration, fence.ca);
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
