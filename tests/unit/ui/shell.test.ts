/**
 * App shell (UI-3), rendered on the server from data: landmarks and the skip link, the rail with exactly the given
 * destinations and aria-current on the active one, the wordmark and the workspace block, the switcher only when
 * there is somewhere else to go (links only where a destination exists), the Monitor-only pill, the account menu
 * as a native details with the given content, the reserved panel, and never a hex color, a script or a handler.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell, type AppShellProps } from "@/ui/shell/app-shell";

const TEXTS = { brand: "wrenkind", skipToContent: "Skip to content", navigation: "Main navigation", workspace: "Workspace", workspaceUnavailable: "This workspace isn't available to you.", switchWorkspace: "Switch workspace", monitorOnly: "Monitor-only", account: "Account" };
const INBOX = "/workspaces/11111111-1111-4111-8111-111111111111/inbox";
const CONNECTIONS = "/workspaces/11111111-1111-4111-8111-111111111111/settings/connections";
const LONG = "Lumen Coffee Roasters International Holdings and Subsidiaries <b>Ünïcödé</b>";

function render(overrides: Partial<AppShellProps> = {}): string {
  const props: AppShellProps = {
    texts: TEXTS,
    workspace: { name: "Lumen Coffee", organizationName: "Lumen Group", monitorOnly: false },
    switcher: [],
    nav: [
      { key: "inbox", label: "Inbox", href: INBOX, icon: "nav-inbox", current: true },
      { key: "settings", label: "Settings", href: CONNECTIONS, icon: "nav-settings", current: false },
    ],
    sidebar: { heading: "Inbox", items: [{ label: "Conversations", href: INBOX, current: true }] },
    account: h("p", { id: "account-content" }, "sign-out form goes here"),
    children: h("main", {}, h("h1", {}, "Page")),
    ...overrides,
  };
  return renderToStaticMarkup(h(AppShell, props));
}

describe("<AppShell>", () => {
  it("has a skip link to the content region, named navigation landmarks and the page inside the content region", () => {
    const html = render();
    expect(html).toMatch(/^<div class="[^"]*shell[^"]*"><a href="#content" class="[^"]*">Skip to content<\/a><header/);
    expect(html).toContain('aria-label="Main navigation"');
    expect(html).toContain('<aside class="');
    expect(html).toContain('aria-label="Workspace"');
    expect(html).toMatch(/<div id="content" class="[^"]*" tabindex="-1"><main><h1>Page<\/h1><\/main><\/div>/);
  });

  it("draws exactly the given destinations, marks the active one, and nothing more", () => {
    const html = render();
    expect(html).toMatch(new RegExp(`<a href="${INBOX}" class="[^"]*" aria-current="page"><svg`));
    expect(html).toMatch(new RegExp(`<a href="${CONNECTIONS}" class="[^"]*"><svg`));
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(2); // rail Inbox + sidebar Conversations
    expect(html).not.toMatch(/Home|Insights|Reports|TikTok/);
    const none = render({ nav: [], sidebar: undefined });
    expect(none).not.toContain("<nav");
    expect(none).not.toContain("aria-current");
  });

  it("shows the wordmark and the workspace; a missing workspace says so; long names are text, never markup", () => {
    const html = render();
    expect(html).toContain("<title>wrenkind</title>");
    expect(html).toContain('viewBox="-20 -790 4125 830"');
    expect(html).toContain(">Lumen Coffee</p>");
    expect(html).toContain(">Lumen Group</p>");
    expect(html).not.toContain("Monitor-only");
    const missing = render({ workspace: undefined });
    expect(missing).toContain("This workspace isn&#x27;t available to you.");
    const long = render({ workspace: { name: LONG, organizationName: LONG, monitorOnly: true } });
    expect(long).toContain("&lt;b&gt;Ünïcödé&lt;/b&gt;");
    expect(long).not.toContain("<b>");
    expect(long).toContain("Monitor-only");
    expect(long).toMatch(/<span class="[^"]*pill[^"]*"><span class="[^"]*icon[^"]*"><svg/);
  });

  it("offers the switcher only when there is another workspace, linking only where a destination exists", () => {
    expect(render()).not.toContain("Switch workspace");
    const html = render({
      switcher: [
        { id: "a", name: "Other One", organizationName: "Org A", href: "/workspaces/22222222-2222-4222-8222-222222222222/inbox" },
        { id: "b", name: "Guest Only", organizationName: "Org B", href: undefined },
      ],
    });
    expect(html).toMatch(/<details class="[^"]*"><summary class="[^"]*"><svg[\s\S]*<\/svg><span class="[^"]*">Switch workspace<\/span><\/summary>/);
    expect(html).toMatch(/<a href="\/workspaces\/22222222-2222-4222-8222-222222222222\/inbox" class="[^"]*">Other One<span class="[^"]*">Org A<\/span><\/a>/);
    expect(html).toMatch(/<span class="[^"]*">Guest Only<span class="[^"]*">Org B<\/span><\/span>/);
  });

  it("the account menu is a native details carrying the given content; the panel renders only when given", () => {
    const html = render();
    expect(html).toMatch(/<details class="[^"]*"><summary class="[^"]*"><svg[\s\S]*<\/svg><span>Account<\/span><\/summary><div class="[^"]*"><p class="[^"]*">Account<\/p><p id="account-content">sign-out form goes here<\/p><\/div><\/details>/);
    expect(html).not.toMatch(/withPanel/);
    const withPanel = render({ panel: h("p", {}, "detail") });
    expect(withPanel).toMatch(/withPanel/);
    expect(withPanel).toMatch(/<aside class="[^"]*panel[^"]*"><p>detail<\/p><\/aside>/);
  });

  it("the account menu uses the neutral 'more' glyph, never the Persona dot; a contextual list that only repeats the section is marked", () => {
    const html = render();
    const account = /<details class="[^"]*account[^"]*"><summary[\s\S]*?<\/summary>/.exec(html)?.[0] ?? "";
    expect(account).toContain("<svg");
    expect(account).not.toContain("--wk-human-dot");
    expect(account).toContain('<path d="M5 12h.01">');
    expect(html).toMatch(/<nav class="[^"]*sideNav[^"]*sideNavCurrentOnly[^"]*" aria-label="Inbox">/);
    const two = render({ sidebar: { heading: "Inbox", items: [{ label: "Conversations", href: INBOX, current: true }, { label: "Needs a look", href: `${INBOX}?view=x`, current: false }] } });
    expect(two).not.toMatch(/sideNavCurrentOnly/);
  });

  it("carries no hex color, script, image or inline handler", () => {
    const html = render({ workspace: { name: "X", organizationName: "Y", monitorOnly: true }, switcher: [{ id: "a", name: "A", organizationName: "O", href: "/x" }] });
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/<script|<img|on[a-z]+=/i);
  });
});
