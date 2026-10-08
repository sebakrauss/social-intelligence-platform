/**
 * Trigger.dev deployment configuration for the jobs unit's INTEGRATION execution plane (Step 7E.4B.3): ONLY the tasks
 * that open a provider credential (connections.discover_assets, capability.evaluate_account). A separate Trigger.dev
 * project, so its environment — and later its AWS worker identity — never reaches a main-plane task. No Vercel
 * integration and no automatic pull-request previews for this project. Used only by the Trigger.dev CLI
 * (`trigger deploy --config trigger.integration.config.ts --external-id <commit SHA>`, the same id as the main plane's
 * deployment of that commit). The project reference comes from the environment and is never committed.
 */
import { defineConfig } from "@trigger.dev/sdk";
import { RETRY_POLICIES } from "./platform/jobs/registry";

export default defineConfig({
  // Node 22 like .nvmrc and package.json engines; never the CLI's implicit "current LTS" default.
  runtime: "node-22",
  project: process.env["TRIGGER_INTEGRATION_PROJECT_REF"] ?? "",
  dirs: ["./jobs/trigger/integration"],
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
