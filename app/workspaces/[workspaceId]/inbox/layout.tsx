import type { ReactNode } from "react";
import { WorkspaceShell } from "../workspace-shell";

/** Shell state is per request and per member: never prerender it. */
export const dynamic = "force-dynamic";

/** Workspace › Inbox section (UI-3): the app shell around the Step 7A pages, which keep their own reads and states. */
export default async function InboxSectionLayout({ params, children }: { readonly params: Promise<{ readonly workspaceId: string }>; readonly children: ReactNode }) {
  const { workspaceId } = await params;
  return (
    <WorkspaceShell workspaceId={workspaceId} section="inbox">
      {children}
    </WorkspaceShell>
  );
}
