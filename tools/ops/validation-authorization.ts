/**
 * Operator CLI for ONE-time LIVE validation authorizations (Step 7B-14I2; migration 0029). Development only. Prints no
 * secrets: identifiers, closed values and database refusals only.
 *
 *   npm run ops:validation-authorization -- issue  --target development --workspace <uuid> --preflight <uuid> --initiator <uuid> --reason live_validation [--lifetime-minutes 60] [--accept-token-type-not-verified] [--apply]
 *   npm run ops:validation-authorization -- revoke --target development --workspace <uuid> --authorization <uuid> --reason incident [--apply]
 *   npm run ops:validation-authorization -- status --target development --workspace <uuid> --authorization <uuid>
 *
 * Without --apply, issue and revoke run their ONE database call inside a transaction that is rolled back: every check
 * runs, nothing persists. Nothing happens after issue: no request, no intent, no task, no provider call.
 *
 * Identity: the database login of DATABASE_VALIDATION_OPERATOR_URL (`.env.local`) — a dedicated
 * validation_operator_<handle> LOGIN, NOINHERIT, member of app_validation_operator only (SET, no ADMIN), never the
 * migration role. Provisioning such a login is a separate, explicitly authorized gate (per operator, long-lived, R8):
 *   create role validation_operator_<handle> login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password '<SCRAM verifier>';
 *   grant connect on database postgres to validation_operator_<handle>;
 *   grant app_validation_operator to validation_operator_<handle> with inherit false, set true;
 * run once by the migration role; the password exists only in that operator's `.env.local`.
 */
import { loadTargetEnvironment } from "../db/environment.ts";
import { describeValidationCommand, parseValidationCommand } from "./validation-authorization-command.ts";
import { operatorSessionProblems, refusalLine, runValidationCall } from "./validation-authorizations.ts";
import { checkValidationOperatorTarget, validationOperatorClient } from "../db/validation-operator-target.ts";

function fail(message: string): never {
  console.log(`REFUSED: ${message}`);
  process.exit(1);
}

const parsed = parseValidationCommand(process.argv.slice(2));
if (!parsed.ok) fail(`${parsed.problem}. Nothing was contacted.`);
const command = parsed.command;

console.log(`Validation authorization ${command.action} (no secrets) — target development`);
for (const line of describeValidationCommand(command)) console.log(line);
const loaded = loadTargetEnvironment("development");
const fence = checkValidationOperatorTarget(loaded.env);
for (const line of fence.lines) console.log(line);
if (!fence.ok || fence.target === undefined) fail("configuration incomplete or unsafe. Nothing was contacted.");
const made = validationOperatorClient(fence.target, loaded.env);
if ("problem" in made) fail(`${made.problem}. Nothing was contacted.`);
const client = made.client;

try {
  await client.connect();
  const problems = await operatorSessionProblems(client);
  if (problems.length > 0) {
    for (const problem of problems) console.log(`  PROBLEM: ${problem}`);
    fail("this session is not a validation operator session. Nothing was written.");
  }
  const result = await runValidationCall(client, command);
  if (result.action === "issue") {
    console.log(`  authorization            ${result.authorizationId}`);
    console.log(`  expires at               ${result.expiresAt}`);
    console.log(result.committed ? "ISSUED (committed). Nothing else was done." : "DRY RUN: every check passed; rolled back. Re-run with --apply to issue.");
  } else if (result.action === "revoke") {
    console.log(`  revoked at               ${result.revokedAt}`);
    console.log(result.committed ? "REVOKED (committed)." : "DRY RUN: the revocation would be accepted; rolled back. Re-run with --apply to revoke.");
  } else {
    for (const [key, value] of Object.entries(result.status)) console.log(`  ${key.padEnd(24)} ${value === null ? "—" : String(value)}`);
  }
} catch (error) {
  console.log(refusalLine(error));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
