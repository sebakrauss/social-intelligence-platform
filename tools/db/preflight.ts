/**
 * Read-only preflight for the SELECTED database target. Run: `npm run db:preflight -- --target development [--connect]`.
 * Without --connect it only inspects the target's local configuration (the same identity fence as db:migrate). With
 * --connect it opens each configured connection and reports current_user / session_user and basic project facts. It
 * never writes anything and never prints a secret.
 */
import { RUNTIME_KINDS, RUNTIME_URL_VARIABLES } from "../../platform/db/connection.ts";
import { prepareTarget, privilegedClient } from "./environment.ts";
import { migrationStatus, readMigrations } from "./migrations.ts";
import pg from "pg";

const args = process.argv.slice(2);
const connect = args.includes("--connect");
const unknown = args.filter((arg, index) => arg !== "--connect" && !arg.startsWith("--target") && args[index - 1] !== "--target");
const fence = prepareTarget(args, { migration: true, runtime: "configured" });

console.log(`Database preflight — target: ${fence.target ?? "none"}`);
for (const line of fence.lines) console.log(line);
if (unknown.length > 0) console.log(`  PROBLEM: unknown argument(s): ${unknown.join(" ")}`);

if (!fence.ok || unknown.length > 0 || fence.report === undefined) {
  console.log("PREFLIGHT: configuration incomplete or unsafe (see PROBLEM lines). Nothing was contacted.");
  process.exit(1);
}
const report = fence.report;
const configuredRuntime = RUNTIME_KINDS.filter((kind) => report.runtime[kind] !== undefined);
if (!connect || report.migration === undefined) {
  console.log("PREFLIGHT: configuration OK (no connection attempted; add --connect to test connectivity).");
  process.exit(0);
}

const ca = fence.ca;
let failed = false;
const migration = privilegedClient(report.migration, ca);
try {
  await migration.connect();
  const who = (await migration.query<{ current: string; session: string; version: string }>(
    "select current_user::text as current, session_user::text as session, current_setting('server_version') as version")).rows[0];
  const facts = (await migration.query<{ spike: number; ours: number }>(
    "select (select count(*)::int from pg_namespace where nspname like 'spike29%') as spike, (select count(*)::int from pg_namespace where nspname in ('tenancy','audit','system','app','app_private')) as ours")).rows[0];
  const status = await migrationStatus(migration, readMigrations());
  console.log(`  migration connection      PASS (current_user=${who?.current ?? "?"}, session_user=${who?.session ?? "?"}, server ${who?.version ?? "?"})`);
  console.log(`  project facts             spike29 schemas=${String(facts?.spike)}, application schemas=${String(facts?.ours)}, migrations applied=${String(status.applied.length)}, pending=${String(status.pending.length)}`);
} catch (error) {
  failed = true;
  console.log(`  migration connection      FAIL (${(error as { code?: string }).code ?? "error"})`);
} finally {
  await migration.end().catch(() => undefined);
}

for (const kind of configuredRuntime) {
  const target = report.runtime[kind];
  if (target === undefined) continue;
  const client = new pg.Client({
    host: target.host, port: target.port, database: target.database, user: target.user, password: target.password,
    ssl: target.endpoint === "local" ? false : { ca, rejectUnauthorized: true },
  });
  try {
    await client.connect();
    const who = (await client.query<{ current: string; session: string }>("select current_user::text as current, session_user::text as session")).rows[0];
    console.log(`  ${RUNTIME_URL_VARIABLES[kind].padEnd(24)} PASS (current_user=${who?.current ?? "?"}, session_user=${who?.session ?? "?"})`);
  } catch (error) {
    failed = true;
    console.log(`  ${RUNTIME_URL_VARIABLES[kind].padEnd(24)} FAIL (${(error as { code?: string }).code ?? "error"})`);
  } finally {
    await client.end().catch(() => undefined);
  }
}
console.log(failed ? "PREFLIGHT: connectivity FAILED" : "PREFLIGHT: connectivity PASS");
process.exit(failed ? 1 : 0);
