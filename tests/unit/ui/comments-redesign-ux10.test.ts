// @vitest-environment happy-dom
/**
 * COMMENTS-UX-10 — navigation consistency and keyboard focus (Comments prototype; development only, synthetic data).
 *
 * A. Once navigation settles, the address, the open conversation and the selected row always agree — also when a person
 *    acts before the previous navigation has committed. The router here behaves as the App Router does (Next 16.4.5,
 *    client/components/app-router-instance.js): a new navigation — push, replace, Back or Forward — DISCARDS the one
 *    still pending ("so the state is never applied"), and a history entry is written only when a navigation commits
 *    (a push to the address already shown adds no entry). Back and Forward fire popstate and restore the entry in one
 *    go — also onto an entry whose address is the same as the one left (R-5).
 * B. The Period control and its panel are one group: focus moving on from the group closes the panel (keeping the
 *    period); Escape anywhere in it closes the panel and returns focus to the control; Escape with focus fallen to the
 *    page (a phone sheet's last stop) closes the Period and Filters sheets.
 */
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentsRedesign } from "@/app/dev/ui-reference/comments-redesign/prototype";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Browser history + the App Router's single pending navigation. `hold` keeps navigations pending until commit(). */
const router = vi.hoisted(() => {
  const state = {
    entries: [""] as string[],
    index: 0,
    pending: undefined as { readonly search: string; readonly how: "push" | "replace" } | undefined,
    hold: false,
    requests: [] as string[],
    get search(): string {
      return state.entries[state.index] ?? "";
    },
    request(href: string, how: "push" | "replace"): void {
      state.requests.push(`${how} ${href}`);
      state.pending = { search: href.split("?")[1] ?? "", how }; // a newer navigation discards the pending one
      if (!state.hold) state.commit();
    },
    commit(): void {
      const next = state.pending;
      state.pending = undefined;
      if (next === undefined) return;
      if (next.how === "replace" || next.search === state.search) state.entries[state.index] = next.search;
      else {
        state.entries = [...state.entries.slice(0, state.index + 1), next.search];
        state.index += 1;
      }
    },
    /** Back/Forward: discards the pending navigation, moves through the entries actually written. */
    go(step: number): void {
      state.pending = undefined;
      state.index = Math.min(state.entries.length - 1, Math.max(0, state.index + step));
    },
  };
  return state;
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => { router.request(href, "push"); },
    replace: (href: string) => { router.request(href, "replace"); },
  }),
  usePathname: () => "/dev/ui-reference/comments-redesign",
  useSearchParams: () => new URLSearchParams(router.search),
}));

let container: HTMLElement;
let root: Root | undefined;

async function settle(run: () => void): Promise<void> {
  await act(async () => {
    run();
    await Promise.resolve();
  });
}
const rerender = (): Promise<void> => settle(() => { root?.render(h(CommentsRedesign)); });
/** The pending navigation commits (the router's request finished). */
const commit = async (): Promise<void> => {
  router.commit();
  await rerender();
};
/**
 * Back/Forward as the browser does it: popstate fires and the App Router restores the entry. `order`: the page's own
 * popstate update renders first, while the router still gives the address being left (as in the browser, where the
 * restore is a transition), or both render together.
 */
let order: "popstate first" | "together" = "popstate first";
const traverse = async (step: number): Promise<void> => {
  if (order === "popstate first") {
    await settle(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    await settle(() => {
      router.go(step);
      root?.render(h(CommentsRedesign));
    });
    return;
  }
  await settle(() => {
    router.go(step);
    window.dispatchEvent(new PopStateEvent("popstate"));
    root?.render(h(CommentsRedesign));
  });
};
const back = (): Promise<void> => traverse(-1);
const forward = (): Promise<void> => traverse(1);
const q = (selector: string, scope: ParentNode = container): HTMLElement => {
  const found = scope.querySelector(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`not found: ${selector}`);
  return found;
};
const text = (element: Element): string => element.textContent.replace(/\s+/g, " ").trim();
const buttonNamed = (scope: ParentNode, name: string): HTMLButtonElement => {
  const found = [...scope.querySelectorAll("button")].find((button) => text(button).startsWith(name));
  if (found === undefined) throw new Error(`no button "${name}"`);
  return found;
};
const click = (element: HTMLElement): Promise<void> => settle(() => { element.click(); });
const open = (id: string): Promise<void> => click(q(`#row-${id}`));
const listed = (): string[] => [...container.querySelectorAll<HTMLButtonElement>("[id^=row-]")].map((button) => button.id.slice(4));
const side = (): HTMLElement => q('nav[aria-label="Comments views"]');
const active = (): Element | null => container.ownerDocument.activeElement;

/** The settled state: the address's conversation, the conversation shown and the selected row are one and the same. */
function agreed(): string | null {
  const address = new URLSearchParams(router.search).get("conversation");
  const shown = container.querySelector("[id^=focus-]")?.id.slice(6) ?? null;
  const selected = container.querySelector("[aria-current=true][id^=row-]")?.id.slice(4) ?? null;
  expect({ shown, selected }, `address ${String(address)}`).toEqual({ shown: address, selected: address });
  return address;
}

beforeEach(async () => {
  Object.assign(router, { entries: [""], index: 0, pending: undefined, hold: false, requests: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await rerender();
});

afterEach(async () => {
  await settle(() => { root?.unmount(); });
  container.remove();
});

describe.each(["popstate first", "together"] as const)("A: the address and the selection agree once navigation settles (%s)", (sequence) => {
  beforeEach(() => {
    order = sequence;
  });

  it("R-1: Back before a pending conversation's address commits, then Back/Forward again — and that conversation later", async () => {
    const [a, b, c] = listed() as [string, string, string];
    await open(a);
    expect(agreed()).toBe(a);
    router.hold = true;
    await open(b); // B's address is still on its way…
    await back(); // …and Back overtakes it: the router discards B (it never gets a history entry)
    expect(agreed()).toBeNull();
    await forward();
    expect(agreed()).toBe(a);
    await back();
    expect(agreed()).toBeNull();
    // B, opened again normally, is followed through Back and Forward like any other step (no stale record of the
    // request that was discarded may make the page ignore it).
    router.hold = false;
    await open(b);
    expect(agreed()).toBe(b);
    await back();
    expect(agreed()).toBeNull();
    await forward();
    expect(agreed()).toBe(b);
    await open(c);
    await back();
    expect(agreed()).toBe(b);
    await back();
    expect(agreed()).toBeNull();
    await forward();
    expect(agreed()).toBe(b);
  });

  it("R-2: Reset data right after opening a conversation asks for the list even though the list's address is still the committed one", async () => {
    const [a] = listed() as [string];
    router.hold = true;
    await open(a);
    await click(buttonNamed(container, "Reset data"));
    expect(router.requests.at(-1)).toBe("replace /dev/ui-reference/comments-redesign");
    await commit();
    expect(agreed()).toBeNull();
    expect(router.entries).toEqual([""]);
  });

  it("R-3: another view right after opening a conversation — Done (it isn't there) clears both; All conversations (it is) keeps both", async () => {
    const [a] = listed() as [string];
    router.hold = true;
    await open(a);
    await click(buttonNamed(side(), "Done"));
    await commit();
    expect(agreed()).toBeNull();
    await click(buttonNamed(side(), "Open"));
    const [b] = listed() as [string];
    await open(b);
    await click(buttonNamed(side(), "All conversations"));
    await commit();
    expect(agreed()).toBe(b);
  });

  it("R-4: the in-app Back right after opening (and opening right after the in-app Back) settles on what was chosen last", async () => {
    const [a, b] = listed() as [string, string];
    router.hold = true;
    await open(a);
    await click(buttonNamed(q(`#focus-${a}`), "Back"));
    await commit();
    expect(agreed()).toBeNull();
    expect(active()).toBe(q(`#row-${a}`));
    await open(a);
    await commit();
    expect(agreed()).toBe(a);
    await click(buttonNamed(q(`#focus-${a}`), "Back"));
    await open(b);
    await commit();
    expect(agreed()).toBe(b);
    await back();
    expect(agreed()).toBe(a);
  });

  it("rapid consecutive selections: only the last commits; Back and Forward then move through the steps actually written", async () => {
    const [a, b, c] = listed() as [string, string, string];
    router.hold = true;
    await open(a);
    await open(b);
    await open(c);
    await commit();
    expect(agreed()).toBe(c);
    expect(router.entries).toEqual(["", `conversation=${c}`]);
    for (let round = 0; round < 3; round++) {
      await back();
      expect(agreed()).toBeNull();
      await forward();
      expect(agreed()).toBe(c);
    }
  });

  it("R-5: Back onto a list entry with the same address (after Reset data) while a conversation's request is pending shows the list", async () => {
    const [a, b] = listed() as [string, string];
    await open(a);
    await click(buttonNamed(container, "Reset data")); // a's entry becomes the list's: two list entries side by side
    expect(router.entries).toEqual(["", ""]);
    expect(agreed()).toBeNull();
    router.hold = true;
    await open(b); // b's address is still on its way…
    await back(); // …Back discards it and lands on the other list entry: the address does not change
    expect(router.search).toBe("");
    expect(agreed()).toBeNull();
    await rerender(); // and it stays that way (no later change repairs a mismatch)
    expect(agreed()).toBeNull();
    await forward();
    expect(agreed()).toBeNull();
    router.hold = false;
    await open(b);
    expect(agreed()).toBe(b);
    await back();
    expect(agreed()).toBeNull();
    await forward();
    expect(agreed()).toBe(b);
  });

  it("R-5: the same after switching to a view that does not hold the conversation and back to Open", async () => {
    const [a, b] = listed() as [string, string];
    await open(a);
    await click(buttonNamed(side(), "Done")); // a isn't Done: its entry is replaced by the list's
    await click(buttonNamed(side(), "Open"));
    expect(router.entries).toEqual(["", ""]);
    router.hold = true;
    await open(b);
    await back();
    expect(agreed()).toBeNull();
    expect(active()).toBe(q(`#row-${b}`));
    await rerender();
    expect(agreed()).toBeNull();
  });

  it("R-5: one popstate listener per page, kept across renders and removed when the page goes", async () => {
    await settle(() => { root?.unmount(); });
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const popstate = (spy: typeof added): unknown[] => spy.mock.calls.filter((call) => call[0] === "popstate").map((call) => call[1]);
    root = createRoot(container);
    await rerender();
    const [a] = listed() as [string];
    await open(a);
    await back();
    await rerender();
    expect(popstate(added)).toHaveLength(1);
    expect(popstate(removed)).toHaveLength(0);
    await settle(() => { root?.unmount(); });
    expect(popstate(removed)).toEqual(popstate(added));
    root = undefined;
    added.mockRestore();
    removed.mockRestore();
  });

  it("an address that differs from what the page shows is always followed — so even a late address could not leave a mismatch", async () => {
    const [a, b] = listed() as [string, string];
    await open(a);
    await open(b);
    // Not a sequence the App Router produces (it discards superseded navigations), but whatever the address says once
    // it changes, the page shows the same.
    router.entries[router.index] = `conversation=${a}`;
    await rerender();
    expect(agreed()).toBe(a);
    router.entries[router.index] = "";
    await rerender();
    expect(agreed()).toBeNull();
  });
});

/* ───────────── B: the Period group and the sheets' Escape ───────────── */

const period = (): HTMLElement | null => container.querySelector('[role="dialog"][class*=periodMenu]');
const filters = (): HTMLElement | null => container.querySelector('[role="dialog"][class*=filterMenu]');
/** Focus moved from `from` to `next` (as Tab or Shift+Tab would): React reads it from focusout. */
const moveFocus = (from: HTMLElement, next: HTMLElement): Promise<void> =>
  settle(() => {
    next.focus();
    from.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: next }));
  });
const escapeOn = (target: HTMLElement): Promise<void> => settle(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });

describe("B: the Period control and its panel are one group", () => {
  it("Shift+Tab from the panel to its control keeps it open; on from the control to an earlier one closes it, period unchanged", async () => {
    const trigger = q("[class*=periodButton]");
    const before = text(trigger);
    await click(trigger);
    const heading = q("h2", period() ?? container);
    await moveFocus(heading, trigger);
    expect(period()).not.toBeNull();
    const earlier = q('input[type="search"]');
    await moveFocus(trigger, earlier);
    expect(period()).toBeNull();
    expect(active()).toBe(earlier);
    expect(text(trigger)).toBe(before);
  });

  it("Escape with focus on the control (panel open) closes the panel and keeps focus on the control", async () => {
    const trigger = q("[class*=periodButton]");
    await click(trigger);
    await moveFocus(q("h2", period() ?? container), trigger);
    await escapeOn(trigger);
    expect(period()).toBeNull();
    expect(active()).toBe(trigger);
  });

  it("Escape inside the panel, Cancel and Apply each close it and return focus to the control", async () => {
    const trigger = q("[class*=periodButton]");
    await click(trigger);
    await escapeOn(q("h2", period() ?? container));
    expect([period(), active()]).toEqual([null, trigger]);
    await click(trigger);
    await click(buttonNamed(period() ?? container, "Cancel"));
    expect([period(), active()]).toEqual([null, trigger]);
    await click(trigger);
    await click(buttonNamed(period() ?? container, "Apply"));
    expect([period(), active()]).toEqual([null, trigger]);
  });

  it("Escape with focus fallen to the page closes the Period and the Filters sheets (focus back on their controls)", async () => {
    const trigger = q("[class*=periodButton]");
    await click(trigger);
    await settle(() => { (container.ownerDocument.activeElement as HTMLElement | null)?.blur(); });
    await escapeOn(container.ownerDocument.body);
    expect([period(), active()]).toEqual([null, trigger]);
    const filtersButton = q("button[class*=filtersButton]");
    await click(filtersButton);
    expect(filters()).not.toBeNull();
    await settle(() => { (container.ownerDocument.activeElement as HTMLElement | null)?.blur(); });
    await escapeOn(container.ownerDocument.body);
    expect([filters(), active()]).toEqual([null, filtersButton]);
    // Focus on anything else outside Comments (a development tool's control, say) is the same.
    const outside = document.createElement("button");
    document.body.append(outside);
    await click(trigger);
    await settle(() => { outside.focus(); });
    await escapeOn(outside);
    expect([period(), active()]).toEqual([null, trigger]);
    outside.remove();
  });
});
