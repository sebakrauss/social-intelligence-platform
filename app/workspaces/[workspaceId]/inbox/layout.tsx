import type { ReactNode } from "react";
import { ReplyDraftsConversationScope } from "@/ui/inbox/reply-drafts-scope";
import { WorkspaceShell } from "../workspace-shell";

/** Shell state is per request and per member: never prerender it. */
export const dynamic = "force-dynamic";

/**
 * Workspace › Inbox section (UI-3): the app shell around the Step 7A pages, which keep their own reads and states.
 * Step 7B-17K: the layout stays on screen while the Inbox moves between its pages in-app, so it also draws the reply
 * drafts' conversation boundary (renders nothing; forgets the drafts of a conversation once it is left — UX-20).
 */
export default async function InboxSectionLayout({ params, children }: { readonly params: Promise<{ readonly workspaceId: string }>; readonly children: ReactNode }) {
  const { workspaceId } = await params;
  return (
    <WorkspaceShell workspaceId={workspaceId} section="inbox">
      <ReplyDraftsConversationScope />
      {children}
    </WorkspaceShell>
  );
}
