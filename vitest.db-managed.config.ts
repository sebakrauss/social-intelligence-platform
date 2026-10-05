import { defineConfig } from "vitest/config";

/**
 * Managed database suite (Supabase development project, Supavisor transaction pooler). Requires local
 * secrets in `.env.local`; run it through `npm run test:db:managed`, which refuses to report a pass when
 * the configuration is absent.
 */
export default defineConfig({
  resolve: {
    alias: { "@": import.meta.dirname },
  },
  test: {
    include: ["tests/db/managed/**/*.test.ts"],
    globalSetup: ["tests/db/managed/global-setup.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    restoreMocks: true,
  },
});
