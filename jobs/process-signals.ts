/**
 * Job-runtime composition of the MAIN-plane tenant task `ingestion.process_signals` (Step H6-F4; design H6-F0 §9–§14).
 * DB planning only: it never opens a provider credential, calls a provider, reads a webhook body or appends its own
 * topic (the 0022 restrictive policy denies the worker that; only the system routing and due-mark definers produce it).
 * Thin handler: resolve the identifiers (the workspace is the outbox row's, never a subject), run the application
 * service in the run's single workspace-scoped transaction, log the closed outcome and counts only.
 */
import { randomUUID } from "node:crypto";
import { parseCorrelationId } from "@/domain/correlation";
import { processProviderSignal, type SignalResult } from "@/modules/ingestion";
import { NonRetryableJobError, type TenantJobContext } from "@/platform/jobs";
import type { Logger } from "@/platform/observability";
import { reconciliationScope } from "@/server/persistence/ingestion";

const systemClock = { newId: randomUUID, now: () => new Date() };
const HINT_SUBJECTS = ["connected_account_id", "provider_event_hint_id"] as const;
const DUE_SUBJECTS = ["connected_account_id"] as const;

export async function runProcessSignals(context: TenantJobContext, logger: Logger, clock: { readonly newId: () => string; readonly now: () => Date } = systemClock): Promise<SignalResult> {
  const subjects = context.payload.subjectIds;
  const names = Object.keys(subjects).sort();
  // Exactly the routed-hint shape or the due-mark shape (0022 owner_signal_dispatch); anything else is refused.
  const routed = names.length === HINT_SUBJECTS.length && HINT_SUBJECTS.every((name) => names.includes(name));
  const due = names.length === DUE_SUBJECTS.length && DUE_SUBJECTS.every((name) => names.includes(name));
  const connectedAccountId = subjects["connected_account_id"];
  const correlationId = parseCorrelationId(context.payload.correlationId);
  if ((!routed && !due) || connectedAccountId === undefined || correlationId === undefined) throw new NonRetryableJobError("invalid_payload");
  const result = await processProviderSignal(reconciliationScope(context), clock, {
    connectedAccountId,
    providerEventHintId: routed ? (subjects["provider_event_hint_id"] ?? null) : null,
    correlationId,
  });
  const log = logger.child({ module: "jobs.process_signals", task: context.payload.task });
  log.info(`signal.${result.outcome.toLowerCase()}`, { count: 1 });
  if (result.expired > 0) log.info("signal.mark_expired", { count: result.expired });
  if (result.contentNotCanonical) log.info("signal.content_not_canonical", { count: 1 });
  if (result.coalesced) log.info("signal.confirmation_coalesced", { count: 1 });
  if (result.confirmationsRequested > 0) log.info("signal.confirmation_requested", { count: result.confirmationsRequested });
  return result;
}
