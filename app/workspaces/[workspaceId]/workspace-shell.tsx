import { signOutAction } from "@/server/auth/actions";
import { t } from "@/server/i18n";
import { workspaceConnectionsPath, workspaceInboxPath } from "@/server/routes";
import { currentShellState } from "@/server/shell/runtime";
import { shellAccess, type ShellWorkspace } from "@/server/shell/shell";
import { Button } from "@/ui/primitives/button";
import { AppShell, type ShellNavItem, type ShellSidebarItem, type ShellSwitcherItem } from "@/ui/shell/app-shell";
import type { ReactNode } from "react";

export type ShellSection = "inbox" | "settings";

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
  const sidebar = sidebarFor(current, access, section);
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
  if (access.inbox && inbox !== undefined) items.push({ key: "inbox", label: t("shell.nav.inbox"), href: inbox, icon: "nav-inbox", current: section === "inbox" });
  if (access.connections && connections !== undefined) items.push({ key: "settings", label: t("shell.nav.settings"), href: connections, icon: "nav-settings", current: section === "settings" });
  return items;
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
