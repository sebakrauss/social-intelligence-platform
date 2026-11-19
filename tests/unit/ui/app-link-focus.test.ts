// @vitest-environment happy-dom
/**
 * In-app link focus hand-off (COMMENTS-INT-03A-FIX, audit L-5). After an in-app move to `#anchor`, the link standing
 * for that anchor takes the keyboard focus. A link that can't take it — a list row that is not drawn while the open
 * conversation fills a small screen — must leave it to the next link standing for the same anchor (the way back to the
 * list), so the focus never falls to the top of the page; and going back hands it to the row again.
 */
import { act, createElement as h, forwardRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: forwardRef<HTMLAnchorElement, { href: string; className?: string; onNavigate?: () => void; children?: ReactNode }>(function Link({ href, className, onNavigate, children, ...rest }, ref) {
    const passed = Object.fromEntries(Object.entries(rest).filter(([key]) => key.startsWith("aria-")));
    return h("a", { ref, href, className, ...passed, onClick: (event: { preventDefault: () => void }) => { event.preventDefault(); onNavigate?.(); } }, children);
  }),
  useLinkStatus: () => ({ pending: false }),
}));

const { AppLink } = await import("@/ui/navigation/app-link");
const { CommentsConversationNav, CommentsPane, CommentsRow } = await import("@/ui/inbox/comments");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ROW = "row-1";
let container: HTMLElement;
let root: Root;
const render = async (node: ReactNode): Promise<void> => { await act(async () => { root.render(node); await Promise.resolve(); }); };
const link = (text: string): HTMLAnchorElement => [...container.querySelectorAll("a")].find((a) => a.textContent === text) as HTMLAnchorElement;
const active = (): Element | null => container.ownerDocument.activeElement;

/** The list page (the row, nothing selected) and the conversation page (the row selected, plus the way back). */
const listPage = (): ReactNode => h("div", null, h(AppLink, { href: `/c/1#${ROW}`, focusKey: ROW, current: false, children: "row" }));
const conversationPage = (): ReactNode => h("div", null, h(AppLink, { href: `/c/1#${ROW}`, focusKey: ROW, current: true, children: "row" }), h(AppLink, { href: `/c#${ROW}`, focusKey: ROW, children: "back" }));

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); await Promise.resolve(); });
  container.remove();
});

describe("in-app link: who takes the focus after a move", () => {
  it("wide screen: the selected row takes the focus, the way back does not", async () => {
    await render(listPage());
    await act(async () => { link("row").click(); await Promise.resolve(); });
    await render(conversationPage());
    expect(active()).toBe(link("row"));
  });

  it("small screen: the row is not drawn and can't take the focus — the way back takes it, never the page body", async () => {
    await render(listPage());
    const row = link("row");
    // Not drawn (its column is display:none): focusing it does nothing, as in a browser.
    Object.defineProperty(row, "focus", { configurable: true, value: () => undefined });
    await act(async () => { row.click(); await Promise.resolve(); });
    await render(conversationPage());
    expect(active()).toBe(link("back"));
    expect(active()).not.toBe(document.body);
    // Going back: the row is drawn again and takes the focus.
    Reflect.deleteProperty(row, "focus");
    await act(async () => { link("back").click(); await Promise.resolve(); });
    await render(listPage());
    expect(active()).toBe(link("row"));
  });

  it("a move to another anchor moves no focus here", async () => {
    await render(h("div", null, h(AppLink, { href: "/c/2#row-2", children: "other" }), h(AppLink, { href: `/c/1#${ROW}`, focusKey: ROW, current: false, children: "row" })));
    await act(async () => { link("other").click(); await Promise.resolve(); });
    await render(conversationPage());
    expect(active()).not.toBe(link("row"));
    expect(active()).not.toBe(link("back"));
  });
});

/* COMMENTS-INT-03B-FIX (M-1): a link to a conversation goes to the conversation's anchor (#conversation). The real
   Comments row and pane are drawn here: the SELECTED row and the way back stand for that anchor; every other row for its own. */
describe("Comments: the focus after opening a conversation (the real row and pane)", () => {
  const time = { iso: "2026-11-01T10:00:00.000Z", label: "10:00", full: "01 NOV 2026 · 10:00 UTC" };
  const row = (current: boolean): ReactNode => h(CommentsRow, { id: ROW, href: "/c/1#conversation", current, origin: null, author: "Person 1", time, excerpt: "excerpt" });
  // The same structure on both pages, so the row is the same element (as the original cases above do).
  const list = (): ReactNode => h("div", null, h("ul", null, row(false)));
  const opened = (): ReactNode => h("div", null, h("ul", null, row(true)), h(CommentsPane, { label: "Conversation", back: { href: `/c#${ROW}`, label: "back", focusKey: "conversation" }, content: "conversation", children: "thread" }));
  const rowLink = (): HTMLAnchorElement => container.querySelector(`#${ROW} a`) as HTMLAnchorElement;

  it("wide screen: the selected row takes the focus back once the conversation opens", async () => {
    await render(list());
    await act(async () => { rowLink().click(); await Promise.resolve(); });
    await render(opened());
    expect(active()).toBe(rowLink());
  });

  it("one panel: the row is not drawn — the way back takes the focus (never the page body), and going back hands it to the row", async () => {
    await render(list());
    const target = rowLink();
    Object.defineProperty(target, "focus", { configurable: true, value: () => undefined });
    await act(async () => { target.click(); await Promise.resolve(); });
    await render(opened());
    expect(active()).toBe(link("back"));
    Reflect.deleteProperty(target, "focus");
    await act(async () => { link("back").click(); await Promise.resolve(); });
    await render(list());
    expect(active()).toBe(rowLink());
  });
});

/* COMMENTS-INT-03C-1: Previous / Next lead to their own anchors, so the control used keeps the focus (the prototype's
   behavior: moving again is one key press away); at an end of the page, the remaining control takes it. */
describe("Comments: the focus after Previous / Next (the real header navigation)", () => {
  // Each conversation is a new address, so its page is mounted afresh (as the framework does): a key per page.
  const nav = (previous: string | undefined, next: string | undefined): ReactNode =>
    h("div", { key: `${String(previous)}|${String(next)}` }, h(CommentsConversationNav, {
      label: "Move between conversations",
      position: "2 of 3",
      previous: { label: "Previous", href: previous },
      next: { label: "Next", href: next },
      anchors: { previous: "conversation-previous", next: "conversation-next" },
    }));
  const move = (word: string): HTMLAnchorElement => [...container.querySelectorAll("a")].find((a) => a.textContent.includes(word)) as HTMLAnchorElement;

  it("Next keeps the focus on Next", async () => {
    await render(nav("/c/1#conversation-previous", "/c/3#conversation-next"));
    await act(async () => { move("Next").click(); await Promise.resolve(); });
    await render(nav("/c/2#conversation-previous", "/c/4#conversation-next"));
    expect(active()).toBe(move("Next"));
  });

  it("Previous keeps the focus on Previous", async () => {
    await render(nav("/c/1#conversation-previous", "/c/3#conversation-next"));
    await act(async () => { move("Previous").click(); await Promise.resolve(); });
    await render(nav("/c/0#conversation-previous", "/c/2#conversation-next"));
    expect(active()).toBe(move("Previous"));
  });

  it("at the last conversation of the page Next is not a link: Previous takes the focus, never the page body", async () => {
    await render(nav("/c/1#conversation-previous", "/c/3#conversation-next"));
    await act(async () => { move("Next").click(); await Promise.resolve(); });
    await render(nav("/c/2#conversation-previous", undefined));
    expect(active()).toBe(move("Previous"));
    expect(active()).not.toBe(document.body);
  });

  it("at the first conversation of the page Previous is not a link: Next takes the focus", async () => {
    await render(nav("/c/1#conversation-previous", "/c/3#conversation-next"));
    await act(async () => { move("Previous").click(); await Promise.resolve(); });
    await render(nav(undefined, "/c/2#conversation-next"));
    expect(active()).toBe(move("Next"));
  });
});
