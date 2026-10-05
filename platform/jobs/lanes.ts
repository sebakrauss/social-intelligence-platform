/**
 * Priority lanes (TA §19.5, §45). Each lane is its own bounded queue, so lower-priority work can never
 * share — or starve — a higher lane's queue. Lane 1 also gets the strongest run priority. Concurrency
 * limits are explicit configuration, never implicit vendor defaults.
 */

export const LANES = [1, 2, 3, 4, 5] as const;
export type Lane = (typeof LANES)[number];

export interface LaneDefinition {
  readonly lane: Lane;
  /** Queue name in the job runtime. One queue per lane; never shared across lanes. */
  readonly queue: string;
  readonly purpose: string;
  /** Maximum concurrently executing runs on this lane's queue (per concurrency key when one is given). */
  readonly concurrencyLimit: number;
  /** Seconds of scheduling advantage given to this lane's runs (higher = picked earlier). */
  readonly priorityOffsetSeconds: number;
}

export const LANE_DEFINITIONS: Readonly<Record<Lane, LaneDefinition>> = {
  1: { lane: 1, queue: "lane-1-user-mutations", purpose: "user-initiated platform mutations", concurrencyLimit: 10, priorityOffsetSeconds: 3600 },
  2: { lane: 2, queue: "lane-2-realtime", purpose: "realtime ingestion, understanding, automation evaluation", concurrencyLimit: 10, priorityOffsetSeconds: 600 },
  3: { lane: 3, queue: "lane-3-correctness", purpose: "reconciliation, health checks, token refresh", concurrencyLimit: 5, priorityOffsetSeconds: 120 },
  4: { lane: 4, queue: "lane-4-intelligence", purpose: "aggregates, intelligence refresh, reports", concurrencyLimit: 5, priorityOffsetSeconds: 0 },
  5: { lane: 5, queue: "lane-5-backfill", purpose: "historical backfill and reprocessing", concurrencyLimit: 2, priorityOffsetSeconds: 0 },
};

/** Named system jobs (relay, sweepers) run on their own bounded queue, outside the product lanes. */
export const SYSTEM_QUEUE = { queue: "system-delivery", concurrencyLimit: 2 } as const;

export function isLane(value: unknown): value is Lane {
  return typeof value === "number" && (LANES as readonly number[]).includes(value);
}

/** Lane label for structured logs. */
export function laneLabel(lane: Lane | "system"): "1" | "2" | "3" | "4" | "5" | "system" {
  return lane === "system" ? "system" : (["1", "2", "3", "4", "5"] as const)[lane - 1] ?? "system";
}
