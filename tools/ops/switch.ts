/**
 * Operator CLI for operational switches (TA §66). Plan only unless `--apply`; refuses any target other than
 * the configured development project (same checks as the database tooling). Prints no secrets.
 *
 *   npm run ops:switch -- set   --key automation.global_kill --scope global --value '{"active":true}' --operator <id> --reason incident [--apply]
 *   npm run ops:switch -- clear --key automation.global_kill --scope global --operator <id> --reason rollback [--apply]
 *
 * Optional: --qualifier <q> (default "*"), --organization <uuid>, --workspace <uuid>.
 */
import { parseArgs } from "node:util";
import { SWITCHES } from "../../platform/flags/registry.ts";
import { checkTarget, EXPECTED_PROJECT_LABEL, loadEnvironment, privilegedClient, readCa } from "../db/environment.ts";
import { clearSwitch, REASON_CODES, setSwitch, SwitchChangeError, validateTarget, type ReasonCode } from "./switches.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    key: { type: "string" },
    qualifier: { type: "string", default: "*" },
    scope: { type: "string" },
    organization: { type: "string" },
    workspace: { type: "string" },
    value: { type: "string" },
    operator: { type: "string" },
    reason: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  console.log(`REFUSED: ${message}`);
  process.exit(1);
}

const action = positionals[0];
if (action !== "set" && action !== "clear") fail("action must be 'set' or 'clear'");
const reason = values.reason ?? "";
if (!(REASON_CODES as readonly string[]).includes(reason)) fail(`--reason must be one of ${REASON_CODES.join(", ")}`);
const attribution = { operator: values.operator ?? "", reason: reason as ReasonCode };

let target;
let value: unknown;
try {
  target = validateTarget({
    key: values.key ?? "",
    qualifier: values.qualifier,
    scope: values.scope ?? "",
    ...(values.organization === undefined ? {} : { organizationId: values.organization }),
    ...(values.workspace === undefined ? {} : { workspaceId: values.workspace }),
  });
  if (action === "set") value = JSON.parse(values.value ?? "null") as unknown;
} catch (error) {
  fail(error instanceof SwitchChangeError ? error.message : "--value must be JSON");
}
if (action === "set" && SWITCHES[target.key].parse(value) === undefined) fail(`value shape not valid for ${target.key}`);

const env = loadEnvironment();
const report = checkTarget(env, { migration: true, runtime: [] });
console.log(`Operational switch change (no secrets) — target ${EXPECTED_PROJECT_LABEL}`);
for (const line of report.lines) console.log(line);
console.log(`  action                   ${action} ${target.key} [${target.qualifier}] scope=${target.scope}`);
if (!report.ok || report.migration === undefined) fail("configuration incomplete or unsafe. Nothing was contacted.");
if (!values.apply) {
  console.log("DRY RUN: re-run with --apply to write the change (audited: operator + reason).");
  process.exit(0);
}

const client = privilegedClient(report.migration, readCa(env));
try {
  await client.connect();
  if (action === "set") {
    await setSwitch(client, target, value, attribution);
    console.log("APPLIED: switch set (history row written).");
  } else {
    const existed = await clearSwitch(client, target, attribution);
    console.log(existed ? "APPLIED: override cleared (history row written)." : "NO CHANGE: no such override.");
  }
} catch (error) {
  console.log(`FAILED: ${error instanceof SwitchChangeError ? error.message : ((error as { code?: string }).code ?? "error")}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
