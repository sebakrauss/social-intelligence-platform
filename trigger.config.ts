/**
 * Trigger.dev deployment configuration for the jobs unit's MAIN execution plane (TA §63.1; Step 7E.4B.3): the outbox
 * relay and sweepers and the Move saga steps — every task that never opens a provider credential. The integration plane
 * is a separate project and deployment (trigger.integration.config.ts); the two discover disjoint task directories.
 * Used only by the Trigger.dev CLI, which is NOT a repository dependency: it runs as a pinned, ephemeral tool (see
 * README › Jobs). The project reference comes from the environment and is never committed. Both planes are deployed
 * from the same commit with the same `--external-id` (version-skew protection across planes).
 */
import { defineConfig } from "@trigger.dev/sdk";
import { RETRY_POLICIES } from "./platform/jobs/registry";

export default defineConfig({
  // Node 22 like .nvmrc and package.json engines; never the CLI's implicit "current LTS" default.
  runtime: "node-22",
  project: process.env["TRIGGER_PROJECT_REF"] ?? "",
  dirs: ["./jobs/trigger/main"],
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
