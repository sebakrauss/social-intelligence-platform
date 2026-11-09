/**
 * Workspace shell composition (UI-3), rendered on the server with the shell read replaced in-process. Proves what
 * surrounds a page: no shell at all when the caller is signed out, unverified, without workspaces or the read is
 * unavailable (the page stays alone); for a member, the destinations their role allows and no other, the active
 * section, the current workspace, the switcher to other workspaces, the Monitor-only indicator, and exactly one
 * form — sign out.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ShellState, ShellWorkspace } from "@/server/shell/shell";

const env = vi.hoisted((): { state: unknown } => ({ state: undefined }));
vi.mock("@/server/shell/runtime", () => ({ currentShellState: () => Promise.resolve(env.state) }));
vi.mock("@/server/auth/actions", () => ({ signOutAction: Object.assign(() => Promise.resolve(), { $$typeof: Symbol.for("react.server.reference"), $$id: "sign-out" }) }));

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const OTHER = "11111111-1111-4111-8111-111111111111";
const workspace = (overrides: Partial<ShellWorkspace> = {}): ShellWorkspace => ({ id: WS, name: "Lumen Coffee", organizationName: "Lumen Group", role: "OWNER", mode: "STANDARD", ...overrides });

async function render(state: ShellState, section: "inbox" | "settings" = "inbox"): Promise<string> {
  env.state = state;
  const { WorkspaceShell } = await import("@/app/workspaces/[workspaceId]/workspace-shell");
  return renderToStaticMarkup(await WorkspaceShell({ workspaceId: WS, section, children: h("main", {}, h("h1", {}, "Page")) }));
}

describe("WorkspaceShell", () => {
  it("renders the page alone when there is no ready shell state", async () => {
    for (const kind of ["signed_out", "verification_required", "unavailable", "no_workspaces"] as const) {
      expect(await render({ kind })).toBe("<main><h1>Page</h1></main>");
    }
  });

  it("an Owner sees Inbox and Settings, the active section, the workspace and the sign-out form", async () => {
    const html = await render({ kind: "ready", current: workspace(), workspaces: [workspace()] });
    expect(html).toMatch(new RegExp(`<a href="/workspaces/${WS}/inbox" class="[^"]*" aria-current="page"><svg`));
    expect(html).toMatch(new RegExp(`<a href="/workspaces/${WS}/settings/connections" class="[^"]*"><svg`));
    expect(html).toContain(">Lumen Coffee</p>");
    expect(html).toContain(">Conversations</a>");
    expect((html.match(/<form\b/g) ?? []).length).toBe(1);
    expect(html).toMatch(/<form[^>]*><button type="submit"[^>]*>Sign out<\/button><\/form>/);
    expect(html).not.toContain("Switch workspace");
    expect(html).not.toContain("Monitor-only");
    expect(html).toContain("<main><h1>Page</h1></main>");
    const settings = await render({ kind: "ready", current: workspace(), workspaces: [workspace()] }, "settings");
    expect(settings).toMatch(new RegExp(`<a href="/workspaces/${WS}/settings/connections" class="[^"]*" aria-current="page"><svg`));
    expect(settings).toContain(">Connections</a>");
  });

  it("a Responder sees Inbox only; a Client guest sees no destination at all", async () => {
    const responder = await render({ kind: "ready", current: workspace({ role: "RESPONDER" }), workspaces: [workspace({ role: "RESPONDER" })] });
    expect(responder).toContain(`/workspaces/${WS}/inbox"`);
    expect(responder).not.toContain("settings/connections");
    const guest = await render({ kind: "ready", current: workspace({ role: "CLIENT_GUEST" }), workspaces: [workspace({ role: "CLIENT_GUEST" })] });
    expect(guest).not.toContain(`/workspaces/${WS}/inbox"`);
    expect(guest).not.toContain("settings/connections");
    expect(guest).not.toContain("<nav");
    expect(guest).toContain(">Lumen Coffee</p>");
  });

  it("a workspace the caller isn't a member of shows no name and no destination, only the way to their own", async () => {
    const other = workspace({ id: OTHER, name: "Mine", organizationName: "Org" });
    const html = await render({ kind: "ready", current: undefined, workspaces: [other] });
    expect(html).toContain("This workspace isn&#x27;t available to you.");
    expect(html).not.toContain("<nav");
    expect(html).toContain(`<a href="/workspaces/${OTHER}/inbox" class="`);
    expect(html).toContain(">Mine<span");
  });

  it("other workspaces are offered as links to their Inbox, except where the caller is a guest; Monitor-only is shown", async () => {
    const current = workspace({ mode: "MONITOR_ONLY" });
    const linked = workspace({ id: OTHER, name: "Second", organizationName: "Org B", role: "MANAGER" });
    const guestOnly = workspace({ id: "22222222-2222-4222-8222-222222222222", name: "Client view", organizationName: "Org C", role: "CLIENT_GUEST" });
    const html = await render({ kind: "ready", current, workspaces: [current, linked, guestOnly] });
    expect(html).toContain("Monitor-only");
    expect(html).toContain("Switch workspace");
    expect(html).toContain(`<a href="/workspaces/${OTHER}/inbox" class="`);
    expect(html).toMatch(/<span class="[^"]*">Client view<span/);
    expect(html).not.toContain("22222222-2222-4222-8222-222222222222/inbox");
  });

  it("never shows a future destination, raw markup or an external link", async () => {
    const html = await render({ kind: "ready", current: workspace({ name: "<b>x</b>" }), workspaces: [workspace({ name: "<b>x</b>" })] });
    expect(html).not.toMatch(/Home|Insights|Reports|TikTok|<b>x/);
    // Outside the RSC runtime React renders a server-action form with its own inert shim; everything else is script-free.
    const outsideTheForm = html.replace(/<form[\s\S]*?<\/form>/, "").replace(/<script>addEventListener\("submit"[\s\S]*?<\/script>$/, "");
    expect(outsideTheForm).not.toMatch(/<a [^>]*href="https?:|<script|<img|javascript:/);
  });
});
