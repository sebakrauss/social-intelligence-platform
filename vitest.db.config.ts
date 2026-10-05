import { defineConfig } from "vitest/config";

/** Local database suite: a disposable embedded PostgreSQL 17 cluster (no secrets, runs in CI). */
export default defineConfig({
  resolve: {
    alias: { "@": import.meta.dirname },
  },
  test: {
    include: ["tests/db/local/**/*.test.ts"],
    globalSetup: ["tests/db/local/global-setup.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    restoreMocks: true,
  },
});
