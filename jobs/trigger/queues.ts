/** One declared queue per lane plus the system queue, each with an explicit concurrency limit (TA §19.5). */
import { queue } from "@trigger.dev/sdk";
import { LANE_DEFINITIONS, SYSTEM_QUEUE, type Lane } from "@/platform/jobs";

export const LANE_QUEUES = {
  1: queue({ name: LANE_DEFINITIONS[1].queue, concurrencyLimit: LANE_DEFINITIONS[1].concurrencyLimit }),
  2: queue({ name: LANE_DEFINITIONS[2].queue, concurrencyLimit: LANE_DEFINITIONS[2].concurrencyLimit }),
  3: queue({ name: LANE_DEFINITIONS[3].queue, concurrencyLimit: LANE_DEFINITIONS[3].concurrencyLimit }),
  4: queue({ name: LANE_DEFINITIONS[4].queue, concurrencyLimit: LANE_DEFINITIONS[4].concurrencyLimit }),
  5: queue({ name: LANE_DEFINITIONS[5].queue, concurrencyLimit: LANE_DEFINITIONS[5].concurrencyLimit }),
} as const satisfies Record<Lane, ReturnType<typeof queue>>;

export const SYSTEM_DELIVERY_QUEUE = queue({ name: SYSTEM_QUEUE.queue, concurrencyLimit: SYSTEM_QUEUE.concurrencyLimit });
