/**
 * INTEGRATION-plane read_content VALIDATION diagnostic task (Step 7G-H5.5-P5-B; jobs/integration-read-content-validation.ts).
 * Not a product task: absent from the task registry (never routed by the outbox), no schedule, no hook, no product UI,
 * one attempt, its own queue of one, 120 seconds. Run only when an operator triggers it by id; the guards — not the
 * id's obscurity — are the boundary. Thin: the run's release comes from its own deployment, never from the payload.
 * A refusal or pre-provider failure ends the run with one fixed code and no retry; provider answers are returned as
 * the module's redacted outcome.
 */
import { AbortTaskRunError, queue, task } from "@trigger.dev/sdk";
import { jobRelease } from "@/platform/jobs";
import {
  ReadContentValidationError,
  runReadContentValidation,
  type ReadContentValidationFailure,
  type ReadContentValidationOutcome,
} from "../../integration-read-content-validation";

export const READ_CONTENT_VALIDATION_QUEUE = queue({ name: "integration-read-content-validation", concurrencyLimit: 1 });

export const readContentValidation = task({
  id: "integration.read_content_validation",
  queue: READ_CONTENT_VALIDATION_QUEUE,
  retry: { maxAttempts: 1 },
  maxDuration: 120,
  run: async (payload: unknown, { ctx }): Promise<ReadContentValidationOutcome> => {
    try {
      const release = jobRelease({ environmentType: ctx.environment.type, externalDeploymentId: ctx.deployment?.externalId });
      return await runReadContentValidation(payload, { environmentType: ctx.environment.type, release }, process.env);
    } catch (error) {
      throw new AbortTaskRunError(error instanceof ReadContentValidationError ? error.failure : ("read_content_validation_failed" satisfies ReadContentValidationFailure));
    }
  },
});
