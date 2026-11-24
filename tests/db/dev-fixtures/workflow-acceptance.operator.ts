/**
 * W12-PREP-01 — the operator run of the shared-dev Workflow acceptance tooling (only through `npm run
 * db:workflow-acceptance`; the global setup has re-parsed the operation and proven the target). PLAN and verify are
 * read-only; APPLY performs exactly the one operation named. Prints one secret-free JSON line (ids, counts, states,
 * digests; user ids masked). Any refusal, conflict, containment or postcondition failure makes the run fail (exit ≠ 0).
 */
import { inject, it } from "vitest";
import { createLogger } from "@/platform/observability";
import { privilegedPool, runtimeDatabase } from "../support/target";
import { applyWorkflowAcceptanceFixture, applyWorkflowAcceptanceReply, formatWorkflowAcceptanceReport, planWorkflowAcceptanceFixture, planWorkflowAcceptanceReply } from "./workflow-acceptance";
import { applyMembers, applyRole, planMembers, planRole, verifyAcceptance } from "./workflow-acceptance-members";

/** Success depends on the mode: a plan status returned by an APPLY means nothing was applied, and is a failure. */
const SUCCESS = {
  plan: new Set(["CREATE_ALL", "RESUME_CONVERSATIONS", "RESUME_MEMBERS", "ALREADY_PRESENT_MATCH", "READY", "VERIFIED"]),
  apply: new Set(["CREATED", "RESUMED", "ALREADY_PRESENT_MATCH", "INGESTED", "CHANGED"]),
} as const;

it("W12 Comments Workflow acceptance (shared dev)", async () => {
  const target = inject("dbTarget");
  const operation = inject("workflowAcceptanceOperation");
  const privileged = privilegedPool(target, 1);
  const worker = runtimeDatabase(target, "worker", 1);
  const log = createLogger({ sink: (line) => process.stdout.write(`${line}\n`), now: () => new Date(), base: { module: "workflow-acceptance" } });
  try {
    let status: string;
    let report: object;
    switch (operation.command) {
      case "fixture": {
        const r = operation.mode === "apply" ? await applyWorkflowAcceptanceFixture({ privileged, worker }) : await planWorkflowAcceptanceFixture(privileged);
        status = r.status;
        report = r;
        break;
      }
      case "reply": {
        const r = operation.mode === "apply" ? await applyWorkflowAcceptanceReply({ privileged, worker }, operation.kind) : await planWorkflowAcceptanceReply(privileged, operation.kind);
        status = r.status;
        report = r;
        break;
      }
      case "members": {
        const users = { U1: operation.u1, U2: operation.u2 };
        const r = operation.mode === "apply" ? await applyMembers(privileged, users) : await planMembers(privileged, users);
        status = r.status;
        report = r;
        break;
      }
      case "role": {
        const r = operation.mode === "apply" ? await applyRole(privileged, operation.u2, operation.from, operation.to) : await planRole(privileged, operation.u2, operation.from, operation.to);
        status = r.status;
        report = r;
        break;
      }
      case "verify": {
        const r = await verifyAcceptance(privileged, { U1: operation.u1, U2: operation.u2 });
        status = r.ok ? "VERIFIED" : "VERIFY_FAILED";
        report = r;
        break;
      }
    }
    process.stdout.write(`${formatWorkflowAcceptanceReport(operation.command, operation.mode, { status, ...report })}\n`);
    const ok = SUCCESS[operation.mode].has(status);
    log.info("workflow_acceptance.w12", { operation: `${operation.command}.${operation.mode}.${status.toLowerCase()}`, outcome: ok ? "ok" : "error" });
    if (!ok) throw new Error(`workflow acceptance stopped: ${status}`);
  } finally {
    await worker.end();
    await privileged.end();
  }
});
