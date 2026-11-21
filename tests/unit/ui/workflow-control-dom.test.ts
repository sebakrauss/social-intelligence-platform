// @vitest-environment happy-dom
/**
 * WORKFLOW-WF-2E — the workflow control in a REAL client runtime (React's client renderer on happy-dom, real clicks and
 * form submissions through useActionState / useFormStatus), against a synthetic in-memory "server" under the test's
 * control: it checks the version like the real command (compare-and-set), and on every answer re-renders the control
 * from its own state, the way the page re-renders from the database. Nothing here can reach a database or a platform.
 *
 * The three WF-2D browser findings, each pinned:
 * - B-1: Mark done → Undo → Mark done → Undo … every answer shows its OWN outcome, and Undo is offered after each Mark done.
 * - B-2: the keyboard focus is put back on the control's state button after each answer (Done, Reopen, Undo, failure),
 *   and nothing moves when the focus was not in the control (a pointer press that never focused it).
 * - B-3: one submission at a time — a double click, two submits in one tick or a held Enter reach the server ONCE, so the
 *   person's own change is never answered "conflict"; a real conflict (another tab) is still refused and shown.
 */
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowActionState } from "@/server/inbox/workflow-state";
import type * as ControlModule from "@/ui/inbox/workflow-control";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const CONVERSATION = "11111111-1111-4111-8111-000000000002";
const OUTCOMES: ControlModule.WorkflowOutcomeLabels = {
  savedDone: "Marked done.",
  savedReopened: "Reopened.",
  unchanged: "Nothing to change.",
  conflict: "This conversation changed after it was shown.",
  notPermitted: "Your role can't change this conversation's state.",
  notFound: "Not found.",
  invalid: "Invalid.",
  unavailable: "The change couldn't be saved. Try again.",
  signedOut: "Signed out.",
};
const LABELS: ControlModule.WorkflowControlLabels = {
  markDone: "Mark done",
  marking: "Marking done…",
  reopen: "Reopen",
  reopening: "Reopening…",
  resolution: "Resolution",
  noResolution: "No resolution",
  undo: "Undo",
  undoing: "Undoing…",
  outcomes: OUTCOMES,
};

let control: typeof ControlModule;
let container: HTMLElement;
let root: Root | undefined;
/** Every server call still waiting, across tests: answered in afterEach, so one test's unanswered call (React entangles
 *  later transitions with a pending async action) can never hold up the next test. */
const waiting: (() => void)[] = [];
/** Set once a test is over: any call still arriving (a queued duplicate) is answered at once instead of waiting. */
let draining = false;

beforeEach(async () => {
  vi.resetModules();
  draining = false;
  control = await import("@/ui/inbox/workflow-control");
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(async () => {
  await act(async () => {
    draining = true;
    for (const answer of waiting.splice(0)) answer();
    await new Promise((resolve) => setTimeout(resolve, 10));
    root?.unmount();
    await Promise.resolve();
  });
  root = undefined;
  container.remove();
});

interface Item {
  state: "open" | "done";
  version: number;
}

/**
 * The synthetic server. Each call waits until the test releases it (so "pending" lasts as long as the test wants), then
 * answers like the real action: unavailable when told to fail, conflict on a stale version, unchanged, or saved — and
 * re-renders the control from its item, as the page does after `revalidatePath`.
 */
function fakeServer(initial: Item) {
  const item: Item = { ...initial };
  const calls: { to: string; expectedVersion: number; undo: boolean; resolution: string }[] = [];
  const gates: (() => void)[] = [];
  let failNext = false;
  const draw = (): void => {
    root?.render(h(control.WorkflowControl, { action, fields: { workspaceId: WS, conversationId: CONVERSATION }, current: { state: item.state, version: item.version }, resolutions: [{ value: "reviewed", label: "Reviewed" }], labels: LABELS }));
  };
  const action = vi.fn(async (_previous: WorkflowActionState, form: FormData): Promise<WorkflowActionState> => {
    const field = (name: string): string => { const value = form.get(name); return typeof value === "string" ? value : ""; };
    const call = { to: field("to"), expectedVersion: Number(field("expectedVersion")), undo: field("undo") === "1", resolution: field("resolution") };
    calls.push(call);
    if (!draining)
      await new Promise<void>((resolve) => {
        gates.push(resolve);
        waiting.push(resolve);
      });
    if (failNext) {
      failNext = false;
      return { kind: "unavailable" };
    }
    if (call.expectedVersion !== item.version) {
      draw();
      return { kind: "conflict" };
    }
    const to = call.to === "done" ? "done" : "open";
    if (to === item.state) return { kind: "unchanged" };
    item.state = to;
    item.version += 1;
    draw();
    return { kind: "saved", change: to === "done" ? "done" : "reopened", undoable: to === "done" && !call.undo, version: item.version };
  });
  return {
    item,
    calls,
    action,
    pending: (): number => gates.length,
    failNextOnce: (): void => {
      failNext = true;
    },
    /** Someone else (another tab, a new audience comment) changes it; this page is NOT redrawn. */
    changeElsewhere: (state: "open" | "done"): void => {
      item.state = state;
      item.version += 1;
    },
    mount: () =>
      act(async () => {
        root = createRoot(container);
        draw();
        await Promise.resolve();
      }),
    /** Answer the oldest waiting call and let React show it. */
    release: () =>
      act(async () => {
        gates.shift()?.();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }),
  };
}

const buttons = (): HTMLButtonElement[] => [...container.querySelectorAll("button")];
const byText = (text: string): HTMLButtonElement | undefined => buttons().find((button) => button.textContent.trim() === text);
const must = (text: string): HTMLButtonElement => {
  const found = byText(text);
  if (found === undefined) throw new Error(`no "${text}" button (have: ${buttons().map((b) => b.textContent.trim()).join(", ")})`);
  return found;
};
const statusText = (): string => container.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? "";
const press = (button: HTMLButtonElement, { keyboard }: { readonly keyboard: boolean }) =>
  act(async () => {
    // A keyboard press acts on the focused button; a pointer press that does not focus it leaves the focus where it was.
    if (keyboard) button.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
    button.click();
    await Promise.resolve();
  });

describe("B-1: every answer shows its own outcome — Mark done → Undo → Mark done → Undo, repeated", () => {
  it("three full cycles: 'Marked done.' + Undo, then 'Reopened.' with no Undo, every time; one version step per press", async () => {
    const server = fakeServer({ state: "open", version: 1 });
    await server.mount();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await press(must("Mark done"), { keyboard: false });
      await server.release();
      expect(statusText(), `cycle ${String(cycle)}: after Mark done`).toContain("Marked done.");
      expect(statusText()).not.toContain("Reopened.");
      expect(byText("Undo"), `cycle ${String(cycle)}: Undo offered after Mark done`).toBeDefined();
      expect(byText("Reopen")).toBeDefined();
      await press(must("Undo"), { keyboard: false });
      await server.release();
      expect(statusText(), `cycle ${String(cycle)}: after Undo`).toContain("Reopened.");
      expect(statusText()).not.toContain("Marked done.");
      expect(byText("Undo"), `cycle ${String(cycle)}: Undo not offered again after Undo`).toBeUndefined();
      expect(byText("Mark done")).toBeDefined();
    }
    expect(server.item).toEqual({ state: "open", version: 7 });
    // Six presses, six calls, each against the version the page showed; the Undos say so.
    expect(server.calls.map((c) => `${c.to}@${String(c.expectedVersion)}${c.undo ? "+undo" : ""}`)).toEqual(["done@1", "open@2+undo", "done@3", "open@4+undo", "done@5", "open@6+undo"]);
  });

  it("Reopen (not Undo) after a Mark done, then Mark done again: each outcome is its own, and Undo is back after the second Mark done", async () => {
    const server = fakeServer({ state: "open", version: 1 });
    await server.mount();
    await press(must("Mark done"), { keyboard: false });
    await server.release();
    await press(must("Reopen"), { keyboard: false });
    await server.release();
    expect(statusText()).toContain("Reopened.");
    expect(byText("Undo")).toBeUndefined();
    await press(must("Mark done"), { keyboard: false });
    await server.release();
    expect(statusText()).toContain("Marked done.");
    expect(byText("Undo")).toBeDefined();
    expect(server.calls).toHaveLength(3);
  });

  it("a stale outcome never survives: after a failure, the retry's 'Marked done.' replaces the warning", async () => {
    const server = fakeServer({ state: "open", version: 1 });
    await server.mount();
    server.failNextOnce();
    await press(must("Mark done"), { keyboard: false });
    await server.release();
    expect(statusText()).toContain("The change couldn't be saved. Try again.");
    await press(must("Mark done"), { keyboard: false });
    await server.release();
    expect(statusText()).toContain("Marked done.");
    expect(statusText()).not.toContain("couldn't be saved");
  });
});

describe("B-3: one press, one transition — duplicates never reach the server; real conflicts still do", () => {
  it("double click (second press while the first is pending): one call, one transition, outcome 'Marked done.'", async () => {
    const server = fakeServer({ state: "open", version: 1 });
    await server.mount();
    const button = must("Mark done");
    await press(button, { keyboard: false });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent.trim()).toBe("Marking done…");
    await press(button, { keyboard: false });
    expect(server.action).toHaveBeenCalledTimes(1);
    await server.release();
    expect(server.pending()).toBe(0);
    expect(server.item).toEqual({ state: "done", version: 2 });
    expect(statusText()).toContain("Marked done.");
  });

  it("same-tick double submit (two clicks in one task, before React can disable the button): one call, no 'conflict'", async () => {
    const server = fakeServer({ state: "open", version: 1 });
    await server.mount();
    await act(async () => {
      const button = must("Mark done");
      button.click();
      button.click();
      await Promise.resolve();
    });
    expect(server.action).toHaveBeenCalledTimes(1);
    await server.release();
    await server.release(); // nothing else is waiting
    expect(server.calls).toHaveLength(1);
    expect(server.item).toEqual({ state: "done", version: 2 });
    expect(statusText()).toContain("Marked done.");
    expect(statusText()).not.toContain("changed after it was shown");
  });

  it("held Enter (auto-repeat submits, even ones that bypass the disabled button): one call, one transition", async () => {
    const server = fakeServer({ state: "open", version: 1 });
    await server.mount();
    const button = must("Mark done");
    const form = button.form;
    if (form === null) throw new Error("no form");
    for (let repeat = 0; repeat < 6; repeat += 1) {
      await act(async () => {
        form.requestSubmit(button); // what an auto-repeated Enter on the focused button does — even once it is disabled
        await Promise.resolve();
      });
    }
    expect(server.action).toHaveBeenCalledTimes(1);
    await server.release();
    expect(server.item).toEqual({ state: "done", version: 2 });
    expect(statusText()).toContain("Marked done.");
  });

  it("while one form is pending, the control's other buttons cannot be pressed either (Undo pending: Reopen is disabled)", async () => {
    const server = fakeServer({ state: "open", version: 1 });
    await server.mount();
    await press(must("Mark done"), { keyboard: false });
    await server.release();
    await press(must("Undo"), { keyboard: false });
    expect(must("Reopen").disabled).toBe(true);
    await press(must("Reopen"), { keyboard: false });
    expect(server.action).toHaveBeenCalledTimes(2);
    await server.release();
    expect(server.item).toEqual({ state: "open", version: 3 });
    expect(statusText()).toContain("Reopened.");
  });

  it("two tabs: a change made elsewhere is still refused as a conflict, nothing is overwritten, the latest state is shown, and the next press goes through", async () => {
    const server = fakeServer({ state: "open", version: 1 });
    await server.mount();
    server.changeElsewhere("done"); // the other tab marked it done (v2); this page still shows Open v1
    await press(must("Mark done"), { keyboard: false });
    await server.release();
    expect(statusText()).toContain("This conversation changed after it was shown.");
    expect(server.item).toEqual({ state: "done", version: 2 });
    expect(byText("Reopen")).toBeDefined();
    expect(byText("Undo")).toBeUndefined();
    await press(must("Reopen"), { keyboard: false });
    await server.release();
    expect(statusText()).toContain("Reopened.");
    expect(server.calls.map((c) => `${c.to}@${String(c.expectedVersion)}`)).toEqual(["done@1", "open@2"]);
  });

  it("failure then retry: the failed press frees the control (it is pressable again) and the retry is one more call that saves", async () => {
    const server = fakeServer({ state: "open", version: 1 });
    await server.mount();
    server.failNextOnce();
    await press(must("Mark done"), { keyboard: false });
    await server.release();
    expect(statusText()).toContain("The change couldn't be saved. Try again.");
    expect(must("Mark done").disabled).toBe(false);
    expect(server.item).toEqual({ state: "open", version: 1 });
    await press(must("Mark done"), { keyboard: false });
    await server.release();
    expect(server.action).toHaveBeenCalledTimes(2);
    expect(server.item).toEqual({ state: "done", version: 2 });
    expect(statusText()).toContain("Marked done.");
  });
});

describe("B-2: the keyboard focus stays in the workflow control", () => {
  it("Mark done → Reopen → Mark done → Undo, by keyboard: after each answer the focus is on the state button the page now offers", async () => {
    const server = fakeServer({ state: "open", version: 1 });
    await server.mount();
    await press(must("Mark done"), { keyboard: true });
    await server.release();
    expect(document.activeElement).toBe(must("Reopen"));
    await press(must("Reopen"), { keyboard: true });
    await server.release();
    expect(document.activeElement).toBe(must("Mark done"));
    await press(must("Mark done"), { keyboard: true });
    await server.release();
    await press(must("Undo"), { keyboard: true });
    await server.release();
    expect(statusText()).toContain("Reopened.");
    expect(document.activeElement).toBe(must("Mark done"));
  });

  it("a failed press and a conflict also give the focus back (the button was disabled while pending)", async () => {
    const server = fakeServer({ state: "open", version: 1 });
    await server.mount();
    server.failNextOnce();
    await press(must("Mark done"), { keyboard: true });
    await server.release();
    expect(document.activeElement).toBe(must("Mark done"));
    server.changeElsewhere("done");
    await press(must("Mark done"), { keyboard: true });
    await server.release();
    expect(statusText()).toContain("changed after it was shown");
    expect(document.activeElement).toBe(must("Reopen"));
  });

  it("a press that never focused the control moves nothing: the focus stays where it was", async () => {
    const server = fakeServer({ state: "open", version: 1 });
    await server.mount();
    await press(must("Mark done"), { keyboard: false });
    await server.release();
    expect(statusText()).toContain("Marked done.");
    expect(container.contains(document.activeElement)).toBe(false);
  });

  it("the outcome is still announced politely, in the one status region", async () => {
    const server = fakeServer({ state: "open", version: 1 });
    await server.mount();
    await press(must("Mark done"), { keyboard: true });
    await server.release();
    const regions = container.querySelectorAll('[role="status"]');
    expect(regions).toHaveLength(1);
    expect(regions[0]?.getAttribute("aria-live")).toBe("polite");
    expect(regions[0]?.textContent).toContain("Marked done.");
  });
});
