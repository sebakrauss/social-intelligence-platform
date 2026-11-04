/**
 * READ-ONLY operator reconciliation of provider-call intents (Step H7-D1e2b; target-aware since Step
 * H7-ops-tooling-production-parity):
 *
 *   node tools/db/ai-call-reconciliation.ts --target development|production [--stale-minutes 15] [--rows]
 *
 * The SELECTED target only (tools/db/environment.ts prepareTarget: `production` reads `.env.database-production.local`
 * and nothing else, must prove its explicit class / project reference / region and a strict CA; never a fallback to
 * development). One `begin read only` transaction; counts per derived state, and with --rows the sanitized rows (ids,
 * generation, attempt, times, states). Never writes, never prints social text, a prompt, a response, a URL or a secret.
 */
import { CALL_ACCOUNTING_SQL, summarizeCallAccounting, type CallAccountingRow } from "./ai-call-accounting.ts";
import { parseReconciliationArguments } from "./ai-call-reconciliation-args.ts";
import { prepareTarget, privilegedClient } from "./environment.ts";

const parsed = parseReconciliationArguments(process.argv.slice(2));
if (!parsed.ok) {
  console.log(`REFUSED: ${parsed.problem}. Nothing was contacted.`);
  process.exit(2);
}
const { target, staleMinutes, rows: wantRows } = parsed.value;
const fence = prepareTarget(["--target", target], { migration: true, runtime: [] });
console.log(`AI call reconciliation (read-only, no secrets) — target ${target}`);
for (const line of fence.lines) console.log(line);
if (!fence.ok || fence.report?.migration === undefined) {
  console.log("REFUSED: target configuration incomplete or unsafe. Nothing was contacted.");
  process.exit(1);
}
const client = privilegedClient(fence.report.migration, fence.ca);
try {
  await client.connect();
  await client.query("begin read only");
  const rows = (await client.query<CallAccountingRow>(CALL_ACCOUNTING_SQL, [new Date(Date.now() - staleMinutes * 60_000)])).rows;
  await client.query("rollback");
  console.log(JSON.stringify({ target, staleMinutes, intents: rows.length, ...summarizeCallAccounting(rows) }));
  if (wantRows) {
    for (const row of rows) {
      console.log(JSON.stringify({
        intent: row.intent_id, request: row.understanding_request_id, generation: row.dispatch_generation, attempt: row.attempt_number, kind: row.attempt_kind,
        createdAt: new Date(row.intent_created_at).toISOString(), requestState: row.request_state, requestGeneration: row.request_generation,
        attemptOutcome: row.attempt_outcome, state: row.accounting_state,
      }));
    }
  }
} catch (error) {
  console.log(`FAILED: ${(error as { code?: string }).code ?? "error"}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
