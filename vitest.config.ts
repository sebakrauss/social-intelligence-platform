import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": import.meta.dirname },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/architecture/fixtures/**", "node_modules/**", "spikes/**"],
    environment: "node",
    restoreMocks: true,
  },
});
