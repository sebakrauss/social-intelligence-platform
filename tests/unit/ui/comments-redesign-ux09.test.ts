// @vitest-environment happy-dom
/**
 * COMMENTS-UX-09 — final focused remediation of the independent audit (COMMENTS-UX-07/08-FINAL-VERIFY), in the Comments
 * prototype (development only, synthetic data):
 * - M-1: the browser's Back brings the list back with the row that was opened focused AND in view. Chrome re-applies the
 *   scroll it kept for the list's address after the page has drawn the list (and it kept the conversation's position),
 *   so the row is checked again on the next frame; nothing moves when it is in view.
 * - L-2: Period and Filters are nonmodal popovers from 640 px (focus moving on to the page closes them, never trapped)
 *   and sheets over a hidden page on a phone (as Details); focus returns to their control once they are gone.
 * - L-1/L-3/L-4: the phone's Period sheet is the whole window; its options, "Read through…" and "Why some actions…" are
 *   44px targets below 1024 px; the custom range's presets column is as wide as its widest row.
 * - L-5: one full stop between sentences of a navigation announcement.
 * - L-6: an automatic reopen ends the resolution and its timestamp, as a manual Reopen does; history is kept.
 * - L-7: Done read by Resolved uses the resolution's own date, not the received date (and Latest activity stays its own).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEED_ASSIGNMENTS, SEED_LABELS } from "@/app/dev/ui-reference/comments-redesign/fixtures";
import {
  NO_FILTERS,
  SEED_SIM,
  SEED_WORKFLOW,
  audienceWritesAgain,
  dateOf,
  flowOf,
  liveConversations,
  listOf,
  markDone,
  type Period,
  type WorkContext,
} from "@/app/dev/ui-reference/comments-redesign/model";
import { CommentsRedesign } from "@/app/dev/ui-reference/comments-redesign/prototype";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The address as the App Router would hold it: pushes and replacements apply at once. */
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => { nav.search = href.split("?")[1] ?? ""; },
    replace: (href: string) => { nav.search = href.split("?")[1] ?? ""; },
  }),
  usePathname: () => "/dev/ui-reference/comments-redesign",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const ROOT = path.resolve(__dirname, "../../..");
const DIR = path.join(ROOT, "app/dev/ui-reference/comments-redesign");
const css = readFileSync(path.join(DIR, "prototype.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const LABELS = { labels: SEED_LABELS, assignments: SEED_ASSIGNMENTS, nextId: 1 };
const CTX: WorkContext = { labels: LABELS, wf: SEED_WORKFLOW, sim: SEED_SIM, allHealthy: false, target: 240 };
const ZONE = "America/Argentina/Buenos_Aires";
const at = (period: Period) => ({ period, zone: ZONE });
const ids = (list: readonly { readonly id: string }[]): string[] => list.map((item) => item.id);

/* ───────────── model ───────────── */

describe("L-7: Done read by Resolved is the resolution's own date", () => {
  // cv-49 was received on 14 Oct; it is marked Done today (17 Nov): the two dates fall in different months.
  const done = markDone(SEED_WORKFLOW, "manager", "standard", "cv-49", "no_reply_needed", SEED_SIM);
  if (!done.ok) throw new Error(done.reason);
  const ctx = { ...CTX, wf: done.wf };
  const doneIn = (period: Period) => ids(listOf("done", NO_FILTERS, "", "newest", ctx, at(period)));

  it("the resolution date is the simulated Done, not the root comment's date", () => {
    const cv49 = liveConversations(done.wf).find((item) => item.id === "cv-49");
    if (cv49 === undefined) throw new Error("cv-49");
    expect(dateOf(cv49, "received", done.wf)?.startsWith("2026-10-14")).toBe(true);
    expect(dateOf(cv49, "resolved", done.wf)).toBe(flowOf(done.wf, "cv-49").resolvedAt);
    expect(flowOf(done.wf, "cv-49").resolvedAt?.startsWith("2026-11-17")).toBe(true);
  });

  it("Resolved this month lists it and Resolved last month does not; Received says the opposite", () => {
    expect(doneIn({ preset: "this_month", basis: "resolved" })).toContain("cv-49");
    expect(doneIn({ preset: "today", basis: "resolved" })).toContain("cv-49");
    expect(doneIn({ preset: "last_month", basis: "resolved" })).toEqual(["cv-52"]);
    expect(doneIn({ preset: "last_month", basis: "received" })).toEqual(expect.arrayContaining(["cv-49", "cv-52"]));
    expect(doneIn({ preset: "this_month", basis: "received" })).not.toContain("cv-49");
  });

  it("Latest activity stays its own date: a later reply moves it, the received date never", () => {
    const allIn = (period: Period) => ids(listOf("all", NO_FILTERS, "", "newest", CTX, at(period)));
    // cv-50: first comment 28 Oct, follow-up 16 Nov.
    expect(allIn({ preset: "this_month", basis: "activity" })).toContain("cv-50");
    expect(allIn({ preset: "this_month", basis: "received" })).not.toContain("cv-50");
    expect(allIn({ preset: "last_month", basis: "received" })).toContain("cv-50");
  });
});

describe("L-6: an automatic reopen ends the resolution like a manual Reopen; history is kept", () => {
  it("the author writes again on a Done conversation: no resolution, no resolution date, both Done and reopen in history", () => {
    const done = markDone(SEED_WORKFLOW, "manager", "standard", "cv-07", "no_reply_needed", SEED_SIM);
    if (!done.ok) throw new Error(done.reason);
    expect(flowOf(done.wf, "cv-07")).toMatchObject({ status: "done", resolution: "no_reply_needed" });
    const conversation = liveConversations(done.wf).find((item) => item.id === "cv-07");
    if (conversation === undefined) throw new Error("cv-07");
    const reopened = audienceWritesAgain(done.wf, conversation);
    const flow = flowOf(reopened, "cv-07");
    expect(flow.status).toBe("open");
    expect(flow).not.toHaveProperty("resolution");
    expect(flow).not.toHaveProperty("resolvedAt");
    const history = reopened.activity.filter((entry) => entry.conversationId === "cv-07").map((entry) => entry.text);
    expect(history).toEqual(expect.arrayContaining(done.wf.activity.filter((entry) => entry.conversationId === "cv-07").map((entry) => entry.text)));
    expect(reopened.activity.at(-1)).toMatchObject({ by: "Wrenkind", text: expect.stringMatching(/^Reopened automatically: / ) as unknown });
    // No longer Done: it leaves every Resolved period.
    const resolvedToday = ids(listOf("done", NO_FILTERS, "", "newest", { ...CTX, wf: reopened }, at({ preset: "today", basis: "resolved" })));
    expect(resolvedToday).not.toContain("cv-07");
  });

  it("a seeded Done conversation (resolved in October) reopened by a new reply keeps no resolution date either", () => {
    const conversation = liveConversations(SEED_WORKFLOW).find((item) => item.id === "cv-52");
    if (conversation === undefined) throw new Error("cv-52");
    expect(flowOf(SEED_WORKFLOW, "cv-52").resolvedAt).toBeDefined();
    const flow = flowOf(audienceWritesAgain(SEED_WORKFLOW, conversation), "cv-52");
    expect(flow).toEqual({ status: "open" });
  });
});

/* ───────────── stylesheet (the phone sheet, targets, the custom range) ───────────── */

/** The body of the CSS rule whose selector is exactly this, inside one width block. */
function rule(selector: string, scope: "desktop-wide" | "tablet" | "phone"): string {
  const open = scope === "desktop-wide" ? "@media (min-width: 1024px)" : scope === "tablet" ? "@media (max-width: 1023px)" : "@media (max-width: 639px)";
  const from = css.indexOf(open);
  const block = css.slice(from, css.indexOf("\n}\n", from));
  const found = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((match) => (match[1] ?? "").replace(/\s+/g, " ").trim() === selector);
  if (found === undefined) throw new Error(`no rule ${selector} in ${scope}`);
  return found[2] ?? "";
}

describe("L-1, L-3, L-4: the Period sheet, touch targets and the custom range", () => {
  it("L-1: on a phone the Period sheet has no width limit (no strip of the page beside it)", () => {
    expect(rule(".popover.periodMenu", "phone")).toMatch(/max-width:\s*none/);
    expect(rule(".periodMenu", "phone")).toMatch(/position:\s*fixed;[\s\S]*inset:\s*0/);
  });

  it("L-2: on a phone the page under an open Period or Filters sheet is hidden, as under Details", () => {
    expect(rule(".shell:has(.periodMenu, .filterMenu)", "phone")).toMatch(/visibility:\s*hidden/);
    expect(rule(".shell:has(.periodMenu, .filterMenu) :is(.periodMenu, .filterMenu)", "phone")).toMatch(/visibility:\s*visible/);
  });

  it("L-3: period options, Read through and Why some actions… are 44px targets below 1024 px", () => {
    const targets = [...css.slice(css.indexOf("@media (max-width: 1023px)")).matchAll(/([^{}]+)\{\s*min-height:\s*44px;\s*\}/g)].map((match) => (match[1] ?? "").split(",").map((item) => item.trim()));
    const listed = targets.flat();
    for (const selector of [".presetOption", ".coverageSummary", ".disclosureSummary"]) expect(listed, selector).toContain(selector);
  });

  it("L-4: the presets column is as wide as its widest row; the panel widens so the calendar keeps its width", () => {
    expect(rule(".periodCustom > .periodBody", "desktop-wide")).toMatch(/grid-template-columns:\s*max-content minmax\(0, 1fr\)/);
    expect(rule(".popover.periodCustom", "desktop-wide")).toMatch(/width:\s*728px/);
  });
});

/* ───────────── the page ───────────── */

let container: HTMLElement;
let root: Root | undefined;
const frames: FrameRequestCallback[] = [];

async function settle(run: () => void): Promise<void> {
  await act(async () => {
    run();
    await Promise.resolve();
  });
}
/** The browser moved through its history: the address changes, the page renders again. */
async function browse(search: string): Promise<void> {
  nav.search = search;
  await settle(() => { root?.render(h(CommentsRedesign)); });
}
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
const active = (): Element | null => container.ownerDocument.activeElement;
const listed = (): string[] => [...container.querySelectorAll<HTMLButtonElement>("[id^=row-]")].map((button) => button.id.slice(4));
const side = (): HTMLElement => q('nav[aria-label="Comments views"]');
const announced = (): string => text(q('[role="status"][aria-live="polite"]'));
const runFrames = (): Promise<void> => settle(() => { for (const frame of frames.splice(0)) frame(0); });
/** Focus moved from the panel to `next` (as Tab or Shift+Tab would): React reads it from focusout. */
const moveFocus = (from: HTMLElement, next: HTMLElement): Promise<void> =>
  settle(() => {
    next.focus();
    from.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: next }));
  });
const period = (): HTMLElement | null => container.querySelector('[role="dialog"][class*=periodMenu]');
const filters = (): HTMLElement | null => container.querySelector('[role="dialog"][class*=filterMenu]');

beforeEach(async () => {
  nav.search = "";
  frames.length = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await settle(() => { root?.render(h(CommentsRedesign)); });
});

afterEach(async () => {
  await settle(() => { root?.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

describe("M-1: the browser's Back returns to the row — focused and in view", () => {
  async function openThenBrowserBack(): Promise<HTMLButtonElement> {
    const id = listed()[3] ?? "";
    await click(q(`#row-${id}`));
    expect(nav.search).toBe(`conversation=${id}`);
    await browse("");
    const row = q(`#row-${id}`) as HTMLButtonElement;
    expect(active()).toBe(row);
    return row;
  }

  it("the browser then moves the page (its kept scroll): on the next frame the row comes back into view, centred", async () => {
    const scrolled = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
    const row = await openThenBrowserBack();
    scrolled.mockClear();
    // Chrome re-applied the scroll it kept for the list's address: the row is now far below the window.
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ x: 0, y: 2997, top: 2997, bottom: 3069, left: 0, right: 390, width: 390, height: 72, toJSON: () => ({}) });
    vi.spyOn(row.ownerDocument.documentElement, "clientHeight", "get").mockReturnValue(844);
    expect(frames.length).toBeGreaterThan(0);
    await runFrames();
    expect(scrolled.mock.contexts).toContain(row);
    expect(scrolled.mock.calls.at(-1)).toEqual([{ block: "center" }]);
    expect(active()).toBe(row);
  });

  it("nothing moves when the row is already in view, or when focus has moved on before the frame", async () => {
    const scrolled = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
    const row = await openThenBrowserBack();
    scrolled.mockClear();
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ x: 0, y: 300, top: 300, bottom: 372, left: 0, right: 390, width: 390, height: 72, toJSON: () => ({}) });
    vi.spyOn(row.ownerDocument.documentElement, "clientHeight", "get").mockReturnValue(844);
    await runFrames();
    expect(scrolled).not.toHaveBeenCalled();
    // Again, but the person moved on (focus elsewhere) before the frame: their place is not taken away.
    await browse(`conversation=${row.id.slice(4)}`);
    await browse("");
    vi.spyOn(q(`#${row.id}`), "getBoundingClientRect").mockReturnValue({ x: 0, y: 2997, top: 2997, bottom: 3069, left: 0, right: 390, width: 390, height: 72, toJSON: () => ({}) });
    (q('input[type="search"]') as HTMLInputElement).focus();
    scrolled.mockClear();
    await runFrames();
    expect(scrolled).not.toHaveBeenCalled();
  });

  it("the in-app Back keeps doing the same (row focused); browser Forward opens the conversation at its title", async () => {
    const id = listed()[2] ?? "";
    await click(q(`#row-${id}`));
    await click(buttonNamed(q(`#focus-${id}`), "Back"));
    expect(active()).toBe(q(`#row-${id}`));
    await browse(`conversation=${id}`);
    expect(active()).toBe(q(`#pane-${id}`));
  });
});

describe("L-2: Period and Filters — nonmodal beside the list, focus returned when they close", () => {
  it("Period: focus moving on to the page closes it and stays there; its own control, a press on its text, or leaving Comments keep it open", async () => {
    const trigger = q("[class*=periodButton]");
    await click(trigger);
    const dialog = period();
    if (dialog === null) throw new Error("no Period panel");
    const heading = q("h2", dialog);
    expect(active()).toBe(heading);
    // Shift+Tab to its own control: still open.
    await moveFocus(heading, trigger);
    expect(period()).not.toBeNull();
    // A press on text inside it focuses the page's <main>, which holds it: still open.
    await moveFocus(heading, q("#comments-main"));
    expect(period()).not.toBeNull();
    // Focus to something outside Comments (a development tool, the browser): still open.
    const outside = document.createElement("button");
    document.body.append(outside);
    await moveFocus(heading, outside);
    expect(period()).not.toBeNull();
    outside.remove();
    // Tab on to the search field: the panel closes and focus stays on the search field.
    const searchField = q('input[type="search"]');
    await moveFocus(heading, searchField);
    expect(period()).toBeNull();
    expect(active()).toBe(searchField);
  });

  it("Period: Escape and Cancel close it and return focus to its control (after it is gone)", async () => {
    const trigger = q("[class*=periodButton]");
    await click(trigger);
    await settle(() => { q("h2", period() ?? container).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(period()).toBeNull();
    expect(active()).toBe(trigger);
    await click(trigger);
    await click(buttonNamed(period() ?? container, "Cancel"));
    expect(period()).toBeNull();
    expect(active()).toBe(trigger);
  });

  it("Filters: focus back on Filters keeps it open; moving on closes it without taking focus back; × returns focus", async () => {
    const trigger = q("button[class*=filtersButton]");
    await click(trigger);
    const heading = q("h2", filters() ?? container);
    await moveFocus(heading, trigger);
    expect(filters()).not.toBeNull();
    const sort = [...container.querySelectorAll<HTMLSelectElement>('[role="search"] select')].find((item) => item.labels[0]?.textContent === "Sort");
    if (sort === undefined) throw new Error("sort");
    await moveFocus(heading, sort);
    expect(filters()).toBeNull();
    expect(active()).toBe(sort);
    await click(trigger);
    await click(q('[aria-label="Close filters"]'));
    expect(filters()).toBeNull();
    expect(active()).toBe(trigger);
  });
});

describe("L-5: one full stop between the sentences of a navigation announcement", () => {
  it("leaving a list whose selection isn't in the next one, with a filter set: two sentences, never '..'", async () => {
    const platform = [...container.querySelectorAll<HTMLSelectElement>('[role="search"] select')].find((item) => item.labels[0]?.textContent === "Platform");
    if (platform === undefined) throw new Error("platform");
    await settle(() => {
      platform.value = "facebook";
      platform.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const id = listed()[0] ?? "";
    await click(q(`#row-${id}`));
    const label = SEED_LABELS.find((item) => !(SEED_ASSIGNMENTS[id] ?? []).includes(item.id));
    if (label === undefined) throw new Error("label");
    await click(buttonNamed(side(), label.name));
    expect(announced()).toContain("nothing is selected. Search and filters from the previous list were cleared.");
    expect(announced()).not.toContain("..");
    expect(announced().endsWith(".")).toBe(true);
  });
});
