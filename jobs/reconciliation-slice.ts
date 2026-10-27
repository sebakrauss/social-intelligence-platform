/**
 * Job-runtime composition of the INTEGRATION-plane reconciliation task `ingestion.reconcile_slice` (Step H6-C3; design
 * H6-C0). The provider credential is opened only through this plane's credential access (jobs/connections.ts
 * composeJobProviders), once per provider read, between transactions. Thin handler: resolve the slice's identifiers,
 * run the application service, map its outcome — a busy account or a transient failure the runtime may retry, a
 * missing slice is non-retryable; everything else is a recorded slice outcome.
 */
import { randomUUID } from "node:crypto";
import { runReconciliationSlice, type SliceOutcome } from "@/modules/ingestion";
import type { DiscoveryProviders, ProviderCredentialAccess } from "@/modules/connections";
import { NonRetryableJobError, type TenantStepJobContext } from "@/platform/jobs";
import { reconciliationScope } from "@/server/persistence/ingestion";
import { composeJobProviders } from "./connections";
import { PRODUCTION_TASKS } from "./registry";

export const RECONCILE_SLICE_TASK = "ingestion.reconcile_slice";

let composition: { readonly access: ProviderCredentialAccess; readonly providers: DiscoveryProviders } | undefined;

/** Thrown so the runtime retries: another slice of the account is RUNNING, or a transient provider/infra failure. */
export class ReconciliationRetryableError extends Error {
  override readonly name = "ReconciliationRetryableError";
}

export async function runReconcileSlice(
  context: TenantStepJobContext,
  base?: { readonly access: ProviderCredentialAccess; readonly providers: DiscoveryProviders },
  options: { readonly clock?: { readonly newId: () => string; readonly now: () => Date } } = {},
): Promise<SliceOutcome> {
  const sliceId = context.payload.subjectIds["reconciliation_slice_id"];
  const connectedAccountId = context.payload.subjectIds["connected_account_id"];
  if (sliceId === undefined || connectedAccountId === undefined) throw new NonRetryableJobError("invalid_payload");
  const resolved = base ?? (composition ??= composeJobProviders(process.env));
  const maxAttempts = PRODUCTION_TASKS.get(RECONCILE_SLICE_TASK)?.retry.maxAttempts ?? 1;
  const outcome = await runReconciliationSlice(
    {
      inScope: (work) => context.inScope((scope) => work(reconciliationScope(scope))),
      access: resolved.access,
      providers: resolved.providers,
      clock: options.clock ?? { newId: randomUUID, now: () => new Date() },
      finalAttempt: context.run.attempt >= maxAttempts,
    },
    { sliceId, connectedAccountId },
  );
  if (outcome.kind === "not_found") throw new NonRetryableJobError("reconciliation_slice_not_found");
  if (outcome.kind === "busy") throw new ReconciliationRetryableError("reconciliation_slice_busy");
  if (outcome.kind === "retry") throw outcome.error;
  return outcome;
}
