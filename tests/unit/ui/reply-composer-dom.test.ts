// @vitest-environment happy-dom
/**
 * Step 7B-15J (audit 7B-15I F1, F2) — the reply composer in a REAL client runtime: React's client renderer and
 * hydration on a DOM (happy-dom), real clicks, real form submission through useActionState / useFormStatus, and a
 * synthetic publish action under the test's control (never a pipeline; nothing here can reach Meta).
 *
 * What only a running client can show, and a syntax rule cannot: that rendering, hydrating or restoring never calls the
 * action; that while a publication is pending NO control — whatever it is, wherever it sits — reopens the text; that one
 * deliberate Publish calls the action once; and that after an uncertain outcome nothing typed can come back under a new
 * form key on a remount.
 */
import { act, createElement as h } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyActionState } from "@/server/inbox/reply-state";
import type * as ComposerModule from "@/ui/inbox/reply-composer";
import type * as DraftsModule from "@/ui/inbox/reply-drafts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const A = "a1111111-1111-4111-8111-111111111111";
const B = "a4444444-4444-4444-8444-444444444444";
const SCOPE = "scope-dom";
const LABELS = {
  open: "Reply",
  heading: "Reply publicly",
  to: "Replying to caro",
  as: "As your Facebook account",
  fieldLabel: "Your reply",
  fieldHelp: "Up to 2200 characters.",
  remaining: "{count} characters left",
  overLimit: "{count} characters over",
  empty: "Write a reply first.",
  cancel: "Cancel",
  review: "Review reply",
  edit: "Edit",
  reviewHeading: "Check your reply",
  reviewTextLabel: "This will be published",
  reviewNote: "Publishing is final.",
  publish: "Publish reply",
  publishing: "Publishing…",
  restored: "Your unsent reply is back.",
};
const OUTCOMES = { requested: "requested", existing: "existing", unavailable: "unknown outcome", "refused.TARGET_NOT_PRESENT": "refused", signed_out: "signed out" };

/** React's act in its awaited form (flushes renders, effects and transitions before the test goes on). */
async function settleAct(run: () => void): Promise<void> {
  await act(async () => {
    run();
    await Promise.resolve();
  });
}

let composer: typeof ComposerModule;
let drafts: typeof DraftsModule;
let container: HTMLElement;
let root: Root | undefined;

beforeEach(async () => {
  vi.resetModules();
  composer = await import("@/ui/inbox/reply-composer");
  drafts = await import("@/ui/inbox/reply-drafts");
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(async () => {
  await settleAct(() => {
    root?.unmount();
  });
  root = undefined;
  container.remove();
});

/** A publish action the test answers; every call (and its form fields) is recorded. */
function controlledAction() {
  const calls: { key: string | null; text: string | null }[] = [];
  const answers: ((value: ReplyActionState) => void)[] = [];
  const action = vi.fn((_previous: ReplyActionState, form: FormData) => {
    calls.push({ key: form.get("idempotencyKey") as string | null, text: form.get("text") as string | null });
    return new Promise<ReplyActionState>((resolve) => answers.push(resolve));
  });
  return {
    action,
    calls,
    answer: (value: ReplyActionState) =>
      settleAct(() => {
        answers.shift()?.(value);
      }),
  };
}

const props = (action: ComposerModule.ReplyComposerProps["action"], target: string, key: string, extra: Partial<ComposerModule.ReplyComposerProps> = {}): ComposerModule.ReplyComposerProps => ({
  action,
  fields: { workspaceId: WS, conversationId: CONVERSATION, targetInteractionId: target, idempotencyKey: key },
  maxChars: 2200,
  labels: LABELS,
  outcomes: OUTCOMES,
  draftScope: SCOPE,
  ...extra,
});
async function mount(p: ComposerModule.ReplyComposerProps): Promise<void> {
  await settleAct(() => {
    root = createRoot(container);
    root.render(h(composer.ReplyComposer, p));
  });
}
async function remount(p: ComposerModule.ReplyComposerProps): Promise<void> {
  await settleAct(() => {
    root?.unmount();
  });
  await mount(p);
}
const buttons = (): HTMLButtonElement[] => [...container.querySelectorAll("button")];
const byText = (text: string): HTMLButtonElement | undefined => buttons().find((button) => button.textContent.trim() === text);
const textarea = (): HTMLTextAreaElement | null => container.querySelector("textarea");
async function click(element: HTMLElement | undefined): Promise<void> {
  if (element === undefined) throw new Error("no such control");
  await settleAct(() => {
    element.click();
  });
}
async function type(text: string): Promise<void> {
  const field = textarea();
  if (field === null) throw new Error("no textarea");
  await settleAct(() => {
    // React tracks the element's own value; the prototype setter is what a real keystroke goes through.
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field) as object, "value") as { readonly set: (this: HTMLTextAreaElement, value: string) => void };
    descriptor.set.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
};
async function toReview(text: string): Promise<void> {
  if (textarea() === null) await click(byText(LABELS.open));
  await type(text);
  await click(byText(LABELS.review));
}

describe("rendering, hydrating and restoring never call the publish action", () => {
  it("client render (closed, write, with and without a kept draft) and hydration of the server markup: zero calls, even after timers run", async () => {
    const request = controlledAction();
    for (const extra of [{}, { initialStage: "write" as const }]) {
      await remount(props(request.action, A, "rk-render", extra));
      await settle();
    }
    drafts.keepReplyDraft(drafts.replyDraftKey(SCOPE, { workspaceId: WS, conversationId: CONVERSATION, targetInteractionId: A }), "kept text");
    await remount(props(request.action, A, "rk-restore"));
    expect(textarea()?.value).toBe("kept text");
    expect(container.querySelector("form")).toBeNull();
    await settle();
    // Hydration of what the server drew (the server never restores; the client store is the same module here).
    await settleAct(() => {
      root?.unmount();
    });
    root = undefined;
    container.innerHTML = renderToString(h(composer.ReplyComposer, props(request.action, B, "rk-hydrate", { initialStage: "write" })));
    await settleAct(() => {
      root = hydrateRoot(container, h(composer.ReplyComposer, props(request.action, B, "rk-hydrate", { initialStage: "write" })));
    });
    await settle();
    expect(request.action).not.toHaveBeenCalled();
  });

  it("reaching the review stage posts nothing; one deliberate Publish calls the action exactly once with the shown text and the server's key", async () => {
    const request = controlledAction();
    await mount(props(request.action, A, "rk-once"));
    await toReview("Hola caro");
    expect(request.action).not.toHaveBeenCalled();
    const publish = byText(LABELS.publish);
    await click(publish);
    await click(byText(LABELS.publishing) ?? publish);
    expect(request.calls).toEqual([{ key: "rk-once", text: "Hola caro" }]);
    await request.answer({ kind: "requested", intentId: "b1" });
    expect(request.action).toHaveBeenCalledTimes(1);
  });
});

describe("while Publish is pending, nothing reopens the text (audit 7B-15I X12–X14)", () => {
  it("every control in the composer other than Publish is disabled or leaves the review stage untouched; no textarea appears", async () => {
    const request = controlledAction();
    await mount(props(request.action, A, "rk-pending"));
    await toReview("Reviewed text");
    await click(byText(LABELS.publish));
    expect(byText(LABELS.publishing)?.disabled).toBe(true);
    for (const control of buttons()) {
      if (control.type === "submit") continue;
      await click(control);
      expect(textarea(), `control "${control.textContent}" reopened the text while pending`).toBeNull();
    }
    expect(container.textContent).toContain("Reviewed text");
    await request.answer({ kind: "requested", intentId: "b1" });
    expect(request.action).toHaveBeenCalledTimes(1);
  });
});

/**
 * Step 7B-15L (audit 7B-15K K14) — the invariant is about the PUBLICATION, not about one button: while Publish is
 * pending, no interaction with anything the composer draws may reopen the text. So this does not look for buttons: it
 * drives EVERY element of the composer (a native button, a component, a `role="button"` span, a quote, the form itself,
 * anything inside or outside the form) with every pointer, keyboard, focus and input event a handler could listen to.
 */
const INTERACTIONS: readonly (readonly [string, () => Event])[] = [
  ...(["click", "dblclick", "auxclick", "contextmenu", "mousedown", "mouseup", "mouseover", "mouseout", "mousemove"] as const).map((name) => [name, () => new MouseEvent(name, { bubbles: true, cancelable: true })] as const),
  ...(["pointerdown", "pointerup", "pointerover", "pointerout", "pointermove", "touchstart", "touchend", "focusin", "focusout", "input", "change", "wheel", "scroll", "copy", "paste", "dragstart", "drop"] as const).map((name) => [name, () => new Event(name, { bubbles: true, cancelable: true })] as const),
  ...(["keydown", "keypress", "keyup"] as const).flatMap((name) => ["Enter", " ", "e", "Escape", "Backspace"].map((key) => [`${name} ${key}`, () => new KeyboardEvent(name, { key, bubbles: true, cancelable: true })] as const)),
];
const everyElement = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>("*")];
const described = (element: HTMLElement): string => `<${element.tagName.toLowerCase()}${element.getAttribute("role") === null ? "" : ` role="${element.getAttribute("role") ?? ""}"`}> "${element.textContent.trim().slice(0, 30)}"`;
/** Every interaction on every element except pressing the submit button itself (that is the one deliberate Publish). */
async function interactWithEverything(): Promise<void> {
  for (const element of everyElement()) {
    const submit = element instanceof HTMLButtonElement && element.type === "submit";
    for (const [name, event] of INTERACTIONS) {
      if (submit && (name === "click" || name.startsWith("key"))) continue;
      await settleAct(() => {
        element.dispatchEvent(event());
      });
      expect(textarea(), `${name} on ${described(element)} reopened the text while Publish was pending`).toBeNull();
    }
  }
}

describe("Step 7B-15L — while Publish is pending, NO interaction with anything in the composer reopens the text (audit 7B-15K K14)", () => {
  it("the probe is alive: before Publish the same sweep does reach the Edit control (so a pass below is not a sweep that touches nothing)", async () => {
    const request = controlledAction();
    await mount(props(request.action, A, "rk-alive"));
    await toReview("Reviewed text");
    expect(everyElement().length).toBeGreaterThan(10);
    let reopened = false;
    for (const element of everyElement()) {
      if (element instanceof HTMLButtonElement && element.type === "submit") continue;
      await settleAct(() => {
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      if (textarea() !== null) {
        reopened = true;
        expect(element.textContent.trim()).toBe(LABELS.edit);
        break;
      }
    }
    expect(reopened).toBe(true);
    expect(request.action).not.toHaveBeenCalled();
  });

  it("every element × every pointer, keyboard, focus and input event: the review stays, no textarea appears, nothing is kept as a draft, and the action ran once", async () => {
    const request = controlledAction();
    await mount(props(request.action, A, "rk-pending-all"));
    await toReview("Reviewed text");
    await click(byText(LABELS.publish));
    expect(byText(LABELS.publishing)?.disabled).toBe(true);
    await interactWithEverything();
    expect(container.querySelector("form")).not.toBeNull();
    expect(container.textContent).toContain("Reviewed text");
    expect(byText(LABELS.publishing)?.disabled).toBe(true);
    expect(drafts.restoreReplyDraft(drafts.replyDraftKey(SCOPE, { workspaceId: WS, conversationId: CONVERSATION, targetInteractionId: A }))).toBeUndefined();
    expect(request.calls).toEqual([{ key: "rk-pending-all", text: "Reviewed text" }]);
    await request.answer({ kind: "requested", intentId: "b1" });
    await interactWithEverything();
    expect(request.action).toHaveBeenCalledTimes(1);
  });

  it("the Edit control is pending-aware, not dead: once a refusal arrives it works again", async () => {
    const request = controlledAction();
    await mount(props(request.action, A, "rk-edit-back"));
    await toReview("Reviewed text");
    await click(byText(LABELS.publish));
    expect(byText(LABELS.edit)?.disabled).toBe(true);
    await request.answer({ kind: "refused", reason: "TARGET_NOT_PRESENT" });
    expect(byText(LABELS.edit)?.disabled).toBe(false);
    await click(byText(LABELS.edit));
    expect(textarea()?.value).toBe("Reviewed text");
  });
});

describe("Step 7B-15L — an unknown outcome keeps the form key with the submission (audit 7B-15K K22)", () => {
  it("unavailable: the open composer still carries the key it submitted with — Publish again, and Edit → change → Publish, all post under that ONE key", async () => {
    const request = controlledAction();
    await mount(props(request.action, A, "rk-keep"));
    await toReview("first text");
    await click(byText(LABELS.publish));
    await request.answer({ kind: "unavailable" });
    const hidden = (): string | undefined => container.querySelector<HTMLInputElement>('input[name="idempotencyKey"]')?.value;
    expect(hidden()).toBe("rk-keep");
    await click(byText(LABELS.publish));
    await request.answer({ kind: "unavailable" });
    await click(byText(LABELS.edit));
    await type("first text, edited");
    await click(byText(LABELS.review));
    expect(hidden()).toBe("rk-keep");
    await click(byText(LABELS.publish));
    await request.answer({ kind: "refused", reason: "IDEMPOTENCY_KEY_REUSED" });
    expect(request.calls).toEqual([
      { key: "rk-keep", text: "first text" },
      { key: "rk-keep", text: "first text" },
      { key: "rk-keep", text: "first text, edited" },
    ]);
  });
});

describe("after the answer (audit 7B-15I F1)", () => {
  const key = (target: string) => drafts.replyDraftKey(SCOPE, { workspaceId: WS, conversationId: CONVERSATION, targetInteractionId: target });

  it.each(["requested", "existing"] as const)("%s: a remount under a NEW form key brings no text back", async (kind) => {
    const request = controlledAction();
    await mount(props(request.action, A, "rk-1"));
    await toReview("accepted text");
    await click(byText(LABELS.publish));
    await request.answer(kind === "requested" ? { kind, intentId: "b1" } : { kind, intentId: "b1" });
    await settle();
    await remount(props(request.action, A, "rk-2", { initialStage: "write" }));
    expect(textarea()?.value).toBe("");
    expect(container.textContent).not.toContain(LABELS.restored);
  });

  it("unavailable (unknown outcome): Edit, typing and a remount under a NEW form key bring nothing back — the audit's reproduction", async () => {
    const request = controlledAction();
    await mount(props(request.action, A, "rk-first"));
    await toReview("fail first text");
    await click(byText(LABELS.publish));
    await request.answer({ kind: "unavailable" });
    expect(container.textContent).toContain(OUTCOMES.unavailable);
    await click(byText(LABELS.edit));
    await type("fail first text plus edit");
    await settle();
    expect(drafts.restoreReplyDraft(key(A))).toBeUndefined();
    await remount(props(request.action, A, "rk-second", { initialStage: "write" }));
    await settle();
    expect(textarea()?.value).toBe("");
    expect(container.textContent).not.toContain(LABELS.restored);
    // Retrying in the SAME composer would have reused rk-first; no second key ever carried the earlier text.
    expect(request.calls.map((call) => call.key)).toEqual(["rk-first"]);
  });

  it("refused (nothing created): the submitted text comes back on a remount, at the write stage, and nothing is posted", async () => {
    const request = controlledAction();
    await mount(props(request.action, A, "rk-1"));
    await toReview("refused text");
    await click(byText(LABELS.publish));
    await request.answer({ kind: "refused", reason: "TARGET_NOT_PRESENT" });
    await remount(props(request.action, A, "rk-2", { initialStage: "write" }));
    expect(textarea()?.value).toBe("refused text");
    expect(container.querySelector("form")).toBeNull();
    expect(request.action).toHaveBeenCalledTimes(1);
  });
});

describe("cancel and people", () => {
  it("Cancel forgets THIS comment's draft only", async () => {
    const request = controlledAction();
    drafts.keepReplyDraft(drafts.replyDraftKey(SCOPE, { workspaceId: WS, conversationId: CONVERSATION, targetInteractionId: B }), "B stays");
    await mount(props(request.action, A, "rk-1", { initialStage: "write" }));
    await type("A goes");
    await click(byText(LABELS.cancel));
    await remount(props(request.action, A, "rk-2", { initialStage: "write" }));
    expect(textarea()?.value).toBe("");
    await remount(props(request.action, B, "rk-3", { initialStage: "write" }));
    expect(textarea()?.value).toBe("B stays");
  });

  it("another person's composer under the same comment never shows the first person's draft", async () => {
    const request = controlledAction();
    await mount(props(request.action, A, "rk-1", { initialStage: "write" }));
    await type("person one's words");
    await remount(props(request.action, A, "rk-2", { initialStage: "write", draftScope: "scope-person-two" }));
    expect(textarea()?.value).toBe("");
    expect(container.textContent).not.toContain("person one's words");
  });
});

describe("no browser persistence or exfiltration while writing, restoring and publishing", () => {
  it("web storage, cookies, window.name and the URL stay untouched; no window.open", async () => {
    const opened = vi.spyOn(window, "open");
    const before = { url: window.location.href, name: window.name, cookie: document.cookie };
    const request = controlledAction();
    await mount(props(request.action, A, "rk-1"));
    await toReview("private words");
    await click(byText(LABELS.publish));
    await request.answer({ kind: "refused", reason: "TARGET_NOT_PRESENT" });
    await remount(props(request.action, A, "rk-2", { initialStage: "write" }));
    await settle();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect({ url: window.location.href, name: window.name, cookie: document.cookie }).toEqual(before);
    expect(opened).not.toHaveBeenCalled();
  });
});
