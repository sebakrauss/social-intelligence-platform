/**
 * The opaque per-person scope of the reply composer's in-memory drafts (Step 7B-15F; ui/inbox/reply-drafts.ts). It only
 * separates one person's unsent drafts from another's when both use the same browser tab (sign-out and sign-in are
 * in-app navigations, so the tab's memory survives them). It is NOT an identifier the browser can use: a one-way
 * digest of the verified user id under a fixed purpose label — never the user id itself, never an authorization, and
 * nothing on the server ever reads it back.
 */
import { createHash } from "node:crypto";

const PURPOSE = "wrenkind.inbox.reply-draft-scope.v1";

export function replyDraftScope(userId: string): string | undefined {
  if (userId === "") return undefined;
  return createHash("sha256").update(`${PURPOSE}\u0000${userId}`).digest("base64url").slice(0, 22);
}
