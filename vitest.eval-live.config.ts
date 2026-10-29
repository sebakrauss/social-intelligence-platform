import { defineConfig } from "vitest/config";

/**
 * Step H7-D0 — the OPERATOR-ONLY real-model bake-off. Run it only through `npm run eval:classification:live`, which
 * refuses in CI and requires an explicit confirmation for real calls; the runner refuses again on its own.
 */
export default defineConfig({
  resolve: {
    alias: { "@": import.meta.dirname },
  },
  test: {
    include: ["tests/eval/classification/live.eval.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 3_600_000,
  },
});
