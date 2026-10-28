/** Step H6-F3 — the router nudge built by the web composition: a valid MAIN system payload, keyed by the receipt. */
import { describe, expect, it } from "vitest";
import { parseSystemJobPayload, type EnqueueRequest, type JobRuntime } from "@/platform/jobs";
import { ROUTE_PROVIDER_EVENTS_TASK } from "@/modules/ingestion";
import { nudgeProviderEventRouter } from "@/server/webhooks/runtime";

describe("nudgeProviderEventRouter", () => {
  it("enqueues the router task with a parseable system payload, the system lane and a receipt-keyed dispatch key", async () => {
    const seen: EnqueueRequest[] = [];
    const runtime = { enqueue: (request: EnqueueRequest) => { seen.push(request); return Promise.resolve({ runId: "run_1" }); } } as unknown as JobRuntime;
    const receiptId = "00000000-0000-4000-8000-0000000000a1";
    await nudgeProviderEventRouter(runtime, receiptId);
    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request).toMatchObject({ task: ROUTE_PROVIDER_EVENTS_TASK, lane: "system", dispatchKey: `${ROUTE_PROVIDER_EVENTS_TASK}:${receiptId}` });
    expect(parseSystemJobPayload(request?.payload)).toMatchObject({ scope: "system", task: ROUTE_PROVIDER_EVENTS_TASK, initiator: { type: "system" } });
    // IDs only: the payload names no receipt, hint, tenant or provider value.
    expect(JSON.stringify(request?.payload)).not.toContain(receiptId);
  });
});
