/**
 * INTEGRATION-plane Instagram reply PREFLIGHT / OBSERVE diagnostic task (Step 7B-14C1; jobs/integration-instagram-reply-
 * preflight.ts). Not a product task: absent from the task registry (never routed by the outbox), no schedule, no hook,
 * no product UI, one attempt, its own queue of one, 120 seconds. Run only when an operator triggers it by id; the guards
 * — not the id's obscurity — are the boundary. READ-ONLY towards Meta: Graph GETs on an allowlist; Step 7B-14I2: its only
 * write is its own evidence row (preflight mode, the 0029 definer). Thin:
 * the run's release comes from its own deployment, never from the payload. A refusal or pre-provider failure ends the
 * run with one fixed code and no retry; provider answers are returned as the module's redacted outcome.
 */
import { AbortTaskRunError, queue, task } from "@trigger.dev/sdk";
import { jobRelease } from "@/platform/jobs";
import {
  InstagramReplyPreflightError,
  runInstagramReplyPreflight,
  type InstagramReplyPreflightFailure,
  type InstagramReplyPreflightOutcome,
} from "../../integration-instagram-reply-preflight";

export const INSTAGRAM_REPLY_PREFLIGHT_QUEUE = queue({ name: "integration-instagram-reply-preflight", concurrencyLimit: 1 });

export const instagramReplyPreflight = task({
  id: "integration.instagram_reply_preflight",
  queue: INSTAGRAM_REPLY_PREFLIGHT_QUEUE,
  retry: { maxAttempts: 1 },
  maxDuration: 120,
  run: async (payload: unknown, { ctx }): Promise<InstagramReplyPreflightOutcome> => {
    try {
      const release = jobRelease({ environmentType: ctx.environment.type, externalDeploymentId: ctx.deployment?.externalId });
      return await runInstagramReplyPreflight(payload, { environmentType: ctx.environment.type, release, runId: ctx.run.id }, process.env);
    } catch (error) {
      throw new AbortTaskRunError(error instanceof InstagramReplyPreflightError ? error.failure : ("instagram_reply_preflight_failed" satisfies InstagramReplyPreflightFailure));
    }
  },
});
