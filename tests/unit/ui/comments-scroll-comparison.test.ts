// @vitest-environment happy-dom
/**
 * COMMENTS-UX-07A — the development-only scroll comparison in a real client runtime (React + happy-dom). The scroll
 * itself (sticky, inner scroll areas, wheel) is a layout behavior verified in a browser; here: the three models draw the
 * same conversations, labels belong to the conversation (shown in the row and the header, managed from the header only,
 * never from a reply, never shared with the other conversations on the same post), the comment menu shows the proposed
 * wording and acts on nothing, and Previous / Next, Back and Reply move focus where the comparison says.
 */
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScrollComparison } from "@/app/dev/ui-reference/comments-scroll/comparison";
import { LONG_THREAD_ID, SCROLL_CONVERSATIONS } from "@/app/dev/ui-reference/comments-scroll/data";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root | undefined;

const q = (selector: string, scope: ParentNode = container): HTMLElement => {
  const found = scope.querySelector(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`not found: ${selector}`);
  return found;
};
const text = (element: Element): string => element.textContent.replace(/\s+/g, " ").trim();
const buttons = (scope: ParentNode = container): HTMLButtonElement[] => [...scope.querySelectorAll("button")];
const button = (name: string, scope: ParentNode = container): HTMLButtonElement => {
  const found = buttons(scope).find((item) => text(item) === name || item.getAttribute("aria-label") === name);
  if (found === undefined) throw new Error(`no button "${name}"`);
  return found;
};
const rowIds = (): string[] => [...container.querySelectorAll<HTMLButtonElement>("[id^=row-]")].map((item) => item.id.slice(4));
const active = (): Element | null => container.ownerDocument.activeElement;
const root$ = (): HTMLElement => q("[data-mode]");
const pane = (): HTMLElement => q('section[aria-label^="Conversation with"]');

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container);
    root.render(h(ScrollComparison));
    await Promise.resolve();
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await Promise.resolve();
  });
  container.remove();
});

describe("the three scroll models draw the same conversations", () => {
  it("A, B and C list the same 54 conversations in the same order (most recent activity first) and differ only by data-mode", async () => {
    // 48 when UX-07A was reviewed; UX-08A added six conversations dated in earlier months to the shared fixtures.
    expect(SCROLL_CONVERSATIONS).toHaveLength(54);
    const expected = SCROLL_CONVERSATIONS.map((item) => item.id);
    for (const letter of ["A", "B", "C"]) {
      const choice = buttons(q('[role="group"][aria-label="Scroll model"]')).find((item) => text(item).startsWith(letter));
      if (choice === undefined) throw new Error(letter);
      await click(choice);
      expect(root$().dataset["mode"]).toBe(letter.toLowerCase());
      expect(choice.getAttribute("aria-pressed")).toBe("true");
      expect(rowIds()).toEqual(expected);
    }
  });

  it("the width presets change only the frame (the same tree is drawn)", async () => {
    await click(button("Phone 390"));
    expect(q("[data-width]").dataset["width"]).toBe("390");
    expect(rowIds()).toHaveLength(54);
  });
});

describe("labels belong to the conversation", () => {
  it("the header has the one Labels button; no comment or reply has a label control", async () => {
    await click(q(`#row-${LONG_THREAD_ID}`));
    const thread = q('ol[aria-label="Comment and replies"]', pane());
    expect(thread.querySelectorAll("li").length).toBeGreaterThan(10);
    expect(buttons(pane()).filter((item) => text(item) === "Labels")).toHaveLength(1);
    expect(buttons(thread).some((item) => /label/i.test(`${text(item)} ${item.getAttribute("aria-label") ?? ""}`))).toBe(false);
  });

  it("assigning in the header shows in the row and the header, and never on another conversation of the same post", async () => {
    const target = SCROLL_CONVERSATIONS.find((item) => item.siblings > 0 && !item.seedLabels.includes("lbl-delivery"));
    if (target === undefined) throw new Error("no conversation with siblings");
    const sibling = SCROLL_CONVERSATIONS.find((item) => item.id !== target.id && item.postCaption === target.postCaption && item.platform === target.platform && item.postKind === target.postKind);
    if (sibling === undefined) throw new Error("no sibling");
    const siblingBefore = text(q(`#row-${sibling.id}`));
    await click(q(`#row-${target.id}`));
    await click(button("Labels", pane()));
    const popover = q('[role="group"][aria-labelledby$="-title"]', pane());
    expect(text(popover)).toMatch(/not to the \d+ other conversations? on this post/);
    const delivery = [...popover.querySelectorAll("label")].find((item) => text(item) === "Delivery");
    const box = delivery?.querySelector("input");
    if (!(box instanceof HTMLInputElement)) throw new Error("Delivery checkbox");
    await click(box);
    expect(text(q('header ul[aria-label="Labels"]', pane()))).toContain("Delivery");
    expect(text(q(`#row-${target.id}`))).toContain("Delivery");
    expect(text(q(`#row-${sibling.id}`))).toBe(siblingBefore);
  });
});

describe("the comment menu shows the proposed wording and acts on nothing", () => {
  it("Hide comment, Delete comment, Block author — no ellipsis, each aria-disabled", async () => {
    await click(q(`#row-${LONG_THREAD_ID}`));
    const more = buttons(pane()).find((item) => (item.getAttribute("aria-label") ?? "").startsWith("More actions for"));
    if (more === undefined) throw new Error("More actions");
    await click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const menu = q('[role="group"][aria-label="Comment actions (wording preview)"]', pane());
    const items = buttons(menu);
    expect(items.map(text)).toEqual(["Hide comment", "Delete comment", "Block author"]);
    for (const item of items) expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(text(menu)).not.toContain("…");
    await click(items[1] as HTMLButtonElement);
    expect(q('[role="group"][aria-label="Comment actions (wording preview)"]', pane())).toBeTruthy();
  });

  it("Escape closes the menu and returns focus to its trigger", async () => {
    await click(q(`#row-${LONG_THREAD_ID}`));
    const more = buttons(pane()).find((item) => (item.getAttribute("aria-label") ?? "").startsWith("More actions for"));
    if (more === undefined) throw new Error("More actions");
    await click(more);
    const menu = q('[role="group"][aria-label="Comment actions (wording preview)"]', pane());
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    expect(pane().querySelector('[aria-label="Comment actions (wording preview)"]')).toBeNull();
    expect(active()).toBe(more);
  });
});

describe("moving through the list", () => {
  it("Previous / Next follow the list order and keep focus on the control", async () => {
    await click(q(`#row-${SCROLL_CONVERSATIONS[1]?.id ?? ""}`));
    expect(text(q("h3", pane()))).toBe(SCROLL_CONVERSATIONS[1]?.author);
    expect(text(pane())).toContain(`2 of 54`);
    const next = button("Next conversation", pane());
    await click(next);
    expect(text(pane())).toContain(`3 of 54`);
    expect(active()?.getAttribute("aria-label")).toBe("Next conversation");
    await click(button("Previous conversation", pane()));
    await click(button("Previous conversation", pane()));
    expect(text(pane())).toContain(`1 of 54`);
    expect((button("Previous conversation", pane())).disabled).toBe(true);
  });

  it("opening from a row keeps focus on that row while the list is drawn (two panels), and All comments returns focus to the row", async () => {
    // happy-dom reports layout boxes for every element, so the list column reads as drawn: the two-panel path. The
    // single-panel path (the list not drawn → focus on All comments) is verified in a browser at 834 and 390.
    const id = SCROLL_CONVERSATIONS[30]?.id ?? "";
    const row = q(`#row-${id}`);
    await click(row);
    expect(q("[data-view]").dataset["view"]).toBe("conversation");
    expect(active()).toBe(row);
    await click(button("All comments"));
    expect(q("[data-view]").dataset["view"]).toBe("list");
    expect(active()).toBe(q(`#row-${id}`));
  });

  it("Reply moves focus to the reply area; Back to the comment returns it to that comment's Reply", async () => {
    await click(q(`#row-${LONG_THREAD_ID}`));
    const replies = buttons(pane()).filter((item) => text(item) === "Reply");
    const deep = replies.at(-1);
    if (deep === undefined) throw new Error("Reply");
    await click(deep);
    expect(active()?.tagName).toBe("H4");
    expect(text(active() ?? container)).toMatch(/^Replying to /);
    await click(button("Back to the comment", pane()));
    expect(active()).toBe(deep);
  });
});
