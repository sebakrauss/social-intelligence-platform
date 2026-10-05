/**
 * Jobs deployment mapping onto Trigger.dev: declared queues match the lane model, retry policies come from
 * the registry, and permanent failures become the vendor's non-retryable abort.
 */
import { AbortTaskRunError } from "@trigger.dev/sdk";
import { describe, expect, it } from "vitest";
import { LANES, LANE_DEFINITIONS, NonRetryableJobError, RETRY_POLICIES, SYSTEM_QUEUE } from "@/platform/jobs";
import { toVendorError, triggerRetry } from "@/jobs/trigger/define";
import { LANE_QUEUES, SYSTEM_DELIVERY_QUEUE } from "@/jobs/trigger/queues";

describe("Trigger.dev task mapping", () => {
  it("declares one queue per lane with the lane's explicit concurrency limit, plus the system queue", () => {
    for (const lane of LANES) {
      expect(LANE_QUEUES[lane]).toMatchObject({ name: LANE_DEFINITIONS[lane].queue, concurrencyLimit: LANE_DEFINITIONS[lane].concurrencyLimit });
    }
    expect(SYSTEM_DELIVERY_QUEUE).toMatchObject({ name: SYSTEM_QUEUE.queue, concurrencyLimit: SYSTEM_QUEUE.concurrencyLimit });
  });

  it("maps retry policies field by field", () => {
    expect(triggerRetry(RETRY_POLICIES.transient)).toEqual({ maxAttempts: 4, factor: 2, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000, randomize: true });
    expect(triggerRetry(RETRY_POLICIES.singleAttempt).maxAttempts).toBe(1);
  });

  it("turns a permanent failure into the vendor's abort (no retry) and leaves other errors retryable", () => {
    const aborted = toVendorError(new NonRetryableJobError("invalid_payload"));
    expect(aborted).toBeInstanceOf(AbortTaskRunError);
    expect((aborted as Error).message).toBe("invalid_payload");
    const transient = new Error("transient");
    expect(toVendorError(transient)).toBe(transient);
  });
});
