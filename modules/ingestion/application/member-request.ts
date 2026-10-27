/**
 * A member's reconciliation request (Step H6-C4): the web's typed adapter of the 0019 request boundary,
 * ingestion.request_reconciliation. The boundary is the whole algorithm: it authorizes OWNER/ADMIN from the
 * transaction's verified claims and live membership, scopes the account to the sealed workspace, enforces the one open
 * run (`already_running`), and writes the REQUESTED run, its `connected_account.reconciliation_requested` audit event
 * and its `ingestion.reconcile_account` planner row atomically. This adapter sends only the routed account and the
 * request's correlation id: no time and no budget — a member's run always gets the approved defaults (40 operations)
 * at statement time, and the boundary refuses a member that names either. It maps the closed answer; anything else
 * fails closed in the store (`reconciliation_request_incoherent`). No provider is reached.
 */
import type { CorrelationId } from "@/domain/correlation";
import type { ReconciliationRequestPort } from "./reconciliation-ports";

export type MemberReconciliationRequest =
  | { readonly kind: "requested"; readonly runId: string; readonly outboxId: string }
  | { readonly kind: "already_running"; readonly runId: string }
  | { readonly kind: "not_found" };

export async function requestMemberReconciliation(
  port: ReconciliationRequestPort,
  input: { readonly connectedAccountId: string; readonly correlationId: CorrelationId },
): Promise<MemberReconciliationRequest> {
  const result = await port.requestRun({ connectedAccountId: input.connectedAccountId, correlationId: input.correlationId, requestedAt: null, budget: null });
  switch (result.outcome) {
    case "requested":
      return { kind: "requested", runId: result.runId, outboxId: result.outboxId };
    case "already_running":
      return { kind: "already_running", runId: result.runId };
    case "not_found":
      return { kind: "not_found" };
  }
}
