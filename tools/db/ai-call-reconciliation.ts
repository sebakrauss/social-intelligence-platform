/**
 * READ-ONLY operator reconciliation of provider-call intents (Step H7-D1e2b): `node tools/db/ai-call-reconciliation.ts
 * [--stale-minutes 15] [--rows]`. One `begin read only` transaction against the configured development project (the
 * same target checks as the migration tooling); counts per derived state, and with --rows the sanitized rows (ids,
 * generation, attempt, times, states). Never writes, never prints social text, a prompt, a response or a secret.
 */
import { checkTarget, loadEnvironment, privilegedClient, readCa } from "./environment.ts";
import { CALL_ACCOUNTING_SQL, summarizeCallAccounting, type CallAccountingRow } from "./ai-call-accounting.ts";

const args = process.argv.slice(2);
const minutesAt = args.indexOf("--stale-minutes");
const staleMinutes = minutesAt < 0 ? 15 : Number(args[minutesAt + 1]);
if (!Number.isInteger(staleMinutes) || staleMinutes < 1 || staleMinutes > 1440) {
  console.log("USAGE: --stale-minutes must be an integer from 1 to 1440");
  process.exit(2);
}
const env = loadEnvironment();
const report = checkTarget(env, { migration: true, runtime: [] });
if (!report.ok || report.migration === undefined) {
  for (const line of report.lines) console.log(line);
  console.log("REFUSED: target configuration incomplete or unsafe. Nothing was contacted.");
  process.exit(1);
}
const client = privilegedClient(report.migration, readCa(env));
await client.connect();
try {
  await client.query("begin read only");
  const rows = (await client.query<CallAccountingRow>(CALL_ACCOUNTING_SQL, [new Date(Date.now() - staleMinutes * 60_000)])).rows;
  await client.query("rollback");
  console.log(JSON.stringify({ staleMinutes, intents: rows.length, ...summarizeCallAccounting(rows) }));
  if (args.includes("--rows")) {
    for (const row of rows) {
      console.log(JSON.stringify({
        intent: row.intent_id, request: row.understanding_request_id, generation: row.dispatch_generation, attempt: row.attempt_number, kind: row.attempt_kind,
        createdAt: new Date(row.intent_created_at).toISOString(), requestState: row.request_state, requestGeneration: row.request_generation,
        attemptOutcome: row.attempt_outcome, state: row.accounting_state,
      }));
    }
  }
} finally {
  await client.end();
}
