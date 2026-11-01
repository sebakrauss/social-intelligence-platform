/**
 * Job-runtime composition of the MAIN-plane reconciliation tasks (Step H6-C3; design H6-C0): the planner
 * `ingestion.reconcile_account` and the consumer `interactions.observed`. Neither opens a provider credential, calls a
 * provider, an AI model or KMS: this file never reaches jobs/connections.ts (execution-plane guard).
 * Thin handlers: resolve the run's identifiers, call the application services in the run's single workspace-scoped
 * transaction, map refusals to a non-retryable failure (surfaced, never retried blindly).
 *
 * Step H7-B: `interactions.observed` also runs the DETERMINISTIC stage of classification for the immutable source text
 * version a `created` / `text_changed` event names — after ingestion has verified the event against its IDs-only
 * payload, in the same transaction (request + signals commit together; a retry re-runs both idempotently). Ingestion
 * itself stays independent of classification: the composition lives here. Logs carry ids, counts and outcome classes
 * only — never text.
 *
 * Step H7-D1d: after a DETERMINISTIC_DONE outcome the same transaction asks the intelligence pipeline to continue
 * (dispatchUnderstanding: request AI_PENDING + its `classification.understand_ai` outbox row, atomically — only when
 * the route policy, the kill switches and every pre-model check allow it; by default nothing is read or written), and
 * every delivery runs one bounded recovery pass over the workspace's stale in-flight intelligence requests.
 */
import { randomUUID } from "node:crypto";
import {
  ARRIVALS,
  dispatchUnderstanding,
  recoverStaleUnderstanding,
  understandDeterministically,
  type Arrival,
  type DeterministicOutcome,
  type DispatchOutcome,
  type RecoveryOutcome,
  type UnderstandAiRoutePolicy,
} from "@/modules/classification";
import { acceptObservedInteraction, planReconciliation, type ObservedOutcome, type PlanOutcome } from "@/modules/ingestion";
import { NonRetryableJobError, type TenantJobContext } from "@/platform/jobs";
import type { Logger } from "@/platform/observability";
import { classificationScope, intelligenceScope } from "@/server/persistence/classification";
import { ingestionStores, reconciliationScope } from "@/server/persistence/ingestion";
import { INTELLIGENCE_ROUTE_POLICY } from "./intelligence-policy";
import { jobLogger } from "./runtime";

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

export type InteractionsObservedResult = ObservedOutcome & {
  readonly classification: DeterministicOutcome | null;
  /** Step H7-D1d: the intelligence continuation of a DETERMINISTIC_DONE request (null when none was considered). */
  readonly intelligence: DispatchOutcome | null;
  readonly recovery: RecoveryOutcome;
};

/**
 * interactions.observed: the IDs-only event names one canonical event of this workspace. Ingestion verifies it; then a
 * `created` / `text_changed` event's immutable text version gets its deterministic understanding (Step H7-B).
 */
export async function runInteractionsObserved(
  context: TenantJobContext,
  clock: { readonly newId: () => string; readonly now: () => Date } = systemClock,
  log: Logger = jobLogger,
  policy: UnderstandAiRoutePolicy = INTELLIGENCE_ROUTE_POLICY,
): Promise<InteractionsObservedResult> {
  const subjects = context.payload.subjectIds;
  const eventId = subjects["ingestion_event_id"];
  const interactionId = subjects["interaction_id"];
  if (eventId === undefined || interactionId === undefined) throw new NonRetryableJobError("invalid_payload");
  const sourceTextVersionId = subjects["source_text_version_id"] ?? null;
  const outcome = await acceptObservedInteraction(ingestionStores(context), {
    eventId,
    interactionId,
    conversationId: subjects["conversation_id"] ?? null,
    sourceTextVersionId,
  });
  if (outcome.kind === "rejected") throw new NonRetryableJobError(outcome.reason);
  // Only an event that ESTABLISHED a text version is analyzed — by that version's id, never the current pointer.
  const fields = { workspaceId: context.payload.workspaceId, task: "interactions.observed" } as const;
  const recover = async (): Promise<RecoveryOutcome> => {
    const recovery = await recoverStaleUnderstanding(intelligenceScope(context), clock, policy, { correlationId: context.payload.correlationId });
    if (recovery.redispatched + recovery.failed > 0) log.info("classification.intelligence.recovered", { ...fields, outcome: "ok", count: recovery.redispatched + recovery.failed, operation: `redispatched.${String(recovery.redispatched)}` });
    return recovery;
  };
  if ((outcome.change !== "created" && outcome.change !== "text_changed") || sourceTextVersionId === null) return { ...outcome, classification: null, intelligence: null, recovery: await recover() };
  if (!(ARRIVALS as readonly string[]).includes(outcome.arrival)) throw new NonRetryableJobError("invalid_arrival");
  const started = Date.now();
  const classification = await understandDeterministically(classificationScope(context), clock, { interactionId, sourceTextVersionId, arrival: outcome.arrival as Arrival });
  if (classification.kind !== "recorded") {
    log.warn(`classification.deterministic.${classification.kind}`, { ...fields, outcome: "error", count: 1 });
    throw new NonRetryableJobError(`classification_${classification.kind}`);
  }
  log.info("classification.deterministic.recorded", { ...fields, outcome: "ok", operation: `request.${classification.state.toLowerCase()}`, durationMs: Date.now() - started, count: classification.signalsInserted });
  for (const [kind, n] of Object.entries(classification.signals)) if (n > 0) log.info(`classification.signal.${kind}`, { ...fields, count: n });
  if (classification.signalsEquivalent > 0) log.info("classification.signal.equivalent", { ...fields, count: classification.signalsEquivalent });
  // Own-brand text (SKIPPED_OWN_BRAND) and a request a later stage already owns are never continued.
  const intelligence = classification.state === "DETERMINISTIC_DONE"
    ? await dispatchUnderstanding(intelligenceScope(context), clock, policy, { workspaceId: context.payload.workspaceId, interactionId, sourceTextVersionId, arrival: outcome.arrival as Arrival, correlationId: context.payload.correlationId })
    : null;
  if (intelligence !== null) log.info("classification.intelligence.dispatch", { ...fields, outcome: "ok", operation: intelligence.kind === "skipped" ? `skipped.${intelligence.reason}` : intelligence.kind });
  return { ...outcome, classification, intelligence, recovery: await recover() };
}
