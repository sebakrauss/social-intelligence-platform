import { defineConfig } from "vitest/config";

/**
 * Managed job-runtime suite: Trigger.dev DEVELOPMENT environment + the Supabase development project. Run it
 * only through `npm run test:jobs:managed`, which starts the pinned, ephemeral Trigger.dev CLI dev session
 * and refuses to report a pass when the configuration is absent.
 */
export default defineConfig({
  resolve: {
    alias: { "@": import.meta.dirname },
  },
  test: {
    include: ["tests/jobs/managed/**/*.test.ts"],
    globalSetup: ["tests/db/managed/global-setup.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 120_000,
    restoreMocks: true,
  },
});
