/**
 * Post-commit relay nudge (TA §5 "web-invoked dispatch after commit"; §10.6 step 9). After a transaction
 * that appended outbox rows commits, the web runtime asks the job runtime to run the system relay now
 * instead of waiting for the scheduled sweeper. It never touches the outbox itself (web users can't read
 * or update it): the system relay stays the single writer of delivery state. Best effort by design: if the
 * nudge fails, the dispatch sweeper delivers the rows later.
 */
import type { JobRuntime } from "@/platform/jobs";

export const RELAY_TASK = "outbox.relay";

export async function nudgeRelay(runtime: JobRuntime, options: { readonly outboxId: string; readonly correlationId: string }): Promise<string> {
  const { runId } = await runtime.enqueue({
    task: RELAY_TASK,
    payload: { v: 1, scope: "system", task: RELAY_TASK, correlationId: options.correlationId, initiator: { type: "system" } },
    dispatchKey: `outbox.relay:${options.outboxId}`,
    lane: "system",
  });
  return runId;
}
