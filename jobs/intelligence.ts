/**
 * INTELLIGENCE-plane composition of `classification.understand_ai` (Step H7-D1d; H7-A0 §8–§12, D-H7-1). Thin: it
 * validates the IDs-only envelope, binds the module's runner to the run's workspace-scoped steps and composes the AI
 * gateway — and nothing else. MAIN never imports this file (execution-plane guards), so no MAIN graph reaches the
 * gateway, a provider adapter or the model credential.
 *
 *   model       the QUALIFIED descriptor (ai/providers/anthropic/qualified.ts) — still `enabled: false`, so even a
 *               complete route policy gets AI_UNAVAILABLE(model_unavailable) until a later gate enables it
 *   credential  INTELLIGENCE_MODEL_API_KEY, read here and passed EXPLICITLY to the runtime client (H7-D1g-prep:
 *               ai/providers/anthropic/runtime-client.ts — no SDK retries, no trace propagation to the provider); absent ⇒ no
 *               provider is composed (model_unavailable, no call). The SDK's ambient variables (ANTHROPIC_API_KEY and
 *               the endpoint overrides) are never read: the plane refuses a run that holds any of them
 *   route       INTELLIGENCE_ROUTE_POLICY (deny-by-default); the gateway's kill switch is the policy's
 *   budget      per run, the runner's port over classification.reserve_ai_budget()
 *   egress      per run, the runner's fence (Step H7-D1e2b): each call's ai_call_intents row is committed first
 */
import { randomUUID } from "node:crypto";
import { createLedgeredAiGateway, createModelRegistry, type ModelDescriptor, type ModelProvider } from "@/ai/gateway";
import { createAnthropicProvider } from "@/ai/providers/anthropic";
import {
  QUALIFIED_UNDERSTANDING_CALL_TIMEOUT_MS,
  QUALIFIED_UNDERSTANDING_DESCRIPTOR,
  QUALIFIED_UNDERSTANDING_FINGERPRINT,
  QUALIFIED_UNDERSTANDING_MODEL_KEY,
  QUALIFIED_UNDERSTANDING_MODEL_REF,
  QUALIFIED_UNDERSTANDING_SETTINGS,
} from "@/ai/providers/anthropic/qualified";
import { createRuntimeAnthropicClient } from "@/ai/providers/anthropic/runtime-client";
import { ANTHROPIC_TRANSPORT_SCHEMA_VERSION } from "@/ai/providers/anthropic/schema-projection";
import { understandAiPayloadFromEnvelope, type ClassificationClock, type UnderstandAiRoutePolicy } from "@/modules/classification";
import { interruptedRunReport, runUnderstanding, understandAiRouteTable, understandingRunReport, type UnderstandingModelBinding, type UnderstandingRunOutcome, type UnderstandingRunReport } from "@/modules/classification/intelligence-runtime";
import { NonRetryableJobError, type TenantStepJobContext } from "@/platform/jobs";
import type { Logger } from "@/platform/observability";
import { intelligenceScope } from "@/server/persistence/classification";
import { INTELLIGENCE_ROUTE_POLICY } from "./intelligence-policy";
import { INTELLIGENCE_MODEL_API_KEY_ENV } from "./plane-environment";
import { jobLogger } from "./runtime";

type Environment = Readonly<Record<string, string | undefined>>;

/** The qualified binding: provenance of every attempt and result (route fingerprint = the H7-D0 qualified configuration). */
export const QUALIFIED_UNDERSTANDING_BINDING: UnderstandingModelBinding = Object.freeze({
  model: QUALIFIED_UNDERSTANDING_MODEL_REF,
  modelRequested: QUALIFIED_UNDERSTANDING_SETTINGS.model,
  transportSchemaVersion: ANTHROPIC_TRANSPORT_SCHEMA_VERSION,
  routeFingerprint: QUALIFIED_UNDERSTANDING_FINGERPRINT,
});

/** The plane's model providers: the qualified adapter with the INTELLIGENCE credential passed explicitly — none without it. */
export function intelligenceProviders(environment: Environment = process.env): readonly ModelProvider[] {
  const apiKey = environment[INTELLIGENCE_MODEL_API_KEY_ENV];
  if (apiKey === undefined || apiKey === "") return Object.freeze([]);
  return Object.freeze([
    createAnthropicProvider({ client: createRuntimeAnthropicClient(apiKey), models: { [QUALIFIED_UNDERSTANDING_MODEL_KEY]: QUALIFIED_UNDERSTANDING_SETTINGS }, timeoutMs: QUALIFIED_UNDERSTANDING_CALL_TIMEOUT_MS }),
  ]);
}

export interface IntelligenceComposition {
  readonly policy: UnderstandAiRoutePolicy;
  readonly models: readonly ModelDescriptor[];
  readonly providers: () => readonly ModelProvider[];
  readonly binding: UnderstandingModelBinding;
  readonly clock: ClassificationClock;
}

let providers: readonly ModelProvider[] | undefined;

export const PRODUCTION_INTELLIGENCE: IntelligenceComposition = Object.freeze({
  policy: INTELLIGENCE_ROUTE_POLICY,
  models: Object.freeze([QUALIFIED_UNDERSTANDING_DESCRIPTOR]),
  // Lazily, on the first run (never at import time: the runtime indexes task files without a credential).
  providers: () => (providers ??= intelligenceProviders()),
  binding: QUALIFIED_UNDERSTANDING_BINDING,
  clock: Object.freeze({ newId: randomUUID, now: () => new Date() }),
});

/** classification.understand_ai: one understanding request of the run's workspace, by its identifiers only. */
export async function runUnderstandAi(context: TenantStepJobContext, composition: IntelligenceComposition = PRODUCTION_INTELLIGENCE, log: Logger = jobLogger): Promise<UnderstandingRunOutcome> {
  const parsed = understandAiPayloadFromEnvelope(context.payload);
  if (!parsed.ok) throw new NonRetryableJobError("invalid_payload");
  const { policy, clock } = composition;
  const registry = createModelRegistry(composition.models);
  const routes = understandAiRouteTable(policy);
  const started = Date.now();
  // Step H7-D1g-prep: the ACTUAL terminal outcome (closed category + closed reason/cause), never a hard-coded "ok".
  const logRun = (report: UnderstandingRunReport, count: number): void => {
    const fields = { workspaceId: context.payload.workspaceId, task: "classification.understand_ai", outcome: report.ok ? "ok" as const : "error" as const, operation: `${report.category}.${report.detail}`, durationMs: Date.now() - started, count };
    if (report.ok) log.info("classification.intelligence.run", fields);
    else log.warn("classification.intelligence.run", fields);
  };
  const egressCounts = { authorized: 0, recorded: 0 };
  let outcome: UnderstandingRunOutcome;
  try {
    outcome = await runUnderstanding({
      inScope: (work) => context.inScope((scope) => work({ ...intelligenceScope(scope), claimEffect: scope.claimEffect })),
      policy,
      binding: composition.binding,
      clock,
      // Step H7-D1e2b: the LEDGERED gateway — no provider call without the runner's committed egress identity.
      gatewayFor: (budget, egress) => createLedgeredAiGateway({ registry, routes, providers: composition.providers(), budget, egress, killed: () => policy.killSwitch !== "inactive", now: clock.now }),
      egressObserver: { authorized: () => { egressCounts.authorized += 1; }, recorded: () => { egressCounts.recorded += 1; } },
    }, parsed.payload, { runId: context.run.runId });
  } catch (error) {
    logRun(interruptedRunReport(egressCounts), egressCounts.authorized);
    throw error;
  }
  logRun(understandingRunReport(outcome), "attempts" in outcome ? outcome.attempts : 0);
  return outcome;
}
