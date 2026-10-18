"use server";
/**
 * Onboarding server actions (Step 7G-F3): create the first organization, then the first Standard workspace. POST only
 * (Server Actions), behind Next.js's Origin/Host check; the identity is the session's, never a form field. Each action
 * runs the command once and then redirects to a fixed internal path (post/redirect/get: a refresh never resubmits).
 * Nothing identifying or internal is logged or returned: outcomes are closed status codes.
 */
import { redirect } from "next/navigation";
import { createLogger, stdoutSink } from "@/platform/observability";
import type { ActionPipeline } from "@/server/pipeline";
import { requestAuth } from "@/server/auth/request-auth";
import { submitOrganization, submitWorkspace, type OnboardingOutcome } from "./onboarding";
import { onboardingPipeline } from "./runtime";

const log = createLogger({ sink: stdoutSink, base: { module: "server.tenancy" } });

async function run(operation: string, work: (pipeline: ActionPipeline) => Promise<OnboardingOutcome>): Promise<OnboardingOutcome> {
  const auth = await requestAuth();
  if (auth === undefined) return { kind: "status", status: "unavailable" };
  try {
    return await work(onboardingPipeline(auth));
  } catch {
    log.warn("onboarding.action.unavailable", { operation, outcome: "error" });
    return { kind: "status", status: "unavailable" };
  }
}

function destination(outcome: OnboardingOutcome): string {
  switch (outcome.kind) {
    case "done":
      return "/onboarding";
    case "signed_out":
      return "/sign-in";
    case "verification_required":
      return "/sign-in?status=verification_required";
    case "status":
      return `/onboarding?status=${outcome.status}`;
  }
}

export async function createOrganizationAction(form: FormData): Promise<void> {
  redirect(destination(await run("create_organization", (pipeline) => submitOrganization(pipeline, form))));
}

export async function createWorkspaceAction(form: FormData): Promise<void> {
  redirect(destination(await run("create_workspace", (pipeline) => submitWorkspace(pipeline, form))));
}
