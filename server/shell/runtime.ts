/**
 * Web composition of the app shell (UI-3): the action pipeline on the web's tenant-scoped PostgreSQL unit of work,
 * bound to this request's server-validated identity — the same composition the onboarding surface uses. Reads only.
 */
import { randomUUID } from "node:crypto";
import type { IdentityPort } from "@/platform/auth/port";
import { createLogger, stdoutSink } from "@/platform/observability";
import { requestAuth } from "@/server/auth/request-auth";
import { webUnitOfWork } from "@/server/persistence/runtime";
import { createActionPipeline, type ActionPipeline } from "@/server/pipeline";
import { resolveShell, type ShellState } from "./shell";

const logger = createLogger({ sink: stdoutSink, base: { module: "server.shell" } });

export function shellPipeline(identity: IdentityPort): ActionPipeline {
  return createActionPipeline({ identity, unitOfWork: webUnitOfWork(), clock: () => new Date(), newId: randomUUID, logger });
}

/** The current request's shell state; any composition or database failure is `unavailable`, never its detail. */
export async function currentShellState(workspaceId: unknown): Promise<ShellState> {
  const auth = await requestAuth();
  if (auth === undefined) return { kind: "unavailable" };
  try {
    return await resolveShell(shellPipeline(auth), workspaceId);
  } catch {
    logger.warn("shell.state.unavailable", { outcome: "error" });
    return { kind: "unavailable" };
  }
}
