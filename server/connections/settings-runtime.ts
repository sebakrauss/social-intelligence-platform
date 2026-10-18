/**
 * Web composition of Workspace Settings › Connections (Step 7G-F4): the action pipeline on the web's tenant-scoped
 * PostgreSQL unit of work, bound to this request's server-validated identity. The read needs no OAuth secret, sealer,
 * KMS identity or provider adapter, so the page stays usable whether or not Meta's app configuration is present.
 */
import { randomUUID } from "node:crypto";
import type { IdentityPort } from "@/platform/auth/port";
import { createLogger, stdoutSink } from "@/platform/observability";
import { requestAuth } from "@/server/auth/request-auth";
import { webUnitOfWork } from "@/server/persistence/runtime";
import { createActionPipeline, type ActionPipeline } from "@/server/pipeline";
import { resolveConnectionSettings, type ConnectionSettingsState } from "./settings";

const logger = createLogger({ sink: stdoutSink, base: { module: "server.connections" } });

export function connectionSettingsPipeline(identity: IdentityPort): ActionPipeline {
  return createActionPipeline({ identity, unitOfWork: webUnitOfWork(), clock: () => new Date(), newId: randomUUID, logger });
}

/** The current request's view of one workspace's connections; any composition or database failure is `unavailable`. */
export async function currentConnectionSettings(workspaceId: unknown): Promise<ConnectionSettingsState> {
  const auth = await requestAuth();
  if (auth === undefined) return { kind: "unavailable" };
  try {
    return await resolveConnectionSettings(connectionSettingsPipeline(auth), workspaceId);
  } catch {
    logger.warn("connections.settings.unavailable", { outcome: "error" });
    return { kind: "unavailable" };
  }
}
