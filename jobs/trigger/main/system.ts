/**
 * Shared composition of the MAIN plane's named system tasks (outbox delivery, Step 3/7E.4B.3; provider-event inbox,
 * Step H6-F3). It exports no task (helpers only); every system task runs through
 * runSystemJob, which accepts only registered, named system tasks, and takes its retry policy and schedule from the
 * registry declaration — never from literals at the call site.
 */
import { type TaskRunContext } from "@trigger.dev/sdk";
import { randomUUID } from "node:crypto";
import { runSystemJob, type RetryPolicy, type SystemJobContext } from "@/platform/jobs";
import { assertPlaneEnvironment } from "../../plane-environment";
import { systemDatabase } from "../../main-runtime";
import { PRODUCTION_TASKS } from "../../registry";
import { jobLogger } from "../../runtime";
import { releaseOf, toVendorError } from "../define";

export async function runSystem<T>(name: string, payload: unknown, ctx: TaskRunContext, work: (context: SystemJobContext) => Promise<T>): Promise<T> {
  try {
    assertPlaneEnvironment("main", releaseOf(ctx), process.env);
    return await runSystemJob({ registry: PRODUCTION_TASKS, system: systemDatabase(), logger: jobLogger }, name, payload, { runId: ctx.run.id, attempt: ctx.attempt.number }, work);
  } catch (error) {
    throw toVendorError(error);
  }
}

/** Retry policy and schedule come from the registry declaration, never from literals here. */
export function declared(name: string): { readonly retry: RetryPolicy; readonly cron: string | undefined } {
  const definition = PRODUCTION_TASKS.system(name);
  if (definition === undefined) throw new Error(`system task not registered: ${name}`);
  return { retry: definition.retry, cron: definition.schedule?.cron };
}

export function declaredCron(name: string): string {
  const { cron } = declared(name);
  if (cron === undefined) throw new Error(`system task has no schedule: ${name}`);
  return cron;
}

/** The system payload a scheduled (or nudged) run executes with: the incoming vendor payload is never trusted. */
export const schedulePayload = (taskName: string) => ({ v: 1, scope: "system", task: taskName, correlationId: `sched-${randomUUID()}`, initiator: { type: "system" } });
