/**
 * INTEGRATION-plane KMS worker-auth DIAGNOSTIC task (Step 7E.7-B; jobs/integration-kms-diagnostic.ts). Not a product
 * task: absent from the task registry (never routed by the outbox), no schedule, no hook, one attempt, its own queue
 * of one, 60 seconds. Run only when an operator triggers it by id; the guards — not the id's obscurity — are the
 * boundary. Thin: the run's release comes from its own deployment, never from the payload. Every failure ends the run
 * with one fixed code and no retry.
 */
import { AbortTaskRunError, queue, task } from "@trigger.dev/sdk";
import { jobRelease } from "@/platform/jobs";
import { KmsDiagnosticError, runKmsWorkerAuthDiagnostic, type KmsDiagnosticFailure, type KmsDiagnosticOutcome } from "../../integration-kms-diagnostic";

export const KMS_DIAGNOSTIC_QUEUE = queue({ name: "integration-kms-diagnostic", concurrencyLimit: 1 });

export const kmsWorkerAuthDiagnostic = task({
  id: "integration.kms_worker_auth_diagnostic",
  queue: KMS_DIAGNOSTIC_QUEUE,
  retry: { maxAttempts: 1 },
  maxDuration: 60,
  run: async (payload: unknown, { ctx }): Promise<KmsDiagnosticOutcome> => {
    let outcome: KmsDiagnosticOutcome;
    try {
      const release = jobRelease({ environmentType: ctx.environment.type, externalDeploymentId: ctx.deployment?.externalId });
      outcome = await runKmsWorkerAuthDiagnostic(payload, { environmentType: ctx.environment.type, release }, process.env);
    } catch (error) {
      throw new AbortTaskRunError(error instanceof KmsDiagnosticError ? error.failure : ("kms_diagnostic_failed" satisfies KmsDiagnosticFailure));
    }
    if (!outcome.plaintextMatches) throw new AbortTaskRunError("kms_diagnostic_plaintext_mismatch" satisfies KmsDiagnosticFailure);
    return outcome;
  },
});
