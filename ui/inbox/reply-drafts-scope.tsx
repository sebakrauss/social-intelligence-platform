"use client";
/**
 * The conversation boundary of the reply drafts (Step 7B-17K). The Inbox now moves between conversations without
 * reloading the page, so this tab's memory would otherwise keep an unsent reply after its conversation was left — and
 * offer it again on the way back. Drawn once by the Inbox layout, it reports the conversation on screen (from the
 * address: workspace and conversation, nothing else) to the drafts module whenever it changes; the module forgets every
 * draft of any other conversation, and every draft when the Inbox itself is left. It renders nothing, reads nothing
 * else and sends nothing.
 */
import { useParams } from "next/navigation";
import { useEffect } from "react";
import { showReplyDraftsConversation } from "./reply-drafts";

const segment = (value: string | string[] | undefined): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

export function ReplyDraftsConversationScope(): null {
  // Outside the App Router (a static render) there are no route segments at all.
  const params = useParams() as Readonly<Record<string, string | string[] | undefined>> | null;
  const workspaceId = segment(params === null ? undefined : params["workspaceId"]) ?? "";
  const conversationId = segment(params === null ? undefined : params["conversationId"]);
  useEffect(() => showReplyDraftsConversation(workspaceId, conversationId), [workspaceId, conversationId]);
  return null;
}
