// @vitest-environment happy-dom
/**
 * Comments workspace (Step UX-04) — the interactive prototype in a real client runtime (React + happy-dom), driven the
 * way a person would: clicks, typing, Enter and Escape. It checks that every action changes ONE shared state, so list
 * membership, counts, statuses, Previous / Next and the activity follow: the A1 → A2 → A3 Needs attention journey,
 * conversation management (assign, Urgent, escalate, Done with a resolution, Reopen), search and filters, comment
 * actions with their confirmations and simulated outcomes, labels (assigning ≠ creating; Settings), the Details drawer,
 * and the UX4 safety regressions (H-1, H-2, M-1…M-5). Layout itself (widths, breakpoints) is verified in a browser;
 * here the single-panel structure (Back, splitActive) is checked. Synthetic data; nothing is read or sent.
 */
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SEED_ASSIGNMENTS, SEED_LABELS } from "@/app/dev/ui-reference/comments-redesign/fixtures";
import { NO_FILTERS, PAGE_SIZE, SEED_SIM, SEED_WORKFLOW, listOf, viewCounts, type WorkContext } from "@/app/dev/ui-reference/comments-redesign/model";
import { CommentsRedesign } from "@/app/dev/ui-reference/comments-redesign/prototype";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CTX: WorkContext = { labels: { labels: SEED_LABELS, assignments: SEED_ASSIGNMENTS, nextId: 1 }, wf: SEED_WORKFLOW, sim: SEED_SIM, allHealthy: false, target: 240 };
const START = viewCounts(CTX);

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
const buttonsIn = (scope: ParentNode): HTMLButtonElement[] => [...scope.querySelectorAll("button")];
const named = (button: HTMLButtonElement): string => button.textContent.replace(/\s+/g, " ").trim();
const buttonNamed = (scope: ParentNode, text: string): HTMLButtonElement => {
  const found = buttonsIn(scope).find((button) => named(button).startsWith(text));
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
};
const hasButton = (scope: ParentNode, text: string): boolean => buttonsIn(scope).some((button) => named(button).startsWith(text));
const article = (commentId: string): HTMLElement => q(`[aria-labelledby="c-${commentId}"]`);
const row = (conversationId: string): HTMLButtonElement => q(`#row-${conversationId}`) as HTMLButtonElement;
const pane = (conversationId: string): HTMLElement => q(`#focus-${conversationId}`);
const management = (conversationId: string): HTMLElement => q('[aria-label="Manage this conversation"]', pane(conversationId));
const text = (element: Element): string => element.textContent.replace(/\s+/g, " ").trim();
const listedIds = (): string[] => [...container.querySelectorAll<HTMLButtonElement>("[id^=row-]")].map((button) => button.id.slice(4));
const announced = (): string => text(q('[role="status"][aria-live="polite"]'));
const active = (): Element | null => container.ownerDocument.activeElement;
const sideView = (name: string): HTMLButtonElement => buttonNamed(q('nav[aria-label="Comments views"]'), name);

async function click(element: HTMLElement): Promise<void> {
  await settle(() => { element.click(); });
}
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = Object.getPrototypeOf(element) as object;
  await settle(() => {
    Reflect.set(proto, "value", value, element);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(element: Element, name: string): Promise<void> {
  await settle(() => element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
}
async function pick(select: HTMLSelectElement, value: string): Promise<void> {
  await settle(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
/** A prototype control (role, workspace…): not product UI. */
async function choose(label: string, value: string): Promise<void> {
  const select = [...container.querySelectorAll<HTMLSelectElement>('[aria-label="Prototype controls"] select')].find((item) => item.labels[0]?.textContent.startsWith(label) === true);
  if (select === undefined) throw new Error(label);
  await pick(select, value);
}
const toolbarSelect = (label: string): HTMLSelectElement => {
  const found = [...container.querySelectorAll<HTMLSelectElement>('[role="search"] select')].find((item) => item.labels[0]?.textContent === label);
  if (found === undefined) throw new Error(label);
  return found;
};
const title = (): string => text(q("h1"));

beforeEach(async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await settle(() => root?.render(h(CommentsRedesign)));
});
afterEach(async () => {
  await settle(() => root?.unmount());
  root = undefined;
  container.remove();
});

/* ───────────── the workspace ───────────── */

describe("the workspace: views, list and two panels", () => {
  it("opens on Needs attention with its count; the sidebar lists the workflow views and labels — and no Intelligence", () => {
    expect(title()).toBe(`Needs attention ${String(START.attention)}`);
    const views = buttonsIn(q('nav[aria-label="Comments views"]')).map(named);
    expect(views.slice(0, 5)).toEqual([`Needs attention${String(START.attention)}`, `Open${String(START.open)}`, `Assigned to me${String(START.mine)}`, `Escalated${String(START.escalated)}`, "Done"]);
    expect(text(q('nav[aria-label="Comments views"]'))).not.toMatch(/Intelligence|Needs review|Priority/);
    expect(listedIds()).toEqual(listOf("attention", NO_FILTERS, "", "attention", CTX).map((item) => item.id));
    expect(container.textContent).toContain("Select a conversation to read it here.");
  });

  it("a row selects its conversation into the panel: identity · management · navigation, in three zones", async () => {
    await click(row("cv-10"));
    expect(row("cv-10").getAttribute("aria-current")).toBe("true");
    expect(q(".splitActive, [class*=splitActive]")).toBeDefined();
    const head = q("header", pane("cv-10"));
    expect(text(q("h2", head))).toContain("Ramiro Paz");
    expect(text(head)).toContain("on Lumen Coffee");
    expect(text(head)).toContain("Open");
    expect(text(head)).toContain("Urgent");
    expect(text(head)).toContain("New reply · 40 min");
    expect(buttonsIn(management("cv-10")).map(named)).toEqual(["BDBruno Díaz, assigned — change", "Urgent", "Escalate", "Mark done", "More for this conversation"]);
    expect(text(q('nav[aria-label="Move through Needs attention"]', pane("cv-10")))).toMatch(/^1 of \d+ in Needs attention$/);
  });

  it("Previous / Next move through the list and keep focus on the same control (M-1); Back deselects (one panel at a time)", async () => {
    const list = listedIds();
    await click(row(list[0] ?? ""));
    await click(q('[data-nav="next"]', pane(list[0] ?? "")));
    expect(row(list[1] ?? "").getAttribute("aria-current")).toBe("true");
    expect(active()?.getAttribute("data-nav")).toBe("next");
    await click(buttonNamed(pane(list[1] ?? ""), "Needs attention"));
    expect(container.querySelector("[aria-current=true][id^=row-]")).toBeNull();
    expect(active()).toBe(row(list[1] ?? ""));
    expect(container.querySelector("[class*=splitActive]")).toBeNull();
  });

  it("Escape in the conversation keeps it selected and returns focus to its row", async () => {
    await click(row("cv-07"));
    await key(q("h2", pane("cv-07")), "Escape");
    expect(row("cv-07").getAttribute("aria-current")).toBe("true");
    expect(active()).toBe(row("cv-07"));
  });

  it("H-2: each conversation gets a fresh panel (post details opened in one are closed in the next)", async () => {
    await click(row("cv-10"));
    const details = q("details", pane("cv-10")) as HTMLDetailsElement;
    await settle(() => { details.open = true; });
    await click(q('[data-nav="next"]', pane("cv-10")));
    const next = listedIds()[1] ?? "";
    expect((q("details", pane(next)) as HTMLDetailsElement).open).toBe(false);
  });

  it("the list draws a bounded number of rows and shows more on request", async () => {
    await click(sideView("Open"));
    expect(listedIds()).toHaveLength(PAGE_SIZE);
    await click(buttonNamed(container, "Show "));
    expect(listedIds()).toHaveLength(START.open);
  });
});

/* ───────────── Needs attention: A1 → A2 → A3 ───────────── */

async function replyTo(commentId: string, words: string): Promise<void> {
  await click(buttonNamed(article(commentId), "Reply"));
  await type(q("textarea", article(commentId)) as HTMLTextAreaElement, words);
  await click(buttonNamed(article(commentId), "Review reply"));
  await click(buttonNamed(article(commentId), "Simulate publishing"));
}
const answerButton = (scope: ParentNode, name: string): HTMLButtonElement => {
  const found = buttonsIn(scope).find((button) => named(button) === name);
  if (found === undefined) throw new Error(name);
  return found;
};

describe("Needs attention: the reason is explained, a reply resolves it, the list updates when you move on", () => {
  it("A1 → A2 → A3: waiting over target → reply Sent (still Open, still listed) → moving on leaves it Open, with a way back", async () => {
    await click(row("cv-07"));
    expect(text(q("header", pane("cv-07")))).toContain("Needs attention: Waiting 4 h · over target");
    await replyTo("cv-07-m00", "Both! Whole bean and ground.");
    expect(text(pane("cv-07"))).toContain("Sending");
    expect(title()).toBe(`Needs attention ${String(START.attention)}`); // Sending is not an answer yet
    await click(answerButton(pane("cv-07"), "Confirmed"));
    // A2: the reason is gone, the conversation stays Open and selected, in place; the count already follows.
    expect(text(q("header", pane("cv-07")))).not.toContain("Waiting");
    expect(text(q("header", pane("cv-07")))).toContain("Open");
    expect(text(q("header", pane("cv-07")))).toContain("No longer in Needs attention · stays here until you move on");
    expect(title()).toBe(`Needs attention ${String(START.attention - 1)}`);
    expect(text(row("cv-07"))).toContain("Reply sent · leaves this list when you move on");
    expect(text(pane("cv-07"))).toContain("Reply sent. Is the question answered, or is something still pending?");
    expect(hasButton(pane("cv-07"), "Mark done · Replied publicly")).toBe(true);
    // A3: Keep open, move on; the row leaves, the note says where it went, Show brings it back.
    await click(buttonNamed(pane("cv-07"), "Keep open"));
    expect(text(pane("cv-07"))).not.toContain("Reply sent. Is the question");
    const before = listedIds();
    const index = before.indexOf("cv-07");
    const neighbour = before[index - 1] ?? before[index + 1] ?? "";
    await click(q(`[data-nav="${index > 0 ? "previous" : "next"}"]`, pane("cv-07")));
    expect(listedIds()).not.toContain("cv-07");
    expect(new Set(listedIds()).size).toBe(listedIds().length);
    expect(row(neighbour).getAttribute("aria-current")).toBe("true");
    expect(text(q('[class*=toast]'))).toContain("nina.coffeelab left Needs attention. It's still Open.");
    await click(buttonNamed(q("[class*=toast]"), "Show"));
    expect(row("cv-07").getAttribute("aria-current")).toBe("true");
    await click(sideView("Open"));
    expect(listedIds()).toContain("cv-07");
  });

  it("Mark done from the nudge records the resolution; moving on says it's Done; Done lists it and Reopen brings it back", async () => {
    await click(row("cv-07"));
    await replyTo("cv-07-m00", "Both!");
    await click(answerButton(pane("cv-07"), "Confirmed"));
    await click(buttonNamed(pane("cv-07"), "Mark done · Replied publicly"));
    expect(text(q("header", pane("cv-07")))).toContain("Done · Replied publicly");
    expect(text(row("cv-07"))).toContain("Done · Replied publicly · leaves this list when you move on");
    await click(row(listedIds().find((id) => id !== "cv-07") ?? ""));
    expect(text(q("[class*=toast]"))).toContain("It's Done · Replied publicly.");
    await click(sideView("Done"));
    expect(listedIds()).toContain("cv-07");
    await click(row("cv-07"));
    await click(buttonNamed(management("cv-07"), "Reopen"));
    expect(text(q("header", pane("cv-07")))).toContain("Open");
    expect(announced()).toBe("Reopened");
  });

  it("other reasons stay independent; an unknown outcome is 'Reply not confirmed', never resolved, never retried", async () => {
    await click(row("cv-07"));
    await replyTo("cv-07-m00", "Both!");
    await click(answerButton(pane("cv-07"), "No answer"));
    expect(text(row("cv-07"))).toContain("Reply not confirmed");
    expect(text(pane("cv-07"))).toContain("It may already be public");
    expect(text(pane("cv-07"))).not.toContain("Reply sent. Is the question");
    expect(buttonsIn(pane("cv-07")).some((button) => /retry|try again/i.test(named(button)))).toBe(false);
    // Untouched by the other conversation's reply (the synthetic clock moved a minute per recorded action).
    expect(text(row("cv-10"))).toMatch(/Needs attention: New reply · \d+ min/);
    // The seeded reply under check (cv-04): resolved by the check, the attention goes.
    await click(row("cv-04"));
    expect(text(q("header", pane("cv-04")))).toContain("Reply not confirmed");
    await click(answerButton(pane("cv-04"), "It went through"));
    expect(text(q("header", pane("cv-04")))).not.toContain("Reply not confirmed");
  });
});

/* ───────────── conversation management ───────────── */

describe("conversation management: assign, Urgent, escalate, Done — separate from comment actions", () => {
  it("assigning shows in the header, the row, the Assignee filter and the activity", async () => {
    await click(row("cv-07"));
    await click(buttonsIn(management("cv-07")).find((button) => named(button).includes("Assign: unassigned")) as HTMLButtonElement);
    await click(buttonNamed(q('[aria-label="Assign this conversation"]'), "TLTomás Lerner"));
    expect(text(management("cv-07"))).toContain("Tomás Lerner");
    expect(text(row("cv-07"))).toContain("Assigned to Tomás Lerner");
    expect(active()).toBe(buttonNamed(management("cv-07"), "TLTomás Lerner"));
    await click(buttonNamed(container, "Filters"));
    await pick(q('[role="dialog"] select[aria-label="Assignee"]') as HTMLSelectElement, "m-tomas");
    expect(listedIds()).toEqual(["cv-07"]);
    await click(q("time", article("cv-07-m00")).closest("button") as HTMLButtonElement);
    expect(text(q('[role="dialog"][aria-labelledby]', pane("cv-07")))).toContain("Assigned to Tomás Lerner · Ana Ruiz");
  });

  it("Urgent is a pressed toggle (a person's flag); Escalate is a hand-off; neither implies the other", async () => {
    await click(row("cv-07"));
    const urgent = buttonNamed(management("cv-07"), "Urgent");
    expect(urgent.getAttribute("aria-pressed")).toBe("false");
    await click(urgent);
    expect(buttonNamed(management("cv-07"), "Urgent").getAttribute("aria-pressed")).toBe("true");
    expect(text(row("cv-07"))).toContain("Urgent");
    expect(text(q("header", pane("cv-07")))).not.toContain("Escalated");
    await click(buttonNamed(management("cv-07"), "Escalate"));
    await pick(q('[aria-label="Escalate this conversation"] select') as HTMLSelectElement, "Finance");
    await click(buttonNamed(q('[aria-label="Escalate this conversation"]'), "Escalate"));
    expect(text(q("header", pane("cv-07")))).toContain("Escalated · Finance");
    expect(buttonNamed(management("cv-07"), "Urgent").getAttribute("aria-pressed")).toBe("true");
    expect(text(sideView("Escalated"))).toContain(String(START.escalated + 1));
    await click(buttonNamed(management("cv-07"), "Urgent"));
    expect(text(q("header", pane("cv-07")))).toContain("Escalated · Finance");
    expect(text(q("header", pane("cv-07")))).not.toContain("Urgent (marked");
  });

  it("Mark done asks how it was resolved; it clears Urgent; Escape closes the menu back on its button", async () => {
    await click(row("cv-10"));
    await click(buttonNamed(management("cv-10"), "Mark done"));
    const menu = q('[aria-label="Mark done as"]');
    expect(buttonsIn(menu).map(named)).toEqual(["Replied publicly", "Replied privately", "Replied on the platform", "No reply needed", "Moderated"]);
    // No private reply is confirmed in Ramiro's conversation: that resolution is listed, unavailable, with its reason (UX-05 H-2).
    const privately = buttonNamed(menu, "Replied privately");
    expect(privately.getAttribute("aria-disabled")).toBe("true");
    expect(text(q(`#${CSS.escape(privately.getAttribute("aria-describedby") ?? "")}`))).toBe("No private reply from Wrenkind is confirmed sent in this conversation.");
    await click(privately);
    expect(text(q("header", pane("cv-10")))).not.toContain("Done ·");
    await key(menu, "Escape");
    expect(container.querySelector('[aria-label="Mark done as"]')).toBeNull();
    expect(active()).toBe(buttonNamed(management("cv-10"), "Mark done"));
    await click(buttonNamed(management("cv-10"), "Mark done"));
    await click(buttonNamed(q('[aria-label="Mark done as"]'), "Replied publicly"));
    expect(text(q("header", pane("cv-10")))).toContain("Done · Replied publicly");
    expect(text(q("header", pane("cv-10")))).not.toContain("Urgent");
    expect(hasButton(management("cv-10"), "Reopen")).toBe(true);
  });

  it("Monitor-only keeps management (internal) and offers 'Reviewed'; platform actions say Monitor-only; Analyst has no management", async () => {
    await choose("Workspace", "monitor");
    await click(row("cv-07"));
    expect(container.textContent).toContain("This workspace is Monitor-only: nothing is done on the platform from here.");
    await click(buttonNamed(management("cv-07"), "Mark done"));
    expect(hasButton(q('[aria-label="Mark done as"]'), "Reviewed")).toBe(true);
    await click(buttonNamed(article("cv-07-m00"), "Hide"));
    expect(text(article("cv-07-m00"))).toContain("Not available here. This workspace is Monitor-only.");
    await choose("Role", "analyst");
    expect(pane("cv-07").querySelector('[aria-label="Manage this conversation"]')).toBeNull();
    expect(hasButton(article("cv-07-m00"), "Reply")).toBe(false);
  });

  it("a new reply from the author (prototype control) reopens a Done conversation by itself", async () => {
    await click(sideView("Done"));
    await click(row("cv-02"));
    await click(buttonNamed(q('[aria-label="Prototype controls"]'), "Simulate a new reply from joaquin.rv"));
    expect(text(q("header", pane("cv-02")))).toContain("Open");
    expect(text(q("header", pane("cv-02")))).toContain("New reply");
    expect(text(pane("cv-02"))).toContain("Any news on this? Still waiting for an answer.");
  });
});

/* ───────────── search, filters, navigation ───────────── */

describe("search, two quick filters, Filters menu, sort — and what Previous / Next moves through", () => {
  it("search narrows the list, says how many match and where, and is removable; no match is a clear empty state", async () => {
    await click(sideView("Open"));
    await type(q('input[type="search"]') as HTMLInputElement, "wholesale");
    expect(text(q("[class*=activeRow]"))).toMatch(/^\d+ results? in Open/);
    expect(text(q('[aria-label="Active filters"]'))).toContain("Search:“wholesale”");
    expect(listedIds()).toContain("cv-05");
    await type(q('input[type="search"]') as HTMLInputElement, "zzzz nothing");
    expect(container.textContent).toContain("No conversation in Open matches.");
    await click(buttonNamed(container, "Clear search and filters"));
    expect(listedIds().length).toBe(PAGE_SIZE);
  });

  it("Platform and Label are quick filters; the Filters menu holds the rest; every filter is a removable chip", async () => {
    await click(sideView("Open"));
    await pick(toolbarSelect("Platform"), "facebook");
    await pick(toolbarSelect("Label"), "lbl-wholesale");
    await click(buttonNamed(container, "Filters"));
    const menu = q('[role="dialog"][aria-labelledby]');
    const account = [...menu.querySelectorAll<HTMLLabelElement>("label")].find((label) => label.textContent.includes("Lumen Coffee") && !label.textContent.includes("Eventos"));
    await click(account?.querySelector("input") as HTMLInputElement);
    expect(text(buttonNamed(container, "Filters"))).toContain("1");
    expect([...q('[aria-label="Active filters"]').querySelectorAll("li")].map(text)).toEqual(["Platform:Facebook", "Label:Wholesale lead", "Account:Lumen Coffee"]);
    expect(listedIds().sort()).toEqual(["cv-05", "cv-22", "cv-42"]);
    await click(buttonNamed(menu, "Show 3 results"));
    expect(container.querySelector('[role="dialog"][aria-labelledby]')).toBeNull();
    expect(active()).toBe(buttonNamed(container, "Filters"));
    await click(q('[aria-label="Remove the filter Label: Wholesale lead"]'));
    expect(text(q('[aria-label="Active filters"]'))).not.toContain("Wholesale");
    await click(buttonNamed(q("[class*=activeRow]"), "Clear all"));
    expect(container.querySelector('[aria-label="Active filters"]')).toBeNull();
  });

  it("Previous / Next move only through the filtered, sorted list", async () => {
    await click(sideView("Open"));
    await pick(toolbarSelect("Label"), "lbl-wholesale");
    await pick(toolbarSelect("Platform"), "facebook");
    const list = listedIds();
    await click(row(list[0] ?? ""));
    const nav = q("nav[aria-label^='Move through']", pane(list[0] ?? ""));
    expect(text(nav)).toBe(`1 of ${String(list.length)} in Open`);
    for (let index = 1; index < list.length; index += 1) await click(q('[data-nav="next"]', pane(list[index - 1] ?? "")));
    expect((q('[data-nav="next"]', pane(list.at(-1) ?? "")) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a filter that no longer lists the selected conversation clears the selection and says why (M-4)", async () => {
    await click(row("cv-07"));
    await pick(toolbarSelect("Platform"), "facebook");
    expect(container.querySelector("#focus-cv-07")).toBeNull();
    expect(announced()).toContain("The conversation you had open isn't in this list, so nothing is selected.");
  });

  it("Escape closes the Filters menu and returns focus to its button", async () => {
    await click(buttonNamed(container, "Filters"));
    await key(q('[role="dialog"][aria-labelledby]'), "Escape");
    expect(container.querySelector('[role="dialog"][aria-labelledby]')).toBeNull();
    expect(active()).toBe(buttonNamed(container, "Filters"));
  });

  it("Done has no attention order: it sorts by activity", async () => {
    await click(sideView("Done"));
    const sort = [...container.querySelectorAll<HTMLSelectElement>('[role="search"] select')].find((item) => item.labels[0]?.textContent === "Sort");
    expect([...(sort?.options ?? [])].map((option) => option.text)).toEqual(["Newest activity", "Oldest activity"]);
  });
});

/* ───────────── comment actions ───────────── */

describe("comment actions: what the platform supports, confirmed when destructive, simulated and labelled as such", () => {
  it("each comment shows Reply · Reply privately · Hide · More; Instagram's More has no Like or Block; links say why they are missing", async () => {
    await click(row("cv-07"));
    expect(buttonsIn(q('[role="group"][aria-label^="Actions for"]', article("cv-07-m00"))).map(named)).toEqual(["Reply", "Reply privately", "Hide", "More for nina.coffeelab's comment"]);
    await click(buttonNamed(article("cv-07-m00"), "More"));
    const menu = q('[aria-label="More actions"]', article("cv-07-m00"));
    expect(menu.getAttribute("data-platform")).toBe("instagram");
    expect(buttonsIn(menu).map(named)).toEqual(["Open on Instagram", "Copy link", "Delete comment…"]);
    expect(text(menu)).toContain("No platform link in this synthetic data.");
  });

  it("Facebook's More adds Like and Block author, destructive actions after a separator", async () => {
    await click(sideView("Open"));
    await click(row("cv-39"));
    await click(buttonNamed(article("cv-39-m00"), "More"));
    const menu = q('[aria-label="More actions"]', article("cv-39-m00"));
    expect(buttonsIn(menu).map(named)).toEqual(["Like", "Open on Facebook", "Copy link", "Delete comment…", "Block author…"]);
  });

  it("Delete asks first; Cancel changes nothing; a failed delete is retried only through the confirmation again", async () => {
    await click(sideView("Open"));
    await click(row("cv-39"));
    await click(buttonNamed(article("cv-39-m00"), "More"));
    await click(buttonNamed(article("cv-39-m00"), "Delete comment…"));
    expect(text(article("cv-39-m00"))).toContain("Delete Café Barato Oficial's comment from Facebook?");
    expect(active()).toBe(buttonNamed(article("cv-39-m00"), "Cancel"));
    await click(buttonNamed(article("cv-39-m00"), "Cancel"));
    expect(hasButton(article("cv-39-m00"), "Delete comment")).toBe(false);
    await click(buttonNamed(article("cv-39-m00"), "More"));
    await click(buttonNamed(article("cv-39-m00"), "Delete comment…"));
    await click(answerButton(article("cv-39-m00"), "Delete comment"));
    await click(answerButton(article("cv-39-m00"), "Failed"));
    await click(buttonNamed(article("cv-39-m00"), "Try again…"));
    // Not a second delete: the confirmation, with its consequences, again.
    expect(text(article("cv-39-m00"))).toContain("Delete Café Barato Oficial's comment from Facebook?");
    expect([...article("cv-39-m00").querySelectorAll("[data-op-status]")].map((item) => item.getAttribute("data-op-status"))).toEqual(["failed"]);
  });

  it("Hide is one step and becomes Unhide; the hidden state is marked simulated; focus stays on the toggle (M-2)", async () => {
    await click(sideView("Open"));
    await click(row("cv-39"));
    await click(buttonNamed(article("cv-39-m00"), "Hide"));
    await click(answerButton(article("cv-39-m00"), "Confirmed"));
    expect(text(article("cv-39-m00"))).toContain("Hidden on Facebook (simulated)");
    expect(active()).toBe(buttonNamed(article("cv-39-m00"), "Unhide"));
  });

  it("public reply: write → review → simulated publishing; a draft survives closing the composer (UX-20)", async () => {
    await click(row("cv-07"));
    await click(buttonNamed(article("cv-07-m00"), "Reply"));
    expect(text(article("cv-07-m00"))).toContain("Preview — nothing is sent");
    await type(q("textarea", article("cv-07-m00")) as HTMLTextAreaElement, "Draft words");
    await click(buttonNamed(article("cv-07-m00"), "Reply"));
    await click(buttonNamed(article("cv-07-m00"), "Reply"));
    expect((q("textarea", article("cv-07-m00")) as HTMLTextAreaElement).value).toBe("Draft words");
    expect(text(article("cv-07-m00"))).toContain("Draft kept from earlier in this tab.");
  });

  it("private reply: write → review → confirm; one per comment; the record says there is no message inbox", async () => {
    await click(row("cv-07"));
    await click(buttonNamed(article("cv-07-m00"), "Reply privately"));
    const composer = q('[role="group"][aria-labelledby]', article("cv-07-m00"));
    expect(text(composer)).toContain("One per comment, within 7 days of it");
    expect(text(composer)).toContain("Wrenkind has no message inbox.");
    await type(q("textarea", composer) as HTMLTextAreaElement, "Hi Nina — sending you our price list.");
    expect(hasButton(composer, "Simulate sending")).toBe(false);
    await click(buttonNamed(composer, "Review private reply"));
    expect(text(article("cv-07-m00"))).toContain("You can send only one private reply to this comment.");
    await click(buttonNamed(article("cv-07-m00"), "Simulate sending"));
    await click(answerButton(article("cv-07-m00"), "Confirmed"));
    expect(text(article("cv-07-m00"))).toContain("Wrenkind has no message inbox, so it won't appear here.");
    await click(buttonNamed(article("cv-07-m00"), "Reply privately"));
    expect(text(article("cv-07-m00"))).toContain("A private reply was already sent for this comment. Only one is allowed.");
    expect(text(pane("cv-07"))).toContain("Mark done · Replied privately");
  });

  it("an Agent replies and hides but has no Delete or Block; an Analyst has no platform action", async () => {
    await choose("Role", "agent");
    await click(sideView("Open"));
    await click(row("cv-39"));
    await click(buttonNamed(article("cv-39-m00"), "More"));
    expect(buttonsIn(q('[aria-label="More actions"]')).map(named)).toEqual(["Like", "Open on Facebook", "Copy link"]);
    await choose("Role", "analyst");
    expect(buttonsIn(q('[role="group"][aria-label^="Actions for"]', article("cv-39-m00"))).map(named)).toEqual(["More for Café Barato Oficial's comment"]);
  });

  it("the simulated answers are never focused on their own (Enter twice cannot answer)", async () => {
    await click(row("cv-07"));
    await click(buttonNamed(article("cv-07-m00"), "Hide"));
    expect(active()?.className ?? "").not.toMatch(/simButton/);
  });
});

/* ───────────── UX4 H-1: revalidated at the moment of acting ───────────── */

describe("UX4 H-1: a stale panel never acts", () => {
  it("a Delete confirmation left open when the workspace becomes Monitor-only can no longer delete", async () => {
    await click(sideView("Open"));
    await click(row("cv-39"));
    await click(buttonNamed(article("cv-39-m00"), "More"));
    await click(buttonNamed(article("cv-39-m00"), "Delete comment…"));
    await choose("Workspace", "monitor");
    expect(text(article("cv-39-m00"))).toContain("No longer possible. This workspace is Monitor-only.");
    expect(buttonsIn(article("cv-39-m00")).some((button) => named(button) === "Delete comment")).toBe(false);
  });

  it("a Block confirmation left open when the role changes to Agent can no longer block", async () => {
    await click(sideView("Open"));
    await click(row("cv-39"));
    await click(buttonNamed(article("cv-39-m00"), "More"));
    await click(buttonNamed(article("cv-39-m00"), "Block author…"));
    await choose("Role", "agent");
    expect(text(article("cv-39-m00"))).toContain("No longer possible.");
    expect(buttonsIn(article("cv-39-m00")).some((button) => named(button) === "Block author")).toBe(false);
  });

  it("'Try again' disappears while retrying is not allowed, and comes back when it is", async () => {
    await click(sideView("Open"));
    await click(row("cv-39"));
    await click(buttonNamed(article("cv-39-m00"), "Hide"));
    await click(answerButton(article("cv-39-m00"), "Failed"));
    expect(hasButton(article("cv-39-m00"), "Try again")).toBe(true);
    await choose("Workspace", "monitor");
    expect(hasButton(article("cv-39-m00"), "Try again")).toBe(false);
    await choose("Workspace", "standard");
    expect(hasButton(article("cv-39-m00"), "Try again")).toBe(true);
  });

  it("a reply under review cannot be published after Monitor-only; the draft is kept", async () => {
    await click(row("cv-07"));
    await click(buttonNamed(article("cv-07-m00"), "Reply"));
    await type(q("textarea", article("cv-07-m00")) as HTMLTextAreaElement, "Both!");
    await click(buttonNamed(article("cv-07-m00"), "Review reply"));
    await choose("Workspace", "monitor");
    expect(text(article("cv-07-m00"))).toContain("Reply unavailable. This workspace is Monitor-only.");
    expect(container.querySelector("[data-sim-reply]")).toBeNull();
    await choose("Workspace", "standard");
    expect(text(article("cv-07-m00"))).toContain("Both!");
  });

  it("a private reply composer left open when actions switch to 'as in Wrenkind today' can no longer send", async () => {
    await click(row("cv-07"));
    await click(buttonNamed(article("cv-07-m00"), "Reply privately"));
    await choose("Actions", "today");
    expect(text(article("cv-07-m00"))).toContain("No longer possible. Not available in Wrenkind yet.");
    expect(hasButton(article("cv-07-m00"), "Simulate sending")).toBe(false);
  });
});

/* ───────────── labels ───────────── */

describe("labels: assigning an existing label ≠ creating a workspace label", () => {
  it("+ Label opens the picker; a checkbox adds the label to this comment, the row and the sidebar count, and the activity", async () => {
    await click(row("cv-07"));
    const before = text(buttonNamed(q('nav[aria-label="Comments views"]'), "Praise"));
    await click(buttonNamed(article("cv-07-m00"), "Label"));
    const picker = q('[aria-label="Labels on nina.coffeelab\'s comment"]');
    expect(text(picker)).toContain("Create workspace label…");
    const praise = [...picker.querySelectorAll("label")].find((label) => label.textContent.includes("Praise"));
    await click(praise?.querySelector("input") as HTMLInputElement);
    expect(text(q('ul[aria-label="Labels"]', article("cv-07-m00")))).toContain("Praise");
    expect(text(row("cv-07"))).toContain("Praise");
    expect(text(buttonNamed(q('nav[aria-label="Comments views"]'), "Praise"))).not.toBe(before);
    expect(announced()).toBe("Label Praise added to nina.coffeelab's comment");
  });

  it("Enter acts only on an exact name and never creates (M-3); Escape closes back on + Label", async () => {
    await click(row("cv-10"));
    await click(buttonNamed(article("cv-10-m00"), "Label"));
    const input = q("input", q('[aria-label^="Labels on Ramiro"]')) as HTMLInputElement;
    await type(input, "Refund");
    await key(input, "Enter");
    expect(text(q('ul[aria-label="Labels"]', article("cv-10-m00")))).toContain("Refund request");
    await type(input, "Brand new name");
    await key(input, "Enter");
    expect(container.textContent).not.toContain("Brand new name created");
    expect(text(q('[aria-label^="Labels on Ramiro"]'))).toContain("Create it as a workspace label below.");
    await type(input, "praise");
    await key(input, "Enter");
    expect(text(q('ul[aria-label="Labels"]', article("cv-10-m00")))).toContain("Praise");
    await key(input, "Escape");
    expect(active()).toBe(buttonNamed(article("cv-10-m00"), "Label"));
  });

  it("creating is its own step: workspace scope, gray by default (five approved colors), validation, optional add", async () => {
    await click(row("cv-07"));
    await click(buttonNamed(article("cv-07-m00"), "Label"));
    await click(buttonNamed(container, "Create workspace label…"));
    const panel = q('[role="group"][aria-labelledby]', article("cv-07-m00"));
    expect(text(panel)).toContain("Labels belong to the Lumen Coffee workspace: everyone here can use it on any comment.");
    const markers = [...panel.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(markers.map((input) => [input.value, input.checked, input.disabled])).toEqual([["gray", true, false], ["teal", false, false], ["plum", false, false], ["magenta", false, false], ["olive", false, false]]);
    await click(buttonNamed(panel, "Create label"));
    expect(text(panel)).toContain("Write a name for the label.");
    await type(q("input:not([type])", panel) as HTMLInputElement, "delivery");
    await click(buttonNamed(panel, "Create label"));
    expect(text(panel)).toContain("A label with this name already exists.");
    await type(q("input:not([type])", panel) as HTMLInputElement, "Supplier inquiry");
    await click(buttonNamed(panel, "Create label"));
    expect(text(q('ul[aria-label="Labels"]', article("cv-07-m00")))).toContain("Supplier inquiry");
    expect(hasButton(q('nav[aria-label="Comments views"]'), "Supplier inquiry")).toBe(true);
  });

  it("an Agent assigns existing labels but sees no create entry and no Manage", async () => {
    await choose("Role", "agent");
    await click(row("cv-07"));
    await click(buttonNamed(article("cv-07-m00"), "Label"));
    expect(hasButton(container, "Create workspace label…")).toBe(false);
    expect(container.textContent).toContain("Only owners, admins and managers create labels.");
    expect(hasButton(q('nav[aria-label="Comments views"]'), "Manage")).toBe(false);
  });

  it("removing a chip moves focus to the next chip, then to + Label (M-2)", async () => {
    await click(row("cv-10"));
    await click(q('[aria-label="Remove label Delivery from Ramiro Paz\'s comment"]'));
    expect(active()?.getAttribute("aria-label")).toBe("Remove label Refund request from Ramiro Paz's comment");
    await click(q('[aria-label="Remove label Refund request from Ramiro Paz\'s comment"]'));
    expect(active()).toBe(buttonNamed(article("cv-10-m00"), "Label"));
  });

  it("Settings › Labels: rename (validated), delete behind a confirmation; comments stay, assignments go, activity records it", async () => {
    await click(buttonNamed(q('nav[aria-label="Comments views"]'), "Manage"));
    expect(title()).toContain("Labels");
    await click(buttonNamed(container, "Edit Follow up Monday"));
    await type(q("input", q("[class*=editingRow]")) as HTMLInputElement, "Delivery");
    await click(buttonNamed(container, "Save"));
    expect(container.textContent).toContain("A label with this name already exists.");
    await type(q("input", q("[class*=editingRow]")) as HTMLInputElement, "Follow up later");
    await click(buttonNamed(container, "Save"));
    expect(container.textContent).toContain("Follow up later");
    await click(buttonNamed(container, "Delete Refund request"));
    const dialog = q('[role="alertdialog"]');
    expect(text(dialog)).toContain("It's removed from the 5 comments that use it. No comment is deleted.");
    expect(active()).toBe(buttonNamed(dialog, "Cancel"));
    await click(buttonNamed(dialog, "Delete label"));
    expect(announced()).toBe("Label Refund request deleted. It was removed from 5 comments; no comment was deleted.");
    await click(buttonNamed(q('nav[aria-label="Main navigation"]'), "Comments"));
    await click(row("cv-10"));
    expect(text(q('ul[aria-label="Labels"]', article("cv-10-m00")))).toBe("Delivery");
    expect(text(article("cv-10-m00"))).toContain("El último pedido llegó con el paquete roto");
    await click(q("time", article("cv-10-m00")).closest("button") as HTMLButtonElement);
    expect(text(q('[role="dialog"]', pane("cv-10")))).toContain("Label Refund request deleted in Settings");
  });

  it("an Agent sees Settings › Labels read-only", async () => {
    await choose("Role", "agent");
    await click(buttonNamed(q('nav[aria-label="Main navigation"]'), "Settings"));
    expect(container.textContent).toContain("Your role can use labels on comments but can't create, rename or delete them.");
    expect(hasButton(container, "New label")).toBe(false);
    expect(hasButton(container, "Edit")).toBe(false);
  });
});

/* ───────────── Details ───────────── */

describe("Details: an overlay drawer tied to one comment", () => {
  it("opens from the comment's time; exact times, what happened, the author here, capabilities last; Escape returns focus", async () => {
    await click(row("cv-10"));
    const opener = q("#time-cv-10-m00") as HTMLButtonElement;
    await click(opener);
    expect(opener.getAttribute("aria-expanded")).toBe("true");
    const drawer = q('[role="dialog"]', pane("cv-10"));
    expect(drawer.tagName).toBe("ASIDE");
    expect(text(drawer)).toContain("About Ramiro Paz's comment");
    expect(text(drawer)).toContain("Written on Facebook");
    expect(text(drawer)).toContain("Edited");
    expect(text(drawer)).toContain("Read by Wrenkind");
    expect(text(drawer)).toContain("What happened in this conversation");
    expect(text(drawer)).toContain("Marked urgent · Ana Ruiz");
    expect(text(drawer)).toContain("Ramiro Paz in this workspace");
    const sections = [...drawer.querySelectorAll("h3, summary")].map(text);
    expect(sections.at(-1)).toMatch(/^Why some actions aren't available here/);
    expect(q("article", pane("cv-10")).closest("li")?.className ?? "").toMatch(/entryAnchored/);
    expect(active()?.textContent).toContain("Details");
    await key(drawer, "Escape");
    expect(pane("cv-10").querySelector('[role="dialog"]')).toBeNull();
    expect(active()).toBe(q("#time-cv-10-m00"));
    expect(row("cv-10").getAttribute("aria-current")).toBe("true");
  });

  it("the close button returns focus too; moving to another conversation never carries the drawer over", async () => {
    await click(row("cv-10"));
    await click(q("#time-cv-10-m00"));
    await click(q('[aria-label="Close details"]'));
    expect(active()).toBe(q("#time-cv-10-m00"));
    await click(q("#time-cv-10-m00"));
    await click(q('[data-nav="next"]', pane("cv-10")));
    const next = listedIds()[1] ?? "";
    expect(pane(next).querySelector('[role="dialog"]')).toBeNull();
  });
});

/* ───────────── the frame: guest, theme, prototype controls, no Intelligence ───────────── */

describe("the frame", () => {
  it("a client guest is denied: no comment, label or account is drawn", async () => {
    await choose("Role", "guest");
    expect(container.textContent).toContain("Comments aren't available to you");
    expect(container.querySelector("[id^=row-]")).toBeNull();
  });

  it("the prototype controls say what is simulated and what is a proposal, apart from the product UI; Reset restores", async () => {
    const bar = q('[aria-label="Prototype controls"]');
    expect(text(bar)).toContain("Facebook and Instagram actions are simulated in this tab. Workflow, attention and labels are proposals.");
    await click(row("cv-07"));
    await click(buttonNamed(management("cv-07"), "Urgent"));
    await click(buttonNamed(bar, "Reset data"));
    expect(container.querySelector("#focus-cv-07")).toBeNull();
    expect(text(row("cv-07"))).not.toContain("Urgent");
    expect(announced()).toContain("Prototype data reset");
  });

  it("System sets nothing; Light and Dark set data-theme on <html>; System puts back what was there", async () => {
    const html = container.ownerDocument.documentElement;
    html.removeAttribute("data-theme");
    await choose("Theme", "dark");
    expect(html.getAttribute("data-theme")).toBe("dark");
    await choose("Theme", "light");
    expect(html.getAttribute("data-theme")).toBe("light");
    await choose("Theme", "system");
    expect(html.hasAttribute("data-theme")).toBe(false);
  });

  it("no AI output anywhere: no Signals, assessments or priorities; Settings › Intelligence says it is not active", async () => {
    await click(row("cv-10"));
    expect(text(pane("cv-10"))).not.toMatch(/Complaint|Signal|P1|P2|never auto-hidden/);
    await click(buttonNamed(q('nav[aria-label="Main navigation"]'), "Settings"));
    await click(buttonNamed(q('nav[aria-label="Settings"]'), "Intelligence"));
    expect(container.textContent).toContain("Not active for this workspace. Nothing in Comments is classified, prioritized or summarized by Wrenkind today.");
    expect(hasButton(container, "Turn on")).toBe(false);
  });
});

/* ───────────── UX-05: independent audit remediation ───────────── */

describe("UX-05 H-1 / H-2: replies whose outcome isn't known", () => {
  it("a second reply (Sending, then Sent) to another comment never hides the first reply's failure", async () => {
    await click(row("cv-10"));
    await replyTo("cv-10-m00", "We're on it.");
    await click(answerButton(pane("cv-10"), "Failed"));
    expect(text(q("header", pane("cv-10")))).toContain("Needs attention: Reply failed");
    await replyTo("cv-10-m02", "Ramiro, the replacement left today.");
    expect(text(q("header", pane("cv-10")))).toContain("Needs attention: Reply failed");
    await click(answerButton(pane("cv-10"), "Confirmed"));
    expect(text(q("header", pane("cv-10")))).toContain("Needs attention: Reply failed");
    expect(text(row("cv-10"))).toContain("Reply failed");
  });

  it("Mark done is refused, with the reason, while a reply is Checking; once confirmed it offers the resolution the reply supports", async () => {
    await click(row("cv-04"));
    await click(buttonNamed(management("cv-04"), "Mark done"));
    const blocked = q('[aria-label="Mark done"]');
    expect(text(blocked)).toContain("A reply's outcome is still being checked: it isn't known whether it reached the platform.");
    expect(hasButton(blocked, "Replied")).toBe(false);
    expect(hasButton(blocked, "No reply needed")).toBe(false);
    await click(answerButton(pane("cv-04"), "It went through"));
    const menu = q('[aria-label="Mark done as"]');
    expect(buttonNamed(menu, "Replied publicly").getAttribute("aria-disabled")).toBeNull();
    expect(buttonNamed(menu, "Replied privately").getAttribute("aria-disabled")).toBe("true");
    await click(buttonNamed(menu, "Replied publicly"));
    expect(text(q("header", pane("cv-04")))).toContain("Done · Replied publicly");
  });

  it("while a reply is Sending there is no nudge and Done is refused; a person's choice never confirms a reply", async () => {
    await click(row("cv-07"));
    await replyTo("cv-07-m00", "Both!");
    expect(text(pane("cv-07"))).not.toContain("Reply sent. Is the question");
    await click(buttonNamed(management("cv-07"), "Mark done"));
    expect(text(q('[aria-label="Mark done"]'))).toContain("A reply is still being sent.");
    await key(q('[aria-label="Mark done"]'), "Escape");
    await click(answerButton(pane("cv-07"), "Failed"));
    await click(buttonNamed(management("cv-07"), "Mark done"));
    expect(buttonNamed(q('[aria-label="Mark done as"]'), "Replied publicly").getAttribute("aria-disabled")).toBe("true");
    await click(buttonNamed(q('[aria-label="Mark done as"]'), "Replied on the platform"));
    expect(text(q("header", pane("cv-07")))).toContain("Done · Replied on the platform");
    expect(text(pane("cv-07"))).toContain("Failed");
  });
});

describe("UX-05 M-1: Details takes focus and covers what is under it", () => {
  it("focus lands on the drawer's title; the reading area under it is inert; Escape gives focus back to the opener", async () => {
    await click(row("cv-10"));
    await click(q("#time-cv-10-m00"));
    const drawer = q('[role="dialog"]', pane("cv-10"));
    expect(drawer.contains(active())).toBe(true);
    expect(active()?.tagName).toBe("H2");
    expect(q("[class*=paneBody]", pane("cv-10")).hasAttribute("inert")).toBe(true);
    // Below 1024 px the page behind is hidden while Details is open (the shell carries the state the CSS reads).
    expect(container.querySelector("[class*=drawerOpen]")).not.toBeNull();
    await key(active() as Element, "Escape");
    expect(q("[class*=paneBody]", pane("cv-10")).hasAttribute("inert")).toBe(false);
    expect(container.querySelector("[class*=drawerOpen]")).toBeNull();
    expect(active()).toBe(q("#time-cv-10-m00"));
  });
});

describe("UX-05 M-2: comments on ads", () => {
  it("public and private replies on an Instagram ad are unavailable with the reason; the post says it is an ad", async () => {
    await click(sideView("Open"));
    await click(row("cv-43"));
    expect(text(pane("cv-43"))).toContain("Ad · replies and moderation not validated yet");
    await click(buttonNamed(article("cv-43-m00"), "Reply privately"));
    expect(text(article("cv-43-m00"))).toContain("Replying to comments on ads isn't validated in Wrenkind yet.");
    await click(buttonNamed(article("cv-43-m00"), "Reply"));
    expect(text(article("cv-43-m00"))).toContain("Replying to comments on ads isn't validated in Wrenkind yet.");
    expect(hasButton(article("cv-43-m00"), "Review reply")).toBe(false);
    expect(hasButton(article("cv-43-m00"), "Simulate publishing")).toBe(false);
  });
});

describe("UX-05 small fixes", () => {
  it("a row that leaves Needs attention for another reason never says 'Reply sent'", async () => {
    await click(row("cv-10"));
    await click(buttonNamed(article("cv-10-m02"), "Hide"));
    await click(answerButton(article("cv-10-m02"), "Confirmed"));
    expect(text(row("cv-10"))).toContain("No longer in Needs attention · leaves this list when you move on");
    expect(text(row("cv-10"))).not.toContain("Reply sent");
  });

  it("one live region: the 'left the list' note is announced once, the toast itself is silent", async () => {
    await click(row("cv-07"));
    await click(buttonNamed(management("cv-07"), "Mark done"));
    await click(buttonNamed(q('[aria-label="Mark done as"]'), "No reply needed"));
    await click(row(listedIds().find((id) => id !== "cv-07") ?? ""));
    expect(text(q("[class*=toast]"))).toContain("It's Done · No reply needed.");
    expect(container.querySelectorAll('[role="status"], [aria-live]')).toHaveLength(1);
    expect(announced()).toContain("It's Done · No reply needed.");
  });

  it("losing label management closes an open Edit row and a Delete confirmation in Settings", async () => {
    await click(buttonNamed(q('nav[aria-label="Comments views"]'), "Manage"));
    await click(buttonNamed(container, "Delete Refund request"));
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    await choose("Role", "agent");
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    await choose("Role", "manager");
    expect(container.querySelector('[role="alertdialog"]')).toBeNull(); // not brought back either
    await click(buttonNamed(container, "Edit Praise"));
    expect(container.querySelector("[class*=editingRow]")).not.toBeNull();
    await choose("Role", "analyst");
    expect(container.querySelector("[class*=editingRow]")).toBeNull();
  });

  it("deleting the label the list is filtered by keeps the selected conversation in its true place", async () => {
    await click(sideView("Open"));
    await click(buttonNamed(q('nav[aria-label="Comments views"]'), "Wholesale lead"));
    await click(row("cv-42"));
    const filteredAt = listedIds().indexOf("cv-42");
    await click(buttonNamed(q('nav[aria-label="Comments views"]'), "Manage"));
    await click(buttonNamed(container, "Delete Wholesale lead"));
    await click(buttonNamed(q('[role="alertdialog"]'), "Delete label"));
    expect(announced()).toMatch(/^Label Wholesale lead deleted\. .* Open: \d+ conversations$/);
    await click(buttonNamed(q('nav[aria-label="Main navigation"]'), "Comments"));
    const pinned = listedIds();
    await click(buttonNamed(pane("cv-42"), "Open")); // Back: the selection (and its pin) ends
    expect(listedIds()).toEqual(pinned);
    expect(pinned.indexOf("cv-42")).not.toBe(filteredAt);
  });

  it("labels carry one tag-shaped marker everywhere (never a round dot); long member names are offered in full", async () => {
    const side = q('nav[aria-label="Comments views"]');
    expect(side.querySelectorAll("svg[data-marker]")).toHaveLength(SEED_LABELS.length);
    await click(row("cv-10"));
    expect(article("cv-10-m00").querySelectorAll('ul[aria-label="Labels"] svg[data-marker]')).toHaveLength(2);
    expect(container.querySelectorAll("span[data-marker]")).toHaveLength(0);
    await click(buttonNamed(management("cv-10"), "BD"));
    expect(hasButton(q('[aria-label="Assign this conversation"]'), "MFMaximiliana Fernández-Etcheverry")).toBe(true);
  });
});

describe("UX-05: header menus close from outside", () => {
  it("a press outside the More menu closes it; a press inside does not; Escape returns focus to More", async () => {
    await click(row("cv-10"));
    const more = buttonNamed(management("cv-10"), "More for this conversation");
    await click(more);
    const menu = q('[aria-label="More for this conversation"][role="group"]');
    await settle(() => menu.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(container.querySelector('[aria-label="More for this conversation"][role="group"]')).not.toBeNull();
    await settle(() => q("[class*=paneBody]", pane("cv-10")).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(container.querySelector('[aria-label="More for this conversation"][role="group"]')).toBeNull();
    await click(more);
    await key(q('[aria-label="More for this conversation"][role="group"]'), "Escape");
    expect(active()).toBe(more);
  });
});

/* ───────────── UX-05-FINALFIX ───────────── */

describe("UX-05-FINALFIX R-1 and the small corrections", () => {
  it("R-1: a Sent reply to camila.r's second comment never resolves the failed reply to her first (same Instagram top level)", async () => {
    await click(sideView("Open"));
    await type(q('[role="search"] input') as HTMLInputElement, "camila"); // beyond the first page of Open: found by search
    await click(row("cv-12"));
    await replyTo("cv-12-m01", "@camila.r thanks for the tip!");
    await click(answerButton(pane("cv-12"), "Failed"));
    expect(text(q("header", pane("cv-12")))).toContain("Needs attention: Reply failed");
    await replyTo("cv-12-m03", "@camila.r good point about grinding fresh.");
    await click(answerButton(pane("cv-12"), "Confirmed"));
    expect(text(q("header", pane("cv-12")))).toContain("Needs attention: Reply failed");
    expect(text(row("cv-12"))).toContain("Reply failed");
    expect(text(pane("cv-12"))).not.toContain("Reply sent. Is the question");
    // Answering the first comment again, confirmed, resolves it.
    await replyTo("cv-12-m01", "@camila.r thanks again!");
    await click(answerButton(pane("cv-12"), "Confirmed"));
    expect(text(q("header", pane("cv-12")))).not.toContain("Reply failed");
  });

  it("no false 'Reply sent' while a newer reply is still Sending: no nudge, and the row names no success", async () => {
    await click(row("cv-07"));
    await replyTo("cv-07-m00", "Both!");
    await click(answerButton(pane("cv-07"), "Confirmed"));
    expect(text(row("cv-07"))).toContain("Reply sent · leaves this list when you move on");
    await replyTo("cv-07-m00", "And the 1 kg bag too.");
    expect(text(pane("cv-07"))).not.toContain("Reply sent. Is the question");
    expect(text(row("cv-07"))).not.toContain("Reply sent");
    expect(text(row("cv-07"))).toContain("No longer in Needs attention");
  });

  it("a long assignee is shown compactly once selected; the full name stays in the title and the accessible name", async () => {
    await click(row("cv-10"));
    await click(buttonNamed(management("cv-10"), "BD"));
    await click(buttonNamed(q('[aria-label="Assign this conversation"]'), "MFMaximiliana"));
    const control = buttonsIn(management("cv-10"))[0] as HTMLButtonElement;
    expect(text(q("[class*=assignName]", control))).toBe("Maximiliana F.");
    expect(control.title).toBe("Assigned to Maximiliana Fernández-Etcheverry");
    expect(named(control)).toContain("(Maximiliana Fernández-Etcheverry), assigned — change");
    expect(text(row("cv-10"))).toContain("Assigned to Maximiliana Fernández-Etcheverry");
  });
});

/* ───────────── UX-06-IMPLEMENT: label colors (Manual v1.1 Amendment 2) ───────────── */

describe("label colors: the approved palette, owned by the workspace label", () => {
  const markerIn = (scope: ParentNode, name: string): string | null => {
    const holder = [...scope.querySelectorAll("li, button, label, span")].find((item) => item.textContent.replace(/\s+/g, " ").trim().startsWith(name) && item.querySelector("svg[data-marker]") !== null);
    return holder?.querySelector("svg[data-marker]")?.getAttribute("data-marker") ?? null;
  };
  const sidebarMarker = (name: string): string | null => buttonNamed(q('nav[aria-label="Comments views"]'), name).querySelector("svg[data-marker]")?.getAttribute("data-marker") ?? null;
  const goSettings = async (): Promise<void> => { await click(buttonNamed(q('nav[aria-label="Main navigation"]'), "Settings")); };
  const goComments = async (): Promise<void> => { await click(buttonNamed(q('nav[aria-label="Main navigation"]'), "Comments")); };
  const pickColor = async (scope: ParentNode, id: string): Promise<void> => { await click(q(`input[type="radio"][value="${id}"]`, scope)); };

  it("seeded colors show the same marker in the sidebar, the row and the comment chip; gray stays the default", async () => {
    expect(sidebarMarker("Refund request")).toBe("magenta");
    expect(sidebarMarker("Delivery")).toBe("gray");
    await click(row("cv-10"));
    expect(markerIn(q('ul[aria-label="Labels"]', article("cv-10-m00")), "Refund request")).toBe("magenta");
    expect(markerIn(q('ul[aria-label="Labels"]', article("cv-10-m00")), "Delivery")).toBe("gray");
    expect(row("cv-10").querySelector('svg[data-marker="magenta"]')).not.toBeNull();
    // Only identifiers in the page: no color value anywhere, no brown.
    expect(container.querySelector('[data-marker="brown"]')).toBeNull();
    expect(container.querySelectorAll('[style*="#"], [style*="rgb"], [fill^="#"]')).toHaveLength(0);
  });

  it("a label created from a comment with a color carries it everywhere at once", async () => {
    await click(row("cv-07"));
    await click(buttonNamed(article("cv-07-m00"), "Label"));
    await click(buttonNamed(container, "Create workspace label…"));
    const panel = q('[role="group"][aria-labelledby]', article("cv-07-m00"));
    await type(q("input:not([type])", panel) as HTMLInputElement, "Supplier inquiry");
    await pickColor(panel, "plum");
    expect((q('input[value="plum"]', panel) as HTMLInputElement).checked).toBe(true);
    await click(buttonNamed(panel, "Create label"));
    expect(markerIn(q('ul[aria-label="Labels"]', article("cv-07-m00")), "Supplier inquiry")).toBe("plum");
    expect(sidebarMarker("Supplier inquiry")).toBe("plum");
    expect(announced()).toContain("Workspace label Supplier inquiry (Plum) created");
  });

  it("Settings: choosing a color previews it; Cancel discards; Save recolors every appearance; Reset to gray restores the default", async () => {
    await goSettings();
    await click(buttonNamed(container, "Edit Follow up Monday"));
    const editing = q("[class*=editingRow]");
    expect(text(editing)).not.toContain("Reset to gray"); // already the default
    await pickColor(editing, "teal");
    expect(editing.querySelector("svg[data-marker]")?.getAttribute("data-marker")).toBe("teal"); // the preview
    await click(buttonNamed(editing, "Cancel"));
    await goComments();
    expect(sidebarMarker("Follow up Monday")).toBe("gray");
    await goSettings();
    await click(buttonNamed(container, "Edit Follow up Monday"));
    await pickColor(q("[class*=editingRow]"), "teal");
    await click(buttonNamed(container, "Save"));
    expect(announced()).toBe("Label Follow up Monday is now Teal.");
    expect(text(q("[class*=settingsTable]"))).toContain("Teal");
    await goComments();
    expect(sidebarMarker("Follow up Monday")).toBe("teal");
    await click(row("cv-10"));
    for (const svg of [...container.querySelectorAll("svg[data-marker]")].filter((item) => item.parentElement?.textContent.includes("Follow up Monday") === true)) expect(svg.getAttribute("data-marker")).toBe("teal");
    await goSettings();
    await click(buttonNamed(container, "Edit Follow up Monday"));
    await click(buttonNamed(q("[class*=editingRow]"), "Reset to gray"));
    expect((q('input[value="gray"]', q("[class*=editingRow]")) as HTMLInputElement).checked).toBe(true);
    await click(buttonNamed(container, "Save"));
    expect(announced()).toBe("Label Follow up Monday reset to gray.");
    await goComments();
    expect(sidebarMarker("Follow up Monday")).toBe("gray");
  });

  it("the color picker is a labelled radio group: each option names its color; the choice is not told by color alone", async () => {
    await goSettings();
    await click(buttonNamed(container, "New label"));
    const group = q("fieldset", q('[role="group"][aria-labelledby]'));
    expect(text(q("legend", group))).toBe("Color");
    expect([...group.querySelectorAll("label")].map((item) => text(item))).toEqual(["Gray (default)", "Teal", "Plum", "Magenta", "Olive"]);
    expect(group.getAttribute("aria-describedby")).not.toBeNull();
    expect(text(group)).toContain("It never means priority, urgency, sentiment or attention.");
    await type(q('input:not([type="radio"])', q('[role="group"][aria-labelledby]')) as HTMLInputElement, "VIP");
    await pickColor(group, "olive");
    await click(buttonNamed(container, "Create label"));
    expect(announced()).toBe("Workspace label VIP (Olive) created");
    expect(text(q("[class*=settingsTable]"))).toMatch(/Olive\s*VIP/);
  });

  it("permissions are unchanged: an Agent sees the colors but cannot change or create them; losing the permission closes the form", async () => {
    await goSettings();
    await click(buttonNamed(container, "Edit Praise"));
    await pickColor(q("[class*=editingRow]"), "magenta");
    await choose("Role", "agent");
    expect(container.querySelector("[class*=editingRow]")).toBeNull();
    expect(container.querySelector('input[type="radio"]')).toBeNull();
    expect(hasButton(container, "Edit")).toBe(false);
    expect(q("[class*=settingsTable]").querySelector('svg[data-marker="plum"]')).not.toBeNull(); // Praise unchanged, still visible
    await goComments();
    await click(row("cv-07"));
    await click(buttonNamed(article("cv-07-m00"), "Label"));
    expect(hasButton(container, "Create workspace label…")).toBe(false);
    expect(q('[aria-label^="Labels on"]').querySelectorAll("svg[data-marker]").length).toBeGreaterThanOrEqual(6);
  });
});

/* ───────────── UX-06-CLOSEOUT: Settings › Labels focus, and the two surviving mutations ───────────── */

describe("Settings › Labels: focus returns to what opened a form, never to the page body", () => {
  const openSettings = async (): Promise<void> => { await click(buttonNamed(q('nav[aria-label="Main navigation"]'), "Settings")); };
  const editButton = (name: string): HTMLButtonElement => buttonNamed(container, `Edit ${name}`);
  const heading = (): HTMLElement => q("h1", q("[class*=settings]"));
  const editingRow = (): HTMLElement | null => container.querySelector<HTMLElement>("[class*=editingRow]");

  it("Save returns focus to the label's Edit control — the same label, under its new name", async () => {
    await openSettings();
    await click(editButton("Follow up Monday"));
    expect(editingRow()?.contains(active())).toBe(true);
    await type(q("input", editingRow() as HTMLElement) as HTMLInputElement, "Follow up later");
    await click(buttonNamed(editingRow() as HTMLElement, "Save"));
    expect(editingRow()).toBeNull();
    expect(active()).toBe(editButton("Follow up later"));
    expect(active()).not.toBe(container.ownerDocument.body);
  });

  it("Cancel and Escape close the editor and return focus to its Edit control", async () => {
    await openSettings();
    await click(editButton("Praise"));
    await click(buttonNamed(editingRow() as HTMLElement, "Cancel"));
    expect(editingRow()).toBeNull();
    expect(active()).toBe(editButton("Praise"));
    await click(editButton("Praise"));
    await key(q("input", editingRow() as HTMLElement), "Escape");
    expect(editingRow()).toBeNull();
    expect(active()).toBe(editButton("Praise"));
    // Escape from the color group too (focus on a radio), with the unsaved color discarded.
    await click(editButton("Praise"));
    await click(q('input[value="olive"]', editingRow() as HTMLElement));
    await key(q('input[value="olive"]', editingRow() as HTMLElement), "Escape");
    expect(active()).toBe(editButton("Praise"));
    expect(q("[class*=settingsTable]").querySelector('svg[data-marker="olive"]')).not.toBeNull(); // Allergens only
    expect(editButton("Praise").closest("tr")?.querySelector("svg")?.getAttribute("data-marker")).toBe("plum");
  });

  it("New label: Create, Cancel and Escape return focus to New label", async () => {
    await openSettings();
    const newLabel = (): HTMLButtonElement => buttonNamed(container, "New label");
    await click(newLabel());
    await click(buttonNamed(q('[role="group"][aria-labelledby]'), "Cancel"));
    expect(active()).toBe(newLabel());
    await click(newLabel());
    await key(q('input:not([type="radio"])', q('[role="group"][aria-labelledby]')), "Escape");
    expect(container.querySelector('[class*=settingsForm][role="group"]')).toBeNull();
    expect(active()).toBe(newLabel());
    await click(newLabel());
    await type(q('input:not([type="radio"])', q('[role="group"][aria-labelledby]')) as HTMLInputElement, "Supplier inquiry");
    await click(buttonNamed(q('[role="group"][aria-labelledby]'), "Create label"));
    expect(active()).toBe(newLabel());
  });

  it("Delete: Cancel and Escape return to Delete; after deleting, the label's control is gone and the heading takes focus", async () => {
    await openSettings();
    const del = (): HTMLButtonElement => buttonNamed(container, "Delete Praise");
    await click(del());
    await click(buttonNamed(q('[role="alertdialog"]'), "Cancel"));
    expect(active()).toBe(del());
    await click(del());
    await key(q('[role="alertdialog"]'), "Escape");
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(active()).toBe(del());
    await click(del());
    await click(buttonNamed(q('[role="alertdialog"]'), "Delete label"));
    expect(hasButton(container, "Delete Praise")).toBe(false);
    expect(active()).toBe(heading());
    expect(heading().getAttribute("tabindex")).toBe("-1");
  });

  it("losing the permission closes the editor without moving focus; regaining it never reopens the editor (mutation A)", async () => {
    await openSettings();
    await click(editButton("Praise"));
    await click(q('input[value="magenta"]', editingRow() as HTMLElement));
    await choose("Role", "agent");
    expect(editingRow()).toBeNull();
    expect(active()).not.toBe(heading()); // a role change is not a person closing the form: focus is not taken
    await choose("Role", "manager");
    expect(editingRow()).toBeNull();
    expect(container.querySelector('input[type="radio"]')).toBeNull();
    expect(editButton("Praise").closest("tr")?.querySelector("svg")?.getAttribute("data-marker")).toBe("plum"); // nothing saved
  });

  it("New label always starts gray, even right after editing a label of another color (mutation B)", async () => {
    await openSettings();
    await click(editButton("Praise"));
    expect((q('input[value="plum"]', editingRow() as HTMLElement) as HTMLInputElement).checked).toBe(true);
    await click(buttonNamed(container, "New label")); // straight from an open editor
    const form = (): HTMLElement => q('[role="group"][aria-labelledby]');
    expect((q('input[value="gray"]', form()) as HTMLInputElement).checked).toBe(true);
    await click(buttonNamed(form(), "Cancel"));
    await click(editButton("Refund request"));
    await click(q('input[value="olive"]', editingRow() as HTMLElement));
    await click(buttonNamed(editingRow() as HTMLElement, "Cancel"));
    await click(buttonNamed(container, "New label")); // after an edit cancelled with another color chosen
    expect((q('input[value="gray"]', form()) as HTMLInputElement).checked).toBe(true);
    expect([...form().querySelectorAll<HTMLInputElement>('input[type="radio"]:checked')].map((input) => input.value)).toEqual(["gray"]);
  });
});
