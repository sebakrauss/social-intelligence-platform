/**
 * Operator CLI for operational switches (TA §66). One switch per invocation, on an EXPLICIT database target, behind the
 * same identity fence as the database tooling (`--target production` reads only `.env.database-production.local`
 * and must prove class, project reference, region and a strict CA; never a fallback to development). Prints no secrets.
 *
 *   npm run ops:switch -- show  --target production --key ai.task_kill --qualifier classification_understanding
 *   npm run ops:switch -- set   --target development --key automation.global_kill --scope global --value '{"active":true}' --operator <id> --reason incident [--apply]
 *   npm run ops:switch -- set   --target production  --key ai.task_kill --qualifier classification_understanding --scope global --value '{"active":true}' --operator <id> --reason release [--apply --confirm-production]
 *   npm run ops:switch -- clear --target development --key automation.global_kill --scope global --operator <id> --reason rollback [--apply]
 *
 * Every run first reads the stored row (read-only transaction) and prints the exact transition; without `--apply`
 * that is all it does. A write is idempotent (an identical value writes nothing) and is verified afterwards: the row
 * is re-read, the whole switch table is compared with its pre-write snapshot (nothing else may have moved) and the
 * runtime's own resolver reports what readers now see.
 */
import { prepareTarget, privilegedClient } from "../db/environment.ts";
import { migrationStatus, readMigrations } from "../db/migrations.ts";
import { describeResolution, parseSwitchCommand, planSwitchChange } from "./switch-command.ts";
import { clearSwitch, readSwitchRow, setSwitch, snapshotSwitches, SwitchChangeError, unexpectedChanges } from "./switches.ts";

function fail(message: string): never {
  console.log(`REFUSED: ${message}`);
  process.exit(1);
}

const parsed = parseSwitchCommand(process.argv.slice(2));
if (!parsed.ok) fail(`${parsed.problem}. Nothing was contacted.`);
const command = parsed.command;

const fence = prepareTarget(["--target", command.databaseTarget], { migration: true, runtime: [] });
console.log(`Operational switch ${command.action} (no secrets) — target ${command.databaseTarget}`);
for (const line of fence.lines) console.log(line);
console.log(`  switch                   ${command.target.key} [${command.target.qualifier}] scope=${command.target.scope}${command.target.organizationId === undefined ? "" : ` organization=${command.target.organizationId}`}${command.target.workspaceId === undefined ? "" : ` workspace=${command.target.workspaceId}`}`);
if (command.attribution !== undefined) console.log(`  attribution              operator=${command.attribution.operator} reason=${command.attribution.reason}`);
if (!fence.ok || fence.report?.migration === undefined) fail("configuration incomplete or unsafe. Nothing was contacted.");

const client = privilegedClient(fence.report.migration, fence.ca);
try {
  await client.connect();

  // Read-only: the database must be at the repository's migration level, and the current row decides the plan.
  await client.query("begin read only");
  const status = await migrationStatus(client, readMigrations());
  const current = await readSwitchRow(client, command.target);
  const before = await snapshotSwitches(client);
  await client.query("rollback");
  console.log(`  migrations               applied=${String(status.applied.length)} pending=${String(status.pending.length)}; stored overrides=${String(before.length)}`);
  if (status.pending.length > 0) fail("the database is not at the repository's migration level. Nothing was written.");
  const plan = planSwitchChange(command, current);
  for (const line of plan.lines) console.log(line);
  console.log(describeResolution(before, command.target));

  if (command.action === "show") {
    process.exit(0);
  }
  if (!command.apply) {
    console.log(plan.writes
      ? `DRY RUN: re-run with --apply${command.databaseTarget === "production" ? " --confirm-production" : ""} to write the change (audited: operator + reason).`
      : "DRY RUN: nothing would be written.");
    process.exit(0);
  }
  if (!plan.writes) {
    console.log("NO CHANGE: the stored state already matches. Nothing was written.");
    process.exit(0);
  }
  if (command.attribution === undefined) fail("attribution missing. Nothing was written.");

  const changed = command.action === "set"
    ? (await setSwitch(client, command.target, command.value, command.attribution)).changed
    : await clearSwitch(client, command.target, command.attribution);

  // Verify: the row, the rest of the table, and the runtime's view.
  await client.query("begin read only");
  const after = await readSwitchRow(client, command.target);
  const snapshot = await snapshotSwitches(client);
  await client.query("rollback");
  const stray = unexpectedChanges(before, snapshot, command.target);
  const settled = planSwitchChange(command, after);
  console.log(`  verified                 stored now: ${after === undefined ? "(absent)" : JSON.stringify(after.value)}; other overrides unchanged: ${stray.length === 0 ? "yes" : `NO (${String(stray.length)})`}`);
  console.log(describeResolution(snapshot, command.target));
  if (!changed || settled.writes || stray.length > 0) {
    console.log("FAILED: post-write verification did not match the plan. Inspect system.operational_switch_changes.");
    process.exitCode = 1;
  } else {
    console.log(`APPLIED: ${command.action === "set" ? "switch set" : "override cleared"} (one history row written).`);
  }
} catch (error) {
  console.log(`FAILED: ${error instanceof SwitchChangeError ? error.message : ((error as { code?: string }).code ?? "error")}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
