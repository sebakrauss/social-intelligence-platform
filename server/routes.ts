/**
 * Fixed internal paths built from validated identifiers only (Step 7G-F4). Nothing here takes a browser-chosen
 * destination: a value that isn't a canonical UUID yields no path at all.
 */
import { parseWorkspaceId, type WorkspaceId } from "@/domain/ids";

/** Workspace Settings › Connections (IA §18: Owner/Admin). */
export function workspaceConnectionsPath(workspaceId: WorkspaceId): string;
export function workspaceConnectionsPath(workspaceId: unknown): string | undefined;
export function workspaceConnectionsPath(workspaceId: unknown): string | undefined {
  const id = parseWorkspaceId(workspaceId);
  return id === undefined ? undefined : `/workspaces/${id}/settings/connections`;
}
