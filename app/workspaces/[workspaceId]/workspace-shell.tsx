import { signOutAction } from "@/server/auth/actions";
import { t } from "@/server/i18n";
import { COMMENTS_DEFAULT_VIEW, COMMENTS_VIEW_PARAM, workspaceCommentsPath, workspaceConnectionsPath, workspaceInboxPath, type CommentsView } from "@/server/routes";
import { currentShellState } from "@/server/shell/runtime";
import { shellAccess, type ShellWorkspace } from "@/server/shell/shell";
import { Button } from "@/ui/primitives/button";
import { AppShell, type ShellNavItem, type ShellSidebarItem, type ShellSwitcherItem, type ShellViews } from "@/ui/shell/app-shell";
import type { ReactNode } from "react";

/**
 * COMMENTS-INT-03C-2: "comments" is the Inbox's destination piloted as Comments (the rail's Comments stays current);
 * its sidebar holds the Comments views instead of a link back to the Inbox.
 */
export type ShellSection = "inbox" | "settings" | "comments";

/**
 * The workspace shell (UI-3), composed per request for the section layouts under /workspaces/[workspaceId]: one
 * read of the caller's own tenancy (server/shell) decides which workspace is current and which built destinations
 * the caller's role may reach (IA §18), and the shell draws exactly those. When the caller is signed out, unverified
 * or has no workspace, the screen renders without a shell and the page itself redirects or explains, as before.
 * The only form here is the existing sign-out action (Step 1). Nothing else is read, written or decided.
 */
export async function WorkspaceShell({ workspaceId, section, children }: { readonly workspaceId: string; readonly section: ShellSection; readonly children: ReactNode }) {
  const state = await currentShellState(workspaceId);
  if (state.kind !== "ready") return <>{children}</>;

  const current = state.current;
  const access = current === undefined ? { inbox: false, connections: false } : shellAccess(current.role);
  const nav = navigationFor(current, access, section);
  const sidebar = section === "comments" ? undefined : sidebarFor(current, access, section);
  const views = section === "comments" ? commentsViewsFor(current, access) : undefined;
  const switcher: ShellSwitcherItem[] = state.workspaces
    .filter((workspace) => workspace.id !== current?.id)
    .map((workspace) => ({ id: workspace.id, name: workspace.name, organizationName: workspace.organizationName, href: shellAccess(workspace.role).inbox ? workspaceInboxPath(workspace.id) : undefined }));

  return (
    <AppShell
      texts={{
        brand: "wrenkind",
        skipToContent: t("shell.skip_to_content"),
        navigation: t("shell.nav.label"),
        workspace: t("shell.workspace.label"),
        workspaceUnavailable: t("shell.workspace.unavailable"),
        switchWorkspace: t("shell.workspace.switch"),
        monitorOnly: t("shell.workspace.monitor_only"),
        account: t("shell.account.label"),
      }}
      workspace={current === undefined ? undefined : { name: current.name, organizationName: current.organizationName, monitorOnly: current.mode === "MONITOR_ONLY" }}
      switcher={switcher}
      nav={nav}
      sidebar={sidebar}
      views={views}
      account={
        <form action={signOutAction}>
          <Button type="submit" variant="secondary" size="sm">
            {t("auth.sign_out.submit")}
          </Button>
        </form>
      }
    >
      {children}
    </AppShell>
  );
}

function navigationFor(current: ShellWorkspace | undefined, access: { readonly inbox: boolean; readonly connections: boolean }, section: ShellSection): ShellNavItem[] {
  if (current === undefined) return [];
  const items: ShellNavItem[] = [];
  const inbox = workspaceInboxPath(current.id);
  const connections = workspaceConnectionsPath(current.id);
  if (access.inbox && inbox !== undefined) items.push({ key: "inbox", label: t("shell.nav.inbox"), href: inbox, icon: "nav-inbox", current: section === "inbox" || section === "comments" });
  if (access.connections && connections !== undefined) items.push({ key: "settings", label: t("shell.nav.settings"), href: connections, icon: "nav-settings", current: section === "settings" });
  return items;
}

/**
 * COMMENTS-INT-03C-2 (M-1) — the approved operational hierarchy (UX-07A…UX-10): Open, Needs attention, Assigned to me,
 * Escalated, Done, then All conversations set apart. Only the views backed by real data are views (server/routes
 * COMMENTS_VIEWS: Open — the default, no parameter — Done and All; pinned in comments-views-guards); the others keep their place as text, never as a
 * link or a simulated list. Built from the shell's own read only (the caller's role): nothing else is read.
 */
const COMMENTS_VIEW_LABELS = { open: "comments.views.open", done: "comments.views.done", all: "comments.views.all" } as const satisfies { readonly [V in CommentsView]: string };

function commentsViewsFor(current: ShellWorkspace | undefined, access: { readonly inbox: boolean }): ShellViews | undefined {
  if (current === undefined || !access.inbox) return undefined;
  // S-1: every view leads to the Comments list itself (the route helper's validated address), never to the open conversation.
  const base = workspaceCommentsPath(current.id);
  if (base === undefined) return undefined;
  const view = (value: CommentsView, apart = false) => ({ kind: "view" as const, label: t(COMMENTS_VIEW_LABELS[value]), value: value === COMMENTS_DEFAULT_VIEW ? undefined : value, ...(apart ? { apart: true } : {}) });
  const later = (label: string) => ({ kind: "later" as const, label });
  return {
    label: t("comments.views.label"),
    heading: t("shell.section.inbox.heading"),
    base,
    param: COMMENTS_VIEW_PARAM,
    pickerLabel: t("comments.views.picker"),
    laterNote: t("comments.views.later"),
    laterTag: t("comments.views.later_tag"),
    items: [view("open"), later(t("comments.views.attention")), later(t("comments.views.assigned")), later(t("comments.views.escalated")), view("done"), view("all", true)],
  };
}

function sidebarFor(current: ShellWorkspace | undefined, access: { readonly inbox: boolean; readonly connections: boolean }, section: ShellSection): { readonly heading: string; readonly items: readonly ShellSidebarItem[] } | undefined {
  if (current === undefined) return undefined;
  if (section === "inbox") {
    const inbox = workspaceInboxPath(current.id);
    return access.inbox && inbox !== undefined ? { heading: t("shell.section.inbox.heading"), items: [{ label: t("shell.section.inbox.conversations"), href: inbox, current: true }] } : undefined;
  }
  const connections = workspaceConnectionsPath(current.id);
  return access.connections && connections !== undefined ? { heading: t("shell.section.settings.heading"), items: [{ label: t("shell.section.settings.connections"), href: connections, current: true }] } : undefined;
}
