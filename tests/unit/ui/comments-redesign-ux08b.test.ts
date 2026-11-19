// @vitest-environment happy-dom
/**
 * COMMENTS-UX-08B — consolidated refinements in the Comments prototype (development only, synthetic data):
 * - Comments opens on the approved Phase 1 default: Open, newest activity first (Needs attention is a simulated queue);
 * - each list opens as itself: its own period and sort, and no search or filters carried over from the list left behind
 *   (said aloud); within one list, everything a person chose stays;
 * - the new-conversation lifecycle PROPOSAL, simulated: a new root comment starts one Open, unassigned conversation
 *   (identity = the root comment; never twice), entering each list only by that list's rule; a reply goes to its
 *   conversation and never starts another.
 */
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEED_ASSIGNMENTS, SEED_LABELS } from "@/app/dev/ui-reference/comments-redesign/fixtures";
import {
  LANDING_VIEW,
  NO_FILTERS,
  SEED_SIM,
  SEED_WORKFLOW,
  audienceWritesAgain,
  defaultSort,
  flowOf,
  ingestRootComment,
  inView,
  listOf,
  liveConversations,
  newRootArrives,
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
const THIS_MONTH = { period: { preset: "this_month", basis: "received" }, zone: "America/Argentina/Buenos_Aires" } as const;
const INCOMING = { rootId: "root-test-1", postId: "post-1", accountId: "acc-ig-main", author: "test.author", text: "Do you ship to Chile?" } as const;

describe("the new-conversation lifecycle (proposal, simulated)", () => {
  it("a new root comment starts one Open, unassigned, unlabelled conversation that keeps its post and account", () => {
    const { wf, id } = ingestRootComment(SEED_WORKFLOW, INCOMING);
    if (id === undefined) throw new Error("not created");
    const conversation = liveConversations(wf).find((item) => item.id === id);
    expect(conversation).toMatchObject({ postId: "post-1", accountId: "acc-ig-main" });
    expect(conversation?.comments.map((comment) => comment.id)).toEqual(["root-test-1"]);
    expect(flowOf(wf, id)).toEqual({ status: "open" });
    expect(wf.activity.at(-1)).toMatchObject({ conversationId: id, by: "test.author", text: "New comment from test.author · conversation started" });
    expect(SEED_ASSIGNMENTS[id]).toBeUndefined();
  });

  it("it enters each list by that list's own rule: Open and All conversations (this month), not Needs attention, Assigned to me or Escalated", () => {
    const { wf, id } = ingestRootComment(SEED_WORKFLOW, INCOMING);
    const ctx = { ...CTX, wf };
    const ids = (view: Parameters<typeof listOf>[0]) => listOf(view, NO_FILTERS, "", "newest", ctx, view === "all" ? THIS_MONTH : undefined).map((item) => item.id);
    expect(ids("open")[0]).toBe(id);
    expect(ids("all")[0]).toBe(id);
    for (const view of ["attention", "mine", "escalated", "done"] as const) expect(ids(view), view).not.toContain(id);
    const conversation = liveConversations(wf).find((item) => item.id === id);
    if (conversation === undefined) throw new Error("missing");
    // Needs attention only once the attention rules say so (here: waiting past the response target), never at arrival.
    expect(inView(conversation, "attention", { ...ctx, wf: { ...wf, clock: wf.clock + 241 } })).toBe(true);
  });

  it("the same root comment never starts a second conversation; a reply goes to its conversation and starts none", () => {
    const first = ingestRootComment(SEED_WORKFLOW, INCOMING);
    const again = ingestRootComment(first.wf, INCOMING);
    expect(again.id).toBeUndefined();
    expect(again.wf).toBe(first.wf);
    expect(ingestRootComment(SEED_WORKFLOW, { ...INCOMING, rootId: "cv-01-m00" }).id).toBeUndefined();
    const created = liveConversations(first.wf).find((item) => item.id === first.id);
    if (created === undefined) throw new Error("missing");
    const replied = audienceWritesAgain(first.wf, created);
    expect(replied.created).toHaveLength(1);
    expect(liveConversations(replied).find((item) => item.id === first.id)?.comments).toHaveLength(2);
    // The prototype's control brings a different platform comment each time.
    const one = newRootArrives(SEED_WORKFLOW);
    const two = newRootArrives(one.wf);
    expect([one.id, two.id]).toEqual(["cv-new-01", "cv-new-02"]);
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
  const found = [...scope.querySelectorAll("button")].find((button) => text(button).startsWith(name));
  if (found === undefined) throw new Error(`no button "${name}"`);
  return found;
};
const click = (element: HTMLElement): Promise<void> => settle(() => { element.click(); });
async function pick(select: HTMLSelectElement, value: string): Promise<void> {
  await settle(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function type(element: HTMLInputElement, value: string): Promise<void> {
  const proto = Object.getPrototypeOf(element) as object;
  await settle(() => {
    Reflect.set(proto, "value", value, element);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const toolbarSelect = (label: string): HTMLSelectElement => {
  const found = [...container.querySelectorAll<HTMLSelectElement>('[role="search"] select')].find((item) => item.labels[0]?.textContent === label);
  if (found === undefined) throw new Error(label);
  return found;
};
const side = (): HTMLElement => q('nav[aria-label="Comments views"]');
const listed = (): string[] => [...container.querySelectorAll<HTMLButtonElement>("[id^=row-]")].map((button) => button.id.slice(4));
const announced = (): string => text(q('[role="status"][aria-live="polite"]'));
const search = (): HTMLInputElement => q('input[type="search"]') as HTMLInputElement;

beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await settle(() => { root?.render(h(CommentsRedesign)); });
});

afterEach(async () => {
  await settle(() => { root?.unmount(); });
  container.remove();
});

describe("Comments opens on Open, newest activity first; each list has its own order", () => {
  it("lands on Open at All dates, sorted by Newest activity", () => {
    expect(LANDING_VIEW).toBe("open");
    expect(text(q("h1"))).toBe("Open");
    expect(buttonNamed(side(), "Open").getAttribute("aria-current")).toBe("page");
    expect(toolbarSelect("Sort").value).toBe("newest");
    expect(text(q("[class*=periodButton]"))).toContain("All dates");
    expect(listed().slice(0, 5)).toEqual(listOf("open", NO_FILTERS, "", "newest", CTX).slice(0, 5).map((item) => item.id));
  });

  it("Needs attention opens Attention first; a sort chosen in a list stays while you are in it", async () => {
    expect(defaultSort("attention")).toBe("attention");
    await click(buttonNamed(side(), "Needs attention"));
    expect(toolbarSelect("Sort").value).toBe("attention");
    await pick(toolbarSelect("Sort"), "oldest");
    await pick(toolbarSelect("Platform"), "facebook");
    expect(toolbarSelect("Sort").value).toBe("oldest");
    await click(buttonNamed(side(), "Open"));
    expect(toolbarSelect("Sort").value).toBe("newest");
  });
});

describe("navigating opens each list as itself — nothing invisible carried over", () => {
  it("a sidebar label opens its own list without the search and filters of the view left behind, and says so", async () => {
    await pick(toolbarSelect("Platform"), "facebook");
    await type(search(), "envío");
    expect(container.querySelector('[aria-label="Active filters"]')).not.toBeNull();
    await click(buttonNamed(side(), "Delivery"));
    expect(text(q("h1"))).toBe("Label: Delivery");
    expect(container.querySelector('[aria-label="Active filters"]')).toBeNull();
    expect(search().value).toBe("");
    expect(toolbarSelect("Platform").value).toBe("");
    expect(announced()).toContain("Search and filters from the previous list were cleared.");
    // The count line and the list now describe the same conversations.
    expect(text(q("#list-count"))).toMatch(new RegExp(`^${String(listed().length)} conversations? · received`));
  });

  it("within one list, a filter, a search and a period all stay together until changed", async () => {
    await click(buttonNamed(side(), "Delivery"));
    await pick(toolbarSelect("Platform"), "instagram");
    await click(q("[class*=periodButton]"));
    const dialog = q('[role="dialog"][class*=periodMenu]');
    const allDates = [...dialog.querySelectorAll("label")].find((label) => text(label).startsWith("All dates"))?.querySelector("input");
    if (!(allDates instanceof HTMLInputElement)) throw new Error("All dates");
    await click(allDates);
    await click(buttonNamed(dialog, "Apply"));
    expect(toolbarSelect("Platform").value).toBe("instagram");
    expect(text(q("[class*=activeRow]"))).toContain("in Delivery · All dates");
    expect(listed()).toContain("cv-50");
    expect(listed()).not.toContain("cv-51"); // Facebook
  });

  it("returning to a view through the sidebar opens it clean, with its own default period", async () => {
    await click(buttonNamed(side(), "Delivery"));
    await pick(toolbarSelect("Platform"), "instagram");
    await click(buttonNamed(side(), "Open"));
    expect(toolbarSelect("Platform").value).toBe("");
    expect(text(q("[class*=periodButton]"))).toContain("All dates");
    expect(text(q("#list-count"))).toMatch(/^\d+ conversations · all dates$/);
  });
});

describe("a new comment arrives (prototype control)", () => {
  it("starts a new Open conversation at the top of Open — and nowhere it doesn't belong", async () => {
    const before = listed();
    await click(buttonNamed(container, "Simulate a new comment (new conversation)"));
    expect(listed()[0]).toBe("cv-new-01");
    expect(listed().slice(1, before.length)).toEqual(before.slice(0, before.length - 1));
    expect(announced()).toBe("New comment from vale.rios: a new Open conversation, unassigned (simulated).");
    expect(text(q("#row-cv-new-01"))).not.toMatch(/Needs attention|Assigned to/);
    await click(buttonNamed(side(), "Needs attention"));
    expect(listed()).not.toContain("cv-new-01");
    await click(buttonNamed(side(), "All conversations"));
    expect(listed()[0]).toBe("cv-new-01");
  });
});
