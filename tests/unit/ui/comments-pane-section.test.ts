// @vitest-environment happy-dom
/**
 * COMMENTS-INT-03C-1 — the Comments conversation area's keyboard behavior, from the approved prototype: Escape hands the
 * focus back to the selected conversation's row (or, where the row is not drawn, to the conversation's title). Keys
 * typed into a field, keys already handled, and a pane without a conversation are left alone. Nothing navigates.
 */
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommentsPaneSection } from "@/ui/inbox/comments-pane-section";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

/** The split: the list with the selected row, and the conversation area (its title, a link, a field). */
function draw(content: "message" | "conversation" = "conversation"): void {
  act(() => {
    root.render(
      h("div", { className: "split" },
        h("ul", null, h("li", { id: "row-c2" }, h("a", { href: "/c/c2#conversation", "aria-current": "page" }, "row"))),
        h(CommentsPaneSection, { className: "pane", label: "Conversation", content, children: h("article", null, h("h2", { id: "conversation-title", tabIndex: -1 }, "Title"), h("a", { href: "/inbox/c2" }, "View conversation in Inbox"), h("input", { "aria-label": "field" })) }),
      ),
    );
  });
}
const el = (selector: string): HTMLElement => container.querySelector(selector) as HTMLElement;
const escape = (target: HTMLElement, init: { readonly handled?: boolean } = {}): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  if (init.handled === true) event.preventDefault();
  act(() => { target.dispatchEvent(event); });
  return event;
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe("Escape in the conversation area", () => {
  it("hands the focus back to the selected row, without navigating", () => {
    draw();
    el('a[href="/inbox/c2"]').focus();
    const event = escape(el('a[href="/inbox/c2"]'));
    expect(document.activeElement).toBe(el('[aria-current="page"]'));
    expect(event.defaultPrevented).toBe(true);
    expect(el("section").id).toBe("conversation");
  });

  it("where the row is not drawn (one panel), the conversation's title takes it", () => {
    draw();
    Object.defineProperty(el('[aria-current="page"]'), "focus", { configurable: true, value: () => undefined });
    el('a[href="/inbox/c2"]').focus();
    escape(el('a[href="/inbox/c2"]'));
    expect(document.activeElement).toBe(el("#conversation-title"));
  });

  it("leaves a key typed into a field, a key already handled, and a pane without a conversation alone", () => {
    draw();
    el("input").focus();
    expect(escape(el("input")).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(el("input"));
    el('a[href="/inbox/c2"]').focus();
    escape(el('a[href="/inbox/c2"]'), { handled: true });
    expect(document.activeElement).toBe(el('a[href="/inbox/c2"]'));
    draw("message");
    el('a[href="/inbox/c2"]').focus();
    expect(escape(el('a[href="/inbox/c2"]')).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(el('a[href="/inbox/c2"]'));
  });
});
