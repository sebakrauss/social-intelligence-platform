/**
 * MANAGED TEST TASK — Trigger.dev DEVELOPMENT environment only (never deployed; loaded only by
 * trigger.managed-test.config.ts). It reproduces the TA-Q-04 crash through the production tenant wrapper:
 *
 *   first run   claims the domain effect, commits it (worker scope, sealed workspace), then the worker
 *               process dies (exit 137) before reporting success → the vendor marks the run CRASHED and
 *               does not retry it
 *   recovery    R7 sees CRASHED and re-dispatches under the same dispatch key → a NEW run; the domain claim
 *               returns "already_applied", so the effect is not repeated and the run COMPLETES
 *
 * The crash decision comes from the domain claim, not from the payload (payloads stay IDs-only).
 */
import { task } from "@trigger.dev/sdk";
import { runTenantJob } from "@/platform/jobs";
import { jobLogger, workerDatabase } from "@/jobs/runtime";
import { toVendorError, triggerRetry } from "@/jobs/trigger/define";
import { LANE_QUEUES } from "@/jobs/trigger/queues";
import { recordManagedEffect } from "../../../db/support/managed-effect";
import { CRASH_TASK, MANAGED_TEST_TASKS } from "../registry";

const definition = MANAGED_TEST_TASKS.tenant(CRASH_TASK);
if (definition === undefined) throw new Error("managed test task not registered");

export const crashAfterEffect = task({
  id: CRASH_TASK,
  queue: LANE_QUEUES[definition.lane],
  retry: triggerRetry(definition.retry),
  run: async (payload: unknown, { ctx }) => {
    let outcome: "applied" | "skipped";
    try {
      outcome = await runTenantJob({ registry: MANAGED_TEST_TASKS, worker: workerDatabase(), logger: jobLogger }, CRASH_TASK, payload, { runId: ctx.run.id, attempt: ctx.attempt.number },
        async ({ tx, payload: job, claimEffect }) => {
          const item = job.subjectIds["item_id"] ?? "";
          if ((await claimEffect(`managedtest.effect:${item}`)) === "already_applied") return "skipped";
          await recordManagedEffect(tx, job.workspaceId, item);
          return "applied";
        });
    } catch (error) {
      throw toVendorError(error);
    }
    if (outcome === "applied") process.exit(137); // the effect is committed; the worker dies before reporting
    return { outcome };
  },
});
