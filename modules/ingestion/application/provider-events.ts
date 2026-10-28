/**
 * The provider-event inbox drain and retention (Step H6-F3; design H6-F0 §3, §5, §7; D-F1, D-F2). Pure orchestration
 * over a system-scope store port; the 0022 definers are the authority for every state transition and lock.
 *
 *   routeDueProviderEvents      lists up to `routerBatchLimit` due hint ids, then routes each in ITS OWN transaction:
 *                               a crash or a transient failure keeps what was routed (idempotent: a routed hint answers
 *                               not_pending), and overlapping runs serialize on the hint's row lock — never a second route.
 *   purgeExpiredProviderEvents  at most `purgeMaxBatches` bounded purge calls; a short batch means nothing older is left.
 *   dispatchDueSignalMarks      Step H6-F4 (design H6-F0 §13.5): the router's due-mark sweep — one bounded call of
 *                               system.dispatch_due_signal_marks, which re-dispatches every signal mark whose revisit
 *                               time passed as an account-only `ingestion.process_signals` row (the cron is its clock).
 * Neither reads a raw body, opens a credential, maps a tenant itself or calls a provider.
 */
import { PROVIDER_EVENT_RUNTIME, ROUTE_OUTCOMES, type RouteOutcome } from "../domain/provider-events";
import { SIGNAL_RUNTIME } from "../domain/signals";

export interface ProviderEventStore {
  /** Due hint ids (PENDING, or RETRYABLE whose retry time passed), oldest first, at most `limit`. */
  listDueHints(limit: number): Promise<readonly string[]>;
  routeHint(hintId: string): Promise<RouteOutcome>;
  purgeExpired(limit: number): Promise<{ readonly inboxDeleted: number; readonly hintsDeleted: number }>;
  /** Step H6-F4: system.dispatch_due_signal_marks — the marks re-dispatched (IDs-only rows written by the definer). */
  dispatchDueMarks(limit: number): Promise<number>;
}

export interface ProviderEventDependencies {
  /** One system-scope transaction per call. */
  inSystem<T>(work: (store: ProviderEventStore) => Promise<T>): Promise<T>;
}

export interface RouteSummary {
  readonly listed: number;
  readonly outcomes: Readonly<Record<RouteOutcome, number>>;
}

export async function routeDueProviderEvents(deps: ProviderEventDependencies, limit: number = PROVIDER_EVENT_RUNTIME.routerBatchLimit): Promise<RouteSummary> {
  const bounded = Math.min(Math.max(1, Math.trunc(limit)), PROVIDER_EVENT_RUNTIME.routerBatchLimit);
  const due = await deps.inSystem((store) => store.listDueHints(bounded));
  const outcomes = Object.fromEntries(ROUTE_OUTCOMES.map((outcome) => [outcome, 0])) as Record<RouteOutcome, number>;
  for (const hintId of due.slice(0, bounded)) {
    const outcome = await deps.inSystem((store) => store.routeHint(hintId));
    outcomes[outcome] += 1;
  }
  return Object.freeze({ listed: due.length, outcomes: Object.freeze(outcomes) });
}

export interface PurgeSummary {
  readonly batches: number;
  readonly inboxDeleted: number;
  readonly hintsDeleted: number;
  /** True when the last batch was full: older receipts may remain for the next run. */
  readonly remainderPossible: boolean;
}

export async function purgeExpiredProviderEvents(deps: ProviderEventDependencies): Promise<PurgeSummary> {
  const { purgeBatchSize, purgeMaxBatches } = PROVIDER_EVENT_RUNTIME;
  let batches = 0;
  let inboxDeleted = 0;
  let hintsDeleted = 0;
  let full = false;
  do {
    const result = await deps.inSystem((store) => store.purgeExpired(purgeBatchSize));
    batches += 1;
    inboxDeleted += result.inboxDeleted;
    hintsDeleted += result.hintsDeleted;
    full = result.inboxDeleted >= purgeBatchSize;
  } while (full && batches < purgeMaxBatches);
  return Object.freeze({ batches, inboxDeleted, hintsDeleted, remainderPossible: full });
}

/** Step H6-F4: one bounded due-mark sweep (the remainder waits for the next router run). */
export async function dispatchDueSignalMarks(deps: ProviderEventDependencies): Promise<number> {
  return deps.inSystem((store) => store.dispatchDueMarks(SIGNAL_RUNTIME.dueMarkDispatchLimit));
}
