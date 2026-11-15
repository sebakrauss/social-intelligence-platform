/**
 * Inbox 2.0, phase 1 (Step 7B-15B) — presentation only, rendered on the server with the read model replaced in-process.
 * Proves the layout contract: ONE wide list; the selected conversation drawn IN PLACE inside its own row (or on its own
 * when its row is not on screen); ONE reply composer per render, placed by the address (`?reply=`) and only under a
 * comment the server's reply model allows; secondary actions listed as unavailable with their reason, never as controls;
 * the outbound states as the database reports them. Nothing here posts: the composer's own protocol is pinned by
 * tests/unit/ui/reply-composer.test.ts and the request path by tests/unit/server/inbox-reply.test.ts.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConversationDetail, ConversationViewState, InboxListState } from "@/server/inbox/inbox";
import { REPLY_REASON_MESSAGES, displayTime } from "@/server/inbox/inbox";
import { t } from "@/server/i18n";

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ANCHOR = "a1111111-1111-4111-8111-111111111111";
const OWN = "a2222222-2222-4222-8222-222222222222";
const AUDIENCE_REPLY = "a3333333-3333-4333-8333-333333333333";
const SECOND = "a4444444-4444-4444-8444-444444444444";
const HIDDEN = "a5555555-5555-4555-8555-555555555555";
const T = new Date("2026-11-13T12:37:00.000Z");
const CURSOR = `${T.toISOString()}~${OTHER}`;

// Step 7B-15U: short times depend on the current UTC year — the clock is frozen so these tests never age.
vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-14T12:00:00Z") });
const env = vi.hoisted((): { list: unknown; detail: unknown; scope: string | undefined } => ({ list: undefined, detail: undefined, scope: "scope-layout" }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("@/server/inbox/runtime", () => ({
  currentInboxPage: () => Promise.resolve(env.list),
  currentConversation: () => Promise.resolve(env.detail),
  currentReplyDraftScope: () => Promise.resolve(env.scope),
  inboxPipeline: () => undefined,
}));

const { default: ListPage } = await import("@/app/workspaces/[workspaceId]/inbox/page");
const { default: DetailPage } = await import("@/app/workspaces/[workspaceId]/inbox/[conversationId]/page");
const views = await import("@/app/workspaces/[workspaceId]/inbox/views");
const { replyTargetOf } = views;
const drafts = await import("@/ui/inbox/reply-drafts");

const escape = (message: string): string => message.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const count = (html: string, pattern: RegExp): number => [...html.matchAll(pattern)].length;

type Ready = Extract<InboxListState, { kind: "ready" }>;
const row = (conversationId: string, author: string): Ready["page"]["items"][number] => ({
  conversationId,
  workflowState: "open",
  platform: "instagram",
  source: "organic",
  contentKind: "post",
  anchor: { observed: true, author: "audience", authorLabel: author, excerpt: `excerpt of ${author}`, presence: "present" },
  latestActivityAt: T,
  observedCount: 1,
  notYetReadCount: 0,
  anyHidden: false,
  anyRemovedAtSource: false,
});
const list = (ids: readonly string[] = [OTHER, CONVERSATION]): Ready => ({
  kind: "ready",
  workspaceId: WS as never,
  page: { items: ids.map((id) => row(id, id === CONVERSATION ? "Selected Person" : "Other Person")), nextCursor: null, asOf: T, coverage: [], coverageOmitted: false, emptyReason: null },
});

const member = (interactionId: string, over: Partial<ConversationDetail["thread"][number]> = {}): ConversationDetail["thread"][number] => ({
  interactionId,
  parentInteractionId: null,
  kind: "comment",
  observed: true,
  author: "audience",
  authorLabel: "Selected Person",
  text: `text of ${interactionId.slice(0, 2)}`,
  presence: "present",
  providerCreatedAt: T,
  providerEditedAt: null,
  textObservedAt: T,
  earlierVersions: [],
  olderVersionsOmitted: false,
  facts: [],
  ...over,
});
const AVAILABLE: ConversationDetail["reply"] = { kind: "available", connectedAccountId: "66666666-6666-4666-8666-666666666666", platform: "facebook", maxChars: 2200, limitation: null };
const detail = (reply: ConversationDetail["reply"], over: Partial<ConversationDetail> = {}): Extract<ConversationViewState, { kind: "ready" }> => ({
  kind: "ready",
  workspaceId: WS as never,
  detail: {
    conversationId: CONVERSATION,
    workflowState: "open",
    platform: "facebook",
    source: "organic",
    contentKind: "post",
    anchorInteractionId: ANCHOR,
    truncated: false,
    reply,
    outbound: [],
    thread: [
      member(ANCHOR),
      member(OWN, { parentInteractionId: ANCHOR, kind: "reply", author: "own_account", authorLabel: null }),
      member(AUDIENCE_REPLY, { parentInteractionId: ANCHOR, kind: "reply" }),
      member(SECOND, { authorLabel: "Second Person" }),
      member(HIDDEN, { presence: "hidden" }),
    ],
    ...over,
  },
});

async function renderList(state: InboxListState): Promise<string> {
  env.list = state;
  return renderToStaticMarkup(await ListPage({ params: Promise.resolve({ workspaceId: WS }), searchParams: Promise.resolve({}) }));
}
async function renderConversation(state: ConversationViewState, listState: InboxListState | undefined, query: Record<string, string> = {}): Promise<string> {
  env.detail = state;
  env.list = listState;
  return renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ workspaceId: WS, conversationId: CONVERSATION }), searchParams: Promise.resolve(query) }));
}
const composers = (html: string): number => count(html, />Reply<\/button>/g) + count(html, /<textarea/g);
const expandedOf = (html: string): string => {
  const start = html.indexOf(`<li id="row-${CONVERSATION}"`);
  return html.slice(start, html.indexOf("</ol>", html.lastIndexOf("</ol>")) + 5);
};

describe("list without a selection", () => {
  it("one wide list: every row is a link, nothing is expanded, no second pane, no placeholder, no control", async () => {
    const html = await renderList(list());
    expect(html).toMatch(/class="[^"]*workspace[^"]*" data-selected="false"/);
    expect(count(html, /<li id="row-/g)).toBe(2);
    expect(html).not.toMatch(/expandedItem|aria-current|id="conversation"/);
    expect(html).not.toMatch(/detailPane|listPane/);
    expect(html).not.toContain(escape(t("inbox.detail.placeholder")));
    expect(html).not.toMatch(/<form\b|<button\b|<input\b|<textarea\b/);
    expect(html).toContain(`href="/workspaces/${WS}/inbox/${CONVERSATION}#row-${CONVERSATION}"`);
  });
});

describe("a selected conversation", () => {
  it("is drawn IN PLACE: inside its own row, after its summary link, with the rows before and after still in the list", async () => {
    const html = await renderConversation(detail({ kind: "hidden" }), list([OTHER, CONVERSATION, "33333333-3333-4333-8333-333333333333"]));
    expect(html).toMatch(/class="[^"]*workspace[^"]*" data-selected="true"/);
    expect(count(html, /<li id="row-/g)).toBe(3);
    expect(count(html, /aria-current="page"/g)).toBe(1);
    expect(count(html, /id="conversation"/g)).toBe(1);
    // The conversation lives inside the selected row's <li>, under the row's own link — not in a pane beside the list.
    expect(html).toMatch(new RegExp(`<li id="row-${CONVERSATION}" class="[^"]*expandedItem[^"]*"><a href="/workspaces/${WS}/inbox/${CONVERSATION}#row-${CONVERSATION}"[^>]*aria-current="page"`));
    const before = html.indexOf(`id="row-${OTHER}"`);
    const open = html.indexOf('id="conversation"');
    const after = html.indexOf('id="row-33333333-3333-4333-8333-333333333333"');
    expect(before).toBeGreaterThan(-1);
    expect(before).toBeLessThan(open);
    expect(open).toBeLessThan(after);
    expect(html).not.toMatch(/standalone|detailPane/);
    // IA §8 order inside the expanded row: content context, then the thread.
    const context = html.indexOf(">Facebook</span>", open);
    expect(context).toBeGreaterThan(open);
    expect(context).toBeLessThan(html.indexOf(escape(t("inbox.thread.heading"))));
    // One page heading: the conversation; the list's own heading steps down.
    expect(count(html, /<h1\b/g)).toBe(1);
    // The skip link jumps over the rows before it.
    expect(html).toContain(`href="#conversation"`);
  });

  it("the way back returns to the list at the same position and to this conversation's row; row links keep the position", async () => {
    const html = await renderConversation(detail({ kind: "hidden" }), list(), { cursor: CURSOR });
    expect(html).toContain(`href="/workspaces/${WS}/inbox?cursor=${encodeURIComponent(CURSOR)}#row-${CONVERSATION}"`);
    expect(html).toContain(`href="/workspaces/${WS}/inbox/${OTHER}?cursor=${encodeURIComponent(CURSOR)}#row-${OTHER}"`);
    const plain = await renderConversation(detail({ kind: "hidden" }), list());
    expect(plain).toContain(`href="/workspaces/${WS}/inbox#row-${CONVERSATION}"`);
  });

  it("whose row is not on screen (another position, or no list) is drawn on its own above the list — never dropped", async () => {
    const elsewhere = await renderConversation(detail({ kind: "hidden" }), list([OTHER]));
    expect(elsewhere).toMatch(/class="[^"]*standalone[^"]*"/);
    expect(elsewhere).not.toMatch(/expandedItem|aria-current/);
    expect(elsewhere.indexOf('id="conversation"')).toBeLessThan(elsewhere.indexOf(`id="row-${OTHER}"`));
    expect(count(elsewhere, /<h1\b/g)).toBe(1);
    const alone = await renderConversation(detail({ kind: "hidden" }), undefined);
    expect(alone).toMatch(/class="[^"]*standalone[^"]*"/);
    expect(count(alone, /id="conversation"/g)).toBe(1);
    const missing = await renderConversation({ kind: "conversation_not_found" }, list());
    expect(missing).toContain(escape(t("inbox.conversation.not_found")));
    expect(missing).toMatch(new RegExp(`<li id="row-${CONVERSATION}" class="[^"]*expandedItem`));
  });
});

describe("one reply composer per render", () => {
  it("by default it sits (closed) under the first comment that can be answered; every other answerable comment offers a link, never a second composer", async () => {
    const html = await renderConversation(detail(AVAILABLE), list());
    expect(composers(html)).toBe(1);
    expect(html).not.toMatch(/<form\b|<textarea\b/); // closed: nothing can be posted before write → review
    const anchor = html.slice(html.indexOf(`id="member-${ANCHOR}"`), html.indexOf(`id="member-${OWN}"`));
    expect(anchor).toMatch(/>Reply<\/button>/);
    // The audience reply (Facebook) and the second comment: links that move the composer; own and hidden: nothing.
    expect(count(html, new RegExp(`>${escape(t("inbox.reply.here"))}</a>`, "g"))).toBe(2);
    expect(html).toContain(`href="/workspaces/${WS}/inbox/${CONVERSATION}?reply=${AUDIENCE_REPLY}#member-${AUDIENCE_REPLY}"`);
    expect(html).toContain(`href="/workspaces/${WS}/inbox/${CONVERSATION}?reply=${SECOND}#member-${SECOND}"`);
    expect(html).not.toContain(`reply=${OWN}`);
    expect(html).not.toContain(`reply=${HIDDEN}`);
  });

  it("the address places it: ?reply= opens it under that comment, ready to write; the link moves to the others; the position is kept", async () => {
    const html = await renderConversation(detail(AVAILABLE), list(), { reply: SECOND, cursor: CURSOR });
    expect(count(html, /<textarea/g)).toBe(1);
    expect(count(html, />Reply<\/button>/g)).toBe(0);
    const second = html.slice(html.indexOf(`id="member-${SECOND}"`), html.indexOf(`id="member-${HIDDEN}"`));
    expect(second).toMatch(/<textarea/);
    expect(html).not.toMatch(/<form\b/); // write stage: only the review stage posts
    expect(html).toContain(`href="/workspaces/${WS}/inbox/${CONVERSATION}?cursor=${encodeURIComponent(CURSOR)}&amp;reply=${ANCHOR}#member-${ANCHOR}"`);
    expect(html).not.toContain(`reply=${SECOND}`);
  });

  it("an address naming a comment that cannot be answered (own, hidden, unknown, malformed) is ignored: the default place, closed", async () => {
    for (const reply of [OWN, HIDDEN, "99999999-9999-4999-8999-999999999999", "not-an-id", `${SECOND}' or 1=1`]) {
      const html = await renderConversation(detail(AVAILABLE), list(), { reply });
      expect(composers(html), reply).toBe(1);
      expect(html, reply).not.toMatch(/<textarea/);
      expect(html.slice(html.indexOf(`id="member-${ANCHOR}"`), html.indexOf(`id="member-${OWN}"`)), reply).toMatch(/>Reply<\/button>/);
    }
  });

  it("the address never makes a reply possible: hidden or unavailable reply models draw no composer and no link, whatever ?reply= says", async () => {
    for (const reply of [{ kind: "hidden" }, { kind: "unavailable", reason: "platform_unavailable", platform: "facebook" }, { kind: "unavailable", reason: "paused", platform: "facebook" }] as const) {
      const html = await renderConversation(detail(reply), list(), { reply: ANCHOR });
      expect(composers(html)).toBe(0);
      expect(html).not.toMatch(/<form\b|<button\b|<input\b|<textarea\b/);
      expect(html).not.toContain(escape(t("inbox.reply.here")));
      expect(html).not.toContain("reply=");
    }
    expect(replyTargetOf(detail({ kind: "hidden" }).detail, ANCHOR)).toBeUndefined();
    expect(replyTargetOf(detail(AVAILABLE).detail, undefined)).toBe(ANCHOR);
    expect(replyTargetOf(detail(AVAILABLE).detail, SECOND)).toBe(SECOND);
    expect(replyTargetOf(detail(AVAILABLE).detail, HIDDEN)).toBe(ANCHOR);
  });
});

describe("the exceptional validation reply", () => {
  const expiresAt = new Date("2026-11-13T13:22:54.000Z");
  const validation = (targets: readonly string[]): ConversationDetail["reply"] => ({ kind: "validation", connectedAccountId: "66666666-6666-4666-8666-666666666666", platform: "facebook", maxChars: 2200, targets: targets.map((targetInteractionId) => ({ targetInteractionId, expiresAt })) });

  it("available: the ONE composer only under the comment the live authorization covers — no composer or link under any other; the browser gets a mode flag's notice, never an identifier", async () => {
    const html = await renderConversation(detail(validation([SECOND])), list(), { reply: SECOND });
    expect(count(html, /<textarea/g)).toBe(1);
    expect(html.slice(html.indexOf(`id="member-${SECOND}"`), html.indexOf(`id="member-${HIDDEN}"`))).toMatch(/<textarea/);
    expect(html).toContain(escape(t("inbox.reply.validation_notice", { time: displayTime(expiresAt) })));
    expect(html).not.toContain(escape(t("inbox.reply.here")));
    expect(html).not.toMatch(/authorization[_-]?id|validationAuthorization/i);
    // Asking for another (uncovered) comment changes nothing: the composer stays, closed, under the covered one.
    const elsewhere = await renderConversation(detail(validation([SECOND])), list(), { reply: ANCHOR });
    expect(composers(elsewhere)).toBe(1);
    expect(elsewhere.slice(elsewhere.indexOf(`id="member-${SECOND}"`), elsewhere.indexOf(`id="member-${HIDDEN}"`))).toMatch(/>Reply<\/button>/);
    expect(elsewhere.slice(elsewhere.indexOf(`id="member-${ANCHOR}"`), elsewhere.indexOf(`id="member-${OWN}"`))).not.toMatch(/<button|reply=/);
  });

  it("expired (the server answers the ordinary model again): the unavailable line with its reason, no composer, no validation notice", async () => {
    const html = await renderConversation(detail({ kind: "unavailable", reason: "platform_unavailable", platform: "facebook" }), list(), { reply: SECOND });
    expect(html).toContain(escape(t("inbox.reply.unavailable_label")));
    expect(html).toContain(escape(t("inbox.reply.reason.platform_unavailable")));
    expect(composers(html)).toBe(0);
    expect(html).not.toMatch(/validation|<form\b|<button\b|<textarea\b/i);
  });
});

describe("what is not available says why", () => {
  it("a capability that is not validated / not enabled, paused, the connection or Monitor-only: ONE reason next to the thread, in outcome language", async () => {
    for (const reason of ["platform_unavailable", "paused", "connection", "account_inactive", "monitor_only"] as const) {
      const html = await renderConversation(detail({ kind: "unavailable", reason, platform: "facebook" }), list());
      expect(count(html, new RegExp(escape(t("inbox.reply.unavailable_label")), "g"))).toBe(1);
      expect(html).toContain(escape(t(`inbox.reply.reason.${reason}`)));
    }
  });

  it("secondary actions are grouped under one disclosure and listed with their reason — never as controls; a role without the reply affordance sees none (IA §18); no destructive action is drawn", async () => {
    const html = await renderConversation(detail(AVAILABLE), list());
    const actions = html.slice(html.indexOf(`aria-label="${escape(t("inbox.actions.heading"))}"`));
    expect(actions).toMatch(new RegExp(`<details[^>]*><summary[^>]*>${escape(t("inbox.actions.more"))}`));
    for (const key of ["inbox.actions.reply_private", "inbox.actions.hide"] as const) expect(actions).toContain(escape(t(key)));
    expect(count(actions, new RegExp(escape(t("inbox.actions.reason.not_yet")), "g"))).toBe(2);
    expect(actions.slice(0, actions.indexOf("</section>"))).not.toMatch(/<button|<form|<a\b|<input/);
    expect(html).not.toMatch(/\b(Delete|Block)\b/);
    // The secondary actions come after the thread (primary: the reply, under its comment).
    expect(html.indexOf(`id="member-${HIDDEN}"`)).toBeLessThan(html.indexOf(`aria-label="${escape(t("inbox.actions.heading"))}"`));
    const monitor = await renderConversation(detail({ kind: "unavailable", reason: "monitor_only", platform: "facebook" }), list());
    expect(count(monitor.slice(monitor.indexOf(`aria-label="${escape(t("inbox.actions.heading"))}"`)), new RegExp(escape(t("inbox.reply.reason.monitor_only")), "g"))).toBe(2);
    const none = await renderConversation(detail({ kind: "hidden" }), list());
    expect(none).not.toContain(escape(t("inbox.actions.more")));
    expect(none).not.toContain(escape(t("inbox.actions.reply_private")));
  });
});

describe("outbound replies in the expanded row", () => {
  const outbound = (state: ConversationDetail["outbound"][number]["state"], confirmed = false): ConversationDetail["outbound"][number] => ({ intentId: `b-${state}`, parentInteractionId: ANCHOR, text: `reply ${state}`, state, outcomeCode: state === "checking" ? "RESPONSE_LOST" : null, createdAt: T, confirmedAt: confirmed ? new Date("2026-11-13T12:39:36.000Z") : null });

  it("Sending and Sent: the real state under the comment it answers, the request time, the confirmation time only once confirmed; nothing offers to send again", async () => {
    const sending = await renderConversation(detail(AVAILABLE, { outbound: [outbound("sending")] }), list());
    // Step 7B-15O: the request is an entry of the anchor's own block (after its replies when nothing dates it earlier).
    const under = sending.slice(sending.indexOf(`id="member-${ANCHOR}"`), sending.indexOf(`id="member-${SECOND}"`));
    expect(under).toContain(escape(t("inbox.outbound.state.sending")));
    expect(under).toContain("reply sending");
    expect(under).toContain(escape(t("inbox.outbound.requested_at", { time: displayTime(T) })));
    expect(sending).not.toContain(escape(t("inbox.outbound.state.sent")));
    expect(sending).not.toMatch(/retry|resend|send again/i);
    const sent = await renderConversation(detail(AVAILABLE, { outbound: [outbound("sent", true)] }), list());
    expect(sent).toContain(escape(t("inbox.outbound.state.sent")));
    expect(sent).toContain(escape(t("inbox.outbound.confirmed_at", { time: displayTime(new Date("2026-11-13T12:39:36.000Z")) })));
    expect(sent).not.toContain(escape(t("inbox.outbound.state.sending")));
  });

  it("Failed, Checking and Blocked: each with its note, never a provider code, never a way to send again; moving the selection posts nothing (links only)", async () => {
    const html = await renderConversation(detail(AVAILABLE, { outbound: [outbound("failed"), outbound("checking"), outbound("blocked")] }), list());
    for (const state of ["failed", "checking", "blocked"] as const) {
      expect(html).toContain(escape(t(`inbox.outbound.state.${state}`)));
      expect(html).toContain(escape(t(`inbox.outbound.${state}_note`)));
    }
    expect(html).not.toContain("RESPONSE_LOST");
    expect(html).not.toMatch(/retry|resend|send again/i);
    // Every way to another row or another comment is a plain link (GET): no form exists outside the composer's review stage.
    expect(html).not.toMatch(/<form\b/);
    expect(composers(expandedOf(html))).toBe(1);
  });
});

describe("loading an address never submits or skips the review (Step 7B-15D; audit 7B-15C P2)", () => {
  it("with the REAL composer: for every reply model and every address, the page has no form, no submit control and no hidden field — the furthest an address can get is the write stage (a textarea and a Review button), never the review stage", async () => {
    const expiresAt = new Date("2026-11-13T13:22:54.000Z");
    const models: ConversationDetail["reply"][] = [
      AVAILABLE,
      { kind: "validation", connectedAccountId: "66666666-6666-4666-8666-666666666666", platform: "facebook", maxChars: 2200, targets: [{ targetInteractionId: SECOND, expiresAt }] },
      { kind: "unavailable", reason: "monitor_only", platform: "facebook" },
      { kind: "hidden" },
    ];
    const addresses: Record<string, string>[] = [{}, { reply: ANCHOR }, { reply: SECOND }, { reply: AUDIENCE_REPLY }, { reply: SECOND, initialStage: "review", initialText: "injected", text: "injected", stage: "review" }];
    for (const reply of models) {
      for (const address of addresses) {
        const html = await renderConversation(detail(reply), list(), address);
        expect(html).not.toMatch(/<form\b/);
        expect(html).not.toMatch(/type="submit"|type="hidden"|name="(text|idempotencyKey|targetInteractionId|validation)"/);
        expect(html).not.toContain("injected");
        expect(html).not.toContain(escape(t("inbox.reply.publish")));
        expect(html).not.toContain(escape(t("inbox.reply.review_heading")));
        expect(count(html, /<textarea/g)).toBeLessThanOrEqual(1);
      }
    }
    // The write stage itself: the only way forward is the explicit Review button (disabled while the text is empty).
    const write = await renderConversation(detail(AVAILABLE), list(), { reply: SECOND });
    expect(write).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${escape(t("inbox.reply.review"))}</button>`));
  });

  it("Monitor-only with a valid ?reply=: the mode reason, no composer, no link that places one", async () => {
    const html = await renderConversation(detail({ kind: "unavailable", reason: "monitor_only", platform: "facebook" }), list(), { reply: ANCHOR });
    expect(composers(html)).toBe(0);
    expect(html).not.toMatch(/<form\b|<button\b|<input\b|<textarea\b|reply=/);
    expect(html).toContain(escape(t("inbox.reply.reason.monitor_only")));
  });
});

describe("unsent drafts on the production page (Step 7B-15F; the real composer, a browser tab stubbed)", () => {
  const SCOPE = "scope-layout";
  const keyOf = (target: string): string | undefined => drafts.replyDraftKey(SCOPE, { workspaceId: WS, conversationId: CONVERSATION, targetInteractionId: target });
  const restoredNote = escape(t("inbox.reply.draft_restored"));
  const inTab = async <T,>(run: () => Promise<T>): Promise<T> => {
    vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
    try {
      return await run();
    } finally {
      for (const target of [ANCHOR, SECOND, AUDIENCE_REPLY]) drafts.forgetReplyDraft(keyOf(target));
      vi.unstubAllGlobals();
    }
  };

  it("A → B → A: under B the composer is empty and A's text is nowhere on the page; back on A it is restored at the write stage, with no form", async () => {
    await inTab(async () => {
      drafts.keepReplyDraft(keyOf(ANCHOR), "Draft for the anchor ✓");
      const onB = await renderConversation(detail(AVAILABLE), list(), { reply: SECOND });
      expect(onB).not.toContain("Draft for the anchor");
      expect(onB.slice(onB.indexOf(`id="member-${SECOND}"`), onB.indexOf(`id="member-${HIDDEN}"`))).toMatch(/<textarea[^>]*><\/textarea>/);
      expect(onB).toContain(`href="/workspaces/${WS}/inbox/${CONVERSATION}?reply=${ANCHOR}#member-${ANCHOR}"`);
      const backOnA = await renderConversation(detail(AVAILABLE), list(), { reply: ANCHOR });
      const underA = backOnA.slice(backOnA.indexOf(`id="member-${ANCHOR}"`), backOnA.indexOf(`id="member-${OWN}"`));
      expect(underA).toMatch(/<textarea[^>]*>Draft for the anchor ✓<\/textarea>/);
      expect(underA).toContain(restoredNote);
      expect(count(backOnA, /<textarea/g)).toBe(1);
      expect(backOnA).not.toMatch(/<form\b|type="hidden"|type="submit"/);
    });
  });

  it("the page hands the composer the server's scope: without one (no verified person) no draft is offered", async () => {
    await inTab(async () => {
      drafts.keepReplyDraft(keyOf(ANCHOR), "scoped draft");
      env.scope = undefined;
      try {
        const html = await renderConversation(detail(AVAILABLE), list(), { reply: ANCHOR });
        expect(html).not.toContain("scoped draft");
      } finally {
        env.scope = SCOPE;
      }
      expect(await renderConversation(detail(AVAILABLE), list(), { reply: ANCHOR })).toContain("scoped draft");
    });
  });

  it("a kept draft never brings a composer back: Monitor-only, an unavailable or hidden reply, or an expired validation authorization draw no composer and none of its text", async () => {
    await inTab(async () => {
      drafts.keepReplyDraft(keyOf(ANCHOR), "Kept but not publishable");
      drafts.keepReplyDraft(keyOf(SECOND), "Kept under the second");
      for (const reply of [{ kind: "unavailable", reason: "monitor_only", platform: "facebook" }, { kind: "unavailable", reason: "platform_unavailable", platform: "facebook" }, { kind: "hidden" }] as const) {
        for (const address of [{}, { reply: ANCHOR }, { reply: SECOND }]) {
          const html = await renderConversation(detail(reply), list(), address);
          expect(html).not.toMatch(/Kept but not publishable|Kept under the second|<textarea|<form\b/);
        }
      }
    });
  });

  it("a live validation authorization for SECOND only: the anchor's draft stays hidden, the second's draft shows under the server-drawn validation composer, with its notice and no form", async () => {
    await inTab(async () => {
      drafts.keepReplyDraft(keyOf(ANCHOR), "Draft under the anchor");
      drafts.keepReplyDraft(keyOf(SECOND), "Draft under the second");
      const expiresAt = new Date("2026-11-13T13:22:54.000Z");
      const validation: ConversationDetail["reply"] = { kind: "validation", connectedAccountId: "66666666-6666-4666-8666-666666666666", platform: "facebook", maxChars: 2200, targets: [{ targetInteractionId: SECOND, expiresAt }] };
      for (const address of [{ reply: ANCHOR }, { reply: SECOND }]) {
        const html = await renderConversation(detail(validation), list(), address);
        expect(html).not.toContain("Draft under the anchor");
        expect(html).toContain("Draft under the second");
        expect(html).toContain(escape(t("inbox.reply.validation_notice", { time: displayTime(expiresAt) })));
        expect(html).not.toMatch(/<form\b|type="hidden"/);
      }
    });
  });

  it("'reply to this comment' is an in-app link (no prefetch, the same address), so moving the composer does not reload the page", async () => {
    const html = await renderConversation(detail(AVAILABLE), list());
    // Step 7B-15S: a decorative reply icon (aria-hidden) may precede the label; the label stays the link's only text.
    const link = new RegExp(`<a[^>]*href="/workspaces/${WS}/inbox/${CONVERSATION}\\?reply=${SECOND}#member-${SECOND}"[^>]*>(?:<svg [^>]*aria-hidden="true"[^>]*>[\\s\\S]*?</svg>)?${escape(t("inbox.reply.here"))}</a>`);
    expect(html).toMatch(link);
  });
});

describe("a reply still on its way or being checked (Step 7B-15J; audit 7B-15I F1) — the server's render is the authority across reloads, tabs and sessions", () => {
  const outbound = (state: ConversationDetail["outbound"][number]["state"], parent = ANCHOR): ConversationDetail["outbound"][number] => ({ intentId: `b-${state}`, parentInteractionId: parent, text: `earlier ${state}`, state, outcomeCode: null, createdAt: T, confirmedAt: state === "sent" ? T : null });
  const underOf = (html: string, from: string, to: string): string => html.slice(html.indexOf(`id="member-${from}"`), html.indexOf(`id="member-${to}"`));

  it.each(["sending", "checking"] as const)("%s under a comment: no composer, no link that places one (whatever ?reply= says), and the reason; the ONE composer moves to another answerable comment", async (state) => {
    for (const address of [{}, { reply: ANCHOR }]) {
      const html = await renderConversation(detail(AVAILABLE, { outbound: [outbound(state)] }), list(), address);
      const anchor = underOf(html, ANCHOR, OWN);
      expect(anchor).not.toMatch(/<textarea|>Reply<\/button>|reply=/);
      expect(anchor).toContain(escape(t("inbox.reply.in_flight")));
      expect(html).not.toContain(`reply=${ANCHOR}`);
      expect(composers(html)).toBe(1);
      expect(replyTargetOf(detail(AVAILABLE, { outbound: [outbound(state)] }).detail, ANCHOR)).not.toBe(ANCHOR);
    }
  });

  it.each(["sent", "failed", "blocked"] as const)("%s (settled) under a comment: a new reply can be written there again", async (state) => {
    const html = await renderConversation(detail(AVAILABLE, { outbound: [outbound(state)] }), list(), { reply: ANCHOR });
    expect(underOf(html, ANCHOR, OWN)).toMatch(/<textarea/);
    expect(html).not.toContain(escape(t("inbox.reply.in_flight")));
  });

  it("a validation authorization for a comment whose reply is being checked offers nothing (no composer anywhere)", async () => {
    const validation: ConversationDetail["reply"] = { kind: "validation", connectedAccountId: "66666666-6666-4666-8666-666666666666", platform: "facebook", maxChars: 2200, targets: [{ targetInteractionId: SECOND, expiresAt: new Date("2026-11-13T13:22:54.000Z") }] };
    const html = await renderConversation(detail(validation, { outbound: [outbound("checking", SECOND)] }), list(), { reply: SECOND });
    expect(composers(html)).toBe(0);
    expect(underOf(html, SECOND, HIDDEN)).toContain(escape(t("inbox.reply.in_flight")));
  });

  it("a kept draft for that comment is never shown while its earlier reply is in flight (a new form key cannot carry it)", async () => {
    vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
    try {
      const key = drafts.replyDraftKey("scope-layout", { workspaceId: WS, conversationId: CONVERSATION, targetInteractionId: ANCHOR });
      drafts.keepReplyDraft(key, "draft that must not come back");
      const html = await renderConversation(detail(AVAILABLE, { outbound: [outbound("checking")] }), list(), { reply: ANCHOR });
      expect(html).not.toContain("draft that must not come back");
      drafts.forgetReplyDraft(key);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the unknown-outcome copy no longer claims nothing was published", () => {
    expect(t("inbox.reply.unavailable")).not.toMatch(/nothing was published/i);
    expect(t("inbox.reply.unavailable")).toMatch(/may already be on its way/);
  });
});

/**
 * Step 7B-15O — the Focus presentation of the real Inbox: the same view models, the same addresses, the same one
 * composer; what changed is how they are drawn. Nothing here reads, posts or decides.
 */
describe("Focus presentation (Step 7B-15O)", () => {
  const { threadEntries } = views;
  const at = (minutes: number): Date => new Date(T.getTime() + minutes * 60_000);
  const request = (id: string, minutes: number, parent = ANCHOR, state: ConversationDetail["outbound"][number]["state"] = "sent"): ConversationDetail["outbound"][number] => ({ intentId: id, parentInteractionId: parent, text: `request ${id}`, state, outcomeCode: null, createdAt: at(minutes), confirmedAt: state === "sent" ? at(minutes + 1) : null });
  const timed = (over: Partial<ConversationDetail> = {}) =>
    detail(AVAILABLE, {
      thread: [
        member(ANCHOR, { providerCreatedAt: at(0) }),
        member(OWN, { parentInteractionId: ANCHOR, kind: "reply", author: "own_account", authorLabel: null, providerCreatedAt: at(1) }),
        member(AUDIENCE_REPLY, { parentInteractionId: ANCHOR, kind: "reply", providerCreatedAt: at(3) }),
        member(SECOND, { authorLabel: "Second Person", providerCreatedAt: at(4) }),
        member(HIDDEN, { presence: "hidden", providerCreatedAt: at(5) }),
      ],
      ...over,
    });
  const order = (state: ReturnType<typeof timed>): string[] => threadEntries(state.detail).map((entry) => (entry.kind === "member" ? entry.item.interactionId : entry.item.intentId));

  describe("chronology: the platform's replies and the replies requested from Wrenkind, in one order", () => {
    it("a request made between two replies is drawn between them — under the comment it answers, never under another", async () => {
      const state = timed({ outbound: [request("b-mid", 2)] });
      expect(order(state)).toEqual([ANCHOR, OWN, "b-mid", AUDIENCE_REPLY, SECOND, HIDDEN]);
      const html = await renderConversation(state, list());
      const positions = [`id="member-${ANCHOR}"`, `id="member-${OWN}"`, "request b-mid", `id="member-${AUDIENCE_REPLY}"`, `id="member-${SECOND}"`].map((needle) => html.indexOf(needle));
      expect(positions.every((position) => position > 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });

    it("before the first reply, after the last one, and for a comment without replies: always inside its own comment's block", () => {
      expect(order(timed({ outbound: [request("b-first", 0.5)] }))).toEqual([ANCHOR, "b-first", OWN, AUDIENCE_REPLY, SECOND, HIDDEN]);
      expect(order(timed({ outbound: [request("b-last", 30)] }))).toEqual([ANCHOR, OWN, AUDIENCE_REPLY, "b-last", SECOND, HIDDEN]);
      expect(order(timed({ outbound: [request("b-second", 30, SECOND)] }))).toEqual([ANCHOR, OWN, AUDIENCE_REPLY, SECOND, "b-second", HIDDEN]);
      expect(order(timed({ outbound: [request("b-end", 30, HIDDEN)] }))).toEqual([ANCHOR, OWN, AUDIENCE_REPLY, SECOND, HIDDEN, "b-end"]);
    });

    it("equal times keep the platform's reply first; several requests keep their request order, then their id — the same on every render", () => {
      expect(order(timed({ outbound: [request("b-tie", 1)] }))).toEqual([ANCHOR, OWN, "b-tie", AUDIENCE_REPLY, SECOND, HIDDEN]);
      const many = [request("b-z", 2), request("b-a", 2), request("b-early", 0.5)];
      const expected = [ANCHOR, "b-early", OWN, "b-a", "b-z", AUDIENCE_REPLY, SECOND, HIDDEN];
      expect(order(timed({ outbound: many }))).toEqual(expected);
      expect(order(timed({ outbound: [...many].reverse() }))).toEqual(expected);
    });

    it("a reply the platform did not date never moves anything (no time is invented); a request whose comment is not shown is listed last, not dropped", () => {
      const undated = timed({ outbound: [request("b-x", 2)] });
      const thread = undated.detail.thread.map((item) => (item.interactionId === AUDIENCE_REPLY ? { ...item, providerCreatedAt: null } : item));
      expect(order({ ...undated, detail: { ...undated.detail, thread } })).toEqual([ANCHOR, OWN, AUDIENCE_REPLY, "b-x", SECOND, HIDDEN]);
      expect(order(timed({ outbound: [request("b-orphan", 2, "a9999999-9999-4999-8999-999999999999")] }))).toEqual([ANCHOR, OWN, AUDIENCE_REPLY, SECOND, HIDDEN, "b-orphan"]);
    });

    it("a reply to a reply keeps its place under that reply (parent and child are never separated)", () => {
      const state = timed({ outbound: [request("b-nested", 2, OWN)] });
      expect(order(state)).toEqual([ANCHOR, OWN, "b-nested", AUDIENCE_REPLY, SECOND, HIDDEN]);
    });
  });

  describe("the open conversation in its row", () => {
    it("the row is a compact header: the comment's text is drawn once, in the thread — not again in the row", async () => {
      const html = await renderConversation(detail(AVAILABLE), list());
      expect(count(html, /excerpt of Selected Person/g)).toBe(0);
      expect(count(html, /excerpt of Other Person/g)).toBe(1);
      expect(count(html, new RegExp(`text of ${ANCHOR.slice(0, 2)}`, "g"))).toBe(1);
      // Exactly one conversation is open, and it is the selected row's.
      expect(count(html, /id="conversation"/g)).toBe(1);
      expect(count(html, /aria-current="page"/g)).toBe(1);
    });

    it("Previous / Next / Close are plain links to the rows' own addresses at the same list position; an end of the list is said, not linked", async () => {
      const third = "33333333-3333-4333-8333-333333333333";
      const html = await renderConversation(detail(AVAILABLE), list([OTHER, CONVERSATION, third]), { cursor: CURSOR });
      const nav = html.slice(html.indexOf(`aria-label="${t("inbox.nav.label")}"`), html.indexOf("</nav>", html.indexOf(`aria-label="${t("inbox.nav.label")}"`)));
      expect(nav).toContain(t("inbox.nav.position", { index: "2", count: "3" }));
      const cursor = encodeURIComponent(CURSOR);
      expect(nav).toContain(`href="/workspaces/${WS}/inbox/${OTHER}?cursor=${cursor}#row-${OTHER}"`);
      expect(nav).toContain(`href="/workspaces/${WS}/inbox/${third}?cursor=${cursor}#row-${third}"`);
      expect(nav).toContain(`href="/workspaces/${WS}/inbox?cursor=${cursor}#row-${CONVERSATION}"`);
      expect(nav).not.toMatch(/<form|<button/);
      // First of the list: "Previous" keeps its place as a plain word, hidden from assistive technology (the position
      // says where the person is) — not a link, and not a generic element pretending to be a disabled control.
      const first = await renderConversation(detail(AVAILABLE), list([CONVERSATION, OTHER]));
      const firstNav = first.slice(first.indexOf(`aria-label="${t("inbox.nav.label")}"`), first.indexOf("</nav>", first.indexOf(`aria-label="${t("inbox.nav.label")}"`)));
      expect(firstNav).toMatch(new RegExp(`<span class="[^"]*navEnd[^"]*" aria-hidden="true"><span[^>]*>‹</span><span[^>]*>${t("inbox.nav.previous")}</span></span>`));
      expect(firstNav).not.toContain("aria-disabled");
      expect(count(firstNav, /<a /g)).toBe(2); // Next and Close only
      expect(first).toContain(t("inbox.nav.position", { index: "1", count: "2" }));
    });

    it("Step 7B-15S: with older or newer pages the position says 'on this page', and the last row leads to the older conversations — never a dead end", async () => {
      const older = "2026-11-12T10:00:00.000Z~33333333-3333-4333-8333-333333333333";
      const paged: InboxListState = { ...list([OTHER, CONVERSATION]), page: { ...list([OTHER, CONVERSATION]).page, nextCursor: older } };
      const html = await renderConversation(detail(AVAILABLE), paged);
      const nav = html.slice(html.indexOf(`aria-label="${t("inbox.nav.label")}"`), html.indexOf("</nav>", html.indexOf(`aria-label="${t("inbox.nav.label")}"`)));
      expect(nav).toContain(t("inbox.nav.position_page", { index: "2", count: "2" }));
      expect(nav).toMatch(new RegExp(`<a href="/workspaces/${WS}/inbox\\?cursor=${encodeURIComponent(older).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*><span class="[^"]*navWord[^"]*">${escape(t("inbox.pagination.older"))}</span>`));
      expect(nav).not.toContain(`>${t("inbox.nav.next")}`);
      // A page reached through a cursor has newer pages before it: its first row is not "1 of everything" either.
      const second = await renderConversation(detail(AVAILABLE), list([CONVERSATION, OTHER]), { cursor: CURSOR });
      expect(second).toContain(t("inbox.nav.position_page", { index: "1", count: "2" }));
      // The whole list on one page keeps the plain position.
      const whole = await renderConversation(detail(AVAILABLE), list([OTHER, CONVERSATION]));
      expect(whole).toContain(t("inbox.nav.position", { index: "2", count: "2" }));
      expect(whole).not.toContain(escape(t("inbox.pagination.older")));
    });

    it("a conversation opened on its own (its row is not on screen) has no row navigation — the plain way back to the list stays", async () => {
      const html = await renderConversation(detail(AVAILABLE), list([OTHER]));
      expect(html).not.toContain(`aria-label="${t("inbox.nav.label")}"`);
      expect(html).toContain(`>${t("inbox.back")}</a>`);
      expect(count(html, /id="conversation"/g)).toBe(1);
    });

    it("what is known about the place is ONE disclosure with an honest gap: no caption, handle, date or link is invented", async () => {
      const html = await renderConversation(detail(AVAILABLE), list());
      expect(count(html, /<details class="[^"]*contextBox/g)).toBe(1);
      expect(html).toContain(`>${t("inbox.context.heading")}</summary>`);
      expect(html).toContain(escape(t("inbox.context.post_unavailable")));
      const context = html.slice(html.indexOf("contextBox"), html.indexOf("</details>", html.indexOf("contextBox")));
      expect(context).not.toMatch(/href=|@|https?:/);
      // Step 7B-15S (15P/15R P3): on wide screens the same facts are an <aside> under a real heading — no summary that
      // toggles nothing. Exactly one aside, with the same honest gap and nothing invented.
      expect(count(html, /<aside class="[^"]*contextAside[^"]*" aria-labelledby="conversation-context">/g)).toBe(1);
      const aside = html.slice(html.indexOf("contextAside"), html.indexOf("</aside>", html.indexOf("contextAside")));
      expect(aside).toContain(`<h2 id="conversation-context"`);
      expect(aside).toContain(escape(t("inbox.context.post_unavailable")));
      expect(aside).not.toMatch(/href=|@|https?:|<summary|<details/);
    });

    it("reading and editing times stay on the page, behind a small disclosure — not in the conversation's main line", async () => {
      const html = await renderConversation(detail(AVAILABLE), list());
      const read = escape(t("inbox.thread.text_read", { time: displayTime(T) }));
      const posted = escape(t("inbox.thread.posted", { time: displayTime(T) }));
      const re = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(html).toContain(read);
      // Step 7B-15S: "Exact times" — when it was written, edited and read, every one exact and in UTC — named for screen
      // readers with whose it is, so a thread never lists several identical "Details".
      const context = escape(t("inbox.thread.entry_label", { kind: t("inbox.thread.comment"), author: "Selected Person", time: displayTime(T) }));
      expect(html).toMatch(new RegExp(`<details class="[^"]*memberDetails[^"]*"><summary[^>]*>${re(t("inbox.thread.details"))}<span class="wk-sr-only">${re(context)}</span></summary><div[^>]*><p[^>]*><span>${re(posted)}</span><span>${re(read)}</span></p></div></details>`));
      const names = [...html.matchAll(/<summary class="[^"]*memberDetailsSummary[^"]*">([\s\S]*?)<\/summary>/g)].map((m) => m[1]);
      expect(names.length).toBeGreaterThan(3);
      // The two comments by "Selected Person" at the same minute differ by their kind (comment / reply) or are the
      // anchor and the hidden comment — every accessible name below is still unique per entry kind and author.
      expect(names.every((name) => name?.includes("wk-sr-only") === true)).toBe(true);
    });

    it("Step 7B-15S: a time reads short (\"13 NOV 12:37\", then only \"12:37\" on the same day), the exact UTC form stays for assistive technology and on hover, and 'Times in UTC' is said once", async () => {
      const html = await renderConversation(detail(AVAILABLE), list());
      const thread = html.slice(html.indexOf('id="thread"'));
      // The first time in the thread carries the date; the ones after it on the same day only the clock.
      expect(thread).toContain(`<time class="${/class="([^"]*time[^"]*)" dateTime/.exec(thread)?.[1] ?? ""}" dateTime="2026-11-13T12:37:00Z" title="${escape(displayTime(T))}"><span aria-hidden="true">13 NOV 12:37</span><span class="wk-sr-only">${escape(displayTime(T))}</span></time>`);
      expect(count(thread, /<span aria-hidden="true">12:37<\/span>/g)).toBe(4);
      // No visible full timestamp in the thread's head lines: every displayTime() there is screen-reader or record text.
      expect(count(html, new RegExp(`>${escape(t("inbox.times.utc"))}<`, "g"))).toBe(1); // Step 7B-15U: once per view — the thread heading; the list header says it only when no conversation is open
      expect(count(await renderList(list()), new RegExp(`>${escape(t("inbox.times.utc"))}<`, "g"))).toBe(1);
    });

    it("the automated-review status is one quiet line, not a boxed notice", async () => {
      const html = await renderConversation(detail(AVAILABLE), list());
      expect(html).toMatch(new RegExp(`<p class="[^"]*quietNote[^"]*">${escape(t("inbox.understanding_pending"))}</p>`));
    });
  });

  describe("states, text and edges", () => {
    it.each(["sending", "sent", "checking", "failed", "blocked"] as const)("%s: its own thread entry with the state as a pill and the text as written", async (state) => {
      const html = await renderConversation(timed({ outbound: [request(`b-${state}`, 2, ANCHOR, state)] }), list());
      const entry = html.slice(html.indexOf("outboundItem"), html.indexOf("</li>", html.indexOf("outboundItem")));
      expect(entry).toContain(escape(t(`inbox.outbound.state.${state}`)));
      expect(entry).toContain(`request b-${state}`);
      expect(entry).toContain(escape(t("inbox.outbound.requested_at", { time: displayTime(at(2)) })));
      expect(entry).not.toMatch(/<a |<button|<form/);
    });

    it("the unknown-outcome wording promises nothing about duplicates, and the checking note sends the person to look", () => {
      expect(t("inbox.reply.unavailable")).not.toMatch(/can.t send it twice|cannot|impossible|never/i);
      expect(t("inbox.reply.unavailable")).toMatch(/may already be on its way/);
      expect(t("inbox.outbound.checking_note")).toMatch(/may already be public/);
    });

    it("long, multilingual and markup-like text is drawn whole and as text — never interpreted", async () => {
      const long = `${"Les escribo porque es la tercera vez que compro. ".repeat(40)}\nO preço subiu de novo? <b>não</b> <script>alert(1)</script> 日本語のコメント https://example.test/a?b=1&c=2`;
      const thread = [member(ANCHOR, { text: long })];
      const html = await renderConversation(detail(AVAILABLE, { thread }), list());
      expect(html).toContain(escape(long));
      expect(html).not.toMatch(/<b>|<script>alert/);
      expect(html).not.toContain('href="https://example.test');
    });

    it("an empty conversation (nothing read in it yet) still opens in its row, with its navigation and no composer", async () => {
      const html = await renderConversation(detail(AVAILABLE, { thread: [] }), list());
      expect(count(html, /id="conversation"/g)).toBe(1);
      expect(html).toContain(`aria-label="${t("inbox.nav.label")}"`);
      expect(composers(html)).toBe(0);
    });

    it("Monitor-only: the reason once, no composer, no reply link — the navigation and the thread unchanged", async () => {
      const html = await renderConversation(timed({ reply: { kind: "unavailable", reason: "monitor_only", platform: "facebook" }, outbound: [request("b-old", 2)] }), list());
      expect(composers(html)).toBe(0);
      expect(html).not.toContain("reply=");
      expect(html).toContain(escape(t(REPLY_REASON_MESSAGES.monitor_only)));
      expect(html).toContain(`aria-label="${t("inbox.nav.label")}"`);
      expect(html).toContain("request b-old");
    });

    it("'reply to this comment' is still navigation to the comment's own address (the one composer moves; nothing is posted)", async () => {
      const html = await renderConversation(detail(AVAILABLE), list());
      expect(html).toMatch(new RegExp(`<a [^>]*href="[^"]*reply=${SECOND}[^"]*#member-${SECOND}"[^>]*>(?:<svg [^>]*aria-hidden="true"[^>]*>[\\s\\S]*?</svg>)?${escape(t("inbox.reply.here"))}</a>`));
      expect(composers(html)).toBe(1);
    });
  });
});
