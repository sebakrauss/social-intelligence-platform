/**
 * MAIN-plane provider-event inbox tasks (Step H6-F3; discovered only by trigger.config.ts). Both are scheduled system
 * tasks: the cron is the durable guarantee, the web's post-commit nudge (a trigger of the same task id) only lowers
 * latency. Either way the run executes with a payload built HERE — the vendor's (schedule or nudge) payload is never
 * trusted. DB-only: no provider, no credential, no raw body.
 */
import { schedules } from "@trigger.dev/sdk";
import { PURGE_PROVIDER_EVENTS_TASK, ROUTE_PROVIDER_EVENTS_TASK } from "@/modules/ingestion";
import { runPurgeProviderEvents, runRouteProviderEvents } from "../../provider-events";
import { jobLogger } from "../../runtime";
import { triggerRetry } from "../define";
import { SYSTEM_DELIVERY_QUEUE } from "../queues";
import { declared, declaredCron, runSystem, schedulePayload } from "./system";

// Literal ids (discovered by the plane guards); pinned equal to the module constants by test.
export const ingestionRouteProviderEvents = schedules.task({
  id: "ingestion.route_provider_events",
  cron: declaredCron(ROUTE_PROVIDER_EVENTS_TASK),
  queue: SYSTEM_DELIVERY_QUEUE,
  retry: triggerRetry(declared(ROUTE_PROVIDER_EVENTS_TASK).retry),
  run: async (_payload, { ctx }) =>
    runSystem(ROUTE_PROVIDER_EVENTS_TASK, schedulePayload(ROUTE_PROVIDER_EVENTS_TASK), ctx, (context) => runRouteProviderEvents(context, jobLogger)),
});

export const ingestionPurgeProviderEvents = schedules.task({
  id: "ingestion.purge_provider_events",
  cron: declaredCron(PURGE_PROVIDER_EVENTS_TASK),
  queue: SYSTEM_DELIVERY_QUEUE,
  retry: triggerRetry(declared(PURGE_PROVIDER_EVENTS_TASK).retry),
  run: async (_payload, { ctx }) =>
    runSystem(PURGE_PROVIDER_EVENTS_TASK, schedulePayload(PURGE_PROVIDER_EVENTS_TASK), ctx, (context) => runPurgeProviderEvents(context, jobLogger)),
});
