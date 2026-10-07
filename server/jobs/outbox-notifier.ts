/**
 * Web composition of the post-commit relay nudge. The web runtime holds only the job runtime's trigger
 * credential (TRIGGER_SECRET_KEY), never a system or worker database credential: it asks the job runtime
 * to run the system relay, and the relay (system scope) does the delivery.
 */
import type { JobRuntime } from "@/platform/jobs";
import { createTriggerDevRuntime } from "@/platform/jobs/trigger-dev";
import { nudgeRelay, type OutboxNotice } from "@/platform/outbox";

export function createOutboxNotifier(runtime: JobRuntime): (notices: readonly OutboxNotice[]) => Promise<void> {
  return async (notices) => {
    const first = notices[0];
    if (first === undefined) return;
    await nudgeRelay(runtime, { outboxId: first.id, correlationId: first.correlationId });
  };
}

let runtime: JobRuntime | undefined;

/** The web runtime's job runtime, or undefined when jobs aren't configured (the sweeper still delivers). */
export function webJobRuntime(env: Readonly<Record<string, string | undefined>> = process.env): JobRuntime | undefined {
  const secretKey = env["TRIGGER_SECRET_KEY"];
  if (secretKey === undefined || secretKey === "") return undefined;
  runtime ??= createTriggerDevRuntime({ secretKey });
  return runtime;
}
