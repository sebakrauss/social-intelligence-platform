/**
 * Trigger.dev configuration for the MANAGED TEST leg only (`npm run test:jobs:managed`), DEVELOPMENT
 * environment. It loads the test tasks under tests/jobs/managed/tasks and nothing else: no production tasks
 * and no schedules, so nothing keeps firing once the local dev session stops. Never deployed.
 */
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: process.env["TRIGGER_PROJECT_REF"] ?? "",
  dirs: ["./tests/jobs/managed/tasks"],
  maxDuration: 120,
  retries: { enabledInDev: true },
});
