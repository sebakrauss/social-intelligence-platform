/**
 * WORKFLOW-WF-2C — the reconciliation run itself, executed ONLY through `npm run ops:workflow-reconcile` (which fences the
 * target first). Re-parses the same arguments and re-checks the fence before connecting; prints identifiers and counts
 * only. Exit status: failure when any item failed (the report says which).
 */
import { expect, it } from "vitest";
import { createRuntimeDatabase, resolveSslRootCert } from "@/platform/db/pool";
import { reconcileWorkspaceWorkItems } from "@/server/persistence/workflow-reconciliation";
import { parseReconcileCommand, RECONCILE_PARAMETERS_VARIABLE, reconcileTargetProblems } from "./workflow-reconcile-command";

it("workflow reconciliation (operator run)", async () => {
  const raw = process.env[RECONCILE_PARAMETERS_VARIABLE];
  const parsed = parseReconcileCommand(raw === undefined ? [] : (JSON.parse(raw) as string[]));
  if (!parsed.ok) throw new Error(`refused: ${parsed.problem}`);
  const url = process.env[parsed.command.databaseUrlEnv];
  const problems = reconcileTargetProblems(url, parsed.command.target, process.env);
  if (problems.length > 0 || url === undefined) throw new Error(`refused: ${problems.join("; ")}`);
  // RELEASE-TOOLING-01: the development target connects only with the configured CA (TLS verified, rejectUnauthorized,
  // by the runtime's own pool); a loopback cluster has no TLS. Nothing else about the run differs between the two.
  const sslRootCert = parsed.command.target === "development" ? resolveSslRootCert(process.env) : undefined;
  if (parsed.command.target === "development" && sslRootCert === undefined) throw new Error("refused: the development target needs the project's CA certificate");
  const worker = createRuntimeDatabase("worker", url, { max: 1, ...(sslRootCert === undefined ? {} : { sslRootCert }) });
  try {
    const report = await reconcileWorkspaceWorkItems(
      worker,
      {
        workspaceId: parsed.command.workspaceId,
        dryRun: !parsed.command.apply,
        batchSize: parsed.command.batchSize,
        after: parsed.command.after,
        ...(parsed.command.maxBatches === undefined ? {} : { maxBatches: parsed.command.maxBatches }),
        ...(parsed.command.runCorrelationId === undefined ? {} : { runCorrelationId: parsed.command.runCorrelationId }),
      },
      (batch) => { process.stdout.write(`${JSON.stringify({ batch })}\n`); },
    );
    process.stdout.write(`${JSON.stringify({ report })}\n`);
    expect(report.counts.failed, "items failed (see failedIds)").toBe(0);
  } finally {
    await worker.end();
  }
});
