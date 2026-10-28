/**
 * MAIN-plane composition of the provider-event inbox tasks (Step H6-F3; design H6-F0 §3, §5; D-F1, D-F2). Thin: it
 * binds the system-scope store to the ingestion services and logs bounded counts. The second reviewed user of system
 * scope (after outbox delivery): routing and retention are named system jobs that touch system tables only and reach
 * tenant rows exclusively through the 0022 definers. No provider, no credential, no raw body.
 *
 * Release order: routing (and, since H6-F4, the due-mark sweep) writes IDs-only `ingestion.process_signals` outbox rows,
 * consumed by the MAIN tenant task of the same name (H6-F4): the router and its consumer ship in ONE paired release.
 */
import { dispatchDueSignalMarks, purgeExpiredProviderEvents, routeDueProviderEvents, type ProviderEventDependencies, type PurgeSummary, type RouteSummary } from "@/modules/ingestion";
import type { SystemJobContext } from "@/platform/jobs";
import type { Logger } from "@/platform/observability";
import { withSystemScope } from "@/platform/db/system-scope";
import { providerEventStore } from "@/server/persistence/ingestion";

function dependencies(context: SystemJobContext): ProviderEventDependencies {
  return { inSystem: (work) => withSystemScope(context.system, (tx) => work(providerEventStore(tx))) };
}

export async function runRouteProviderEvents(context: SystemJobContext, logger: Logger): Promise<RouteSummary & { readonly dueMarksDispatched: number }> {
  const summary = await routeDueProviderEvents(dependencies(context));
  // Step H6-F4 (design H6-F0 §13.5): the router's due-mark sweep re-dispatches marks whose revisit time passed.
  const dueMarksDispatched = await dispatchDueSignalMarks(dependencies(context));
  const log = logger.child({ module: "jobs.provider_events", task: context.payload.task });
  log.info("webhook.route.completed", { count: summary.listed });
  for (const [outcome, count] of Object.entries(summary.outcomes)) if (count > 0) log.info(`webhook.route.${outcome}`, { count });
  // D-F2: more than five ACTIVE tenants for one provider asset is a configuration fault, never partially fanned out.
  if (summary.outcomes.multi_org_limit > 0) log.error("webhook.route.multi_org_limit_alert", { count: summary.outcomes.multi_org_limit, outcome: "error" });
  if (dueMarksDispatched > 0) log.info("signal.due_marks_dispatched", { count: dueMarksDispatched });
  return { ...summary, dueMarksDispatched };
}

export async function runPurgeProviderEvents(context: SystemJobContext, logger: Logger): Promise<PurgeSummary> {
  const summary = await purgeExpiredProviderEvents(dependencies(context));
  const log = logger.child({ module: "jobs.provider_events", task: context.payload.task });
  log.info("webhook.purge.completed", { count: summary.inboxDeleted });
  log.info("webhook.purge.hints", { count: summary.hintsDeleted });
  log.info("webhook.purge.batches", { count: summary.batches });
  if (summary.remainderPossible) log.warn("webhook.purge.remainder", { count: summary.batches });
  return summary;
}
