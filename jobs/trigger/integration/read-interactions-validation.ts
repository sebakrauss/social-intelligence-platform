/**
 * INTEGRATION-plane read_interactions VALIDATION diagnostic task (Step 7G-H5.5-P12-B2; jobs/integration-read-interactions-
 * validation.ts). Not a product task: absent from the task registry (never routed by the outbox), no schedule, no hook,
 * no product UI, one attempt, its own queue of one, 120 seconds. Run only when an operator triggers it by id; the
 * guards — not the id's obscurity — are the boundary. Thin: the run's release comes from its own deployment, never from
 * the payload. A refusal or pre-provider failure ends the run with one fixed code and no retry; provider answers are
 * returned as the module's redacted outcome.
 */
import { AbortTaskRunError, queue, task } from "@trigger.dev/sdk";
import { jobRelease } from "@/platform/jobs";
import {
  ReadInteractionsValidationError,
  runReadInteractionsValidation,
  type ReadInteractionsValidationFailure,
  type ReadInteractionsValidationOutcome,
} from "../../integration-read-interactions-validation";

export const READ_INTERACTIONS_VALIDATION_QUEUE = queue({ name: "integration-read-interactions-validation", concurrencyLimit: 1 });

export const readInteractionsValidation = task({
  id: "integration.read_interactions_validation",
  queue: READ_INTERACTIONS_VALIDATION_QUEUE,
  retry: { maxAttempts: 1 },
  maxDuration: 120,
  run: async (payload: unknown, { ctx }): Promise<ReadInteractionsValidationOutcome> => {
    try {
      const release = jobRelease({ environmentType: ctx.environment.type, externalDeploymentId: ctx.deployment?.externalId });
      return await runReadInteractionsValidation(payload, { environmentType: ctx.environment.type, release }, process.env);
    } catch (error) {
      throw new AbortTaskRunError(error instanceof ReadInteractionsValidationError ? error.failure : ("read_interactions_validation_failed" satisfies ReadInteractionsValidationFailure));
    }
  },
});
