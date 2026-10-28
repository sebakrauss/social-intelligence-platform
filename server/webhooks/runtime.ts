/**
 * Web composition of the Meta webhook receiver (Step H6-F3). The ONLY place the webhook configuration is opened: the
 * App Secret and the verify token become a ProviderWebhookPort here and reach nothing else — not the database, not a
 * job payload, not a log. The receipt runs in the provider-signal scope (no claims, no workspace) through the one 0022
 * definer; the nudge asks the MAIN router to drain the inbox now (best effort; its cron is the guarantee).
 */
import { after } from "next/server";
import type { ProviderWebhookPort } from "@/integrations/providers/contract";
import { createMetaWebhookPort } from "@/integrations/providers/meta/webhooks";
import { ROUTE_PROVIDER_EVENTS_TASK, routerNudgeDispatchKey } from "@/modules/ingestion";
import { recordProviderWebhook } from "@/modules/ingestion/persistence";
import { withProviderSignalScope } from "@/platform/db";
import type { JobRuntime } from "@/platform/jobs";
import { createLogger, stdoutSink } from "@/platform/observability";
import { webJobRuntime } from "@/server/jobs/outbox-notifier";
import { webDatabase } from "@/server/persistence/runtime";
import { randomUUID } from "node:crypto";
import { readMetaWebhookConfig } from "./meta-config";
import type { MetaReceiverDependencies } from "./meta-receiver";

type Environment = Readonly<Record<string, string | undefined>>;

let port: ProviderWebhookPort | undefined;

function composedPort(environment: Environment): ProviderWebhookPort | undefined {
  if (port !== undefined) return port;
  const config = readMetaWebhookConfig(environment);
  if (config === undefined) return undefined;
  port = createMetaWebhookPort({ appSecret: config.appSecret, verifyToken: config.verifyToken });
  return port;
}

/** The router nudge: the system payload of a named MAIN system task, keyed by the receipt (one run per new receipt). */
export function nudgeProviderEventRouter(runtime: JobRuntime, receiptId: string): Promise<unknown> {
  return runtime.enqueue({
    task: ROUTE_PROVIDER_EVENTS_TASK,
    payload: { v: 1, scope: "system", task: ROUTE_PROVIDER_EVENTS_TASK, correlationId: `whk-${randomUUID()}`, initiator: { type: "system" } },
    dispatchKey: routerNudgeDispatchKey(receiptId),
    lane: "system",
  });
}

export function metaReceiverRuntime(environment: Environment = process.env): MetaReceiverDependencies {
  return {
    port: () => composedPort(environment),
    record: (delivery, bytes) => withProviderSignalScope(webDatabase(), (tx) => recordProviderWebhook(tx, delivery, bytes)),
    nudge: async (receiptId) => {
      const runtime = webJobRuntime(environment);
      if (runtime === undefined) throw new Error("job runtime not configured");
      await nudgeProviderEventRouter(runtime, receiptId);
    },
    afterResponse: (work) => {
      after(work);
    },
    logger: createLogger({ sink: stdoutSink, base: { module: "server.webhooks" } }),
    now: () => new Date(),
  };
}
