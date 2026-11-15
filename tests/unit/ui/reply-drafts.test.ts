/**
 * Step 7B-15F — unsent public-reply drafts (ui/inbox/reply-drafts.ts) and the composer that uses them. Memory only,
 * per tab: a draft survives moving the ONE composer to another comment and back, stays under its own key (person,
 * workspace, conversation, comment), never seeds the review stage, never outlives a pressed Publish unless the server
 * created nothing, and does nothing at all outside a browser. A fresh module import stands for a reload (a new realm).
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyActionState } from "@/server/inbox/reply-state";
import { replyDraftScope } from "@/server/inbox/draft-scope";
import type * as DraftsModule from "@/ui/inbox/reply-drafts";
import type * as ComposerModule from "@/ui/inbox/reply-composer";

type Drafts = typeof DraftsModule;
type Composer = typeof ComposerModule;

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const WS_2 = "4c352212-f3cc-4366-9dd0-5247d673b073";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_2 = "22222222-2222-4222-8222-222222222222";
const A = "a1111111-1111-4111-8111-111111111111";
const B = "a4444444-4444-4444-8444-444444444444";
const field = (target: string, workspaceId = WS, conversationId = CONVERSATION) => ({ workspaceId, conversationId, targetInteractionId: target });

/** A browser tab: the window the drafts module needs (its one listener is recorded), and a fresh module per "page load". */
interface Tab {
  readonly listeners: { add: string[]; remove: string[] };
  readonly drafts: Drafts;
  readonly composer: Composer;
}
async function openTab(options: { failListeners?: boolean } = {}): Promise<Tab> {
  vi.resetModules();
  const listeners = { add: [] as string[], remove: [] as string[] };
  vi.stubGlobal("window", {
    addEventListener: (name: string) => {
      if (options.failListeners === true) throw new Error("no listeners here");
      listeners.add.push(name);
    },
    removeEventListener: (name: string) => {
      listeners.remove.push(name);
    },
  });
  return { listeners, drafts: await import("@/ui/inbox/reply-drafts"), composer: await import("@/ui/inbox/reply-composer") };
}
afterEach(() => {
  vi.unstubAllGlobals();
});

const LABELS = {
  open: "Reply",
  heading: "Reply publicly",
  to: "Replying to caro",
  as: "As your Instagram account",
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
const never = (): Promise<ReplyActionState> => Promise.reject(new Error("the composer must never call the action while rendering"));
function composerHtml(tab: Tab, props: { target: string; scope?: string; stage?: "closed" | "write" | "review"; workspaceId?: string; conversationId?: string; validation?: true }): string {
  return renderToStaticMarkup(
    h(tab.composer.ReplyComposer, {
      action: never,
      fields: { ...field(props.target, props.workspaceId, props.conversationId), idempotencyKey: "rk-11111111-1111-4111-8111-111111111111", ...(props.validation === true ? { validation: true as const } : {}) },
      maxChars: 2200,
      labels: LABELS,
      outcomes: {},
      ...(props.stage === undefined ? {} : { initialStage: props.stage }),
      ...(props.scope === undefined ? {} : { draftScope: props.scope }),
    }),
  );
}
const SCOPE = "scope-person-one";
const OTHER_PERSON = "scope-person-two";

describe("the draft store (memory, per tab)", () => {
  let tab: Tab;
  beforeEach(async () => {
    tab = await openTab();
  });

  it("A's draft survives writing under B, and each comes back only under its own key", () => {
    const { keepReplyDraft, restoreReplyDraft, replyDraftKey } = tab.drafts;
    const a = replyDraftKey(SCOPE, field(A));
    const b = replyDraftKey(SCOPE, field(B));
    keepReplyDraft(a, "draft for A");
    keepReplyDraft(b, "draft for B");
    expect(restoreReplyDraft(a)).toBe("draft for A");
    expect(restoreReplyDraft(b)).toBe("draft for B");
    // Same comment id under another conversation or workspace is another key.
    expect(restoreReplyDraft(replyDraftKey(SCOPE, field(A, WS, CONVERSATION_2)))).toBeUndefined();
    expect(restoreReplyDraft(replyDraftKey(SCOPE, field(A, WS_2)))).toBeUndefined();
  });

  it("another person on the same tab never sees it: their key differs, and their first keystroke drops every other person's drafts", () => {
    const { keepReplyDraft, restoreReplyDraft, replyDraftKey } = tab.drafts;
    keepReplyDraft(replyDraftKey(SCOPE, field(A)), "person one");
    expect(restoreReplyDraft(replyDraftKey(OTHER_PERSON, field(A)))).toBeUndefined();
    keepReplyDraft(replyDraftKey(OTHER_PERSON, field(B)), "person two");
    expect(restoreReplyDraft(replyDraftKey(SCOPE, field(A)))).toBeUndefined();
    expect(restoreReplyDraft(replyDraftKey(OTHER_PERSON, field(B)))).toBe("person two");
  });

  it("without a scope there is no key: nothing is kept or restored", () => {
    const { keepReplyDraft, restoreReplyDraft, replyDraftKey } = tab.drafts;
    expect(replyDraftKey("", field(A))).toBeUndefined();
    expect(replyDraftKey("bad\u0000scope", field(A))).toBeUndefined();
    keepReplyDraft(undefined, "nowhere");
    expect(restoreReplyDraft(undefined)).toBeUndefined();
    expect(tab.listeners.add).toEqual([]);
  });

  it("an emptied or blank text is not a draft", () => {
    const { keepReplyDraft, restoreReplyDraft, replyDraftKey } = tab.drafts;
    const a = replyDraftKey(SCOPE, field(A));
    keepReplyDraft(a, "something");
    keepReplyDraft(a, "   \n ");
    expect(restoreReplyDraft(a)).toBeUndefined();
    keepReplyDraft(a, "again");
    keepReplyDraft(a, "");
    expect(restoreReplyDraft(a)).toBeUndefined();
  });

  it("long text and any Unicode come back exactly", () => {
    const { keepReplyDraft, restoreReplyDraft, replyDraftKey } = tab.drafts;
    const a = replyDraftKey(SCOPE, field(A));
    const text = `${"Gracias por escribirnos 🙏 ".repeat(150)}\nשלום · مرحبا · é · 👩🏽‍💻 · <b>not html</b> & "quotes"`;
    keepReplyDraft(a, text);
    expect(restoreReplyDraft(a)).toBe(text);
    expect(restoreReplyDraft(a)?.length).toBe(text.length);
  });

  it("keeps at most 20 drafts, dropping the oldest", () => {
    const { keepReplyDraft, restoreReplyDraft, replyDraftKey } = tab.drafts;
    const ids = Array.from({ length: 22 }, (_, index) => `a${String(index).padStart(7, "0")}-1111-4111-8111-111111111111`);
    for (const id of ids) keepReplyDraft(replyDraftKey(SCOPE, field(id)), `draft ${id}`);
    expect(restoreReplyDraft(replyDraftKey(SCOPE, field(ids[0] ?? "")))).toBeUndefined();
    expect(restoreReplyDraft(replyDraftKey(SCOPE, field(ids[1] ?? "")))).toBeUndefined();
    expect(restoreReplyDraft(replyDraftKey(SCOPE, field(ids[2] ?? "")))).toBe(`draft ${ids[2] ?? ""}`);
    expect(restoreReplyDraft(replyDraftKey(SCOPE, field(ids[21] ?? "")))).toBe(`draft ${ids[21] ?? ""}`);
  });

  it("the native leave confirmation is on exactly while a draft is kept (one listener, no other event)", () => {
    const { keepReplyDraft, forgetReplyDraft, replyDraftKey } = tab.drafts;
    const a = replyDraftKey(SCOPE, field(A));
    const b = replyDraftKey(SCOPE, field(B));
    keepReplyDraft(a, "x");
    keepReplyDraft(b, "y");
    keepReplyDraft(a, "xy");
    expect(tab.listeners).toEqual({ add: ["beforeunload"], remove: [] });
    forgetReplyDraft(a);
    expect(tab.listeners.remove).toEqual([]);
    forgetReplyDraft(b);
    expect(tab.listeners).toEqual({ add: ["beforeunload"], remove: ["beforeunload"] });
  });

  it("a reload is a new tab realm: nothing comes back", async () => {
    const { keepReplyDraft, replyDraftKey } = tab.drafts;
    keepReplyDraft(replyDraftKey(SCOPE, field(A)), "lost on reload (the leave confirmation warned first)");
    const reloaded = await openTab();
    expect(reloaded.drafts.restoreReplyDraft(reloaded.drafts.replyDraftKey(SCOPE, field(A)))).toBeUndefined();
  });

  it("fails safe without a leave listener: the draft is still kept for in-page navigation", async () => {
    const failing = await openTab({ failListeners: true });
    const a = failing.drafts.replyDraftKey(SCOPE, field(A));
    failing.drafts.keepReplyDraft(a, "kept anyway");
    expect(failing.drafts.restoreReplyDraft(a)).toBe("kept anyway");
  });
});

describe("outside a browser (server rendering): nothing at all", () => {
  it("every operation is a no-op and the module-level map is never written on the server", async () => {
    vi.resetModules();
    const drafts = await import("@/ui/inbox/reply-drafts");
    const a = drafts.replyDraftKey(SCOPE, field(A));
    drafts.keepReplyDraft(a, "server must not keep this");
    expect(drafts.restoreReplyDraft(a)).toBeUndefined();
    // A later browser read of the same module instance finds nothing either.
    vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
    expect(drafts.restoreReplyDraft(a)).toBeUndefined();
  });
});

describe("publishing: the action passes through untouched; a pressed Publish never comes back as a new draft unless nothing was created", () => {
  const form = (text: string): FormData => {
    const data = new FormData();
    data.set("text", text);
    data.set("idempotencyKey", "rk-1");
    return data;
  };
  const outcomes: Record<string, ReplyActionState> = {
    requested: { kind: "requested", intentId: "b1" },
    existing: { kind: "existing", intentId: "b1" },
    unavailable: { kind: "unavailable" },
    refused: { kind: "refused", reason: "TARGET_NOT_PRESENT" },
    blocked: { kind: "blocked", code: "MODE_BLOCKED" },
    signed_out: { kind: "signed_out" },
  };

  it("without a key the action itself is used (identical function)", async () => {
    const { settleReplyDraft } = (await openTab()).drafts;
    const action = vi.fn(() => Promise.resolve(outcomes["requested"] as ReplyActionState));
    expect(settleReplyDraft(action, undefined)).toBe(action);
  });

  it.each(Object.keys(outcomes))("%s: the action is called once with the same previous state and form, its answer is returned as is, and the draft is gone while it runs", async (kind) => {
    const { drafts } = await openTab();
    const key = drafts.replyDraftKey(SCOPE, field(A));
    drafts.keepReplyDraft(key, "the reviewed text");
    const previous: ReplyActionState = { kind: "idle" };
    const data = form("the reviewed text");
    const answer = outcomes[kind] as ReplyActionState;
    const seenDuringRequest: (string | undefined)[] = [];
    const action = vi.fn((prev: ReplyActionState, sent: FormData) => {
      seenDuringRequest.push(drafts.restoreReplyDraft(key));
      expect(prev).toBe(previous);
      expect(sent).toBe(data);
      return Promise.resolve(answer);
    });
    const result = await drafts.settleReplyDraft(action, key)(previous, data);
    expect(action).toHaveBeenCalledTimes(1);
    expect(result).toBe(answer);
    expect(seenDuringRequest).toEqual([undefined]);
    const nothingCreated = kind === "refused" || kind === "blocked" || kind === "signed_out";
    expect(drafts.restoreReplyDraft(key)).toBe(nothingCreated ? "the reviewed text" : undefined);
  });

  it("a request that fails in transport propagates unchanged and its text never comes back as a draft (the outcome is unknown)", async () => {
    const { drafts } = await openTab();
    const key = drafts.replyDraftKey(SCOPE, field(A));
    drafts.keepReplyDraft(key, "sent text");
    const failure = new Error("network");
    await expect(drafts.settleReplyDraft(() => Promise.reject(failure), key)({ kind: "idle" }, form("sent text"))).rejects.toBe(failure);
    expect(drafts.restoreReplyDraft(key)).toBeUndefined();
  });

  it("while a request for a comment is in flight nothing is kept for it; a refused answer then gives back exactly the submitted text", async () => {
    const { drafts } = await openTab();
    const key = drafts.replyDraftKey(SCOPE, field(A));
    let answer: (value: ReplyActionState) => void = () => undefined;
    drafts.keepReplyDraft(key, "submitted text");
    const pending = drafts.settleReplyDraft(() => new Promise<ReplyActionState>((resolve) => (answer = resolve)), key)({ kind: "idle" }, form("submitted text"));
    drafts.keepReplyDraft(key, "typed while the request was in flight");
    expect(drafts.restoreReplyDraft(key)).toBeUndefined();
    answer({ kind: "refused", reason: "CAPABILITY_UNAVAILABLE" });
    await pending;
    expect(drafts.restoreReplyDraft(key)).toBe("submitted text");
  });

  it("a confirmed request under A leaves B's draft alone, and A gets nothing back (no duplicate under any target)", async () => {
    const { drafts } = await openTab();
    const a = drafts.replyDraftKey(SCOPE, field(A));
    const b = drafts.replyDraftKey(SCOPE, field(B));
    drafts.keepReplyDraft(a, "for A");
    drafts.keepReplyDraft(b, "for B");
    await drafts.settleReplyDraft(() => Promise.resolve<ReplyActionState>({ kind: "requested", intentId: "b1" }), a)({ kind: "idle" }, form("for A"));
    expect(drafts.restoreReplyDraft(a)).toBeUndefined();
    expect(drafts.restoreReplyDraft(b)).toBe("for B");
  });
});

describe("the composer with a kept draft", () => {
  it("returning to A: the composer opens at the WRITE stage with A's text and says it is a kept draft — no form, no hidden field, no Publish", async () => {
    const tab = await openTab();
    tab.drafts.keepReplyDraft(tab.drafts.replyDraftKey(SCOPE, field(A)), "Hola <b>caro</b> 🙏");
    for (const stage of [undefined, "closed", "write"] as const) {
      const html = composerHtml(tab, { target: A, scope: SCOPE, ...(stage === undefined ? {} : { stage }) });
      expect(html).toMatch(/<textarea[^>]*>Hola &lt;b&gt;caro&lt;\/b&gt; 🙏<\/textarea>/);
      expect(html).toContain(LABELS.restored);
      expect(html).not.toMatch(/<form\b|type="hidden"|type="submit"/);
      expect(html).not.toContain(LABELS.publish);
    }
  });

  it("B's composer never shows A's draft; another person, workspace or conversation neither", async () => {
    const tab = await openTab();
    tab.drafts.keepReplyDraft(tab.drafts.replyDraftKey(SCOPE, field(A)), "only for A");
    for (const html of [
      composerHtml(tab, { target: B, scope: SCOPE, stage: "write" }),
      composerHtml(tab, { target: A, scope: OTHER_PERSON, stage: "write" }),
      composerHtml(tab, { target: A, scope: SCOPE, stage: "write", workspaceId: WS_2 }),
      composerHtml(tab, { target: A, scope: SCOPE, stage: "write", conversationId: CONVERSATION_2 }),
    ]) {
      expect(html).not.toContain("only for A");
      expect(html).not.toContain(LABELS.restored);
    }
    // A closed composer without a draft stays closed behind its button.
    expect(composerHtml(tab, { target: B, scope: SCOPE })).toMatch(/>Reply<\/button>/);
  });

  it("without a draft scope (no verified person) a kept draft is not offered", async () => {
    const tab = await openTab();
    tab.drafts.keepReplyDraft(tab.drafts.replyDraftKey(SCOPE, field(A)), "not offered");
    const html = composerHtml(tab, { target: A, stage: "write" });
    expect(html).not.toContain("not offered");
    expect(composerHtml(tab, { target: A })).toMatch(/>Reply<\/button>/);
  });

  it("server rendering never restores (hydration matches: the first paint is the server's empty composer)", async () => {
    vi.resetModules();
    const { ReplyComposer } = await import("@/ui/inbox/reply-composer");
    const html = renderToStaticMarkup(h(ReplyComposer, { action: never, fields: { ...field(A), idempotencyKey: "rk-1" }, maxChars: 2200, labels: LABELS, outcomes: {}, initialStage: "write", draftScope: SCOPE }));
    expect(html).toMatch(/<textarea[^>]*><\/textarea>/);
    expect(html).not.toContain(LABELS.restored);
  });

  it("a validation composer with a kept draft: the mode comes from the server's props only — the draft carries no flag, no identifier and no expiry", async () => {
    const tab = await openTab();
    tab.drafts.keepReplyDraft(tab.drafts.replyDraftKey(SCOPE, field(A)), "validation draft");
    const withMode = composerHtml(tab, { target: A, scope: SCOPE, stage: "write", validation: true });
    expect(withMode).toContain("validation draft");
    expect(withMode).not.toMatch(/<form\b|name="validation"|authorization/i);
  });
});

describe("the draft scope", () => {
  it("is an opaque, stable digest per person — never the user id — and absent without one", () => {
    const user = "5b8f2c7e-1d2a-4e3b-9c4d-6a7b8c9d0e1f";
    const scope = replyDraftScope(user);
    expect(scope).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(scope).toBe(replyDraftScope(user));
    expect(scope).not.toContain(user.slice(0, 8));
    expect(replyDraftScope("6c9f3d8f-2e3b-4f4c-8d5e-7b8c9d0e1f2a")).not.toBe(scope);
    expect(replyDraftScope("")).toBeUndefined();
  });
});

describe("Step 7B-15H — a pending publication never becomes a new draft (audit 7B-15G P2-1)", () => {
  const form = (text: string): FormData => {
    const data = new FormData();
    data.set("text", text);
    data.set("idempotencyKey", "rk-1");
    return data;
  };
  /** A request whose answer the test decides, recording how many times the action really ran. */
  function controlledAction() {
    let answer: (value: ReplyActionState) => void = () => undefined;
    let fail: (error: unknown) => void = () => undefined;
    const action = vi.fn(() => new Promise<ReplyActionState>((resolve, reject) => {
      answer = resolve;
      fail = reject;
    }));
    return {
      action,
      answer: (value: ReplyActionState) => {
        answer(value);
      },
      fail: (error: unknown) => {
        fail(error);
      },
    };
  }

  it.each([
    ["requested", { kind: "requested", intentId: "b1" }],
    ["existing", { kind: "existing", intentId: "b1" }],
    ["unavailable", { kind: "unavailable" }],
  ] as const)("A/B/E — text typed for the same comment while Publish is pending (another mount, any path) is gone after %s: nothing publishable remains", async (_kind, outcome) => {
    const { drafts } = await openTab();
    const key = drafts.replyDraftKey(SCOPE, field(A));
    drafts.keepReplyDraft(key, "hola");
    const request = controlledAction();
    const running = drafts.settleReplyDraft(request.action, key)({ kind: "idle" }, form("hola"));
    // The audit's reproduction: Edit after Publish, " editado" typed while the request is pending.
    drafts.keepReplyDraft(key, "hola editado");
    expect(drafts.restoreReplyDraft(key)).toBeUndefined();
    request.answer(outcome);
    expect(await running).toBe(outcome);
    expect(drafts.restoreReplyDraft(key)).toBeUndefined();
    expect(request.action).toHaveBeenCalledTimes(1);
  });

  it("E — a transport failure (outcome unknown) leaves no draft and propagates unchanged", async () => {
    const { drafts } = await openTab();
    const key = drafts.replyDraftKey(SCOPE, field(A));
    drafts.keepReplyDraft(key, "hola");
    const request = controlledAction();
    const running = drafts.settleReplyDraft(request.action, key)({ kind: "idle" }, form("hola"));
    drafts.keepReplyDraft(key, "hola editado");
    const failure = new Error("network");
    request.fail(failure);
    await expect(running).rejects.toBe(failure);
    expect(drafts.restoreReplyDraft(key)).toBeUndefined();
    // Step 7B-15J: the outcome is unknown, so nothing written afterwards is kept for this comment in this tab…
    drafts.keepReplyDraft(key, "written afterwards");
    expect(drafts.restoreReplyDraft(key)).toBeUndefined();
    // …until a sign-out ends the tab's draft state; then typing is kept again — so the in-flight lock WAS released.
    drafts.clearReplyDrafts();
    drafts.keepReplyDraft(key, "a new session's draft");
    expect(drafts.restoreReplyDraft(key)).toBe("a new session's draft");
  });

  it("C — two requests for the same comment: a refusal of the first never restores text while the second may still be accepted", async () => {
    const { drafts } = await openTab();
    const key = drafts.replyDraftKey(SCOPE, field(A));
    const first = controlledAction();
    const second = controlledAction();
    const one = drafts.settleReplyDraft(first.action, key)({ kind: "idle" }, form("first"));
    const two = drafts.settleReplyDraft(second.action, key)({ kind: "idle" }, form("second"));
    first.answer({ kind: "refused", reason: "IDEMPOTENCY_KEY_REUSED" });
    await one;
    expect(drafts.restoreReplyDraft(key)).toBeUndefined();
    second.answer({ kind: "requested", intentId: "b2" });
    await two;
    expect(drafts.restoreReplyDraft(key)).toBeUndefined();
    // Once nothing is in flight, typing is kept again.
    drafts.keepReplyDraft(key, "a new reply");
    expect(drafts.restoreReplyDraft(key)).toBe("a new reply");
  });

  it("F — refused, blocked and signed_out give back exactly the submitted text (nothing was created) — B's draft untouched", async () => {
    for (const outcome of [{ kind: "refused", reason: "TARGET_NOT_PRESENT" }, { kind: "blocked", code: "PERMISSION_DENIED" }, { kind: "signed_out" }] as const) {
      const { drafts } = await openTab();
      const a = drafts.replyDraftKey(SCOPE, field(A));
      const b = drafts.replyDraftKey(SCOPE, field(B));
      drafts.keepReplyDraft(b, "B's own draft");
      const request = controlledAction();
      const running = drafts.settleReplyDraft(request.action, a)({ kind: "idle" }, form("the reviewed text"));
      request.answer(outcome);
      await running;
      expect(drafts.restoreReplyDraft(a)).toBe("the reviewed text");
      expect(drafts.restoreReplyDraft(b)).toBe("B's own draft");
    }
  });

  it("D — each deliberate submission runs the action exactly once (no retry on any outcome or failure)", async () => {
    for (const outcome of [{ kind: "unavailable" }, { kind: "refused", reason: "CAPABILITY_UNAVAILABLE" }, { kind: "requested", intentId: "b1" }] as const) {
      const { drafts } = await openTab();
      const action = vi.fn(() => Promise.resolve<ReplyActionState>(outcome));
      await drafts.settleReplyDraft(action, drafts.replyDraftKey(SCOPE, field(A)))({ kind: "idle" }, form("x"));
      expect(action).toHaveBeenCalledTimes(1);
    }
    const { drafts } = await openTab();
    const failing = vi.fn(() => Promise.reject(new Error("lost")));
    await expect(drafts.settleReplyDraft(failing, drafts.replyDraftKey(SCOPE, field(A)))({ kind: "idle" }, form("x"))).rejects.toThrow("lost");
    expect(failing).toHaveBeenCalledTimes(1);
  });
});

describe("Step 7B-15H — sign-out clears every draft in the tab (audit 7B-15G P2-2)", () => {
  it("H — person A's drafts are gone after the signed-out surface clears them: person B sees nothing, and the leave confirmation is off", async () => {
    const tab = await openTab();
    const { drafts } = tab;
    drafts.keepReplyDraft(drafts.replyDraftKey(SCOPE, field(A)), "A's unsent reply");
    drafts.keepReplyDraft(drafts.replyDraftKey(SCOPE, field(B, WS_2)), "A's other workspace");
    expect(tab.listeners.add).toEqual(["beforeunload"]);
    drafts.clearReplyDrafts();
    expect(tab.listeners.remove).toEqual(["beforeunload"]);
    for (const scope of [OTHER_PERSON, SCOPE]) {
      expect(drafts.restoreReplyDraft(drafts.replyDraftKey(scope, field(A)))).toBeUndefined();
      expect(drafts.restoreReplyDraft(drafts.replyDraftKey(scope, field(B, WS_2)))).toBeUndefined();
    }
    // B's composer under the same comment shows nothing of A's.
    expect(composerHtml(tab, { target: A, scope: OTHER_PERSON, stage: "write" })).not.toContain("A's unsent reply");
  });

  it("I — signing in again as A brings nothing back (a sign-out is the end of the drafts, by design)", async () => {
    const tab = await openTab();
    tab.drafts.keepReplyDraft(tab.drafts.replyDraftKey(SCOPE, field(A)), "before sign-out");
    tab.drafts.clearReplyDrafts();
    expect(composerHtml(tab, { target: A, scope: SCOPE, stage: "write" })).not.toContain("before sign-out");
  });

  it("H — an answer that arrives AFTER the sign-out never refills the store (no text outlives the session)", async () => {
    const { drafts } = await openTab();
    const key = drafts.replyDraftKey(SCOPE, field(A));
    let answer: (value: ReplyActionState) => void = () => undefined;
    const running = drafts.settleReplyDraft(() => new Promise<ReplyActionState>((resolve) => (answer = resolve)), key)({ kind: "idle" }, (() => {
      const data = new FormData();
      data.set("text", "sent just before signing out");
      return data;
    })());
    drafts.clearReplyDrafts();
    answer({ kind: "refused", reason: "CAPABILITY_UNAVAILABLE" });
    await running;
    expect(drafts.restoreReplyDraft(key)).toBeUndefined();
  });

  it("clearing on the server is a no-op (the boundary's effect never runs there)", async () => {
    vi.resetModules();
    const drafts = await import("@/ui/inbox/reply-drafts");
    expect(() => {
      drafts.clearReplyDrafts();
    }).not.toThrow();
  });
});

describe("Step 7B-15H — restoring never runs anything (K) and never reaches review", () => {
  it("K — rendering composers with kept drafts (every start stage, ordinary and validation) never calls the publish action, even after pending tasks run", async () => {
    const tab = await openTab();
    tab.drafts.keepReplyDraft(tab.drafts.replyDraftKey(SCOPE, field(A)), "kept");
    const action = vi.fn(() => Promise.resolve<ReplyActionState>({ kind: "requested", intentId: "b1" }));
    for (const stage of ["closed", "write", "review", "done"] as const) {
      for (const validation of [false, true]) {
        renderToStaticMarkup(
          h(tab.composer.ReplyComposer, { action, fields: { ...field(A), idempotencyKey: "rk-1", ...(validation ? { validation: true as const } : {}) }, maxChars: 2200, labels: LABELS, outcomes: {}, initialStage: stage, draftScope: SCOPE }),
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    expect(action).not.toHaveBeenCalled();
  });

  it("a kept draft opens the WRITE stage whatever start stage a caller gives (never review or done with restored text)", async () => {
    const tab = await openTab();
    tab.drafts.keepReplyDraft(tab.drafts.replyDraftKey(SCOPE, field(A)), "kept text");
    for (const stage of ["review", "done"] as const) {
      const html = composerHtml(tab, { target: A, scope: SCOPE, stage: stage as "review" });
      expect(html).toMatch(/<textarea[^>]*>kept text<\/textarea>/);
      expect(html).not.toMatch(/<form\b|type="hidden"/);
    }
  });

  it("G/N — Cancel's key is this composer's own: forgetting A leaves B and other workspaces/conversations untouched", async () => {
    const { drafts } = await openTab();
    const keys = [drafts.replyDraftKey(SCOPE, field(A)), drafts.replyDraftKey(SCOPE, field(B)), drafts.replyDraftKey(SCOPE, field(A, WS_2)), drafts.replyDraftKey(SCOPE, field(A, WS, CONVERSATION_2))];
    keys.forEach((key, index) => {
      drafts.keepReplyDraft(key, `draft ${String(index)}`);
    });
    drafts.forgetReplyDraft(keys[0]);
    expect(keys.map((key) => drafts.restoreReplyDraft(key))).toEqual([undefined, "draft 1", "draft 2", "draft 3"]);
  });
});

describe("Step 7B-15J — an unknown outcome never becomes a new publishable draft (audit 7B-15I F1)", () => {
  const form = (text: string): FormData => {
    const data = new FormData();
    data.set("text", text);
    data.set("idempotencyKey", "rk-1");
    return data;
  };

  it.each([
    ["unavailable", () => Promise.resolve<ReplyActionState>({ kind: "unavailable" })],
    ["a transport failure", () => Promise.reject(new Error("lost"))],
  ] as const)("after %s, nothing written for that comment is kept (Edit + typing + remount brings nothing back); other comments are unaffected", async (_label, answer) => {
    const { drafts } = await openTab();
    const a = drafts.replyDraftKey(SCOPE, field(A));
    const b = drafts.replyDraftKey(SCOPE, field(B));
    drafts.keepReplyDraft(a, "fail first text");
    await drafts.settleReplyDraft(answer, a)({ kind: "idle" }, form("fail first text")).catch(() => undefined);
    // The audit's reproduction: Edit after the unknown outcome, then " plus edit" typed.
    drafts.keepReplyDraft(a, "fail first text plus edit");
    expect(drafts.restoreReplyDraft(a)).toBeUndefined();
    // …and nothing comes back LATER either (deferred callbacks, audit 7B-15I X16).
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drafts.restoreReplyDraft(a)).toBeUndefined();
    drafts.keepReplyDraft(b, "B is a different comment");
    expect(drafts.restoreReplyDraft(b)).toBe("B is a different comment");
  });

  it.each([
    ["unavailable", () => Promise.resolve<ReplyActionState>({ kind: "unavailable" })],
    ["a transport failure", () => Promise.reject(new Error("lost"))],
  ] as const)("Step 7B-15L (audit 7B-15K K06): after %s NOTHING is scheduled — no timer, interval or immediate is left behind, and a whole day of them brings no text back", async (_label, answer) => {
    const { drafts } = await openTab();
    const a = drafts.replyDraftKey(SCOPE, field(A));
    vi.useFakeTimers();
    try {
      drafts.keepReplyDraft(a, "fail first text");
      await drafts.settleReplyDraft(answer, a)({ kind: "idle" }, form("fail first text")).catch(() => undefined);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      await vi.runAllTimersAsync();
      expect(drafts.restoreReplyDraft(a)).toBeUndefined();
      drafts.keepReplyDraft(a, "typed after the unknown outcome");
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(drafts.restoreReplyDraft(a)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a later refusal in the SAME composer (its changed text reused the form key) still gives nothing back for that comment", async () => {
    const { drafts } = await openTab();
    const a = drafts.replyDraftKey(SCOPE, field(A));
    await drafts.settleReplyDraft(() => Promise.resolve<ReplyActionState>({ kind: "unavailable" }), a)({ kind: "idle" }, form("first"));
    await drafts.settleReplyDraft(() => Promise.resolve<ReplyActionState>({ kind: "refused", reason: "IDEMPOTENCY_KEY_REUSED" }), a)({ kind: "idle" }, form("changed"));
    expect(drafts.restoreReplyDraft(a)).toBeUndefined();
  });

  it("the uncertainty is per person: another person's key for the same comment is not affected, and a sign-out clears it", async () => {
    const { drafts } = await openTab();
    const mine = drafts.replyDraftKey(SCOPE, field(A));
    await drafts.settleReplyDraft(() => Promise.resolve<ReplyActionState>({ kind: "unavailable" }), mine)({ kind: "idle" }, form("x"));
    drafts.keepReplyDraft(drafts.replyDraftKey(OTHER_PERSON, field(A)), "theirs");
    expect(drafts.restoreReplyDraft(drafts.replyDraftKey(OTHER_PERSON, field(A)))).toBe("theirs");
    drafts.clearReplyDrafts();
    drafts.keepReplyDraft(mine, "after a new sign-in");
    expect(drafts.restoreReplyDraft(mine)).toBe("after a new sign-in");
  });
});
