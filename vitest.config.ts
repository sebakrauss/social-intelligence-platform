import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": import.meta.dirname },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // Database suites run separately: `npm run test:db` (local cluster) and `npm run test:db:managed`.
    exclude: ["tests/architecture/fixtures/**", "tests/db/**", "tests/jobs/managed/**", "node_modules/**", "spikes/**"],
    environment: "node",
    restoreMocks: true,
  },
});
