/**
 * Job deployment composition. Dependencies are created lazily, on the first run that needs them — never at
 * import time (the runtime indexes task files without database access). Each process holds ONLY the
 * worker and system runtime URLs; never the web URL, the migration credential or a service-role key.
 */
import { createRuntimeDatabaseFromEnv, type RuntimeDatabase } from "@/platform/db";
import type { JobRuntime } from "@/platform/jobs";
import { createTriggerDevRuntime } from "@/platform/jobs/trigger-dev";
import { createLogger, stdoutSink, type Logger } from "@/platform/observability";

let worker: RuntimeDatabase<"worker"> | undefined;
let system: RuntimeDatabase<"system"> | undefined;
let runtime: JobRuntime | undefined;

export const jobLogger: Logger = createLogger({ sink: stdoutSink, base: { module: "jobs" } });

export function workerDatabase(): RuntimeDatabase<"worker"> {
  worker ??= createRuntimeDatabaseFromEnv("worker", process.env, { max: 4 });
  return worker;
}

export function systemDatabase(): RuntimeDatabase<"system"> {
  system ??= createRuntimeDatabaseFromEnv("system", process.env, { max: 2 });
  return system;
}

export function jobRuntime(): JobRuntime {
  if (runtime === undefined) {
    const secretKey = process.env["TRIGGER_SECRET_KEY"];
    if (secretKey === undefined || secretKey === "") throw new Error("TRIGGER_SECRET_KEY is not set");
    runtime = createTriggerDevRuntime({ secretKey });
  }
  return runtime;
}
