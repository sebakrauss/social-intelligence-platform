import { defineConfig } from "vitest/config";

/**
 * Shared-dev acceptance fixture (Step H7-B1b-0): ONE operator file against social-intelligence-dev-v2. Run it only
 * through `npm run db:dev-fixture`, which proves the target first; the global setup proves it again.
 */
export default defineConfig({
  resolve: {
    alias: { "@": import.meta.dirname },
  },
  test: {
    include: ["tests/db/dev-fixtures/classification-acceptance.operator.ts"],
    globalSetup: ["tests/db/dev-fixtures/global-setup.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    restoreMocks: true,
  },
});
