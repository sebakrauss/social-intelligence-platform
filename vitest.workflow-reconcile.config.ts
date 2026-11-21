import { defineConfig } from "vitest/config";

/**
 * WORKFLOW-WF-2C — the workflow reconciliation operator run: ONE file. Run it only through `npm run ops:workflow-reconcile`,
 * which fences the target first; the operator file fences it again.
 */
export default defineConfig({
  resolve: {
    alias: { "@": import.meta.dirname },
  },
  test: {
    include: ["tools/ops/workflow-reconcile.operator.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 60 * 60 * 1000,
    restoreMocks: true,
  },
});
