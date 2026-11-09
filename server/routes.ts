/**
 * Fixed internal paths built from validated identifiers only (Step 7G-F4). Nothing here takes a browser-chosen
 * destination: a value that isn't a canonical UUID yields no path at all.
 */
import { isUuid, parseWorkspaceId, type WorkspaceId } from "@/domain/ids";

/** Workspace Settings › Connections (IA §18: Owner/Admin). */
export function workspaceConnectionsPath(workspaceId: WorkspaceId): string;
export function workspaceConnectionsPath(workspaceId: unknown): string | undefined;
export function workspaceConnectionsPath(workspaceId: unknown): string | undefined {
  const id = parseWorkspaceId(workspaceId);
  return id === undefined ? undefined : `/workspaces/${id}/settings/connections`;
}

/** Workspace › Inbox (Step 7A; IA §18: every non-guest role, read). */
export function workspaceInboxPath(workspaceId: WorkspaceId): string;
export function workspaceInboxPath(workspaceId: unknown): string | undefined;
export function workspaceInboxPath(workspaceId: unknown): string | undefined {
  const id = parseWorkspaceId(workspaceId);
  return id === undefined ? undefined : `/workspaces/${id}/inbox`;
}

/** Workspace › Inbox › one conversation (Step 7A). Both ids must be canonical UUIDs or there is no path. */
export function workspaceConversationPath(workspaceId: unknown, conversationId: unknown): string | undefined {
  const id = parseWorkspaceId(workspaceId);
  return id === undefined || !isUuid(conversationId) ? undefined : `/workspaces/${id}/inbox/${conversationId}`;
}

/** The Inbox page with an older-conversations position (Step 7A); the cursor is an opaque, server-issued string. */
export function workspaceInboxPagePath(workspaceId: unknown, cursor: string): string | undefined {
  const base = workspaceInboxPath(workspaceId);
  return base === undefined ? undefined : `${base}?cursor=${encodeURIComponent(cursor)}`;
}
