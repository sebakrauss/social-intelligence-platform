/**
 * MANAGED TEST TASKS — Trigger.dev DEVELOPMENT environment only (never deployed; loaded only by
 * trigger.managed-test.config.ts). They validate the Step 5G post-commit relay wake-up (G5, TA-Q-31) with the
 * PRODUCTION wiring:
 *
 *   outbox.relay                 the production relay pass (system scope, PRODUCTION_TASKS registry), without the two
 *                                scheduled sweepers: in this session nothing dispatches a row except a wake-up or the
 *                                test itself acting as the sweeper
 *   connections.move.*           the production saga handlers through the production defineTenantTask, so every
 *                                committed job transaction wakes the relay with the worker's own TRIGGER_SECRET_KEY
 *   capability.evaluate_account  a STUB (no provider call): the hand-off is enqueued and delivered, evaluation is not
 *                                under test here
 */
import { task } from "@trigger.dev/sdk";
import { runActivateDestination, runRejectDestination, runReleaseSource } from "@/jobs/connections";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { jobLogger, jobRuntime, systemDatabase } from "@/jobs/runtime";
import { defineTenantTask, toVendorError, triggerRetry } from "@/jobs/trigger/define";
import { SYSTEM_DELIVERY_QUEUE } from "@/jobs/trigger/queues";
import { runSystemJob } from "@/platform/jobs";
import { relayPass } from "@/platform/outbox/delivery";

const relayDefinition = PRODUCTION_TASKS.system("outbox.relay");
if (relayDefinition === undefined) throw new Error("outbox.relay not registered");

export const managedRelay = task({
  id: relayDefinition.name,
  queue: SYSTEM_DELIVERY_QUEUE,
  retry: triggerRetry(relayDefinition.retry),
  run: async (payload: unknown, { ctx }) => {
    try {
      return await runSystemJob({ registry: PRODUCTION_TASKS, system: systemDatabase(), logger: jobLogger }, relayDefinition.name, payload, { runId: ctx.run.id, attempt: ctx.attempt.number }, (context) =>
        relayPass({ system: context.system, runtime: jobRuntime(), registry: PRODUCTION_TASKS, logger: jobLogger, clock: () => new Date() }),
      );
    } catch (error) {
      throw toVendorError(error);
    }
  },
});

export const managedReleaseSource = defineTenantTask(PRODUCTION_TASKS, "connections.move.release_source", runReleaseSource);
export const managedActivateDestination = defineTenantTask(PRODUCTION_TASKS, "connections.move.activate_destination", runActivateDestination);
export const managedRejectDestination = defineTenantTask(PRODUCTION_TASKS, "connections.move.reject_destination", runRejectDestination);
export const managedCapabilityStub = defineTenantTask(PRODUCTION_TASKS, "capability.evaluate_account", () => Promise.resolve({ kind: "stub_not_under_test" }));
