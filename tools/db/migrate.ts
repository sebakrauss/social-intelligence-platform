/**
 * Applies schema migrations to the SELECTED target with that target's privileged migration credential.
 * Run: `npm run db:migrate -- --target development` (plan only) · `npm run db:migrate -- --target development --apply`.
 * `--target production` reads only `.env.database-production.local` and must prove its explicit identity authority.
 *
 * Always prints a secret-free plan first. Refuses — before any connection — unless the target is explicit, its
 * configuration and identity authority (environment class, expected project ref, expected region) are complete, every
 * configured URL is on that project and region, the migration URL uses the migration role, and the CA bundle passes
 * the runtime's strict parser; TLS is then verified by the connection itself. Never the frozen validation project.
 * Migrations create or validate NOLOGIN foundation roles only; they never drop or recreate a role (R8).
 */
import { privilegedClient, prepareTarget } from "./environment.ts";
import { applyMigrations, migrationStatus, readMigrations } from "./migrations.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const unknown = args.filter((arg, index) => arg !== "--apply" && !arg.startsWith("--target") && args[index - 1] !== "--target");
const fence = prepareTarget(args, { migration: true, runtime: "configured" });
const migrations = readMigrations();

console.log("Migration plan (no secrets)");
for (const line of fence.lines) console.log(line);
if (unknown.length > 0) console.log(`  PROBLEM: unknown argument(s): ${unknown.join(" ")}`);
if (!fence.ok || unknown.length > 0 || fence.report?.migration === undefined) {
  console.log("REFUSED: configuration incomplete or unsafe. Nothing was contacted.");
  process.exit(1);
}

const client = privilegedClient(fence.report.migration, fence.ca);
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
