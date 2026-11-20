// @vitest-environment happy-dom
/**
 * COMMENTS-INT-03C-2 (M-1) — the shell's opt-in view navigation (ui/shell/shell-view-nav.tsx), drawn by the real
 * component with the address replaced in-process. Proves: the current view follows the ADDRESS (the server's rule: the
 * value named exactly once, anything else the default), each entry leads to the section's list (the server-built base,
 * never the address on screen) with only the view set — S-1: a list position is dropped and an open conversation is
 * left for the chosen view's list — the planned views keep their place as text only, All
 * conversations sits apart, the narrow picker offers the same views and moves with the app's navigation, and the
 * control used keeps the keyboard focus (the shell is not redrawn by the move).
 */
import { act, createElement as h, forwardRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const address = vi.hoisted((): { path: string; query: string; pushes: string[] } => ({ path: "/workspaces/w/comments", query: "", pushes: [] }));
// The address on screen (`path`) is only the page shown: the component must not read it to build where the views lead.
vi.mock("next/navigation", () => ({
  usePathname: () => address.path,
  useSearchParams: () => new URLSearchParams(address.query),
  useRouter: () => ({ push: (href: string) => { address.pushes.push(href); } }),
}));
vi.mock("next/link", () => ({
  default: forwardRef<HTMLAnchorElement, { href: string; className?: string; onNavigate?: () => void; children?: ReactNode }>(function Link({ href, className, onNavigate, children, ...rest }, ref) {
    const passed = Object.fromEntries(Object.entries(rest).filter(([key]) => key.startsWith("aria-")));
    return h("a", { ref, href, className, ...passed, onClick: (event: { preventDefault: () => void }) => { event.preventDefault(); onNavigate?.(); } }, children);
  }),
  useLinkStatus: () => ({ pending: false }),
}));

const { ShellViewNav } = await import("@/ui/shell/shell-view-nav");
type Views = Parameters<typeof ShellViewNav>[0]["views"];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLElement;
let root: Root;

const VIEWS: Views = {
  label: "Comments views",
  heading: "Comments",
  base: "/workspaces/w/comments",
  param: "view",
  pickerLabel: "View",
  laterNote: "Not available yet",
  laterTag: "Not yet",
  items: [
    { kind: "view", label: "Open", value: undefined },
    { kind: "later", label: "Needs attention" },
    { kind: "later", label: "Assigned to me" },
    { kind: "later", label: "Escalated" },
    { kind: "view", label: "Done", value: "done" },
    { kind: "view", label: "All conversations", value: "all", apart: true },
  ],
};

const at = async (path: string, query = ""): Promise<void> => {
  address.path = path;
  address.query = query;
  await act(async () => { root.render(h(ShellViewNav, { views: VIEWS })); await Promise.resolve(); });
};
const links = (): HTMLAnchorElement[] => [...container.querySelectorAll("a")];
const link = (text: string): HTMLAnchorElement => links().find((a) => a.textContent === text) as HTMLAnchorElement;
const current = (): string[] => links().filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent);
const select = (): HTMLSelectElement => container.querySelector("select") as HTMLSelectElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  address.pushes = [];
});
afterEach(async () => {
  await act(async () => { root.unmount(); await Promise.resolve(); });
  container.remove();
});

describe("ShellViewNav: the views of a section, current by the address", () => {
  it("the approved order: the working views, the planned ones as text in their place, All conversations apart", async () => {
    await at("/workspaces/w/comments");
    const lists = [...container.querySelectorAll("ul")];
    expect(lists).toHaveLength(2);
    expect(lists[0]?.textContent).toBe("OpenNeeds attentionNot yet(Not available yet)Assigned to meNot yet(Not available yet)EscalatedNot yet(Not available yet)Done");
    // Seen: the short tag; read aloud: the full note (the tag itself is hidden from assistive technology).
    expect([...container.querySelectorAll('[aria-hidden="true"]')].map((tag) => tag.textContent).filter((text) => text !== "")).toEqual(["Not yet", "Not yet", "Not yet"]);
    expect(lists[1]?.textContent).toBe("All conversations");
    // Only the views backed by data are links; the planned ones are never links, focusable or current.
    expect(links().map((a) => a.textContent)).toEqual(["Open", "Done", "All conversations"]);
    expect(container.querySelectorAll("[tabindex]")).toHaveLength(0);
    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe("Comments views");
  });

  it("the current view follows the address with the server's rule: named exactly once, else the default (Open)", async () => {
    const cases: [string, string][] = [["", "Open"], ["view=done", "Done"], ["view=all", "All conversations"], ["view=open", "Open"], ["view=attention", "Open"], ["view=DONE", "Open"], ["view=done&view=all", "Open"], ["view=", "Open"], ["cursor=done.x&view=done", "Done"]];
    for (const [query, expected] of cases) {
      await at("/workspaces/w/comments", query);
      expect(current(), query).toEqual([expected]);
      expect(select().value, query).toBe(expected === "Open" ? "" : expected === "Done" ? "done" : "all");
    }
  });

  it("S-1: each entry leads to the chosen view's LIST — a list position is dropped and an open conversation is left", async () => {
    const LISTS = ["/workspaces/w/comments", "/workspaces/w/comments?view=done", "/workspaces/w/comments?view=all"];
    // From a list at an older position, and from a conversation open in each view (with or without a position): the
    // same three list addresses, whatever the page on screen — including the view the conversation is already in.
    const from: [string, string][] = [
      ["/workspaces/w/comments", "view=done&cursor=done.2026-11-01T10%3A00%3A00.000Z~x"],
      ["/workspaces/w/comments/c1", ""],
      ["/workspaces/w/comments/c1", "view=done"],
      ["/workspaces/w/comments/c1", "view=all&cursor=x"],
      ["/workspaces/w/comments/c1", "cursor=open.x"],
    ];
    for (const [path, query] of from) {
      await at(path, query);
      expect(links().map((a) => a.getAttribute("href")), `${path}?${query}`).toEqual(LISTS);
      for (const href of LISTS) expect(href).not.toMatch(/c1|cursor/);
    }
    // The destination is the server-built base: never derived from the address on screen.
    await at("/workspaces/other/comments/c9", "view=done");
    expect(links().map((a) => a.getAttribute("href"))).toEqual(LISTS);
  });

  it("the narrow picker offers the same views (the planned ones disabled) and moves with the app's navigation", async () => {
    await at("/workspaces/w/comments/c1", "cursor=open.x");
    const options = [...select().options].map((option) => [option.textContent, option.disabled]);
    expect(options).toEqual([["Open", false], ["Needs attention (Not available yet)", true], ["Assigned to me (Not available yet)", true], ["Escalated (Not available yet)", true], ["Done", false], ["All conversations", false]]);
    expect(container.querySelector(`label[for="${select().id}"]`)?.textContent).toBe("View");
    await act(async () => {
      select().value = "done";
      select().dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    // S-1: from an open conversation, to the chosen view's list (no conversation, no position).
    expect(address.pushes).toEqual(["/workspaces/w/comments?view=done"]);
    // Choosing the view already shown moves nowhere.
    await at("/workspaces/w/comments", "view=done");
    await act(async () => {
      select().value = "done";
      select().dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(address.pushes).toHaveLength(1);
  });

  it("S-1: the narrow picker leaves an open conversation for the chosen view's list too (Open, All conversations)", async () => {
    await at("/workspaces/w/comments/c1", "view=done&cursor=done.x");
    for (const [value, expected] of [["", "/workspaces/w/comments"], ["all", "/workspaces/w/comments?view=all"]] as const) {
      await act(async () => {
        select().value = value;
        select().dispatchEvent(new Event("change", { bubbles: true }));
        await Promise.resolve();
      });
      expect(address.pushes.at(-1)).toBe(expected);
      await at("/workspaces/w/comments/c1", "view=done&cursor=done.x");
    }
    expect(address.pushes).toEqual(["/workspaces/w/comments", "/workspaces/w/comments?view=all"]);
  });

  it("the control used keeps the focus: the shell is not redrawn by the move, only the current view changes", async () => {
    await at("/workspaces/w/comments");
    link("Done").focus();
    await act(async () => { link("Done").click(); await Promise.resolve(); });
    await at("/workspaces/w/comments", "view=done");
    expect(document.activeElement).toBe(link("Done"));
    expect(current()).toEqual(["Done"]);
    select().focus();
    await act(async () => {
      select().value = "all";
      select().dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await at("/workspaces/w/comments", "view=all");
    expect(document.activeElement).toBe(select());
    expect(select().value).toBe("all");
  });
});
