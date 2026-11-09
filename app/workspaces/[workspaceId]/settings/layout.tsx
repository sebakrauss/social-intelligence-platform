import type { ReactNode } from "react";
import { WorkspaceShell } from "../workspace-shell";

/** Shell state is per request and per member: never prerender it. */
export const dynamic = "force-dynamic";

/** Workspace › Settings section (UI-3): the app shell around Settings › Connections, which keeps its own reads and actions. */
export default async function SettingsSectionLayout({ params, children }: { readonly params: Promise<{ readonly workspaceId: string }>; readonly children: ReactNode }) {
  const { workspaceId } = await params;
  return (
    <WorkspaceShell workspaceId={workspaceId} section="settings">
      {children}
    </WorkspaceShell>
  );
}
