// @vitest-environment happy-dom
/**
 * Comments experience redesign (Step 7B-17V) — the prototype in a real client runtime (React + happy-dom), driven
 * the way a person would: clicks, typing, Enter and Escape. Each task counts its steps (one click, one typed text or
 * one key = one step), so the interaction matrix in the design note is a measured, repeatable number — not a claim
 * about human usability, which only a review with people can give. Synthetic data; nothing is read or sent.
 * Step 7B-17V-UX: the comment toolbar and platform menus, confirmations, the private-reply reference and the simulated
 * operation states — every one of them labelled as a simulation. Step 7B-17V-UX2: three visible actions (labels moved
 * into More: one more step to reach them), no repeated label or review notices, the source preview, and the
 * two-panel layout next to the expandable list.
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
/** Labels now live in More: More, then "Labels…" (two steps). */
async function openLabels(commentId: string): Promise<void> {
  await click(buttonNamed(article(commentId), "More"));
  await click(buttonNamed(q('[aria-label="More actions"]', article(commentId)), "Labels"));
}
const sideLabel = (name: string): HTMLButtonElement => buttonNamed(q('nav[aria-label="Comments views"]'), name);
const listedIds = (): string[] => [...container.querySelectorAll<HTMLButtonElement>("[id^=row-]")].map((button) => button.id.slice(4));

beforeEach(async () => {
  steps = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // The 17V–UX2 tests read the expandable list; the review default is two panels (UX3), covered below.
  await settle(() => root?.render(h(CommentsRedesign, { initialLayout: "expand" })));
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
    expect(before.some((element) => element.textContent.includes("assessment"))).toBe(false);
    expect(before.some((element) => element.textContent.includes("isn't available"))).toBe(false);
    // The review status is said once for the whole list, never inside a conversation.
    expect(focus.textContent).not.toMatch(/assess/i);
    expect(container.textContent.match(/Automatic assessment isn't on yet/g)).toHaveLength(1);
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
    expect(facts.textContent).toMatch(/Written on Instagram.*Read by Wrenkind.*Private reply(Possible until|Window closed on)/);
    expect(facts.querySelectorAll("time[datetime]")).toHaveLength(3);
  });

  it("unknown context stays in the conversation details, never as a chip in the header", async () => {
    await click(row("cv-11")); // a post Wrenkind has not read, source not reported
    const focus = q("#focus-cv-11");
    expect(q("summary", focus).textContent).toContain("Post not read yet");
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
  it("each comment carries three actions — Reply · Hide · More — named for that comment; Instagram's More has no Like or Block", async () => {
    await click(row("cv-01"));
    const actions = q('[role="group"]', article("cv-01-m00"));
    expect(actions.getAttribute("aria-label")).toBe("Actions for caro.mendez's comment");
    expect(buttonsIn(actions).map((button) => button.textContent.trim())).toEqual(["Reply", "Hide", "More for caro.mendez's comment"]);
    await click(buttonNamed(actions, "More"));
    const menu = q('[aria-label="More actions"]', article("cv-01-m00"));
    expect(menu.textContent).toContain("On InstagramSimulated");
    const platformItems = buttonsIn(menu).map((button) => button.textContent.trim()).filter((name) => !/^(Labels|Details)/.test(name));
    expect(platformItems).toEqual(["Reply privately", "Delete comment…"]);
    // In Wrenkind first (labels, details); no API explanation in an ordinary menu.
    expect(buttonsIn(menu).map((button) => button.textContent.trim()).slice(0, 2)).toEqual(["Labels…2", "Details and exact times"]);
    expect(menu.textContent).not.toMatch(/Like|Block|other apps|API|Graph|v2\d/);
  });

  it("Facebook's More adds Like and Block author; Block is about the author, Delete is about the comment", async () => {
    await click(row("cv-03"));
    await click(buttonNamed(article("cv-03-m00"), "More"));
    const menu = q('[aria-label="More actions"]', article("cv-03-m00"));
    expect(buttonsIn(menu).map((button) => button.textContent.trim()).filter((name) => !/^(Labels|Details)/.test(name))).toEqual(["Reply privately", "Like", "Delete comment…", "Block author…"]);
    expect(menu.textContent).not.toContain("aren't offered");
  });

  it("as in Wrenkind today: Reply explains at the comment why it is unavailable; More's actions are unavailable with their reason; Monitor-only says so in its own words", async () => {
    await choose("Actions", "today");
    await click(row("cv-01"));
    await click(buttonNamed(article("cv-01-m00"), "Reply"));
    expect(article("cv-01-m00").textContent).toContain("Public replies aren't enabled in Wrenkind yet for this content.");
    expect(container.querySelector("textarea")).toBeNull();
    await click(buttonNamed(article("cv-01-m00"), "More"));
    const menu = q('[aria-label="More actions"]', article("cv-01-m00"));
    const unavailable = buttonsIn(menu).filter((button) => button.getAttribute("aria-disabled") === "true");
    expect(unavailable.map((button) => button.textContent.trim())).toEqual(["Reply privately", "Delete comment…"]);
    expect(menu.textContent).toContain("Not available in Wrenkind yet.");
    expect(menu.textContent).not.toContain("Simulated");
    await choose("Workspace", "monitor");
    expect(article("cv-01-m00").textContent).toContain("This workspace is Monitor-only.");
  });

  it("the composer only simulates publishing, and a draft survives closing and reopening the conversation (UX-20)", async () => {
    await click(row("cv-01"));
    await click(buttonNamed(article("cv-01-m00"), "Reply"));
    expect(article("cv-01-m00").textContent).toContain("Preview — nothing is sent");
    await type(qa(HTMLTextAreaElement, "textarea", article("cv-01-m00")), "We're on it, Caro.");
    await click(row("cv-01"));
    await click(row("cv-01"));
    // Reopened: the composer is where it was, with the unsent text.
    expect(qa(HTMLTextAreaElement, "textarea", article("cv-01-m00")).value).toBe("We're on it, Caro.");
    expect(article("cv-01-m00").textContent).toContain("Draft kept from earlier in this tab.");
    await click(buttonNamed(article("cv-01-m00"), "Review reply"));
    expect(article("cv-01-m00").textContent).toContain("Publishing isn't part of this preview");
    expect(buttonsIn(article("cv-01-m00")).some((button) => /^Publish/.test(button.textContent.trim()))).toBe(false);
    expect(buttonNamed(article("cv-01-m00"), "Simulate publishing")).toBeDefined();
  });
});

describe("simulated operations (7B-17V-UX §3, §9): never confused with a real one", () => {
  it("a simulated reply is Sending until a person answers for the platform; Sent says nothing reached Instagram", async () => {
    await click(row("cv-01"));
    await click(buttonNamed(article("cv-01-m00"), "Reply"));
    await type(qa(HTMLTextAreaElement, "textarea", article("cv-01-m00")), "Checking with the courier now.");
    await click(buttonNamed(article("cv-01-m00"), "Review reply"));
    await click(buttonNamed(article("cv-01-m00"), "Simulate publishing"));
    const entry = q("[data-sim-reply]", q("#focus-cv-01"));
    expect(entry.textContent).toContain("Checking with the courier now.");
    expect(entry.textContent).toMatch(/SimulatedSending/);
    expect(entry.textContent).toContain("Simulated — nothing is sent to Instagram.");
    expect(q('[role="status"]').textContent).toBe("Publishing this reply… Simulated — nothing is sent to Instagram.");
    // The answer buttons are prototype controls, named as such.
    const controls = q('[aria-label="Prototype: simulate the platform\'s answer"]', entry);
    expect(buttonsIn(controls).map((button) => button.textContent)).toEqual(["Confirmed", "Failed", "No answer", "Stopped"]);
    await click(buttonNamed(controls, "Confirmed"));
    expect(entry.textContent).toMatch(/SimulatedSent/);
    expect(entry.textContent).toContain("Simulated outcome: published. Nothing was sent to Instagram.");
    expect(row("cv-01").textContent).toContain("You replied 2×");
  });

  it("REPLY_IN_FLIGHT: a second reply to the same comment is refused while the first is Sending or Checking", async () => {
    await click(row("cv-01"));
    await click(buttonNamed(article("cv-01-m00"), "Reply"));
    await type(qa(HTMLTextAreaElement, "textarea", article("cv-01-m00")), "First.");
    await click(buttonNamed(article("cv-01-m00"), "Review reply"));
    await click(buttonNamed(article("cv-01-m00"), "Simulate publishing"));
    await click(buttonNamed(article("cv-01-m00"), "Reply"));
    const refused = "A reply to this comment is on its way or being checked. You can write another once its outcome is known.";
    expect(article("cv-01-m00").textContent).toContain(refused);
    const entry = q("[data-sim-reply]", q("#focus-cv-01"));
    await click(buttonNamed(entry, "No answer"));
    expect(entry.textContent).toMatch(/SimulatedChecking/);
    expect(entry.textContent).toContain("It may already be public");
    expect(article("cv-01-m00").textContent).toContain(refused);
    await click(buttonNamed(entry, "It didn't"));
    expect(entry.textContent).toMatch(/SimulatedFailed/);
    expect(article("cv-01-m00").querySelector("textarea")).not.toBeNull();
  });

  it("Hide is one step and shows Unhide afterwards; the hidden state is marked simulated, in the thread and in the row", async () => {
    await click(row("cv-03"));
    await click(buttonNamed(article("cv-03-m00"), "Hide"));
    expect(article("cv-03-m00").textContent).toContain("Hiding this comment… Simulated — nothing is sent to Facebook.");
    expect(article("cv-03-m00").textContent).not.toContain("Hidden on Facebook");
    expect(buttonNamed(article("cv-03-m00"), "More").getAttribute("aria-expanded")).toBe("false");
    // While it is on its way, another platform action on the comment waits.
    await click(buttonNamed(q('[role="group"]', article("cv-03-m00")), "Hide"));
    expect(article("cv-03-m00").textContent).toContain("Another action on this comment is still waiting for its outcome.");
    await click(buttonNamed(article("cv-03-m00"), "Confirmed"));
    expect(article("cv-03-m00").textContent).toContain("Hidden on Facebook (simulated)");
    expect(buttonsIn(q('[role="group"]', article("cv-03-m00"))).map((button) => button.textContent.trim())).toContain("Unhide");
    expect(row("cv-03").textContent).toContain("Hidden (simulated)");
  });

  it("Delete asks first, with its consequences; Cancel changes nothing; after a simulated delete no platform action is left", async () => {
    await click(row("cv-03"));
    await click(buttonNamed(article("cv-03-m00"), "More"));
    await click(buttonNamed(article("cv-03-m00"), "Delete comment…"));
    const confirm = q('[role="group"][aria-labelledby]', article("cv-03-m00"));
    expect(confirm.textContent).toContain("Delete Martina Gómez's comment from Facebook?");
    expect(confirm.textContent).toContain("can't be restored there");
    expect(confirm.textContent).toContain("Simulated: nothing is sent to Facebook.");
    expect(document.activeElement?.textContent).toBe("Cancel"); // the safe choice has focus
    await click(buttonNamed(confirm, "Cancel"));
    expect(article("cv-03-m00").textContent).not.toContain("Deleting");
    expect(document.activeElement).toBe(buttonNamed(article("cv-03-m00"), "More"));
    await click(buttonNamed(article("cv-03-m00"), "More"));
    await click(buttonNamed(article("cv-03-m00"), "Delete comment…"));
    await click(buttonNamed(q('[role="group"][aria-labelledby]', article("cv-03-m00")), "Delete comment"));
    await click(buttonNamed(article("cv-03-m00"), "Confirmed"));
    expect(article("cv-03-m00").textContent).toContain("Deleted from Facebook (simulated)");
    expect(buttonsIn(q('[role="group"]', article("cv-03-m00"))).map((button) => button.textContent.trim())).toEqual(["More for Martina Gómez's comment"]);
  });

  it("Block author (Facebook) is confirmed as an action on the person: every comment by them is marked; Unblock promises no fixed cooldown", async () => {
    await click(row("cv-03"));
    await click(buttonNamed(article("cv-03-m00"), "More"));
    await click(buttonNamed(article("cv-03-m00"), "Block author…"));
    const confirm = q('[role="group"][aria-labelledby]', article("cv-03-m00"));
    expect(confirm.textContent).toContain("Block Martina Gómez from Lumen Coffee?");
    expect(confirm.textContent).toContain("This acts on the person, not on this comment");
    expect(confirm.textContent).not.toMatch(/author's ID|API/); // the API detail lives in the capability reference
    await click(buttonNamed(confirm, "Block author"));
    await click(buttonNamed(article("cv-03-m00"), "Confirmed"));
    for (const id of ["cv-03-m00", "cv-03-m02"]) expect(article(id).textContent).toContain("Martina Gómez blocked by Lumen Coffee (simulated)");
    expect(article("cv-03-m01").textContent).not.toContain("blocked");
    await click(buttonNamed(article("cv-03-m02"), "More"));
    await click(buttonNamed(article("cv-03-m02"), "Unblock author…"));
    const unblock = q('[role="group"][aria-labelledby]', article("cv-03-m02"));
    expect(unblock.textContent).toContain("Facebook may refuse it for a while");
    expect(unblock.textContent).not.toMatch(/48|hours/);
  });

  it("Instagram keeps the root: replying to a reply is composed under the top-level comment and names the person", async () => {
    await click(row("cv-19"));
    await click(buttonNamed(article("cv-19-m01"), "Reply"));
    expect(article("cv-19-m01").textContent).toContain("Instagram attaches replies to the top-level comment: this reply would appear under renata.soto's comment, naming fran.gil.");
    expect(qa(HTMLTextAreaElement, "textarea", article("cv-19-m01")).value).toBe("@fran.gil ");
    expect(buttonNamed(article("cv-19-m01"), "Review reply").disabled).toBe(true);
  });
});

describe("private replies (7B-17V-UX §6)", () => {
  it("explain the one-message, seven-day rule and that there is no inbox; one sent, no second one is offered", async () => {
    await click(row("cv-03"));
    await click(buttonNamed(article("cv-03-m00"), "More"));
    await click(buttonNamed(article("cv-03-m00"), "Reply privately"));
    const area = q('[role="group"][aria-labelledby]', article("cv-03-m00"));
    expect(area.textContent).toContain("Reply privately to Martina GómezSimulated");
    expect(area.textContent).toContain("One per comment, within 7 days of it");
    expect(area.textContent).toContain("continues in Facebook's own messages");
    expect(area.textContent).toContain("Wrenkind has no message inbox");
    await type(qa(HTMLTextAreaElement, "textarea", area), "Hola Martina, te escribimos por acá.");
    await click(buttonNamed(area, "Simulate sending"));
    await click(buttonNamed(article("cv-03-m00"), "Confirmed"));
    expect(article("cv-03-m00").textContent).toContain("Private reply to Martina Gómez");
    expect(q("#focus-cv-03 ol").querySelector("[data-sim-reply]")).toBeNull(); // never in the public thread
    await click(buttonNamed(article("cv-03-m00"), "More"));
    const menu = q('[aria-label="More actions"]', article("cv-03-m00"));
    expect(buttonNamed(menu, "Reply privately").getAttribute("aria-disabled")).toBe("true");
    expect(menu.textContent).toContain("A private reply was already sent for this comment. Only one is allowed.");
  });

  it("past seven days the private reply is unavailable, with the reason", async () => {
    await click(row("cv-36"));
    await click(buttonNamed(article("cv-36-m00"), "More"));
    const menu = q('[aria-label="More actions"]', article("cv-36-m00"));
    expect(buttonNamed(menu, "Reply privately").getAttribute("aria-disabled")).toBe("true");
    expect(menu.textContent).toContain("Private replies can only be sent within 7 days of the comment.");
  });
});

describe("platform restrictions and connection health are different reasons (7B-17V-UX §5)", () => {
  it("an Instagram live video: the post preview says so, and each action gives its reason when pressed — never a connection problem", async () => {
    await click(row("cv-27"));
    expect(q("#focus-cv-27 summary").textContent).toContain("Managed in the Instagram app");
    expect(q("#focus-cv-27").querySelector("[data-cause]")).toBeNull(); // no banner for a platform context
    await click(buttonNamed(article("cv-27-m00"), "Hide"));
    expect(article("cv-27-m00").textContent).toContain("Hide unavailable. Comments on live videos can only be managed in the Instagram app.");
    expect(article("cv-27-m00").textContent).not.toContain("Hiding");
  });

  it("a post another account owns: no Hide or Delete; an ad: moderation not assumed", async () => {
    await click(row("cv-35"));
    expect(q("#focus-cv-35 summary").textContent).toContain("Posted by @brunch.club.ba");
    await click(buttonNamed(article("cv-35-m00"), "More"));
    expect(q('[aria-label="More actions"]', article("cv-35-m00")).textContent).toContain("Only @brunch.club.ba, who posted this, can hide or delete its comments.");
    await click(row("cv-28"));
    await click(buttonNamed(article("cv-28-m00"), "Hide"));
    expect(article("cv-28-m00").textContent).toContain("Not available yet for comments on ads.");
  });

  it("a connection that needs attention blocks actions with its recovery; healthy again, they are offered", async () => {
    await click(row("cv-06"));
    expect(q("#focus-cv-06").textContent).toContain("Lumen Coffee Eventos needs to be reconnected.");
    await click(buttonNamed(article("cv-06-m00"), "Hide"));
    expect(article("cv-06-m00").textContent).toContain("Reconnect Lumen Coffee Eventos to act on its comments.");
    await choose("Connections", "healthy");
    expect(q("#focus-cv-06").textContent).not.toContain("needs to be reconnected");
    expect(buttonNamed(q('[role="group"]', article("cv-06-m00")), "Hide").getAttribute("aria-disabled")).toBeNull();
  });
});

describe("assessments, labels and the capability reference", () => {
  it("synthetic assessments are round, separate from a person's labels; hiding a protected comment asks first, with a caution", async () => {
    await choose("Assessments", "examples");
    await click(row("cv-03"));
    await click(row("cv-10"));
    const comment = article("cv-10-m00");
    expect(comment.textContent).toContain("Automatic assessment, synthetic example: Complaint· never auto-hidden");
    expect(q('ul[aria-label="Labels"]', comment).textContent).not.toContain("Complaint");
    await click(buttonNamed(q('[role="group"]', comment), "Hide"));
    const confirm = q('[role="group"][aria-labelledby]', comment);
    expect(confirm.textContent).toContain("Assessed as “Complaint” (synthetic example). Wrenkind never hides or removes these automatically");
    expect(comment.textContent).not.toContain("Hiding this comment");
    expect(q("#focus-cv-10").textContent).not.toContain("synthetic examples: Wrenkind");
    expect(q("#comments-main > header").textContent).toContain("Assessments shown are synthetic examples");
  });

  it("labels are said once, on their comments: no conversation-level summary; a conversation without labels has no label clutter", async () => {
    await click(row("cv-19"));
    expect(q("#focus-cv-19").textContent).not.toContain("Labels on comments here");
    expect(q('ul[aria-label="Labels"]', article("cv-19-m05")).textContent).toBe("DeliveryRefund request");
    await click(row("cv-07"));
    expect(q("#focus-cv-07").querySelector('ul[aria-label="Labels"]')).toBeNull();
    expect(row("cv-07").querySelector("[data-row-chips]")).toBeNull();
  });

  it("the prototype says, at all times, that actions are simulated; the capability reference separates Meta, Wrenkind and the prototype", async () => {
    expect(q('[aria-label="Prototype controls"]').textContent).toContain("Facebook and Instagram actions are simulated in this tab. Nothing is sent to Meta");
    await click(q("summary", q("table").closest("details") ?? container));
    const matrix = q("table");
    expect(matrix.closest("details")?.open).toBe(true);
    const rowText = (name: string, platform: string): string => [...matrix.querySelectorAll("tbody tr")].find((tr) => tr.querySelector("th")?.textContent.startsWith(name) === true && tr.textContent.includes(platform))?.textContent ?? "";
    expect(rowText("Public reply", "Instagram")).toMatch(/Documented, with limits.*Built, turned off.*Simulated here/);
    expect(rowText("Like / unlike", "Instagram")).toMatch(/Not documented.*Not built.*Not offered/);
    expect(rowText("Block / unblock author", "Facebook")).toMatch(/Documented, with limits.*Not built.*Simulated here/);
    expect(q("table").closest("details")?.textContent).toContain("There is no Mute.");
  });
});

describe("manual labels (J, 6.3)", () => {
  it("assign an existing label: 3 steps (More, Labels…, the checkbox — or type + Enter) from an open conversation", async () => {
    await click(row("cv-06"));
    const start = steps;
    await openLabels("cv-06-m00");
    const box = [...article("cv-06-m00").querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.parentElement?.textContent === "Follow up Monday");
    if (box === undefined) throw new Error("checkbox");
    await click(box);
    expect(steps - start).toBe(3);
    expect(q('ul[aria-label="Labels"]', article("cv-06-m00")).textContent).toContain("Follow up Monday");
    // Keyboard: the field has focus; the exact name + Enter applies it (UX4: a partial name never does — see below).
    const field = qa(HTMLInputElement, 'input:not([type="checkbox"])', article("cv-06-m00"));
    expect(document.activeElement).toBe(field);
    await type(field, "allergens");
    await key(field, "Enter");
    expect(q('ul[aria-label="Labels"]', article("cv-06-m00")).textContent).toContain("Allergens");
  });

  it("create a label from a comment and it is assigned there: More, Labels…, type, Enter (4 steps); the sidebar counts it", async () => {
    await click(row("cv-06"));
    const start = steps;
    await openLabels("cv-06-m00");
    const field = qa(HTMLInputElement, 'input:not([type="checkbox"])', article("cv-06-m00"));
    await type(field, "Workshop sign-up");
    expect(buttonNamed(article("cv-06-m00"), "Create “Workshop sign-up” and add it")).toBeDefined();
    await key(field, "Enter");
    expect(steps - start).toBe(4);
    expect(q('ul[aria-label="Labels"]', article("cv-06-m00")).textContent).toContain("Workshop sign-up");
    expect(sideLabel("Workshop sign-up").textContent).toMatch(/1$/);
    expect(q('[role="status"]').textContent).toBe("Label Workshop sign-up created and added to Sofía Quiroga's comment");
  });

  it("duplicate and over-long names are refused with a reason; nothing is created", async () => {
    await click(row("cv-06"));
    await openLabels("cv-06-m00");
    const field = qa(HTMLInputElement, 'input:not([type="checkbox"])', article("cv-06-m00"));
    await type(field, "x".repeat(41));
    await key(field, "Enter");
    expect(q('[role="alert"]', article("cv-06-m00")).textContent).toBe("Use 40 characters or fewer.");
    expect(container.querySelectorAll('nav[aria-label="Comments views"] li')).toHaveLength(7);
  });

  it("several labels per comment, removable from the chip itself; Escape closes the editor and returns focus to More", async () => {
    await click(row("cv-10"));
    const chips = q('ul[aria-label="Labels"]', article("cv-10-m00"));
    expect(chips.textContent).toContain("Delivery");
    expect(chips.textContent).toContain("Refund request");
    await click(q('button[aria-label="Remove label Delivery from Ramiro Paz\'s comment"]', article("cv-10-m00")));
    expect(q('ul[aria-label="Labels"]', article("cv-10-m00")).textContent).not.toContain("Delivery");
    await openLabels("cv-10-m00");
    await key(q('[role="group"][aria-label^="Labels for"]', article("cv-10-m00")), "Escape");
    expect(container.querySelector('[aria-label^="Labels for"]')).toBeNull();
    expect(document.activeElement).toBe(buttonNamed(article("cv-10-m00"), "More"));
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
    await openLabels("cv-19-m00");
    for (const name of ["Praise", "Allergens"]) {
      const box = [...article("cv-19-m00").querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.parentElement?.textContent === name);
      if (box !== undefined) await click(box);
    }
    const rowChips = q("[data-row-chips]", row("cv-19"));
    expect(rowChips.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(3);
    expect(rowChips.textContent).toMatch(/\+2$/);
    // Read as one sentence inside the header's name: every label, not just the two drawn, and where they are.
    expect(rowChips.querySelector(".wk-sr-only")?.textContent).toBe("Labels on comments in this conversation: Delivery, Praise, Allergens, Refund request.");
    expect(row("cv-19").querySelector("ul, li, div, p")).toBeNull(); // phrasing content only inside the button
  });
});

describe("roles (6.3)", () => {
  it("Agent (Responder) replies, hides, likes and replies privately, but has no Delete or Block without a grant", async () => {
    await choose("Role", "agent");
    await click(row("cv-03"));
    await click(buttonNamed(article("cv-03-m00"), "More"));
    const menu = q('[aria-label="More actions"]', article("cv-03-m00"));
    expect(buttonsIn(menu).map((button) => button.textContent.trim()).filter((name) => !/^(Labels|Details)/.test(name))).toEqual(["Reply privately", "Like"]);
  });

  it("Agent assigns existing labels but cannot create one", async () => {
    await choose("Role", "agent");
    await click(row("cv-06"));
    await openLabels("cv-06-m00");
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

describe("UX2: time, collapse, source preview", () => {
  it("the header's time is the conversation's latest activity; every comment and reply keeps its own time", async () => {
    expect(row("cv-02").textContent).toContain("Latest activity");
    await click(row("cv-02"));
    const thread = q("#focus-cv-02 ol");
    expect(thread.querySelectorAll(":scope > li")).toHaveLength(2);
    for (const entry of thread.querySelectorAll(":scope > li")) expect(entry.querySelector("time[datetime]"), entry.textContent).not.toBeNull();
  });

  it("collapsing says Collapse — not Close, nothing implies the case is resolved — and returns focus to the row", async () => {
    await click(row("cv-01"));
    expect(q("#focus-cv-01").textContent).not.toMatch(/Close conversation|Resolve|Done/);
    const collapse = buttonNamed(q("#focus-cv-01"), "Collapse");
    expect(collapse.textContent).toContain("nothing about it changes");
    await click(collapse);
    expect(row("cv-01").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(row("cv-01"));
  });

  it("the source preview names the kind and the source plainly and draws no media", async () => {
    await click(row("cv-02"));
    expect(q("#focus-cv-02 summary").textContent).toMatch(/^ReelOrganic“The holiday blend is back/);
    await click(row("cv-19"));
    expect(q("#focus-cv-19 summary").textContent).toMatch(/^AdPaid“Your first subscription box ships free\.”/);
    await click(row("cv-11"));
    expect(q("#focus-cv-11 summary").textContent).toMatch(/^PostSource not reportedPost not read yet/);
    expect(container.querySelectorAll("img, video, picture")).toHaveLength(0);
    expect(q("#focus-cv-11 details dl").textContent).toContain("MediaNot retrieved — no image or video is shown");
  });
});

describe("UX2: the two-panel layout, next to the expandable list", () => {
  it("a row selects its conversation into the panel beside the list; another row replaces it; Next moves; Back to list deselects", async () => {
    await choose("Layout", "split");
    expect(container.textContent).toContain("Select a conversation to read it here.");
    await click(row("cv-01"));
    expect(row("cv-01").getAttribute("aria-current")).toBe("true");
    expect(row("cv-01").hasAttribute("aria-expanded")).toBe(false);
    const pane = q("#focus-cv-01");
    expect(pane.closest("li")).toBeNull(); // beside the list, not inside the row
    expect(q("h2", pane).textContent).toContain("caro.mendez");
    expect(pane.textContent).not.toContain("Collapse");
    await click(row("cv-03"));
    expect(container.querySelector("#focus-cv-01")).toBeNull();
    expect(row("cv-03").getAttribute("aria-current")).toBe("true");
    await click(buttonNamed(q("#focus-cv-03"), "Next"));
    const third = listedIds()[3] ?? "";
    expect(row(third).getAttribute("aria-current")).toBe("true");
    await click(buttonNamed(q(`#focus-${third}`), "Back to list"));
    expect(container.querySelector("[aria-current=true][id^=row-]")).toBeNull();
    expect(document.activeElement).toBe(row(third));
  });

  it("the comment actions are the same in both layouts", async () => {
    await choose("Layout", "split");
    await click(row("cv-03"));
    expect(buttonsIn(q('[role="group"]', article("cv-03-m00"))).map((button) => button.textContent.trim())).toEqual(["Reply", "Hide", "More for Martina Gómez's comment"]);
    await click(buttonNamed(article("cv-03-m00"), "Hide"));
    await click(buttonNamed(article("cv-03-m00"), "Confirmed"));
    expect(article("cv-03-m00").textContent).toContain("Hidden on Facebook (simulated)");
  });
});

describe("UX3: two panels first, the theme through the product's own override", () => {
  it("rendered as the page renders it, the prototype opens in two panels", async () => {
    // A fresh root: React keeps a mounted component's state, so the default is read on a new mount.
    await settle(() => root?.unmount());
    root = createRoot(container);
    await settle(() => root?.render(h(CommentsRedesign)));
    expect(container.textContent).toContain("Select a conversation to read it here.");
    expect(row("cv-01").hasAttribute("aria-expanded")).toBe(false);
  });

  it("System sets nothing; Light and Dark set data-theme on <html>; System or leaving puts back what was there", async () => {
    const html = document.documentElement;
    html.removeAttribute("data-theme");
    expect(html.hasAttribute("data-theme")).toBe(false);
    await choose("Theme", "light");
    expect(html.getAttribute("data-theme")).toBe("light");
    await choose("Theme", "dark");
    expect(html.getAttribute("data-theme")).toBe("dark");
    await choose("Theme", "system");
    expect(html.hasAttribute("data-theme")).toBe(false);
    // An attribute set by someone else (a future persisted preference) is restored, not erased.
    html.setAttribute("data-theme", "light");
    await choose("Theme", "dark");
    expect(html.getAttribute("data-theme")).toBe("dark");
    await settle(() => root?.unmount());
    root = undefined;
    expect(html.getAttribute("data-theme")).toBe("light");
    html.removeAttribute("data-theme");
  });
});

/* ───────────── Step 7B-17V-UX4: regressions for the independent audit (7B-17V-AUDIT) ───────────── */

const opsShown = (commentId: string): number => article(commentId).querySelectorAll("[data-op-status]").length;

describe("UX4 H-1: every operation is revalidated when it starts; stale panels never act", () => {
  it("a Delete confirmation left open when the workspace becomes Monitor-only can no longer delete", async () => {
    await click(row("cv-03"));
    await click(buttonNamed(article("cv-03-m00"), "More"));
    await click(buttonNamed(article("cv-03-m00"), "Delete comment…"));
    expect(buttonNamed(article("cv-03-m00"), "Delete comment")).toBeDefined();
    await choose("Workspace", "monitor");
    expect(article("cv-03-m00").textContent).toContain("No longer possible. This workspace is Monitor-only.");
    expect(buttonsIn(article("cv-03-m00")).some((button) => button.textContent.trim() === "Delete comment")).toBe(false);
    expect(opsShown("cv-03-m00")).toBe(0);
  });

  it("a Block confirmation left open when the role changes to Agent (no block permission) can no longer block", async () => {
    await click(row("cv-03"));
    await click(buttonNamed(article("cv-03-m00"), "More"));
    await click(buttonNamed(article("cv-03-m00"), "Block author…"));
    await choose("Role", "agent");
    expect(article("cv-03-m00").textContent).toContain("No longer possible.");
    expect(buttonsIn(article("cv-03-m00")).some((button) => button.textContent.trim() === "Block author")).toBe(false);
    expect(article("cv-03-m00").textContent).not.toContain("blocked by");
  });

  it("'Try again' disappears when retrying is no longer allowed, and comes back when it is", async () => {
    await click(row("cv-03"));
    await click(buttonNamed(article("cv-03-m00"), "Hide"));
    await click(buttonNamed(article("cv-03-m00"), "Failed"));
    expect(buttonNamed(article("cv-03-m00"), "Try again")).toBeDefined();
    await choose("Workspace", "monitor");
    expect(buttonsIn(article("cv-03-m00")).some((button) => button.textContent.trim() === "Try again")).toBe(false);
    await choose("Workspace", "standard");
    expect(buttonNamed(article("cv-03-m00"), "Try again")).toBeDefined();
  });

  it("a reply under review cannot be simulated after the workspace becomes Monitor-only; the draft is kept", async () => {
    await click(row("cv-03"));
    await click(buttonNamed(article("cv-03-m00"), "Reply"));
    await type(qa(HTMLTextAreaElement, "textarea", article("cv-03-m00")), "Sí, en Palermo también.");
    await click(buttonNamed(article("cv-03-m00"), "Review reply"));
    await choose("Workspace", "monitor");
    expect(article("cv-03-m00").textContent).toContain("Reply unavailable. This workspace is Monitor-only.");
    expect(buttonsIn(article("cv-03-m00")).some((button) => button.textContent.includes("Simulate publishing"))).toBe(false);
    expect(container.querySelector("[data-sim-reply]")).toBeNull();
    await choose("Workspace", "standard");
    // Back where it was: the review of the same, unsent text.
    expect(article("cv-03-m00").textContent).toContain("Sí, en Palermo también.");
    expect(buttonNamed(article("cv-03-m00"), "Simulate publishing")).toBeDefined();
  });

  it("a private reply composer left open when actions switch to 'as in Wrenkind today' can no longer send", async () => {
    await click(row("cv-03"));
    await click(buttonNamed(article("cv-03-m00"), "More"));
    await click(buttonNamed(article("cv-03-m00"), "Reply privately"));
    await choose("Actions", "today");
    expect(article("cv-03-m00").textContent).toContain("No longer possible. Not available in Wrenkind yet.");
    expect(buttonsIn(article("cv-03-m00")).some((button) => button.textContent.includes("Simulate sending"))).toBe(false);
  });

  it("the labels editor closes for a role that cannot assign labels", async () => {
    await click(row("cv-03"));
    await openLabels("cv-03-m00");
    await choose("Role", "analyst");
    expect(article("cv-03-m00").querySelector('[aria-label^="Labels for"]')).toBeNull();
  });
});

describe("UX4 H-2 and M-1: two panels — a fresh panel per conversation, focus stays in the panel", () => {
  it("open post details do not carry over to the next conversation; the panel is a new one", async () => {
    await choose("Layout", "split");
    await click(row("cv-03"));
    const firstPane = q("#focus-cv-03");
    const details = q("details", firstPane);
    await click(q("summary", details));
    expect(qa(HTMLDetailsElement, "details", firstPane).open).toBe(true);
    await click(buttonNamed(firstPane, "Next"));
    const next = listedIds()[3] ?? "";
    const pane = q(`#focus-${next}`);
    expect(pane).not.toBe(firstPane);
    expect(qa(HTMLDetailsElement, "details", pane).open).toBe(false);
    expect(pane.scrollTop).toBe(0);
  });

  it("Previous / Next keep focus on the same control in the new conversation, never on a row of the list", async () => {
    await choose("Layout", "split");
    await click(row("cv-01"));
    await click(buttonNamed(q("#focus-cv-01"), "Next"));
    const second = listedIds()[1] ?? "";
    expect(document.activeElement).toBe(buttonNamed(q(`#focus-${second}`), "Next"));
    expect(document.activeElement?.id.startsWith("row-")).toBe(false);
    await click(buttonNamed(q(`#focus-${second}`), "Previous"));
    // At the first conversation Previous is disabled: focus goes to the conversation's title in the panel.
    expect(document.activeElement).toBe(q("#pane-cv-01"));
  });

  it("Escape in two panels keeps the conversation selected and returns focus to its row", async () => {
    await choose("Layout", "split");
    await click(row("cv-01"));
    await key(q("#focus-cv-01 ol"), "Escape");
    expect(row("cv-01").getAttribute("aria-current")).toBe("true");
    expect(container.querySelector("#focus-cv-01")).not.toBeNull();
    expect(document.activeElement).toBe(row("cv-01"));
  });
});

describe("UX4 M-2: focus always lands on a control that exists", () => {
  it("More → Details and exact times returns focus to More", async () => {
    await click(row("cv-03"));
    await click(buttonNamed(article("cv-03-m00"), "More"));
    await click(buttonNamed(article("cv-03-m00"), "Details and exact times"));
    expect(q("dl", article("cv-03-m00"))).toBeDefined();
    expect(document.activeElement).toBe(buttonNamed(article("cv-03-m00"), "More"));
  });

  it("removing a label chip moves focus to the next chip, then to More when none is left", async () => {
    await click(row("cv-10"));
    await click(q('button[aria-label="Remove label Delivery from Ramiro Paz\'s comment"]', article("cv-10-m00")));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Remove label Refund request from Ramiro Paz's comment");
    await click(document.activeElement as HTMLElement);
    expect(document.activeElement).toBe(buttonNamed(article("cv-10-m00"), "More"));
  });

  it("confirming moves focus to More (not to the simulated answers: Enter twice cannot answer); settling hands it back to the comment", async () => {
    await click(row("cv-03"));
    await click(buttonNamed(article("cv-03-m00"), "More"));
    await click(buttonNamed(article("cv-03-m00"), "Delete comment…"));
    await click(buttonNamed(q('[role="group"][aria-labelledby]', article("cv-03-m00")), "Delete comment"));
    expect(document.activeElement).toBe(buttonNamed(article("cv-03-m00"), "More"));
    expect(document.activeElement?.closest('[aria-label^="Prototype"]')).toBeNull();
    // A second Enter on More only opens the menu; the deletion is still waiting for an explicit answer.
    await key(document.activeElement as HTMLElement, "Enter");
    expect(article("cv-03-m00").textContent).toContain("Deleting this comment… Simulated");
    await click(buttonNamed(article("cv-03-m00"), "No answer"));
    expect(document.activeElement?.textContent).toBe("It went through");
    await click(buttonNamed(article("cv-03-m00"), "It went through"));
    expect(document.activeElement).toBe(buttonNamed(article("cv-03-m00"), "More"));
  });

  it("a confirmed hide focuses the toggle, now Unhide; a confirmed reply focuses the reply itself", async () => {
    await click(row("cv-03"));
    await click(buttonNamed(article("cv-03-m00"), "Hide"));
    const toggle = buttonsIn(q('[role="group"]', article("cv-03-m00")))[1];
    expect(document.activeElement).toBe(toggle); // while waiting it says why it can't be pressed again
    expect(toggle?.getAttribute("aria-disabled")).toBe("true");
    await click(buttonNamed(article("cv-03-m00"), "Confirmed"));
    expect(document.activeElement?.textContent.trim()).toBe("Unhide");
    await click(buttonNamed(article("cv-03-m02"), "Reply"));
    await type(qa(HTMLTextAreaElement, "textarea", article("cv-03-m02")), "Gracias, Martina.");
    await click(buttonNamed(article("cv-03-m02"), "Review reply"));
    await click(buttonNamed(article("cv-03-m02"), "Simulate publishing"));
    expect(document.activeElement?.textContent.trim()).toBe("Reply");
    const entry = q("[data-sim-reply]");
    await click(buttonNamed(entry, "Confirmed"));
    expect(document.activeElement).toBe(q("article", entry));
  });
});

describe("UX4 M-3: Enter on a label name acts only on an exact name", () => {
  it("a partial name never toggles an existing label ('Refund' keeps 'Refund request') and creates nothing", async () => {
    await click(row("cv-04"));
    await openLabels("cv-04-m00");
    const field = qa(HTMLInputElement, 'input:not([type="checkbox"])', article("cv-04-m00"));
    await type(field, "Refund");
    await key(field, "Enter");
    expect(q('ul[aria-label="Labels"]', article("cv-04-m00")).textContent).toContain("Refund request");
    expect(container.querySelectorAll('nav[aria-label="Comments views"] li')).toHaveLength(7);
    expect(article("cv-04-m00").textContent).toContain("Enter only adds an exact name.");
  });

  it("the exact name toggles (either case); a name matching nothing is created and added", async () => {
    await click(row("cv-04"));
    await openLabels("cv-04-m00");
    const field = qa(HTMLInputElement, 'input:not([type="checkbox"])', article("cv-04-m00"));
    await type(field, "refund REQUEST");
    await key(field, "Enter");
    expect(article("cv-04-m00").querySelector('ul[aria-label="Labels"]')).toBeNull();
    await type(field, "Courier issue");
    await key(field, "Enter");
    expect(q('ul[aria-label="Labels"]', article("cv-04-m00")).textContent).toBe("Courier issue");
  });
});

describe("UX4 M-4: a filtered list never keeps a conversation that left it", () => {
  it("removing the last matching label clears the selection, says why, and moves focus to the list title", async () => {
    await choose("Layout", "split");
    await click(sideLabel("Allergens"));
    await click(row("cv-03"));
    await click(q('button[aria-label="Remove label Allergens from Martina Gómez\'s comment"]', article("cv-03-m00")));
    expect(container.querySelector("#row-cv-03")).toBeNull();
    expect(container.querySelector("#focus-cv-03")).toBeNull();
    expect(container.textContent).toContain("Select a conversation to read it here.");
    expect(q('[role="status"]').textContent).toBe("Label Allergens removed from Martina Gómez's comment. The conversation no longer has a comment labelled Allergens, so it left this list.");
    expect(document.activeElement).toBe(q("h1"));
  });
});

describe("UX4: other interaction corrections", () => {
  it("the simulated answers are never focused on their own", async () => {
    await click(row("cv-03"));
    await click(buttonNamed(article("cv-03-m00"), "Hide"));
    expect(document.activeElement?.closest('[aria-label^="Prototype"]')).toBeNull();
  });

  it("Reset says what it resets and what it keeps", () => {
    const reset = buttonNamed(q('[aria-label="Prototype controls"]'), "Reset data");
    const description = q(`#${CSS.escape(reset.getAttribute("aria-describedby") ?? "")}`).textContent;
    expect(description).toContain("Restores labels, simulated actions, drafts, the filter and the selection");
    expect(description).toContain("Role, workspace, actions, layout, theme and scenario stay as chosen");
  });
});
