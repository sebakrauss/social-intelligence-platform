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
// COMMENTS-INT-03C-2: the Comments section's view navigation reads the address (a client component); here, a fixed one.
const address = vi.hoisted((): { path: string; query: string } => ({ path: "/workspaces/x/comments", query: "" }));
vi.mock("next/navigation", () => ({ usePathname: () => address.path, useSearchParams: () => new URLSearchParams(address.query), useRouter: () => ({ push: () => undefined }) }));
vi.mock("@/server/auth/actions", () => ({ signOutAction: Object.assign(() => Promise.resolve(), { $$typeof: Symbol.for("react.server.reference"), $$id: "sign-out" }) }));

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const OTHER = "11111111-1111-4111-8111-111111111111";
const workspace = (overrides: Partial<ShellWorkspace> = {}): ShellWorkspace => ({ id: WS, name: "Lumen Coffee", organizationName: "Lumen Group", role: "OWNER", mode: "STANDARD", ...overrides });

async function render(state: ShellState, section: "inbox" | "settings" | "comments" = "inbox"): Promise<string> {
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

  it("an Owner sees Comments and Settings, the active section, the workspace and the sign-out form", async () => {
    const html = await render({ kind: "ready", current: workspace(), workspaces: [workspace()] });
    // Step 7B-17K: in-app links — still one <a href> each, with the pending signal first.
    expect(html).toMatch(new RegExp(`<a class="[^"]*" aria-current="page" href="/workspaces/${WS}/inbox"><span class="[^"]*" data-pending="false" aria-hidden="true"></span><svg`));
    expect(html).toMatch(new RegExp(`<a class="[^"]*" href="/workspaces/${WS}/settings/connections"><span class="[^"]*" data-pending="false" aria-hidden="true"></span><svg`));
    expect(html).toContain(">Lumen Coffee</p>");
    // Comments 2.1 (Step 7B-17R): the module is "Comments", its default section "All comments"; no Messages destination.
    expect(html).toMatch(/<span>Comments<\/span><\/a>/);
    expect(html).toContain(">All comments</a>");
    expect(html).not.toMatch(/Inbox<|Conversations<|Messages/);
    expect((html.match(/<form\b/g) ?? []).length).toBe(1);
    expect(html).toMatch(/<form[^>]*><button type="submit"[^>]*>Sign out<\/button><\/form>/);
    expect(html).not.toContain("Switch workspace");
    expect(html).not.toContain("Monitor-only");
    expect(html).toContain("<main><h1>Page</h1></main>");
    const settings = await render({ kind: "ready", current: workspace(), workspaces: [workspace()] }, "settings");
    expect(settings).toMatch(new RegExp(`<a class="[^"]*" aria-current="page" href="/workspaces/${WS}/settings/connections"><span class="[^"]*" data-pending="false" aria-hidden="true"></span><svg`));
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
    expect(html).toMatch(new RegExp(`<a class="[^"]*" href="/workspaces/${OTHER}/inbox"><span class="[^"]*" data-pending="false" aria-hidden="true"></span>`));
    expect(html).toContain(">Mine<span");
  });

  it("other workspaces are offered as links to their Inbox, except where the caller is a guest; Monitor-only is shown", async () => {
    const current = workspace({ mode: "MONITOR_ONLY" });
    const linked = workspace({ id: OTHER, name: "Second", organizationName: "Org B", role: "MANAGER" });
    const guestOnly = workspace({ id: "22222222-2222-4222-8222-222222222222", name: "Client view", organizationName: "Org C", role: "CLIENT_GUEST" });
    const html = await render({ kind: "ready", current, workspaces: [current, linked, guestOnly] });
    expect(html).toContain("Monitor-only");
    expect(html).toContain("Switch workspace");
    expect(html).toMatch(new RegExp(`<a class="[^"]*" href="/workspaces/${OTHER}/inbox"><span class="[^"]*" data-pending="false" aria-hidden="true"></span>`));
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

  it("COMMENTS-INT-03C-2 (M-1): Comments holds its views — Open, the planned ones as text, Done, All conversations apart — current by the address, never a link back to the Inbox", async () => {
    address.path = `/workspaces/${WS}/comments`;
    address.query = "view=done";
    const html = await render({ kind: "ready", current: workspace(), workspaces: [workspace()] }, "comments");
    const at = html.indexOf('aria-label="Comments views"');
    const nav = html.slice(html.indexOf(">", at) + 1, html.indexOf("</nav>", at));
    const words = nav.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    expect(words).toBe("Comments Open Needs attention Not yet (Not available yet) Assigned to me Not yet (Not available yet) Escalated Not yet (Not available yet) Done All conversations View Open Needs attention (Not available yet) Assigned to me (Not available yet) Escalated (Not available yet) Done All conversations");
    expect([...nav.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1])).toEqual([`/workspaces/${WS}/comments`, `/workspaces/${WS}/comments?view=done`, `/workspaces/${WS}/comments?view=all`]);
    expect([...nav.matchAll(/aria-current="page"[^>]*>(?:<span[^>]*><\/span>)?([^<]+)</g)].map((m) => m[1])).toEqual(["Done"]);
    // The contradiction is gone: no "All comments" entry pointing at the Inbox while Comments shows a view.
    expect(html).not.toContain(">All comments</a>");
    expect(html).not.toMatch(new RegExp(`<a [^>]*aria-current="page"[^>]*href="/workspaces/${WS}/inbox"[^>]*>(?:<span[^>]*></span>)?All comments`));
    // The rail's Comments (the Inbox's destination) stays the current section; Settings is untouched.
    expect(html).toMatch(new RegExp(`<a class="[^"]*" aria-current="page" href="/workspaces/${WS}/inbox"><span class="[^"]*" data-pending="false" aria-hidden="true"></span><svg`));
    expect(html).toMatch(new RegExp(`<a class="[^"]*" href="/workspaces/${WS}/settings/connections">`));
    expect((html.match(/<form\b/g) ?? []).length).toBe(1);
  });

  it("COMMENTS-INT-03C-2 (S-1): with a conversation open, the views still lead to the Comments LIST of each view (built from the route helper), the open one's view current", async () => {
    address.path = `/workspaces/${WS}/comments/11111111-1111-4111-8111-111111111111`;
    address.query = "view=done&cursor=done.x";
    const html = await render({ kind: "ready", current: workspace(), workspaces: [workspace()] }, "comments");
    const at = html.indexOf('aria-label="Comments views"');
    const nav = html.slice(html.indexOf(">", at) + 1, html.indexOf("</nav>", at));
    expect([...nav.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1])).toEqual([`/workspaces/${WS}/comments`, `/workspaces/${WS}/comments?view=done`, `/workspaces/${WS}/comments?view=all`]);
    expect(nav).not.toMatch(/11111111|cursor/);
    expect([...nav.matchAll(/aria-current="page"[^>]*>(?:<span[^>]*><\/span>)?([^<]+)</g)].map((m) => m[1])).toEqual(["Done"]);
  });

  it("COMMENTS-INT-03C-2: the Inbox and Settings sidebars are exactly as before (no views), and a guest gets no Comments views", async () => {
    const inbox = await render({ kind: "ready", current: workspace(), workspaces: [workspace()] }, "inbox");
    expect(inbox).toContain(">All comments</a>");
    expect(inbox).not.toContain("Comments views");
    expect(inbox).not.toContain("<select");
    const settings = await render({ kind: "ready", current: workspace(), workspaces: [workspace()] }, "settings");
    expect(settings).toContain(">Connections</a>");
    expect(settings).not.toContain("Comments views");
    const guest = await render({ kind: "ready", current: workspace({ role: "CLIENT_GUEST" }), workspaces: [workspace({ role: "CLIENT_GUEST" })] }, "comments");
    expect(guest).not.toContain("Comments views");
    expect(guest).not.toContain(`/workspaces/${WS}/comments`);
    for (const kind of ["signed_out", "verification_required", "unavailable", "no_workspaces"] as const) expect(await render({ kind }, "comments")).toBe("<main><h1>Page</h1></main>");
  });
});
