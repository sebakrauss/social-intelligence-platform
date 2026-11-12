"use server";
/**
 * Publish a public reply (Step 7B-3): the one Server Action behind the Inbox composer. POST only (a Server Action,
 * behind Next.js's Origin/Host check). It reads exactly five fields — the routed workspace id, the conversation id (to
 * re-render the thread), the canonical target id, the server-issued idempotency key and the text — and runs the
 * registered `mutations.reply_public.request` command through the action pipeline, which re-validates the session,
 * the membership, `reply.public`, the Standard mode, the target, the account, the capability and the key. Nothing is
 * published from here: the command writes a PENDING intent and its outbox row; the integration plane's executor sends.
 *
 * No form field chooses a destination or an account: the account is the target's own, resolved on the server. The
 * answer is a closed state (reply-state.ts); nothing internal is logged or returned, and the text is never logged.
 */
import { revalidatePath } from "next/cache";
import { isUuid, parseWorkspaceId } from "@/domain/ids";
import { createLogger, stdoutSink } from "@/platform/observability";
import { requestAuth } from "@/server/auth/request-auth";
import { requestPublicReplyCommand } from "@/server/commands/mutations";
import { workspaceConversationPath } from "@/server/routes";
import { inboxPipeline } from "./runtime";
import type { ReplyActionState, ReplyBlockedCode } from "./reply-state";

const log = createLogger({ sink: stdoutSink, base: { module: "server.inbox" } });
const BLOCKED: readonly ReplyBlockedCode[] = ["PERMISSION_DENIED", "MODE_BLOCKED", "NOT_FOUND", "INVALID_INPUT"];

const field = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

export async function publishReplyAction(_previous: ReplyActionState, form: FormData): Promise<ReplyActionState> {
  const workspaceId = parseWorkspaceId(field(form, "workspaceId"));
  const conversationId = field(form, "conversationId");
  const targetInteractionId = field(form, "targetInteractionId");
  const idempotencyKey = field(form, "idempotencyKey");
  const text = field(form, "text");
  // Step 7B-14I2: a mode, never an identifier — the command resolves the member's own live authorization for this target.
  const validation = field(form, "validation") === "1";
  if (workspaceId === undefined || !isUuid(conversationId)) return { kind: "blocked", code: "NOT_FOUND" };
  const auth = await requestAuth();
  if (auth === undefined) return { kind: "signed_out" };
  try {
    const result = await inboxPipeline(auth).run(requestPublicReplyCommand, { workspaceId, input: { targetInteractionId, text, idempotencyKey, ...(validation ? { validation: true } : {}) } });
    if (result.status === "unauthenticated" || result.status === "verification_required") return { kind: "signed_out" };
    if (result.status === "error") {
      const code = result.error.code;
      return BLOCKED.includes(code as ReplyBlockedCode) ? { kind: "blocked", code: code as ReplyBlockedCode } : { kind: "unavailable" };
    }
    const path = workspaceConversationPath(workspaceId, conversationId);
    if (path !== undefined) revalidatePath(path.split("?")[0]?.split("#")[0] ?? path);
    const value = result.value;
    if (value.kind === "requested") return { kind: "requested", intentId: value.intentId };
    if (value.kind === "existing") return { kind: "existing", intentId: value.intentId };
    return { kind: "refused", reason: value.reason };
  } catch {
    log.warn("inbox.reply.unavailable", { outcome: "error" });
    return { kind: "unavailable" };
  }
}
