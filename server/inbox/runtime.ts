/**
 * Web composition of Workspace › Inbox (Step 7A): the action pipeline on the web's tenant-scoped PostgreSQL unit of work,
 * bound to this request's server-validated identity. Reads only; no provider, credential, job or outbox dependency.
 */
import { randomUUID } from "node:crypto";
import type { IdentityPort } from "@/platform/auth/port";
import { createLogger, stdoutSink } from "@/platform/observability";
import { requestAuth } from "@/server/auth/request-auth";
import { webUnitOfWork } from "@/server/persistence/runtime";
import { createActionPipeline, type ActionPipeline } from "@/server/pipeline";
import { resolveConversation, resolveInboxPage, type ConversationViewState, type InboxListState } from "./inbox";

const logger = createLogger({ sink: stdoutSink, base: { module: "server.inbox" } });

export function inboxPipeline(identity: IdentityPort): ActionPipeline {
  return createActionPipeline({ identity, unitOfWork: webUnitOfWork(), clock: () => new Date(), newId: randomUUID, logger });
}

/** The current request's Inbox page; any composition or database failure is `unavailable`, never its detail. */
export async function currentInboxPage(workspaceId: unknown, cursor: unknown): Promise<InboxListState> {
  const auth = await requestAuth();
  if (auth === undefined) return { kind: "unavailable" };
  try {
    return await resolveInboxPage(inboxPipeline(auth), workspaceId, cursor);
  } catch {
    logger.warn("inbox.page.unavailable", { outcome: "error" });
    return { kind: "unavailable" };
  }
}

/** The current request's view of one conversation; any composition or database failure is `unavailable`. */
export async function currentConversation(workspaceId: unknown, conversationId: unknown): Promise<ConversationViewState> {
  const auth = await requestAuth();
  if (auth === undefined) return { kind: "unavailable" };
  try {
    return await resolveConversation(inboxPipeline(auth), workspaceId, conversationId);
  } catch {
    logger.warn("inbox.conversation.unavailable", { outcome: "error" });
    return { kind: "unavailable" };
  }
}
