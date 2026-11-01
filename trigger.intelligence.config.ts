/**
 * Trigger.dev deployment configuration for the jobs unit's INTELLIGENCE execution plane (Step H7-D1e; H7-A0 D-H7-1):
 * ONLY `classification.understand_ai`, the one task that may hold the model credential. A separate Trigger.dev project,
 * because a project's environment reaches every task in it: the model credential never reaches a MAIN or INTEGRATION
 * task, and this plane never holds the system database, the Meta configuration, the KMS / AWS worker identity or another
 * plane's keys (jobs/plane-environment.ts refuses them). No build extension: nothing beyond the Node runtime is packaged
 * (no AWS signing helper). No Vercel integration and no automatic previews. Used only by the Trigger.dev CLI, through the
 * release unit `npm run trigger:release` (tools/trigger/deploy-release-pair.ts: INTEGRATION, then this plane, then MAIN,
 * all with the same `--external-id`, because MAIN pins its triggers into this plane to that id). The project reference
 * is never committed.
 */
import { defineConfig } from "@trigger.dev/sdk";
import { RETRY_POLICIES } from "./platform/jobs/registry";

export default defineConfig({
  // Node 22 like .nvmrc and package.json engines; never the CLI's implicit "current LTS" default.
  runtime: "node-22",
  project: process.env["TRIGGER_INTELLIGENCE_PROJECT_REF"] ?? "",
  dirs: ["./jobs/trigger/intelligence"],
  maxDuration: 300,
  retries: {
    enabledInDev: true,
    // The plane's one task declares single attempt itself (the runtime owns transport retries as dispatch generations);
    // the project default matches it, so nothing discovered here can retry implicitly.
    default: {
      maxAttempts: RETRY_POLICIES.singleAttempt.maxAttempts,
      factor: RETRY_POLICIES.singleAttempt.factor,
      minTimeoutInMs: RETRY_POLICIES.singleAttempt.minDelayMs,
      maxTimeoutInMs: RETRY_POLICIES.singleAttempt.maxDelayMs,
      randomize: RETRY_POLICIES.singleAttempt.randomize,
    },
  },
});
