/**
 * Web composition of the onboarding surface (Step 7G-F3): the action pipeline on the web's tenant-scoped PostgreSQL
 * unit of work (web login role, RLS, sealed context), bound to this request's server-validated identity. No outbox
 * notifier: the onboarding commands append no outbox rows. No provider, credential or job dependency.
 */
import { randomUUID } from "node:crypto";
import type { IdentityPort } from "@/platform/auth/port";
import { createLogger, stdoutSink } from "@/platform/observability";
import { requestAuth } from "@/server/auth/request-auth";
import { webUnitOfWork } from "@/server/persistence/runtime";
import { createActionPipeline, type ActionPipeline } from "@/server/pipeline";
import { resolveOnboarding, type OnboardingState } from "./onboarding";

const logger = createLogger({ sink: stdoutSink, base: { module: "server.tenancy" } });

export function onboardingPipeline(identity: IdentityPort): ActionPipeline {
  return createActionPipeline({ identity, unitOfWork: webUnitOfWork(), clock: () => new Date(), newId: randomUUID, logger });
}

/** The current request's onboarding state; any composition or database failure is `unavailable`, never its detail. */
export async function currentOnboardingState(): Promise<OnboardingState> {
  const auth = await requestAuth();
  if (auth === undefined) return { kind: "unavailable" };
  try {
    return await resolveOnboarding(onboardingPipeline(auth));
  } catch {
    logger.warn("onboarding.state.unavailable", { outcome: "error" });
    return { kind: "unavailable" };
  }
}
