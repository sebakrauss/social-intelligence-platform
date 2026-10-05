/**
 * Trigger.dev deployment configuration for the jobs unit (TA §63.1). Used only by the Trigger.dev CLI,
 * which is NOT a repository dependency: it runs as a pinned, ephemeral tool (see README › Jobs). The project
 * reference comes from the environment and is never committed.
 */
import { defineConfig } from "@trigger.dev/sdk";
import { RETRY_POLICIES } from "./platform/jobs/registry";

export default defineConfig({
  project: process.env["TRIGGER_PROJECT_REF"] ?? "",
  dirs: ["./jobs/trigger"],
  maxDuration: 300,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: RETRY_POLICIES.transient.maxAttempts,
      factor: RETRY_POLICIES.transient.factor,
      minTimeoutInMs: RETRY_POLICIES.transient.minDelayMs,
      maxTimeoutInMs: RETRY_POLICIES.transient.maxDelayMs,
      randomize: RETRY_POLICIES.transient.randomize,
    },
  },
});
