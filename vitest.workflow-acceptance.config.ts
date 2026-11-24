import { defineConfig } from "vitest/config";

/**
 * W12-PREP-01 — shared-dev Comments Workflow acceptance fixture: ONE operator file against social-intelligence-dev-v2.
 * Run it only through `npm run db:workflow-acceptance`, which proves the target first; the global setup proves it again.
 */
export default defineConfig({
  resolve: {
    alias: { "@": import.meta.dirname },
  },
  test: {
    include: ["tests/db/dev-fixtures/workflow-acceptance.operator.ts"],
    globalSetup: ["tests/db/dev-fixtures/workflow-acceptance-setup.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
    restoreMocks: true,
  },
});
