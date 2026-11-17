// @vitest-environment happy-dom
/**
 * Comments experience redesign (Step 7B-17V) — the prototype in a real client runtime (React + happy-dom), driven
 * the way a person would: clicks, typing, Enter and Escape. Each task counts its steps (one click, one typed text or
 * one key = one step), so the interaction matrix in the design note is a measured, repeatable number — not a claim
 * about human usability, which only a review with people can give. Synthetic data; nothing is read or sent.
 */
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommentsRedesign } from "@/app/dev/ui-reference/comments-redesign/prototype";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root | undefined;
let steps = 0;

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
/** The same, checked to be of one element class. */
const qa = <E extends HTMLElement>(kind: new () => E, selector: string, scope: ParentNode = container): E => {
  const found = q(selector, scope);
  if (!(found instanceof kind)) throw new Error(`not a ${kind.name}: ${selector}`);
  return found;
};
const buttonsIn = (scope: ParentNode): HTMLButtonElement[] => [...scope.querySelectorAll("button")];
const buttonNamed = (scope: ParentNode, text: string): HTMLButtonElement => {
  const found = buttonsIn(scope).find((button) => button.textContent.trim().startsWith(text));
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
};
const article = (commentId: string): HTMLElement => q(`[aria-labelledby="c-${commentId}"]`);
const row = (conversationId: string): HTMLButtonElement => qa(HTMLButtonElement, `#row-${conversationId}`);

async function click(element: HTMLElement): Promise<void> {
  steps += 1;
  await settle(() => { element.click(); });
}
async function type(element: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> {
  steps += 1;
  // React tracks the value through the prototype's setter: set it there (as a person typing would), then announce it.
  const prototype = Object.getPrototypeOf(element) as object;
  await settle(() => {
    Reflect.set(prototype, "value", text, element);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(element: Element, name: string): Promise<void> {
  steps += 1;
  await settle(() => element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
}
/** A prototype control (role, read model…): not counted, it is not part of a task. */
async function choose(label: string, value: string): Promise<void> {
  const select = [...container.querySelectorAll<HTMLSelectElement>('[aria-label="Prototype controls"] select')].find((item) => item.labels[0]?.textContent === label);
  if (select === undefined) throw new Error(label);
  await settle(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const sideLabel = (name: string): HTMLButtonElement => buttonNamed(q('nav[aria-label="Comments views"]'), name);
const listedIds = (): string[] => [...container.querySelectorAll<HTMLButtonElement>("[id^=row-]")].map((button) => button.id.slice(4));

beforeEach(async () => {
  steps = 0;
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

describe("opening and closing a conversation (6.1)", () => {
  it("the whole row header opens Focus inline and the same header closes it: one step each, with the state announced", async () => {
    const header = row("cv-01");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(header.querySelector("svg")).not.toBeNull(); // the chevron
    await click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    const region = q(`#${header.getAttribute("aria-controls") ?? ""}`);
    expect(region.tagName).toBe("SECTION");
    expect(region.getAttribute("aria-labelledby")).toBe("row-cv-01");
    expect(steps).toBe(1);
    await click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("#focus-cv-01")).toBeNull();
    expect(steps).toBe(2);
  });

  it("no interactive element is nested in a row header (one target, no click conflicts)", async () => {
    await click(row("cv-01"));
    for (const header of container.querySelectorAll("[id^=row-]")) expect(header.querySelectorAll("button, a, input, select, textarea, [tabindex]")).toHaveLength(0);
  });

  it("Escape closes the open conversation and returns focus to its header; Previous / Next move focus to the next header", async () => {
    await click(row("cv-01"));
    await click(buttonNamed(q("#focus-cv-01"), "Next"));
    const second = listedIds()[1] ?? "";
    expect(row(second).getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(row(second));
    expect(q(`#focus-${second}`).textContent).toContain("2 of 36");
    await click(buttonNamed(q(`#focus-${second}`), "Previous"));
    expect(document.activeElement).toBe(row("cv-01"));
    await key(q("#focus-cv-01 ol"), "Escape");
    expect(row("cv-01").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(row("cv-01"));
  });
});

describe("content first, context on demand (B, C, F, G)", () => {
  it("understanding a comment and its reply history takes one step: the thread is the first thing after a one-line post context", async () => {
    await click(row("cv-19"));
    expect(steps).toBe(1);
    const focus = q("#focus-cv-19");
    const thread = q("ol", focus);
    expect(thread.querySelectorAll(":scope > li")).toHaveLength(15);
    // Before the thread there is only the one-line context and Previous / Next — no notice paragraphs.
    const before = [...focus.querySelectorAll("*")].filter((element) => !element.contains(thread) && element.compareDocumentPosition(thread) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before.some((element) => element.textContent.includes("Not automatically reviewed"))).toBe(false);
    expect(before.some((element) => element.textContent.includes("isn't available"))).toBe(false);
    // The review status is said once, after the thread.
    expect(focus.textContent.match(/Not automatically reviewed yet/g)).toHaveLength(1);
  });

  it("no per-comment 'Exact times' disclosure; the exact record is one step away from the visible time", async () => {
    await click(row("cv-19"));
    const focus = q("#focus-cv-19");
    expect(focus.textContent).not.toMatch(/Exact times/);
    expect(focus.querySelectorAll("dl")).toHaveLength(1); // the closed "Conversation details" only
    const before = steps;
    await click(q("button[aria-expanded]", article("cv-19-m00")));
    expect(steps - before).toBe(1);
    const facts = q("dl", article("cv-19-m00"));
    expect(facts.textContent).toMatch(/Written on Instagram.*Read by Wrenkind/);
    expect(facts.querySelectorAll("time[datetime]")).toHaveLength(2);
  });

  it("unknown context stays in the conversation details, never as a chip in the header", async () => {
    await click(row("cv-11")); // a post Wrenkind has not read, source not reported
    const focus = q("#focus-cv-11");
    expect(q("p", focus).textContent).toContain("Post not read yet");
    expect(focus.textContent).not.toMatch(/Organic(?! or paid)/);
    expect(q("details dl", focus).textContent).toContain("Not reported by the platform");
  });
});

describe("the publishing account (D, 6.4)", () => {
  it("a published reply shows the verified account name, the Sent state and its time — one step (opening the conversation)", async () => {
    await click(row("cv-02"));
    const sent = q('[aria-labelledby^="r-cv-02-s"]');
    expect(steps).toBe(1);
    expect(sent.textContent).toContain("@lumen.coffee");
    expect(sent.textContent).toContain("Your Instagram account");
    expect(sent.textContent).toContain("Sent");
    expect(sent.querySelector("time[datetime]")).not.toBeNull();
    expect(sent.textContent).not.toContain("joaquin.rv"); // the commenter is not the author of the reply
    // Who pressed Publish is a separate, internal fact.
    await click(q("button[aria-expanded]", sent));
    expect(q("dl", sent).textContent).toMatch(/Published as@lumen\.coffee.*Requested in Wrenkind byAna Ruiz/);
  });

  it("without a verified name (today's read model, or an account without one) the page says 'Your … account', never a made-up name", async () => {
    await choose("Read model", "today");
    await click(row("cv-02"));
    expect(q('[aria-labelledby^="r-cv-02-s"]').textContent).toMatch(/^Your Instagram account/);
    expect(q("#focus-cv-02").textContent).not.toContain("@lumen.coffee");
    await choose("Read model", "planned");
    await click(row("cv-08")); // the account whose name is not available
    expect(article("cv-08-m01").textContent).toMatch(/^Your Instagram account/);
  });
});

describe("actions at the point of work (A, 6.2, 6.6)", () => {
  it("each comment carries Reply · Labels · More, named for that comment; provider actions are unavailable with their reason", async () => {
    await click(row("cv-01"));
    const actions = q('[role="group"]', article("cv-01-m00"));
    expect(actions.getAttribute("aria-label")).toBe("Actions for caro.mendez's comment");
    expect(buttonsIn(actions).map((button) => button.textContent.trim())).toEqual(["Reply", "Labels", "More for caro.mendez's comment"]);
    await click(buttonNamed(actions, "More"));
    const menu = q('[aria-label="More actions"]', article("cv-01-m00"));
    const provider = buttonsIn(menu).filter((button) => button.getAttribute("aria-disabled") === "true");
    expect(provider.map((button) => button.textContent.trim())).toEqual(["Reply privately", "Hide comment"]);
    expect(menu.textContent).toContain("On Instagram");
    expect(menu.textContent).toContain("Not available in Wrenkind yet.");
    expect(menu.textContent).not.toMatch(/Delete|Block/);
  });

  it("Reply explains, at the comment, why replying is unavailable; Monitor-only says so in its own words", async () => {
    await click(row("cv-01"));
    await click(buttonNamed(article("cv-01-m00"), "Reply"));
    expect(article("cv-01-m00").textContent).toContain("Replying from Wrenkind isn't available yet.");
    expect(container.querySelector("textarea")).toBeNull();
    await choose("Workspace", "monitor");
    expect(article("cv-01-m00").textContent).toContain("This workspace is Monitor-only.");
  });

  it("the composer preview cannot publish, and a draft survives closing and reopening the conversation (UX-20)", async () => {
    await choose("Reply", "preview");
    await click(row("cv-01"));
    await click(buttonNamed(article("cv-01-m00"), "Reply"));
    await type(qa(HTMLTextAreaElement, "textarea", article("cv-01-m00")), "We're on it, Caro.");
    await click(row("cv-01"));
    await click(row("cv-01"));
    // Reopened: the composer is where it was, with the unsent text.
    expect(qa(HTMLTextAreaElement, "textarea", article("cv-01-m00")).value).toBe("We're on it, Caro.");
    expect(article("cv-01-m00").textContent).toContain("Draft kept from earlier in this tab.");
    await click(buttonNamed(article("cv-01-m00"), "Review reply"));
    expect(article("cv-01-m00").textContent).toContain("Publishing isn't part of this preview");
    expect(buttonsIn(article("cv-01-m00")).some((button) => /Publish/.test(button.textContent))).toBe(false);
  });
});

describe("manual labels (J, 6.3)", () => {
  it("assign an existing label: 3 steps (Labels, the checkbox — or type + Enter) from an open conversation", async () => {
    await click(row("cv-06"));
    const start = steps;
    await click(buttonNamed(article("cv-06-m00"), "Labels"));
    const box = [...article("cv-06-m00").querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.parentElement?.textContent === "Follow up Monday");
    if (box === undefined) throw new Error("checkbox");
    await click(box);
    expect(steps - start).toBe(2);
    expect(q('ul[aria-label="Labels"]', article("cv-06-m00")).textContent).toContain("Follow up Monday");
    // Keyboard: the field has focus; part of the name + Enter applies the only match.
    const field = qa(HTMLInputElement, 'input:not([type="checkbox"])', article("cv-06-m00"));
    expect(document.activeElement).toBe(field);
    await type(field, "allerg");
    await key(field, "Enter");
    expect(q('ul[aria-label="Labels"]', article("cv-06-m00")).textContent).toContain("Allergens");
  });

  it("create a label from a comment and it is assigned there: Labels, type, Enter (3 steps); the sidebar counts it", async () => {
    await click(row("cv-06"));
    const start = steps;
    await click(buttonNamed(article("cv-06-m00"), "Labels"));
    const field = qa(HTMLInputElement, 'input:not([type="checkbox"])', article("cv-06-m00"));
    await type(field, "Workshop sign-up");
    expect(buttonNamed(article("cv-06-m00"), "Create “Workshop sign-up” and add it")).toBeDefined();
    await key(field, "Enter");
    expect(steps - start).toBe(3);
    expect(q('ul[aria-label="Labels"]', article("cv-06-m00")).textContent).toContain("Workshop sign-up");
    expect(sideLabel("Workshop sign-up").textContent).toMatch(/1$/);
    expect(q('[role="status"]').textContent).toBe("Label Workshop sign-up created and added to Sofía Quiroga's comment");
  });

  it("duplicate and over-long names are refused with a reason; nothing is created", async () => {
    await click(row("cv-06"));
    await click(buttonNamed(article("cv-06-m00"), "Labels"));
    const field = qa(HTMLInputElement, 'input:not([type="checkbox"])', article("cv-06-m00"));
    await type(field, "x".repeat(41));
    await key(field, "Enter");
    expect(q('[role="alert"]', article("cv-06-m00")).textContent).toBe("Use 40 characters or fewer.");
    expect(container.querySelectorAll('nav[aria-label="Comments views"] li')).toHaveLength(7);
  });

  it("several labels per comment, removable from the chip itself; Escape closes the editor and returns focus to Labels", async () => {
    await click(row("cv-10"));
    const chips = q('ul[aria-label="Labels"]', article("cv-10-m00"));
    expect(chips.textContent).toContain("Delivery");
    expect(chips.textContent).toContain("Refund request");
    await click(q('button[aria-label="Remove label Delivery from Ramiro Paz\'s comment"]', article("cv-10-m00")));
    expect(q('ul[aria-label="Labels"]', article("cv-10-m00")).textContent).not.toContain("Delivery");
    const labels = buttonNamed(article("cv-10-m00"), "Labels");
    await click(labels);
    await key(q('[role="group"][aria-label^="Labels for"]', article("cv-10-m00")), "Escape");
    expect(container.querySelector('[aria-label^="Labels for"]')).toBeNull();
    expect(document.activeElement).toBe(labels);
    expect(row("cv-10").getAttribute("aria-expanded")).toBe("true"); // the editor's Escape does not also close Focus
  });

  it("filtering by a label in the sidebar: one step; Previous / Next stay inside the filtered list; the filter is removable", async () => {
    await click(sideLabel("Refund request"));
    expect(steps).toBe(1);
    expect(listedIds().sort()).toEqual(["cv-04", "cv-10", "cv-19", "cv-26", "cv-34"]);
    expect(q("h1").textContent).toBe("Refund request");
    expect(sideLabel("Refund request").getAttribute("aria-current")).toBe("page");
    const first = listedIds()[0] ?? "";
    await click(row(first));
    expect(q(`#focus-${first}`).textContent).toContain("1 of 5");
    await click(q('button[aria-label="Clear the label filter Refund request"]'));
    expect(listedIds()).toHaveLength(36);
    expect(row(first).getAttribute("aria-expanded")).toBe("true"); // still listed, still open
  });

  it("rows show up to two label chips, then +N", async () => {
    await click(row("cv-19"));
    await click(buttonNamed(article("cv-19-m00"), "Labels"));
    for (const name of ["Praise", "Allergens"]) {
      const box = [...article("cv-19-m00").querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.parentElement?.textContent === name);
      if (box !== undefined) await click(box);
    }
    const rowChips = q("[data-row-chips]", row("cv-19"));
    expect(rowChips.querySelectorAll('[aria-hidden="true"]')).toHaveLength(3);
    expect(rowChips.textContent).toMatch(/\+2$/);
    // Read as one sentence inside the header's name: every label, not just the two drawn.
    expect(rowChips.querySelector(".wk-sr-only")?.textContent).toBe("Labels: Delivery, Praise, Allergens, Refund request.");
    expect(row("cv-19").querySelector("ul, li, div, p")).toBeNull(); // phrasing content only inside the button
  });
});

describe("roles (6.3)", () => {
  it("Agent assigns existing labels but cannot create one", async () => {
    await choose("Role", "agent");
    await click(row("cv-06"));
    await click(buttonNamed(article("cv-06-m00"), "Labels"));
    const field = qa(HTMLInputElement, 'input:not([type="checkbox"])', article("cv-06-m00"));
    await type(field, "Brand new");
    expect(buttonsIn(article("cv-06-m00")).some((button) => button.textContent.includes("Create"))).toBe(false);
    expect(article("cv-06-m00").textContent).toContain("Owners, admins and managers create labels.");
    await key(field, "Enter");
    expect(container.querySelectorAll('nav[aria-label="Comments views"] li')).toHaveLength(7);
    expect(buttonsIn(q('nav[aria-label="Comments views"]')).some((button) => button.textContent.includes("New label"))).toBe(false);
  });

  it("Analyst sees labels and filters, but has no Reply or Labels action and no remove control", async () => {
    await choose("Role", "analyst");
    await click(row("cv-01"));
    const actions = q('[role="group"]', article("cv-01-m00"));
    expect(buttonsIn(actions).map((button) => button.textContent.trim())).toEqual(["More for caro.mendez's comment"]);
    expect(q('ul[aria-label="Labels"]', article("cv-01-m00")).querySelectorAll("button")).toHaveLength(0);
    await click(sideLabel("Delivery"));
    expect(listedIds()).toHaveLength(3);
  });

  it("Client guest is denied: no comment, label or account is drawn", async () => {
    await choose("Role", "guest");
    expect(q("h1").textContent).toBe("Comments aren't available to you");
    expect(container.querySelectorAll("[id^=row-]")).toHaveLength(0);
    expect(container.textContent).not.toMatch(/caro\.mendez|Refund request|@lumen\.coffee/);
  });
});
