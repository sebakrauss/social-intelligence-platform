// DISPOSABLE SPIKE — Trigger.dev DEVELOPMENT project config (social-intelligence-dev). NOT PRODUCTION.
// Project ref comes from the git-ignored .env.local (loaded by managed/run-trigger.mjs); never hard-coded.
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF as string,
  dirs: ["./managed/trigger"],
  maxDuration: 300, // seconds of CPU time per run (waits excluded) — documented semantics
  retries: {
    enabledInDev: true,
    default: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 10000, randomize: false },
  },
});
