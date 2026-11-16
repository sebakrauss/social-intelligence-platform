/**
 * Web composition of Workspace › Inbox (Step 7A): the action pipeline on the web's tenant-scoped PostgreSQL unit of work,
 * bound to this request's server-validated identity. Reads only; no provider, credential, job or outbox dependency.
 * Step 7B-17K: the identity is the rendering request's (requestIdentity): verified with the Auth server once per render,
 * however many of these reads the page and its layout make.
 */
import { randomUUID } from "node:crypto";
import type { IdentityPort } from "@/platform/auth/port";
import { createLogger, stdoutSink } from "@/platform/observability";
import { requestIdentity } from "@/server/auth/request-auth";
import { webUnitOfWork } from "@/server/persistence/runtime";
import { createActionPipeline, type ActionPipeline } from "@/server/pipeline";
import { replyDraftScope } from "./draft-scope";
import { resolveConversation, resolveInboxPage, type ConversationViewState, type InboxListState } from "./inbox";

const logger = createLogger({ sink: stdoutSink, base: { module: "server.inbox" } });

export function inboxPipeline(identity: IdentityPort): ActionPipeline {
  return createActionPipeline({ identity, unitOfWork: webUnitOfWork(), clock: () => new Date(), newId: randomUUID, logger });
}

/** The current request's Inbox page; any composition or database failure is `unavailable`, never its detail. */
export async function currentInboxPage(workspaceId: unknown, cursor: unknown): Promise<InboxListState> {
  const identity = await requestIdentity();
  if (identity === undefined) return { kind: "unavailable" };
  try {
    return await resolveInboxPage(inboxPipeline(identity), workspaceId, cursor);
  } catch {
    logger.warn("inbox.page.unavailable", { outcome: "error" });
    return { kind: "unavailable" };
  }
}

/** The current request's view of one conversation; any composition or database failure is `unavailable`. */
export async function currentConversation(workspaceId: unknown, conversationId: unknown): Promise<ConversationViewState> {
  const identity = await requestIdentity();
  if (identity === undefined) return { kind: "unavailable" };
  try {
    return await resolveConversation(inboxPipeline(identity), workspaceId, conversationId);
  } catch {
    logger.warn("inbox.conversation.unavailable", { outcome: "error" });
    return { kind: "unavailable" };
  }
}

/**
 * Step 7B-15F: the reply-draft scope of the request's verified person (draft-scope.ts), or undefined — then the
 * composer keeps no draft. Presentation only: it authorizes nothing, and every read and command re-checks the session.
 */
export async function currentReplyDraftScope(): Promise<string | undefined> {
  try {
    const identity = await requestIdentity();
    const user = identity === undefined ? undefined : await identity.getVerifiedUser();
    return user === undefined ? undefined : replyDraftScope(user.id);
  } catch {
    return undefined;
  }
}
