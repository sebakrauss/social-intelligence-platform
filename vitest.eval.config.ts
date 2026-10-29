import { defineConfig } from "vitest/config";

/**
 * Offline evaluation report of the classification understanding task (Step H7-C): `npm run eval:classification`.
 * Runs only the deterministic simulator in H7-C (no model, no network); prints one report (not a model benchmark).
 */
export default defineConfig({
  resolve: {
    alias: { "@": import.meta.dirname },
  },
  test: {
    include: ["tests/eval/classification/report.eval.ts"],
    environment: "node",
    testTimeout: 120_000,
  },
});
