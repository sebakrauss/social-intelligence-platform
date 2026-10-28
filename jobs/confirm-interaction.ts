/**
 * Job-runtime composition of the INTEGRATION-plane task `ingestion.confirm_interaction` (Step H6-E): ONE direct
 * provider re-read of ONE canonical interaction, from its stored provenance. The provider credential is opened only
 * through this plane's credential access (jobs/connections.ts composeJobProviders), once, between transactions. Thin
 * handler: resolve the two identifiers and the correlation, run the application service, map its outcome — a transient
 * failure the runtime may retry (bounded by the task's policy); everything else is a recorded outcome.
 */
import { randomUUID } from "node:crypto";
import { parseCorrelationId } from "@/domain/correlation";
import { confirmStoredInteraction, type ConfirmationResult } from "@/modules/ingestion";
import type { DiscoveryProviders, ProviderCredentialAccess } from "@/modules/connections";
import { NonRetryableJobError, type TenantStepJobContext } from "@/platform/jobs";
import { reconciliationScope } from "@/server/persistence/ingestion";
import { composeJobProviders } from "./connections";
import { PRODUCTION_TASKS } from "./registry";

export const CONFIRM_INTERACTION_TASK = "ingestion.confirm_interaction";

let composition: { readonly access: ProviderCredentialAccess; readonly providers: DiscoveryProviders } | undefined;

export async function runConfirmInteraction(
  context: TenantStepJobContext,
  base?: { readonly access: ProviderCredentialAccess; readonly providers: DiscoveryProviders },
  options: { readonly clock?: { readonly newId: () => string; readonly now: () => Date } } = {},
): Promise<Extract<ConfirmationResult, { kind: "confirmed" }>> {
  const interactionId = context.payload.subjectIds["interaction_id"];
  const connectedAccountId = context.payload.subjectIds["connected_account_id"];
  const correlationId = parseCorrelationId(context.payload.correlationId);
  if (interactionId === undefined || connectedAccountId === undefined || correlationId === undefined) throw new NonRetryableJobError("invalid_payload");
  const resolved = base ?? (composition ??= composeJobProviders(process.env));
  const maxAttempts = PRODUCTION_TASKS.get(CONFIRM_INTERACTION_TASK)?.retry.maxAttempts ?? 1;
  const result = await confirmStoredInteraction(
    {
      inScope: (work) => context.inScope((scope) => work(reconciliationScope(scope))),
      access: resolved.access,
      providers: resolved.providers,
      clock: options.clock ?? { newId: randomUUID, now: () => new Date() },
      finalAttempt: context.run.attempt >= maxAttempts,
    },
    { interactionId, connectedAccountId, correlationId },
  );
  if (result.kind === "retry") throw result.error;
  return result;
}
