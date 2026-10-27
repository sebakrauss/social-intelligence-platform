/**
 * Job-runtime composition of the MAIN-plane reconciliation tasks (Step H6-C3; design H6-C0): the planner
 * `ingestion.reconcile_account` and the H6 terminal consumer `interactions.observed`. Neither opens a provider
 * credential, calls a provider, an AI model or KMS: this file never reaches jobs/connections.ts (execution-plane guard).
 * Thin handlers: resolve the run's identifiers, call the application service in the run's single workspace-scoped
 * transaction, map refusals to a non-retryable failure (surfaced, never retried blindly).
 */
import { randomUUID } from "node:crypto";
import { acceptObservedInteraction, planReconciliation, type ObservedOutcome, type PlanOutcome } from "@/modules/ingestion";
import { NonRetryableJobError, type TenantJobContext } from "@/platform/jobs";
import { ingestionStores, reconciliationScope } from "@/server/persistence/ingestion";

const systemClock = { newId: randomUUID, now: () => new Date() };

/** ingestion.reconcile_account: gate the account and start the run with its first content_listing slice. */
export async function runReconcileAccount(context: TenantJobContext, clock: { readonly newId: () => string; readonly now: () => Date } = systemClock): Promise<PlanOutcome> {
  const runId = context.payload.subjectIds["reconciliation_run_id"];
  const connectedAccountId = context.payload.subjectIds["connected_account_id"];
  if (runId === undefined || connectedAccountId === undefined) throw new NonRetryableJobError("invalid_payload");
  const outcome = await planReconciliation(reconciliationScope(context), clock, { runId, connectedAccountId });
  if (outcome.kind === "not_found") throw new NonRetryableJobError("reconciliation_run_not_found");
  return outcome;
}

/** interactions.observed: the IDs-only event names one canonical event of this workspace; accepted, nothing else. */
export async function runInteractionsObserved(context: TenantJobContext): Promise<ObservedOutcome> {
  const subjects = context.payload.subjectIds;
  const eventId = subjects["ingestion_event_id"];
  const interactionId = subjects["interaction_id"];
  if (eventId === undefined || interactionId === undefined) throw new NonRetryableJobError("invalid_payload");
  const outcome = await acceptObservedInteraction(ingestionStores(context), {
    eventId,
    interactionId,
    conversationId: subjects["conversation_id"] ?? null,
    sourceTextVersionId: subjects["source_text_version_id"] ?? null,
  });
  if (outcome.kind === "rejected") throw new NonRetryableJobError(outcome.reason);
  return outcome;
}
