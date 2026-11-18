import type { ReactNode } from "react";
import { WorkspaceShell } from "../workspace-shell";

export const dynamic = "force-dynamic";

/**
 * COMMENTS-INT-03A — the redesigned Comments route, drawn in the same workspace shell as the Inbox (it is the Inbox's
 * own destination, piloted). The shell composition only reads; access to the route itself is decided by its pages.
 */
export default async function CommentsSectionLayout({ params, children }: { readonly params: Promise<{ readonly workspaceId: string }>; readonly children: ReactNode }) {
  const { workspaceId } = await params;
  return (
    <WorkspaceShell workspaceId={workspaceId} section="inbox">
      {children}
    </WorkspaceShell>
  );
}
