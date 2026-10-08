/**
 * Outbox delivery tasks (system scope): the post-commit relay and the two scheduled sweepers (TA §19.3), MAIN plane
 * (Step 7E.4B.3; discovered only by trigger.config.ts). Each runs through runSystemJob, which accepts only registered,
 * named system tasks. A delivery is dispatched and observed through the runtime of its PERSISTED plane; triggers into
 * the integration plane are pinned to this run's own release (its deployment's external id).
 */
import { schedules, task, type TaskRunContext } from "@trigger.dev/sdk";
import { randomUUID } from "node:crypto";
import { runSystemJob, type RetryPolicy, type SystemJobContext } from "@/platform/jobs";
import { relayPass, sweepDispatch, sweepRunOutcomes, type DeliveryDependencies } from "@/platform/outbox/delivery";
import { assertPlaneEnvironment } from "../../plane-environment";
import { deliveryRuntimes, systemDatabase } from "../../main-runtime";
import { PRODUCTION_TASKS } from "../../registry";
import { jobLogger } from "../../runtime";
import { releaseOf, triggerRetry, toVendorError } from "../define";
import { SYSTEM_DELIVERY_QUEUE } from "../queues";

function deliveryDeps(context: SystemJobContext, ctx: TaskRunContext): DeliveryDependencies {
  return { system: context.system, runtimes: deliveryRuntimes(releaseOf(ctx)), registry: PRODUCTION_TASKS, logger: jobLogger, clock: () => new Date() };
}

async function runSystem<T>(name: string, payload: unknown, ctx: TaskRunContext, work: (context: SystemJobContext) => Promise<T>): Promise<T> {
  try {
    assertPlaneEnvironment("main", releaseOf(ctx), process.env);
    return await runSystemJob({ registry: PRODUCTION_TASKS, system: systemDatabase(), logger: jobLogger }, name, payload, { runId: ctx.run.id, attempt: ctx.attempt.number }, work);
  } catch (error) {
    throw toVendorError(error);
  }
}

/** Retry policy and schedule come from the registry declaration, never from literals here. */
function declared(name: string): { readonly retry: RetryPolicy; readonly cron: string | undefined } {
  const definition = PRODUCTION_TASKS.system(name);
  if (definition === undefined) throw new Error(`system task not registered: ${name}`);
  return { retry: definition.retry, cron: definition.schedule?.cron };
}

function declaredCron(name: string): string {
  const { cron } = declared(name);
  if (cron === undefined) throw new Error(`system task has no schedule: ${name}`);
  return cron;
}

const schedulePayload = (taskName: string) => ({ v: 1, scope: "system", task: taskName, correlationId: `sched-${randomUUID()}`, initiator: { type: "system" } });

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
