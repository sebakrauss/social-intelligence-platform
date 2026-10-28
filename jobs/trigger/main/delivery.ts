/**
 * Outbox delivery tasks (system scope): the post-commit relay and the two scheduled sweepers (TA §19.3), MAIN plane
 * (Step 7E.4B.3; discovered only by trigger.config.ts). Each runs through runSystemJob, which accepts only registered,
 * named system tasks. A delivery is dispatched and observed through the runtime of its PERSISTED plane; triggers into
 * the integration plane are pinned to this run's own release (its deployment's external id).
 */
import { schedules, task, type TaskRunContext } from "@trigger.dev/sdk";
import type { SystemJobContext } from "@/platform/jobs";
import { relayPass, sweepDispatch, sweepRunOutcomes, type DeliveryDependencies } from "@/platform/outbox/delivery";
import { deliveryRuntimes } from "../../main-runtime";
import { PRODUCTION_TASKS } from "../../registry";
import { jobLogger } from "../../runtime";
import { releaseOf, triggerRetry } from "../define";
import { SYSTEM_DELIVERY_QUEUE } from "../queues";
import { declared, declaredCron, runSystem, schedulePayload } from "./system";

function deliveryDeps(context: SystemJobContext, ctx: TaskRunContext): DeliveryDependencies {
  return { system: context.system, runtimes: deliveryRuntimes(releaseOf(ctx)), registry: PRODUCTION_TASKS, logger: jobLogger, clock: () => new Date() };
}

export const outboxRelay = task({
  id: "outbox.relay",
  queue: SYSTEM_DELIVERY_QUEUE,
  retry: triggerRetry(declared("outbox.relay").retry),
  run: async (payload: unknown, { ctx }) => runSystem("outbox.relay", payload, ctx, (context) => relayPass(deliveryDeps(context, ctx))),
});

export const outboxDispatchSweep = schedules.task({
  id: "outbox.dispatch_sweep",
  cron: declaredCron("outbox.dispatch_sweep"),
  queue: SYSTEM_DELIVERY_QUEUE,
  retry: triggerRetry(declared("outbox.dispatch_sweep").retry),
  run: async (_payload, { ctx }) =>
    runSystem("outbox.dispatch_sweep", schedulePayload("outbox.dispatch_sweep"), ctx, (context) => sweepDispatch(deliveryDeps(context, ctx))),
});

export const outboxOutcomeSweep = schedules.task({
  id: "outbox.outcome_sweep",
  cron: declaredCron("outbox.outcome_sweep"),
  queue: SYSTEM_DELIVERY_QUEUE,
  retry: triggerRetry(declared("outbox.outcome_sweep").retry),
  run: async (_payload, { ctx }) =>
    runSystem("outbox.outcome_sweep", schedulePayload("outbox.outcome_sweep"), ctx, (context) => sweepRunOutcomes(deliveryDeps(context, ctx))),
});
