/**
 * The MAIN side of the intelligence pipeline (Step H7-D1d; H7-A0 §9, §11; migration 0025). DB only: no provider, no
 * model, no credential. Runs inside the `interactions.observed` consumer's ONE workspace-scoped job transaction, right
 * after the deterministic stage (H7-B) — so the request transition and its outbox row commit or roll back together.
 *
 *   dispatch   route policy FIRST (deny-by-default: disabled ⇒ nothing is read or written) → the global `ai.task_kill`
 *              operational switch (unreadable ⇒ killed) → canonical eligibility
 *              (understanding-eligibility.ts checks 1–5) → the A1 input (check 10) → the ONE request of (text version,
 *              `classification.intelligence.v1`) — the 0024 unique key is the concurrency authority:
 *                new / PENDING  → AI_PENDING generation 1 + the IDs-only `classification.understand_ai` outbox row
 *                               (dispatch key `classification.understand_ai:{request}:a1`; the relay binds the
 *                               `intelligence` plane from the registry)
 *                too large      → AI_FAILED(AI_INPUT_TOO_LARGE) generation 1, no outbox row, no provider call
 *                anything else  → left as it is (check 12: an equivalent request already exists)
 *   recovery   (R6/R7) in-flight requests untouched for STALE_IN_FLIGHT_MS — a lost dispatch, a crashed or lost run —
 *              are bounded by MAX_TRANSPORT_GENERATIONS: the route is re-decided (a disabled route, the kill switch or
 *              a lost data eligibility, the global `ai.task_kill` switch end them AI_FAILED(AI_UNAVAILABLE)), otherwise
 *              one NEW generation is dispatched;
 *              the INTELLIGENCE run re-checks everything and reserves budget again. Never an accepting result.
 *
 * Nothing here emits `classification.understood` (deferred, H7-D1a) or touches an assessment.
 */
import {
  INTELLIGENCE_PIPELINE_VERSION,
  MAX_TRANSPORT_GENERATIONS,
  RECOVERY_BATCH,
  ROUTE_SKIP_REASONS,
  STALE_IN_FLIGHT_MS,
  decideUnderstandAiRoute,
  samplingBucketOf,
  workspaceDataClassOf,
  type UnderstandAiRoutePolicy,
} from "../domain/intelligence-routing";
import { CANONICAL_INELIGIBILITY, canonicalEligibility, prepareUnderstandingInput } from "../domain/understanding-eligibility";
import type { Arrival, ClassificationClock, IntelligenceRequestRecord, IntelligenceScope } from "./ports";

export const DISPATCH_SKIP_REASONS = ["target_not_found", ...CANONICAL_INELIGIBILITY, ...ROUTE_SKIP_REASONS, "input_invalid"] as const;
export type DispatchSkipReason = (typeof DISPATCH_SKIP_REASONS)[number];

export interface DispatchInput {
  /** The job's bound workspace (RLS binds it too). */
  readonly workspaceId: string;
  readonly interactionId: string;
  readonly sourceTextVersionId: string;
  readonly arrival: Arrival;
  readonly correlationId: string;
}

export type DispatchOutcome =
  | { readonly kind: "dispatched"; readonly requestId: string; readonly generation: 1 }
  | { readonly kind: "input_too_large"; readonly requestId: string }
  | { readonly kind: "existing"; readonly requestId: string; readonly state: string }
  | { readonly kind: "skipped"; readonly reason: DispatchSkipReason };

/** The global operational kill switch: a failing read is killed too (fail safe). */
export async function operationallyKilled(scope: Pick<IntelligenceScope, "aiTaskKilled">): Promise<boolean> {
  try {
    // Anything but an explicit `false` is killed (a port built outside the type system included).
    const killed: unknown = await scope.aiTaskKilled();
    return killed !== false;
  } catch {
    return true;
  }
}

/** The route decision of one target: a deterministic sampling bucket of its text version, never its text. */
export const routeDecisionFor = (policy: UnderstandAiRoutePolicy, target: { readonly workspaceId: string; readonly sourceTextVersionId: string; readonly arrival: string }) =>
  decideUnderstandAiRoute(policy, { samplingBucket: samplingBucketOf(target.sourceTextVersionId), dataClass: workspaceDataClassOf(policy, target.workspaceId), arrival: target.arrival });

export async function dispatchUnderstanding(scope: IntelligenceScope, clock: ClassificationClock, policy: UnderstandAiRoutePolicy, input: DispatchInput): Promise<DispatchOutcome> {
  const skip = (reason: DispatchSkipReason): DispatchOutcome => ({ kind: "skipped", reason });
  const route = routeDecisionFor(policy, input);
  if (route.kind === "skip") return skip(route.reason);
  if (await operationallyKilled(scope)) return skip("kill_switch");

  const target = await scope.texts.understandingContext(input.interactionId, input.sourceTextVersionId);
  if (target === undefined || target.workspaceId !== input.workspaceId) return skip("target_not_found");
  const source = target.contentItemId === null ? undefined : await scope.contents.reportedSource(target.contentItemId);
  const canonical = canonicalEligibility(target, source);
  if (!canonical.ok) return skip(canonical.reason);
  const prepared = prepareUnderstandingInput(canonical.params);
  if (prepared.kind === "invalid") return skip("input_invalid");

  const now = clock.now();
  const ensured = await scope.store.ensureRequest({
    id: clock.newId(),
    organizationId: target.organizationId,
    workspaceId: target.workspaceId,
    interactionId: target.interactionId,
    sourceTextVersionId: target.sourceTextVersionId,
    pipelineVersion: INTELLIGENCE_PIPELINE_VERSION,
    arrival: input.arrival,
    now,
  });
  if (ensured.state !== "PENDING") return { kind: "existing", requestId: ensured.id, state: ensured.state };
  // Row-locked by ensureRequest: only this transaction can move it.
  const request = await scope.intelligence.lockRequest(ensured.id);
  if (request === undefined) throw new Error("classification_request_unreadable");

  if (prepared.kind === "failed") {
    const failed = await scope.intelligence.transition({ id: request.id, from: "PENDING", fromGeneration: null, to: "AI_FAILED", generation: 1, failureClass: "AI_INPUT_TOO_LARGE", now });
    if (!failed) throw new Error("classification_request_moved_concurrently");
    return { kind: "input_too_large", requestId: request.id };
  }
  const pending = await scope.intelligence.transition({ id: request.id, from: "PENDING", fromGeneration: null, to: "AI_PENDING", generation: 1, failureClass: null, now });
  if (!pending) throw new Error("classification_request_moved_concurrently");
  // Same transaction: no AI_PENDING without its durable dispatch, no dispatch without its request.
  const appended = await scope.intelligence.appendDispatch({ request, generation: 1, correlationId: input.correlationId, outboxId: clock.newId(), now });
  if (appended !== "appended") throw new Error("classification_dispatch_key_taken");
  return { kind: "dispatched", requestId: request.id, generation: 1 };
}

export interface RecoveryOutcome {
  readonly redispatched: number;
  readonly failed: number;
}

/** Bounded recovery of stale in-flight requests of the bound workspace (RECOVERY_BATCH per call; the next call continues). */
export async function recoverStaleUnderstanding(scope: IntelligenceScope, clock: ClassificationClock, policy: UnderstandAiRoutePolicy, input: { readonly correlationId: string }): Promise<RecoveryOutcome> {
  const now = clock.now();
  const stale = await scope.intelligence.staleInFlight(new Date(now.getTime() - STALE_IN_FLIGHT_MS), RECOVERY_BATCH);
  let redispatched = 0;
  let failed = 0;
  const killed = stale.length > 0 && (await operationallyKilled(scope));
  for (const request of stale) {
    if (await recoverOne(scope, clock, policy, request, input.correlationId, now, killed)) redispatched += 1;
    else failed += 1;
  }
  return { redispatched, failed };
}

async function recoverOne(scope: IntelligenceScope, clock: ClassificationClock, policy: UnderstandAiRoutePolicy, request: IntelligenceRequestRecord, correlationId: string, now: Date, killed: boolean): Promise<boolean> {
  const generation = request.aiGeneration;
  if (generation === null || (request.state !== "AI_PENDING" && request.state !== "AI_RUNNING")) throw new Error("classification_recovery_not_in_flight");
  const from = { id: request.id, from: request.state, fromGeneration: generation, now } as const;
  const route = routeDecisionFor(policy, request);
  if (route.kind === "skip" || killed || generation >= MAX_TRANSPORT_GENERATIONS) {
    if (!(await scope.intelligence.transition({ ...from, to: "AI_FAILED", generation, failureClass: "AI_UNAVAILABLE" }))) throw new Error("classification_request_moved_concurrently");
    return false;
  }
  const next = generation + 1;
  if (!(await scope.intelligence.transition({ ...from, to: "AI_PENDING", generation: next, failureClass: null }))) throw new Error("classification_request_moved_concurrently");
  const appended = await scope.intelligence.appendDispatch({ request, generation: next, correlationId, outboxId: clock.newId(), now });
  if (appended !== "appended") throw new Error("classification_dispatch_key_taken");
  return true;
}
