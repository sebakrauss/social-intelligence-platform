/**
 * Provider-event inbox runtime constants and closed vocabularies (Step H6-F3; design H6-F0 §3, §5, §14; migration 0022).
 * Pure. The inbox is the durable queue of verified provider receipts (D-F1); MAIN drains it in bounded batches, a cron
 * guaranteeing the drain and a web nudge only lowering latency. A webhook is a SIGNAL: nothing here is source authority.
 */

/** MAIN system task draining due hints through system.route_provider_hint (cron every minute + web nudge). */
export const ROUTE_PROVIDER_EVENTS_TASK = "ingestion.route_provider_events" as const;
/** MAIN system task enforcing the 7-day inbox retention through system.purge_provider_events (cron every 15 minutes). */
export const PURGE_PROVIDER_EVENTS_TASK = "ingestion.purge_provider_events" as const;

export const PROVIDER_EVENT_RUNTIME = Object.freeze({
  /** Hints one router run routes at most (design H6-F0 §19); the rest wait for the next run. */
  routerBatchLimit: 500,
  /** Receipts one purge call deletes at most (0022 accepts 1..5000). */
  purgeBatchSize: 1000,
  /** Purge calls one run makes at most: the remainder waits for the next cron run (never an unbounded loop). */
  purgeMaxBatches: 5,
});

/** system.record_provider_webhook outcomes. */
export const RECEIPT_OUTCOMES = ["recorded", "duplicate"] as const;
export type ReceiptOutcome = (typeof RECEIPT_OUTCOMES)[number];

/** system.route_provider_hint outcomes (0022, exactly). */
export const ROUTE_OUTCOMES = ["routed", "retry", "unmapped", "multi_org_limit", "not_due", "not_pending", "not_found"] as const;
export type RouteOutcome = (typeof ROUTE_OUTCOMES)[number];

export const isReceiptOutcome = (value: unknown): value is ReceiptOutcome => typeof value === "string" && (RECEIPT_OUTCOMES as readonly string[]).includes(value);
export const isRouteOutcome = (value: unknown): value is RouteOutcome => typeof value === "string" && (ROUTE_OUTCOMES as readonly string[]).includes(value);

/** The dispatch key of the web's post-commit router nudge: one run per new receipt, never per retry of the same one. */
export const routerNudgeDispatchKey = (receiptId: string): string => `${ROUTE_PROVIDER_EVENTS_TASK}:${receiptId}`;
