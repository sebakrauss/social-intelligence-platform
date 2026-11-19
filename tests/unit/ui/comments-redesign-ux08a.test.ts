// @vitest-environment happy-dom
/**
 * COMMENTS-UX-08A — date periods and the filtering hierarchy in the Comments prototype (development only, synthetic
 * data, nothing queried or stored):
 * - one period per list, beside its title: presets, or a custom range typed or picked on the calendar; Apply commits,
 *   Cancel / Escape discard; the Filters menu has no date any more;
 * - a period reads one named date — Received (the root comment), Latest activity (what Wrenkind has read) or, in Done,
 *   Resolved — in the workspace's days (a configurable time-zone assumption);
 * - defaults: operational views at All dates (older unresolved work stays visible), Done at This month by resolution,
 *   All conversations and a label's own list at This month by received date;
 * - a period chooses which conversations enter a list, never which comments of one are shown, and never reorders;
 * - counters: the sidebar counts the work at all dates; a list's count names its period;
 * - search looks in the list's period and offers all dates; a conversation left out is named, with the way back.
 */
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONVERSATIONS, SEED_ASSIGNMENTS, SEED_LABELS } from "@/app/dev/ui-reference/comments-redesign/fixtures";
import {
  ALL_DATES,
  DEFAULT_ZONE,
  NO_FILTERS,
  SEED_SIM,
  SEED_WORKFLOW,
  activeFilters,
  addMonths,
  calendarMove,
  dateNote,
  dayKey,
  defaultPeriod,
  flowOf,
  listOf,
  markDone,
  menuFilterCount,
  monthGrid,
  parseDay,
  periodPhrase,
  pickDay,
  rangeOf,
  rangeProblem,
  rangeText,
  reopenConversation,
  todayOf,
  viewCounts,
  withFilter,
  type Period,
  type When,
  type WorkContext,
} from "@/app/dev/ui-reference/comments-redesign/model";
import { CommentsRedesign } from "@/app/dev/ui-reference/comments-redesign/prototype";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => "/dev/ui-reference/comments-redesign",
  useSearchParams: () => new URLSearchParams(""),
}));

const LABELS = { labels: SEED_LABELS, assignments: SEED_ASSIGNMENTS, nextId: 1 };
const CTX: WorkContext = { labels: LABELS, wf: SEED_WORKFLOW, sim: SEED_SIM, allHealthy: false, target: 240 };
const TODAY = todayOf(SEED_WORKFLOW, DEFAULT_ZONE);
const at = (period: Period, zone: string = DEFAULT_ZONE): When => ({ period, zone });
const ids = (list: readonly { readonly id: string }[]): string[] => list.map((item) => item.id);
const THIS_MONTH: Period = { preset: "this_month", basis: "received" };
const LAST_MONTH: Period = { preset: "last_month", basis: "received" };

/* ───────────── the rules (pure) ───────────── */

describe("periods: the days each preset covers, in the workspace's days", () => {
  it("on the synthetic today (17 Nov 2026, Buenos Aires)", () => {
    expect(TODAY).toBe("2026-11-17");
    const range = (preset: Period["preset"]) => rangeOf({ preset, basis: "received" }, TODAY);
    expect(range("all")).toBeUndefined();
    expect(range("today")).toEqual({ from: "2026-11-17", to: "2026-11-17" });
    expect(range("yesterday")).toEqual({ from: "2026-11-16", to: "2026-11-16" });
    expect(range("last_7")).toEqual({ from: "2026-11-11", to: "2026-11-17" });
    expect(range("last_30")).toEqual({ from: "2026-10-19", to: "2026-11-17" });
    expect(range("this_month")).toEqual({ from: "2026-11-01", to: "2026-11-17" });
    expect(range("last_month")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(rangeOf({ preset: "custom", basis: "received", from: "2026-10-05", to: "2026-10-09" }, TODAY)).toEqual({ from: "2026-10-05", to: "2026-10-09" });
  });

  it("across a year boundary, a leap February and short months", () => {
    expect(rangeOf(LAST_MONTH, "2026-01-05")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(rangeOf(THIS_MONTH, "2026-01-05")).toEqual({ from: "2026-01-01", to: "2026-01-05" });
    expect(rangeOf({ preset: "last_30", basis: "received" }, "2026-01-05")).toEqual({ from: "2025-12-07", to: "2026-01-05" });
    expect(rangeOf({ preset: "yesterday", basis: "received" }, "2026-01-01")).toEqual({ from: "2025-12-31", to: "2025-12-31" });
    expect(rangeOf(LAST_MONTH, "2028-03-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(rangeText({ from: "2025-12-28", to: "2026-01-03" })).toBe("28 Dec 2025 – 3 Jan 2026");
    expect(rangeText({ from: "2026-10-28", to: "2026-11-03" })).toBe("28 Oct – 3 Nov 2026");
    expect(rangeText({ from: "2026-11-01", to: "2026-11-17" })).toBe("1–17 Nov 2026");
  });

  it("the same moment is a different day, month or year depending on the workspace's time zone", () => {
    const monthEdge = CONVERSATIONS.find((item) => item.id === "cv-53")?.comments[0]?.at ?? "";
    const yearEdge = CONVERSATIONS.find((item) => item.id === "cv-54")?.comments[0]?.at ?? "";
    expect(monthEdge).toBe("2026-11-01T01:30:00Z");
    expect(dayKey(monthEdge, "America/Argentina/Buenos_Aires")).toBe("2026-10-31");
    expect(dayKey(monthEdge, "UTC")).toBe("2026-11-01");
    expect(dayKey(yearEdge, "America/Argentina/Buenos_Aires")).toBe("2025-12-31");
    expect(dayKey(yearEdge, "UTC")).toBe("2026-01-01");
    expect(dayKey("2026-11-17T16:00:00Z", "Asia/Tokyo")).toBe("2026-11-18");
  });

  it("each list starts at its own period; Resolved is Done's", () => {
    for (const view of ["attention", "open", "mine", "escalated"] as const) expect(defaultPeriod(view, false)).toEqual({ preset: "all", basis: "received" });
    expect(defaultPeriod("done", false)).toEqual({ preset: "this_month", basis: "resolved" });
    expect(defaultPeriod("all", false)).toEqual(THIS_MONTH);
    expect(defaultPeriod("all", true)).toEqual(THIS_MONTH);
  });
});

describe("periods over the synthetic conversations (the UX-08A cases)", () => {
  it("received last month and still open: listed in the operational views at All dates, absent from All conversations this month", () => {
    expect(ids(listOf("attention", NO_FILTERS, "", "attention", CTX))).toContain("cv-49");
    expect(ids(listOf("open", NO_FILTERS, "", "attention", CTX, at(defaultPeriod("open", false))))).toContain("cv-49");
    expect(ids(listOf("all", NO_FILTERS, "", "newest", CTX, at(THIS_MONTH)))).not.toContain("cv-49");
    expect(ids(listOf("all", NO_FILTERS, "", "newest", CTX, at(LAST_MONTH)))).toContain("cv-49");
  });

  it("received last month with activity this month: the date the period reads decides", () => {
    expect(ids(listOf("all", NO_FILTERS, "", "newest", CTX, at(THIS_MONTH)))).not.toContain("cv-50");
    expect(ids(listOf("all", NO_FILTERS, "", "newest", CTX, at({ preset: "this_month", basis: "activity" })))).toContain("cv-50");
    expect(ids(listOf("all", NO_FILTERS, "", "newest", CTX, at(LAST_MONTH)))).toContain("cv-50");
    expect(ids(listOf("all", NO_FILTERS, "", "newest", CTX, at({ preset: "last_month", basis: "activity" })))).not.toContain("cv-50");
    // The row says the date the period read when it isn't the day of the row's own time.
    const conversation = CONVERSATIONS.find((item) => item.id === "cv-50");
    if (conversation === undefined) throw new Error("cv-50");
    expect(dateNote(conversation, LAST_MONTH, SEED_WORKFLOW, DEFAULT_ZONE)).toBe("Received 28 Oct 2026");
    expect(dateNote(conversation, { preset: "last_month", basis: "activity" }, SEED_WORKFLOW, DEFAULT_ZONE)).toBeUndefined();
    expect(dateNote(conversation, ALL_DATES.period, SEED_WORKFLOW, DEFAULT_ZONE)).toBeUndefined();
  });

  it("a period never removes an older comment from a conversation that entered, and never reorders the list", () => {
    const listed = listOf("all", NO_FILTERS, "", "newest", CTX, at({ preset: "this_month", basis: "activity" })).find((item) => item.id === "cv-50");
    expect(listed?.comments.map((comment) => comment.at)).toEqual(["2026-10-28T19:40:00Z", "2026-10-28T20:10:00Z", "2026-11-16T12:15:00Z"]);
    const everything = ids(listOf("all", NO_FILTERS, "", "oldest", CTX));
    const month = ids(listOf("all", NO_FILTERS, "", "oldest", CTX, at(THIS_MONTH)));
    expect(month).toEqual(everything.filter((id) => month.includes(id)));
  });

  it("two conversations on the same post keep their own labels; one with several labels is in each label's list", () => {
    const post8 = CONVERSATIONS.filter((item) => item.postId === "post-8").map((item) => item.id);
    expect(post8).toEqual(expect.arrayContaining(["cv-49", "cv-51"]));
    const labelList = (labelId: string, period: Period) => ids(listOf("all", withFilter(NO_FILTERS, "label", labelId), "", "newest", CTX, at(period)));
    expect(labelList("lbl-wholesale", LAST_MONTH)).toEqual(["cv-49"]);
    expect(labelList("lbl-delivery", THIS_MONTH)).toContain("cv-51");
    expect(labelList("lbl-delivery", THIS_MONTH)).not.toContain("cv-49");
    for (const labelId of SEED_ASSIGNMENTS["cv-19"] ?? []) expect(labelList(labelId, ALL_DATES.period)).toContain("cv-19");
    expect(SEED_ASSIGNMENTS["cv-19"]?.length).toBeGreaterThan(1);
  });

  it("resolved in an earlier month: Done reads the resolution date (This month by default)", () => {
    expect(flowOf(SEED_WORKFLOW, "cv-52")).toMatchObject({ status: "done", resolvedAt: "2026-10-02T14:30:00Z" });
    expect(ids(listOf("done", NO_FILTERS, "", "newest", CTX, at(defaultPeriod("done", false))))).not.toContain("cv-52");
    expect(ids(listOf("done", NO_FILTERS, "", "newest", CTX, at({ preset: "last_month", basis: "resolved" })))).toEqual(["cv-52"]);
    expect(ids(listOf("done", NO_FILTERS, "", "newest", CTX))).toContain("cv-52");
    // A conversation marked Done now is resolved today; reopening removes the date (an Open one is never Resolved).
    const done = markDone(SEED_WORKFLOW, "manager", "standard", "cv-07", "no_reply_needed", SEED_SIM);
    if (!done.ok) throw new Error(done.reason);
    const resolvedToday = (wf: typeof SEED_WORKFLOW) => ids(listOf("done", NO_FILTERS, "", "newest", { ...CTX, wf }, at({ preset: "today", basis: "resolved" })));
    expect(resolvedToday(SEED_WORKFLOW)).not.toContain("cv-07");
    expect(resolvedToday(done.wf)).toContain("cv-07");
    const reopened = reopenConversation(done.wf, "manager", "cv-07");
    if (!reopened.ok) throw new Error(reopened.reason);
    expect(flowOf(reopened.wf, "cv-07").resolvedAt).toBeUndefined();
  });

  it("no result within a period is a real zero, not an error", () => {
    expect(listOf("all", NO_FILTERS, "", "newest", CTX, at({ preset: "custom", basis: "received", from: "2026-09-01", to: "2026-09-30" }))).toHaveLength(0);
  });

  it("month and year boundaries follow the workspace's time zone", () => {
    const thisMonth = (zone: string) => ids(listOf("all", NO_FILTERS, "", "newest", CTX, at(THIS_MONTH, zone)));
    expect(thisMonth("America/Argentina/Buenos_Aires")).not.toContain("cv-53");
    expect(thisMonth("UTC")).toContain("cv-53");
    const december: Period = { preset: "custom", basis: "received", from: "2025-12-01", to: "2025-12-31" };
    expect(ids(listOf("all", NO_FILTERS, "", "newest", CTX, at(december, "America/Argentina/Buenos_Aires")))).toEqual(["cv-54"]);
    expect(ids(listOf("all", NO_FILTERS, "", "newest", CTX, at(december, "UTC")))).toEqual([]);
    expect(ids(listOf("done", NO_FILTERS, "", "newest", CTX, at({ preset: "custom", basis: "resolved", from: "2026-01-01", to: "2026-01-01" }, "UTC")))).toEqual(["cv-54"]);
  });

  it("the sidebar's counts are the work at all dates, whatever period a list shows", () => {
    const counts = viewCounts(CTX);
    expect(counts.attention).toBe(listOf("attention", NO_FILTERS, "", "attention", CTX, ALL_DATES).length);
    expect(counts.attention).toBeGreaterThan(listOf("attention", NO_FILTERS, "", "attention", CTX, at(THIS_MONTH)).length);
    expect(counts.all).toBe(CONVERSATIONS.length);
    expect(periodPhrase(ALL_DATES.period, TODAY)).toBe("all dates");
    expect(periodPhrase(THIS_MONTH, TODAY)).toBe("received 1–17 Nov 2026");
  });

  it("the Filters menu holds no date: a period is the one place a list is narrowed by date", () => {
    const filters = withFilter(withFilter(NO_FILTERS, "source", "paid"), "assignee", "m-ana");
    expect(menuFilterCount(filters)).toBe(2);
    expect(activeFilters(filters, LABELS).map((chip) => chip.name)).not.toContain("Date");
    expect(Object.keys(NO_FILTERS)).toEqual(["accounts"]);
  });
});

describe("a custom range: typed days, validation and the calendar's keyboard", () => {
  it("typed days must exist and be in order", () => {
    expect(parseDay("2026-10-01")).toBe("2026-10-01");
    expect(parseDay(" 2028-02-29 ")).toBe("2028-02-29");
    for (const bad of ["2026-02-30", "2026-13-01", "01/10/2026", "2026-1-1", "yesterday", ""]) expect(parseDay(bad), bad).toBeUndefined();
    expect(rangeProblem("", "2026-10-31")).toEqual({ field: "from", text: "Enter a start date." });
    expect(rangeProblem("2026-02-30", "2026-10-31")?.field).toBe("from");
    expect(rangeProblem("2026-10-01", "")).toEqual({ field: "to", text: "Enter an end date." });
    expect(rangeProblem("2026-10-31", "2026-10-01")).toEqual({ field: "to", text: "The end date is before the start date." });
    expect(rangeProblem("2026-10-01", "2026-10-01")).toBeUndefined();
  });

  it("the calendar draws Monday-first weeks and moves as the WAI-ARIA date picker grid does", () => {
    const november = monthGrid("2026-11-01");
    expect(november[0]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, "2026-11-01"]);
    expect(november.at(-1)?.[0]).toBe("2026-11-30");
    const move = (key: string, name: string, shift = false) => calendarMove("2026-11-17", { key: name, shift }) ?? key;
    expect(move("", "ArrowRight")).toBe("2026-11-18");
    expect(move("", "ArrowLeft")).toBe("2026-11-16");
    expect(move("", "ArrowDown")).toBe("2026-11-24");
    expect(move("", "ArrowUp")).toBe("2026-11-10");
    expect(move("", "Home")).toBe("2026-11-16");
    expect(move("", "End")).toBe("2026-11-22");
    expect(move("", "PageDown")).toBe("2026-12-17");
    expect(move("", "PageUp", true)).toBe("2025-11-17");
    expect(calendarMove("2026-11-17", { key: "Tab", shift: false })).toBeUndefined();
  });

  it("the first pick starts a range, the second ends it; an earlier day starts it again", () => {
    expect(pickDay({}, "2026-10-05")).toEqual({ from: "2026-10-05" });
    expect(pickDay({ from: "2026-10-05" }, "2026-10-09")).toEqual({ from: "2026-10-05", to: "2026-10-09" });
    expect(pickDay({ from: "2026-10-05" }, "2026-10-01")).toEqual({ from: "2026-10-01" });
    expect(pickDay({ from: "2026-10-05", to: "2026-10-09" }, "2026-10-20")).toEqual({ from: "2026-10-20" });
  });
});

/* ───────────── the page ───────────── */

let container: HTMLElement;
let root: Root | undefined;

async function settle(run: () => void): Promise<void> {
  await act(async () => {
    run();
    await Promise.resolve();
  });
}
const q = (selector: string, scope: ParentNode = container): HTMLElement => {
  const found = scope.querySelector(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`not found: ${selector}`);
  return found;
};
const text = (element: Element): string => element.textContent.replace(/\s+/g, " ").trim();
const buttonNamed = (scope: ParentNode, name: string): HTMLButtonElement => {
  const found = [...scope.querySelectorAll("button")].find((button) => text(button).startsWith(name) || button.getAttribute("aria-label") === name);
  if (found === undefined) throw new Error(`no button "${name}"`);
  return found;
};
const click = (element: HTMLElement): Promise<void> => settle(() => { element.click(); });
const key = (element: Element, name: string, shift = false): Promise<void> => settle(() => element.dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey: shift, bubbles: true, cancelable: true })));
async function type(element: HTMLInputElement, value: string): Promise<void> {
  const proto = Object.getPrototypeOf(element) as object;
  await settle(() => {
    Reflect.set(proto, "value", value, element);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function pick(select: HTMLSelectElement, value: string): Promise<void> {
  await settle(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const listed = (): string[] => [...container.querySelectorAll<HTMLButtonElement>("[id^=row-]")].map((button) => button.id.slice(4));
const active = (): Element | null => container.ownerDocument.activeElement;
const announced = (): string => text(q('[role="status"][aria-live="polite"]'));
const side = (): HTMLElement => q('nav[aria-label="Comments views"]');
const listCount = (): string => text(q("#list-count"));
const periodButton = (): HTMLButtonElement => q("[class*=periodButton]") as HTMLButtonElement;
const dialog = (): HTMLElement => q('[role="dialog"][class*=periodMenu]');
const radio = (scope: HTMLElement, name: string): HTMLInputElement => {
  const found = [...scope.querySelectorAll("label")].find((label) => text(label).startsWith(name))?.querySelector("input");
  if (!(found instanceof HTMLInputElement)) throw new Error(`no option "${name}"`);
  return found;
};
async function applyPeriod(preset: string, basis?: string): Promise<void> {
  await click(periodButton());
  if (basis !== undefined) await click(radio(dialog(), basis));
  await click(radio(dialog(), preset));
  await click(buttonNamed(dialog(), "Apply"));
}

beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await settle(() => { root?.render(h(CommentsRedesign)); });
  // UX-08B: the page opens on Open (the approved Phase 1 landing; see comments-redesign-ux08b.test.ts). These scenarios
  // were written in Needs attention and start there, chosen in the sidebar as a person would.
  await click(buttonNamed(side(), "Needs attention"));
});

afterEach(async () => {
  await settle(() => { root?.unmount(); });
  container.remove();
});

describe("the hierarchy: views of work, All conversations, then labels", () => {
  it("only the operational views carry a count, and the sidebar says it counts all dates", () => {
    const names = [...side().querySelectorAll("button")].map(text);
    expect(names.slice(0, 6)).toEqual([expect.stringMatching(/^Open\d+$/), expect.stringMatching(/^Needs attention\d+$/), expect.stringMatching(/^Assigned to me\d+$/), expect.stringMatching(/^Escalated\d+$/), "Done", "All conversations"]);
    for (const label of SEED_LABELS) expect(names).toContain(label.name);
    expect(text(side())).toContain("Counts include all dates");
  });

  it("an operational view starts at All dates and keeps older open work; All conversations starts at This month", async () => {
    expect(text(periodButton())).toContain("All dates");
    expect(listCount()).toMatch(/^\d+ conversations · all dates$/);
    expect(listed()).toContain("cv-49");
    await click(buttonNamed(side(), "All conversations"));
    expect(text(q("h1"))).toBe("All conversations");
    expect(text(periodButton())).toContain("This month");
    expect(listCount()).toBe(`${String(listOf("all", NO_FILTERS, "", "attention", CTX, at(THIS_MONTH)).length)} conversations · received 1–17 Nov 2026`);
    expect(container.querySelector("#row-cv-49")).toBeNull();
    await click(buttonNamed(side(), "Open"));
    expect(text(periodButton())).toContain("All dates");
  });

  it("a label in the sidebar opens that label's own list (every status, This month); its label is the list, not a filter", async () => {
    await click(buttonNamed(side(), "Delivery"));
    expect(text(q("h1"))).toBe("Label: Delivery");
    expect(buttonNamed(side(), "Delivery").getAttribute("aria-current")).toBe("page");
    expect(buttonNamed(side(), "Needs attention").getAttribute("aria-current")).toBeNull();
    expect(text(periodButton())).toContain("This month");
    expect(listed().sort()).toEqual(ids(listOf("all", withFilter(NO_FILTERS, "label", "lbl-delivery"), "", "attention", CTX, at(THIS_MONTH))).sort());
    expect([...container.querySelectorAll('[role="search"] select')].some((select) => select.getAttribute("id")?.endsWith("-label") === true)).toBe(false);
    expect(container.querySelector('[aria-label="Active filters"]')).toBeNull();
  });

  it("a label chosen in the toolbar intersects the current operational view instead (and keeps its All dates)", async () => {
    await click(buttonNamed(side(), "Open"));
    const label = [...container.querySelectorAll<HTMLSelectElement>('[role="search"] select')].find((select) => select.labels[0]?.textContent === "Label");
    if (label === undefined) throw new Error("Label");
    await pick(label, "lbl-wholesale");
    expect(text(q("h1"))).toBe("Open");
    expect(text(q('[aria-label="Active filters"]'))).toContain("Wholesale lead");
    expect(listed().sort()).toEqual(ids(listOf("open", withFilter(NO_FILTERS, "label", "lbl-wholesale"), "", "attention", CTX)).sort());
    expect(listed()).toContain("cv-49");
  });

  it("the Filters menu has no date", async () => {
    await click(buttonNamed(container, "Filters"));
    const menu = q('[role="dialog"][class*=filterMenu]');
    expect(text(menu)).not.toMatch(/Latest activity|Last 24 hours|Last 7 days|Any time/);
  });
});

describe("the period control", () => {
  it("opens as a dialog on its heading; nothing changes until Apply; the count names the period", async () => {
    await click(buttonNamed(side(), "All conversations"));
    await click(periodButton());
    expect(periodButton().getAttribute("aria-expanded")).toBe("true");
    expect(active()).toBe(q("h2", dialog()));
    await click(radio(dialog(), "Last month"));
    expect(text(periodButton())).toContain("This month");
    await click(buttonNamed(dialog(), "Apply"));
    expect(container.querySelector('[role="dialog"][class*=periodMenu]')).toBeNull();
    expect(active()).toBe(periodButton());
    expect(text(periodButton())).toContain("Last month");
    expect(listCount()).toBe(`${String(listOf("all", NO_FILTERS, "", "attention", CTX, at(LAST_MONTH)).length)} conversations · received 1–31 Oct 2026`);
    expect(listed()).toEqual(expect.arrayContaining(["cv-49", "cv-50", "cv-52"]));
    expect(announced()).toContain("received 1–31 Oct 2026");
  });

  it("Cancel and Escape discard the choice and return focus to the control", async () => {
    await click(periodButton());
    await click(radio(dialog(), "Today"));
    await click(buttonNamed(dialog(), "Cancel"));
    expect(text(periodButton())).toContain("All dates");
    expect(active()).toBe(periodButton());
    await click(periodButton());
    await click(radio(dialog(), "Yesterday"));
    await key(dialog(), "Escape");
    expect(container.querySelector('[role="dialog"][class*=periodMenu]')).toBeNull();
    expect(text(periodButton())).toContain("All dates");
    expect(active()).toBe(periodButton());
  });

  it("an operational view narrowed to a period says how many it holds at all dates", async () => {
    const all = viewCounts(CTX).attention;
    await applyPeriod("This month");
    const month = listOf("attention", NO_FILTERS, "", "attention", CTX, at(THIS_MONTH)).length;
    expect(listCount()).toBe(`${String(month)} of ${String(all)} conversations · received 1–17 Nov 2026`);
    expect(text(buttonNamed(side(), "Needs attention"))).toBe(`Needs attention${String(all)}`);
  });

  it("Done reads the resolution date: This month by default, Resolved offered only there", async () => {
    await click(buttonNamed(side(), "Done"));
    expect(listCount()).toMatch(/· resolved 1–17 Nov 2026$/);
    expect(container.querySelector("#row-cv-52")).toBeNull();
    await click(periodButton());
    expect(text(dialog())).toContain("Resolved");
    await click(buttonNamed(dialog(), "Cancel"));
    await click(buttonNamed(side(), "All conversations"));
    await click(periodButton());
    expect([...dialog().querySelectorAll("label")].map(text)).not.toContain("Resolved");
  });

  it("a custom range is validated where it is typed: reversed or impossible days are said and nothing is applied", async () => {
    await click(buttonNamed(side(), "All conversations"));
    await click(periodButton());
    await click(radio(dialog(), "Custom range"));
    const from = q('input[id$="-from"]', dialog()) as HTMLInputElement;
    const to = q('input[id$="-to"]', dialog()) as HTMLInputElement;
    expect(from.value).toBe("2026-11-01");
    await type(from, "2026-10-20");
    await type(to, "2026-10-02");
    await click(buttonNamed(dialog(), "Apply"));
    expect(text(dialog())).toContain("The end date is before the start date.");
    expect(to.getAttribute("aria-invalid")).toBe("true");
    expect(to.getAttribute("aria-describedby")).toContain("-problem");
    expect(active()).toBe(to);
    expect(text(periodButton())).toContain("This month");
    await type(to, "2026-02-30");
    expect(text(dialog())).toContain("Choose both dates");
    await type(to, "2026-10-31");
    await click(buttonNamed(dialog(), "Apply"));
    expect(text(periodButton())).toContain("20–31 Oct 2026");
    expect(listCount()).toMatch(/· received 20–31 Oct 2026$/);
    expect(listed()).toContain("cv-50");
    expect(listed()).not.toContain("cv-49");
  });

  it("the calendar: arrows and Page keys move focus by day and month; Enter picks the start, then the end", async () => {
    await click(buttonNamed(side(), "All conversations"));
    await click(periodButton());
    await click(radio(dialog(), "Custom range"));
    const grid = q('[role="grid"]', dialog());
    expect(text(q("h3", dialog()))).toBe("November 2026");
    const focused = (): HTMLElement => q('[role="gridcell"][tabindex="0"]', grid);
    expect(focused().getAttribute("aria-label")).toBe("Sunday, 1 November 2026, start date");
    await key(focused(), "PageUp");
    expect(text(q("h3", dialog()))).toBe("October 2026");
    expect(active()?.getAttribute("aria-label")).toBe("Thursday, 1 October 2026");
    await key(active() as Element, "ArrowRight");
    expect(active()?.getAttribute("aria-label")).toBe("Friday, 2 October 2026");
    await key(active() as Element, "Enter");
    expect(announced()).toBe("Start date Friday, 2 October 2026. Now choose the end date.");
    await key(active() as Element, "ArrowDown");
    await key(active() as Element, " ");
    expect(announced()).toBe("Range 2–9 Oct 2026.");
    expect((q('input[id$="-from"]', dialog()) as HTMLInputElement).value).toBe("2026-10-02");
    expect((q('input[id$="-to"]', dialog()) as HTMLInputElement).value).toBe("2026-10-09");
    expect([...grid.querySelectorAll('[aria-selected="true"]')]).toHaveLength(8);
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    await click(buttonNamed(dialog(), "Apply"));
    expect(text(periodButton())).toContain("2–9 Oct 2026");
  });

  it("the workspace's time zone decides the month: UTC lists the 1 November conversation that Buenos Aires puts in October", async () => {
    await click(buttonNamed(side(), "All conversations"));
    const inBuenosAires = listOf("all", NO_FILTERS, "", "attention", CTX, at(THIS_MONTH)).length;
    expect(listCount()).toBe(`${String(inBuenosAires)} conversations · received 1–17 Nov 2026`);
    const zone = [...container.querySelectorAll<HTMLSelectElement>('[aria-label="Prototype controls"] select')].find((select) => select.labels[0]?.textContent.startsWith("Workspace time zone") === true);
    if (zone === undefined) throw new Error("zone");
    await pick(zone, "UTC");
    // One more: cv-53, written at 22:30 on 31 October in Buenos Aires — 01:30 on 1 November in UTC.
    expect(listCount()).toBe(`${String(inBuenosAires + 1)} conversations · received 1–17 Nov 2026`);
    await click(periodButton());
    expect(text(dialog())).toContain("workspace's: UTC");
  });
});

describe("search, selection and what a period leaves out", () => {
  it("a search looks in the list's period and offers all dates, saying how many more there are", async () => {
    await applyPeriod("This month");
    await settle(() => undefined);
    const search = q('input[type="search"]') as HTMLInputElement;
    await type(search, "grinder");
    expect(text(q("[class*=activeRow]"))).toContain("0 results in Needs attention · This month");
    await click(buttonNamed(q("[class*=activeRow]"), "Search all dates · 1 more"));
    expect(text(periodButton())).toContain("All dates");
    expect(listed()).toEqual(["cv-50"]);
    expect(search.value).toBe("grinder");
  });

  it("the open conversation a new period leaves out is named with its date and the way back — never a generic panel", async () => {
    await click(buttonNamed(side(), "Delivery"));
    await applyPeriod("Last month");
    expect(listed()).toEqual(["cv-50"]);
    expect(text(q("#row-cv-50"))).toContain("Received 28 Oct 2026");
    await click(q("#row-cv-50"));
    await applyPeriod("This month");
    expect(container.querySelector("#focus-cv-50")).toBeNull();
    const missed = q('section[aria-labelledby="missed-title"]');
    expect(text(missed)).toContain("lucia.bm's conversation isn't in this list");
    expect(text(missed)).toContain("Received 28 Oct 2026 — outside Delivery · This month (1–17 Nov 2026).");
    expect(container.textContent).not.toContain("Select a conversation to read it here.");
    await click(buttonNamed(missed, "Show all dates and open it"));
    expect(text(periodButton())).toContain("All dates");
    expect(container.querySelector("#focus-cv-50")).not.toBeNull();
    expect(container.querySelector('section[aria-labelledby="missed-title"]')).toBeNull();
    expect(q("#row-cv-50").getAttribute("aria-current")).toBe("true");
  });

  it("Previous / Next move through the period's list only; the thread keeps every older comment", async () => {
    await click(buttonNamed(side(), "All conversations"));
    await applyPeriod("This month", "Latest activity");
    // UX-08B: All conversations opens newest activity first.
    const list = ids(listOf("all", NO_FILTERS, "", "newest", CTX, at({ preset: "this_month", basis: "activity" })));
    expect(list).toContain("cv-50");
    expect(list.length).toBeLessThan(CONVERSATIONS.length);
    if (container.querySelector("#row-cv-50") === null) await click(buttonNamed(container, "Show "));
    await click(q("#row-cv-50"));
    const pane = q("#focus-cv-50");
    expect(text(q("nav[aria-label^='Move through']", pane))).toBe(`${String(list.indexOf("cv-50") + 1)} of ${String(list.length)} in All conversations`);
    expect(pane.querySelectorAll('ol[aria-label="Comments and replies"] article').length).toBe(3);
    expect(buttonNamed(pane, "Back to All conversations")).toBeTruthy();
  });
});
