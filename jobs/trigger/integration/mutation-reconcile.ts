/**
 * INTEGRATION-plane operator reconciliation task (Step 7B-14I2; jobs/integration-mutation-reconcile.ts). Not a product
 * task: absent from the task registry (never routed by the outbox), no schedule, no hook, no UI, one attempt, its own
 * queue of one, 120 seconds. Run only when an operator triggers it by id; the guards — not the id's obscurity — are the
 * boundary. Graph GETs only; never a send. Thin: the run's release and id come from its own run context, never the
 * payload. A refusal ends the run with one fixed code and no retry.
 */
import { AbortTaskRunError, queue, task } from "@trigger.dev/sdk";
import { jobRelease } from "@/platform/jobs";
import { MutationReconcileError, runMutationReconcile, type MutationReconcileFailure, type MutationReconcileOutcome } from "../../integration-mutation-reconcile";

export const MUTATION_RECONCILE_QUEUE = queue({ name: "integration-mutation-reconcile", concurrencyLimit: 1 });

export const mutationReconcile = task({
  id: "integration.mutation_reconcile",
  queue: MUTATION_RECONCILE_QUEUE,
  retry: { maxAttempts: 1 },
  maxDuration: 120,
  run: async (payload: unknown, { ctx }): Promise<MutationReconcileOutcome> => {
    try {
      const release = jobRelease({ environmentType: ctx.environment.type, externalDeploymentId: ctx.deployment?.externalId });
      return await runMutationReconcile(payload, { environmentType: ctx.environment.type, release, runId: ctx.run.id }, process.env);
    } catch (error) {
      throw new AbortTaskRunError(error instanceof MutationReconcileError ? error.failure : ("mutation_reconcile_failed" satisfies MutationReconcileFailure));
    }
  },
});
