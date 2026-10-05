/**
 * Read-only preflight for the managed development database. Run: `npm run db:preflight [-- --connect]`.
 * Without --connect it only inspects local configuration. With --connect it opens each configured
 * connection and reports current_user / session_user and basic project facts. It never writes anything
 * and never prints a secret.
 */
import { RUNTIME_KINDS, RUNTIME_URL_VARIABLES } from "../../platform/db/connection.ts";
import { checkTarget, EXPECTED_PROJECT_LABEL, loadEnvironment, privilegedClient, readCa } from "./environment.ts";
import { migrationStatus, readMigrations } from "./migrations.ts";
import pg from "pg";

const env = loadEnvironment();
const connect = process.argv.includes("--connect");
const configuredRuntime = RUNTIME_KINDS.filter((kind) => (env[RUNTIME_URL_VARIABLES[kind]] ?? "") !== "");
const report = checkTarget(env, { migration: true, runtime: configuredRuntime });

console.log(`Database preflight — expected target: ${EXPECTED_PROJECT_LABEL} (South America / São Paulo)`);
for (const line of report.lines) console.log(line);

if (!report.ok) {
  console.log("PREFLIGHT: configuration incomplete or unsafe (see PROBLEM lines). Nothing was contacted.");
  process.exit(1);
}
if (!connect || report.migration === undefined) {
  console.log("PREFLIGHT: configuration OK (no connection attempted; add --connect to test connectivity).");
  process.exit(0);
}

const ca = readCa(env);
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
