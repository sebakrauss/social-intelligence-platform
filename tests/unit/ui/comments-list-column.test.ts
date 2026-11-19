// @vitest-environment happy-dom
/**
 * COMMENTS-INT-03B-FIX — the Comments list column. Each conversation's page is mounted afresh (a new address), the list
 * with it: the column gives the SAME list back its scroll (so a visible row does not move), brings a hidden selected
 * row into view inside the list's own scroll only, and never scrolls the page. happy-dom does no layout: each case
 * gives the column and its row their geometry; the column's own scrollTop is real.
 */
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentsListColumn as Column } from "@/ui/inbox/comments-list-column";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let CommentsListColumn: typeof Column;
let container: HTMLElement;
let root: Root;
/** Where the selected row sits in the list's content (px from its top). */
let rowOffset = 0;

/** A list 800px tall showing 3000px of rows (or one that does not scroll); rows are 100px tall. */
function geometry(sizes: { readonly scrollHeight: number; readonly clientHeight: number } = { scrollHeight: 3000, clientHeight: 800 }): void {
  const define = (name: string, value: number): void => {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  };
  define("scrollHeight", sizes.scrollHeight);
  define("clientHeight", sizes.clientHeight);
  define("offsetHeight", 100);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    // The column sits at y=16; the row at its offset in the content, minus what the column has scrolled.
    const y = this.tagName === "A" ? 16 + rowOffset - (this.closest("div")?.scrollTop ?? 0) : 16;
    return { x: 0, y, top: y, left: 0, bottom: y + 100, right: 300, width: 300, height: 100, toJSON: () => ({}) };
  });
}

/** One page: the list column with the selected row at `offset` (a new page = a fresh mount, as the framework does). */
function page(list: string, selected: string | undefined, offset: number): HTMLDivElement {
  rowOffset = offset;
  act(() => {
    root.render(h(CommentsListColumn, { key: `${list}|${String(selected)}`, className: "list", list, selected, children: h("ul", null, h("li", null, h("a", { href: "#conversation", "aria-current": "page" }, "row"))) }));
  });
  const element = container.querySelector("div");
  if (!(element instanceof HTMLDivElement)) throw new Error("no column");
  return element;
}

beforeEach(async () => {
  vi.resetModules(); // the remembered position is this tab's memory: each case starts with none
  ({ CommentsListColumn } = await import("@/ui/inbox/comments-list-column"));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  geometry();
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

describe("the Comments list column", () => {
  it("a fresh page (a direct link, a reload): a selected row out of sight is brought into view inside the list — never by scrolling the page", () => {
    const pageScroll = vi.spyOn(window, "scrollTo");
    const intoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    // Centred in the list's own view: 2500 - (800 - 100) / 2.
    expect(page("ws/list", "c-27", 2500).scrollTop).toBe(2150);
    expect(pageScroll).not.toHaveBeenCalled();
    expect(intoView).not.toHaveBeenCalled();
  });

  it("switching conversations: the same list comes back where it was, so a visible row does not move", () => {
    const first = page("ws/list", "c-12", 1300);
    first.scrollTop = 1200; // the person scrolled the list; row 14 is at 1400 (on screen: 1200–2000)
    const second = page("ws/list", "c-14", 1400);
    expect(second).not.toBe(first); // a new mount, as for a new address
    expect(second.scrollTop).toBe(1200);
    // A neighbour already on screen: still nothing moves.
    expect(page("ws/list", "c-15", 1500).scrollTop).toBe(1200);
  });

  it("the position given back hides the selected row (Back to a conversation further down): the row is brought into view", () => {
    page("ws/list", "c-3", 300).scrollTop = 0;
    expect(page("ws/list", "c-27", 2500).scrollTop).toBe(2150);
  });

  it("a position is only ever given back to the same list (another workspace or page starts from its own top)", () => {
    page("ws/list", "c-14", 1400).scrollTop = 1200;
    // Row 40 is on screen from that page's own top (500 of 0–800); 1200 from the other list would hide it.
    expect(page("ws/list?cursor=older", "c-40", 500).scrollTop).toBe(0);
  });

  it("without a selection, or where the list does not scroll on its own (one panel), it neither moves nor remembers anything", () => {
    expect(page("ws/list", undefined, 2500).scrollTop).toBe(0);
    vi.restoreAllMocks();
    geometry({ scrollHeight: 0, clientHeight: 0 });
    page("ws/list", "c-27", 2500).scrollTop = 900;
    act(() => {
      root.render(null); // that page is taken down while its list still does not scroll
    });
    vi.restoreAllMocks();
    geometry();
    // Nothing was remembered from the list that did not scroll: the row at 1000 is brought into view from the top
    // (1000 - 350), not shown from a stale 900.
    expect(page("ws/list", "c-10", 1000).scrollTop).toBe(650);
  });
});
