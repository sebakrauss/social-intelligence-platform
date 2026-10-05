/**
 * Applies schema migrations to the configured database with the privileged migration credential.
 * Run: `npm run db:migrate` (plan only) · `npm run db:migrate -- --apply` (apply).
 *
 * Always prints a secret-free plan first. Refuses to run unless every configured URL points at the same,
 * expected development project (SUPABASE_PROJECT_REF) and not at the frozen validation project.
 * Migrations create or validate NOLOGIN foundation roles only; they never drop or recreate a role (R8).
 */
import { checkTarget, EXPECTED_PROJECT_LABEL, EXPECTED_REGION, loadEnvironment, privilegedClient, readCa } from "./environment.ts";
import { applyMigrations, migrationStatus, readMigrations } from "./migrations.ts";

const env = loadEnvironment();
const apply = process.argv.includes("--apply");
const report = checkTarget(env, { migration: true, runtime: [] });
const migrations = readMigrations();

console.log("Migration plan (no secrets)");
console.log(`  target project label     ${EXPECTED_PROJECT_LABEL}`);
console.log(`  expected region          ${EXPECTED_REGION} (South America / São Paulo)`);
for (const line of report.lines) console.log(line);
if (!report.ok || report.migration === undefined) {
  console.log("REFUSED: configuration incomplete or unsafe. Nothing was contacted.");
  process.exit(1);
}

const client = privilegedClient(report.migration, readCa(env));
try {
  await client.connect();
  const status = await migrationStatus(client, migrations);
  console.log(`  migrations in repository ${String(migrations.length)}`);
  console.log(`  already applied          ${String(status.applied.length)}`);
  console.log(`  pending                  ${status.pending.map((migration) => migration.name).join(", ") || "none"}`);
  console.log("  roles                    create-if-absent / validate: app_owner, app_worker, app_system (NOLOGIN); requires existing: authenticated");
  console.log("  schemas/tables           app, app_private.context_secret, tenancy.{organizations,workspaces,organization_memberships,workspace_memberships,invitations}, audit.audit_events, system.{outbox,outbox_runs,operational_switches,operational_switch_changes}, idempotency.effect_keys, app_migrations.applied");
  console.log("  role drops               NONE · destructive statements NONE · login roles untouched (see db:provision-roles)");
  if (!apply) {
    console.log("DRY RUN: re-run with --apply to apply the pending migrations.");
  } else {
    const applied = await applyMigrations(client, migrations);
    console.log(`APPLIED: ${applied.join(", ") || "nothing (already up to date)"}`);
  }
} catch (error) {
  console.log(`FAILED: ${(error as { code?: string }).code ?? (error instanceof Error ? error.message : "error")}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
