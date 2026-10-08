/**
 * Job-runtime composition of the Move saga steps (Step 5F), MAIN plane (Step 7E.4B.3). The steps open no provider
 * credential — they only move a Connected Account between workspaces of one organization — so this module never reaches
 * the CredentialOpener composition (jobs/connections.ts, integration plane; dependency rule). Thin handlers: resolve the
 * run's identifiers, call the application service in the run's single bound workspace.
 */
import { randomUUID } from "node:crypto";
import {
  activateDestination,
  rejectDestination,
  releaseSource,
  type ActivationResult,
  type RejectionResult,
  type ReleaseOutcome,
  type SagaStepInput,
} from "@/modules/connections";
import { parseCorrelationId } from "@/domain/correlation";
import { parseUserId, parseWorkspaceId } from "@/domain/ids";
import { NonRetryableJobError, type TenantJobContext } from "@/platform/jobs";
import { connectionWorkerStore } from "@/server/persistence/connections";

/** The common identifiers of a Move saga step (one workspace; IDs only; the move id is the subject). */
function sagaInput(context: TenantJobContext): SagaStepInput {
  const workspaceId = parseWorkspaceId(context.payload.workspaceId);
  const moveId = context.payload.subjectIds["move_id"];
  const correlationId = parseCorrelationId(context.payload.correlationId);
  if (workspaceId === undefined || moveId === undefined || correlationId === undefined) throw new NonRetryableJobError("invalid_payload");
  return { workspaceId, moveId, outboxId: context.payload.outboxId, correlationId, now: new Date(), newId: randomUUID };
}

/** connections.move.release_source (source workspace). Routed only by connections.route_move_step, for a human initiator. */
export async function runReleaseSource(context: TenantJobContext): Promise<ReleaseOutcome> {
  const input = sagaInput(context);
  const connectedAccountId = context.payload.subjectIds["connected_account_id"];
  const destinationWorkspaceId = parseWorkspaceId(context.payload.subjectIds["counterpart_workspace_id"]);
  const initiator = context.payload.initiator.type === "user" ? parseUserId(context.payload.initiator.userId) : undefined;
  if (connectedAccountId === undefined || destinationWorkspaceId === undefined || initiator === undefined) throw new NonRetryableJobError("invalid_payload");
  return releaseSource(connectionWorkerStore(context), { ...input, connectedAccountId, destinationWorkspaceId, initiator });
}

/** connections.move.activate_destination (destination workspace): after a release, or a human retry. */
export async function runActivateDestination(context: TenantJobContext): Promise<ActivationResult> {
  return activateDestination(connectionWorkerStore(context), sagaInput(context));
}

/** connections.move.reject_destination (destination workspace): after the source refused. */
export async function runRejectDestination(context: TenantJobContext): Promise<RejectionResult> {
  return rejectDestination(connectionWorkerStore(context), sagaInput(context));
}
