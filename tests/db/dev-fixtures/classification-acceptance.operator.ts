/**
 * Step H7-B1b-0 — the operator run of the shared-dev acceptance fixture (only through `npm run db:dev-fixture`; the
 * global setup has proven the target and the mode). PLAN is read-only; APPLY creates or verifies the fixture once.
 * Prints one secret-free JSON line (ids, counts, digests). Never deletes anything; never writes classification rows.
 */
import { inject, it } from "vitest";
import { createLogger } from "@/platform/observability";
import { privilegedPool, runtimeDatabase } from "../support/target";
import { applyAcceptanceFixture, formatFixtureReport, planAcceptanceFixture } from "./classification-acceptance";

it("H7 classification acceptance fixture (shared dev)", async () => {
  const target = inject("dbTarget");
  const mode = inject("devFixtureMode");
  const privileged = privilegedPool(target, 1);
  const worker = runtimeDatabase(target, "worker", 1);
  const log = createLogger({ sink: (line) => process.stdout.write(`${line}\n`), now: () => new Date(), base: { module: "dev-fixture" } });
  try {
    const report = mode === "apply" ? await applyAcceptanceFixture({ privileged, worker }) : await planAcceptanceFixture(privileged);
    process.stdout.write(`${formatFixtureReport(mode, report)}\n`);
    log.info("dev_fixture.h7_classification_acceptance", { operation: `${mode}.${report.status.toLowerCase()}`, outcome: report.status === "FIXTURE_IDENTITY_CONFLICT" || report.status === "REFUSED_PROTECTED_WORKSPACE" ? "error" : "ok" });
    if (report.status === "FIXTURE_IDENTITY_CONFLICT" || report.status === "REFUSED_PROTECTED_WORKSPACE") throw new Error(`dev fixture stopped: ${report.status}`);
  } finally {
    await worker.end();
    await privileged.end();
  }
});
