/**
 * Sync interactions (Step H6-C4): an Owner/Admin's explicit request to reconcile ONE connected account's interactions.
 * The routed account id is the only input (an unknown field is INVALID_INPUT): no workspace, organization, role,
 * user, time, budget, topic or subject ever comes from the caller. The pipeline's `connections.manage` check
 * (Owner/Admin, not grantable) is the early, UX-facing refusal; the authority is 0019's SECURITY DEFINER
 * ingestion.request_reconciliation, which decides again from the transaction's verified claims, live membership and
 * sealed workspace, and writes the REQUESTED run (the approved budget: 40 operations), its audit event and its
 * `ingestion.reconcile_account` planner row atomically — or nothing. The pipeline therefore appends NO audit event for
 * this command (`auditedBy`) and the command appends no outbox row: it only reports the boundary's row for the
 * post-commit relay wake-up. A request, not a platform mutation: it works in Monitor-only too. No provider is reached;
 * nothing here waits for, polls or promises the reconciliation itself.
 */
import { isUuid } from "@/domain/ids";
import { object, parsed } from "@/domain/validation";
import { requestMemberReconciliation, type MemberReconciliationRequest } from "@/modules/ingestion";
import type { DatabaseBoundaryAudit, WorkspaceCommand } from "@/server/pipeline";

const uuid = parsed((value) => (isUuid(value) ? value : undefined));

/** The reconciliation request's audit event is written by its boundary, in the request's own statement. */
export const RECONCILIATION_REQUEST_AUDIT: DatabaseBoundaryAudit = Object.freeze({
  kind: "database_boundary",
  function: "ingestion.request_reconciliation",
  actions: Object.freeze(["connected_account.reconciliation_requested"] as const),
});

/** What the caller learns: the closed outcome, and the run for the server layer (never the outbox row). */
export type InteractionsSyncResult =
  | { readonly kind: "requested"; readonly runId: string }
  | { readonly kind: "already_running"; readonly runId: string }
  | { readonly kind: "not_found" };

export const requestInteractionsSyncCommand: WorkspaceCommand<{ readonly connectedAccountId: string }, MemberReconciliationRequest, InteractionsSyncResult> = {
  scope: "workspace",
  name: "ingestion.account.request_reconciliation",
  permission: "connections.manage",
  requiresStandardMode: false,
  validate: object({ connectedAccountId: uuid }),
  async execute(_context, input, tx, env) {
    const output = await requestMemberReconciliation(tx.reconciliation, { connectedAccountId: input.connectedAccountId, correlationId: env.correlationId });
    // The planner row was inserted by the boundary in THIS transaction: wake the relay after commit like a routed row.
    if (output.kind === "requested") tx.outbox.routed({ id: output.outboxId, correlationId: env.correlationId });
    return output;
  },
  audit: () => undefined,
  auditedBy: RECONCILIATION_REQUEST_AUDIT,
  respond: (output) => (output.kind === "not_found" ? { kind: "not_found" } : { kind: output.kind, runId: output.runId }),
};
