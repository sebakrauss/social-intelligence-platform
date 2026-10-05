/**
 * Outbox delivery tasks (system scope): the post-commit relay and the two scheduled sweepers (TA §19.3).
 * Each runs through runSystemJob, which accepts only registered, named system tasks.
 */
import { schedules, task } from "@trigger.dev/sdk";
import { randomUUID } from "node:crypto";
import { runSystemJob, type RetryPolicy, type SystemJobContext } from "@/platform/jobs";
import { relayPass, sweepDispatch, sweepRunOutcomes, type DeliveryDependencies } from "@/platform/outbox/delivery";
import { PRODUCTION_TASKS } from "../registry";
import { jobLogger, jobRuntime, systemDatabase } from "../runtime";
import { triggerRetry, toVendorError } from "./define";
import { SYSTEM_DELIVERY_QUEUE } from "./queues";

function deliveryDeps(context: SystemJobContext): DeliveryDependencies {
  return { system: context.system, runtime: jobRuntime(), registry: PRODUCTION_TASKS, logger: jobLogger, clock: () => new Date() };
}

async function runSystem<T>(name: string, payload: unknown, runId: string, attempt: number, work: (context: SystemJobContext) => Promise<T>): Promise<T> {
  try {
    return await runSystemJob({ registry: PRODUCTION_TASKS, system: systemDatabase(), logger: jobLogger }, name, payload, { runId, attempt }, work);
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
  run: async (payload: unknown, { ctx }) => runSystem("outbox.relay", payload, ctx.run.id, ctx.attempt.number, (context) => relayPass(deliveryDeps(context))),
});

export const outboxDispatchSweep = schedules.task({
  id: "outbox.dispatch_sweep",
  cron: declaredCron("outbox.dispatch_sweep"),
  queue: SYSTEM_DELIVERY_QUEUE,
  retry: triggerRetry(declared("outbox.dispatch_sweep").retry),
  run: async (_payload, { ctx }) =>
    runSystem("outbox.dispatch_sweep", schedulePayload("outbox.dispatch_sweep"), ctx.run.id, ctx.attempt.number, (context) => sweepDispatch(deliveryDeps(context))),
});

export const outboxOutcomeSweep = schedules.task({
  id: "outbox.outcome_sweep",
  cron: declaredCron("outbox.outcome_sweep"),
  queue: SYSTEM_DELIVERY_QUEUE,
  retry: triggerRetry(declared("outbox.outcome_sweep").retry),
  run: async (_payload, { ctx }) =>
    runSystem("outbox.outcome_sweep", schedulePayload("outbox.outcome_sweep"), ctx.run.id, ctx.attempt.number, (context) => sweepRunOutcomes(deliveryDeps(context))),
});
