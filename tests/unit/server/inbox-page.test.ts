/**
 * Workspace › Inbox pages (Step 7A), rendered on the server with the read model replaced in-process. Proves what a member
 * sees: the closed states, the honest empty states (nothing read vs nothing found), coverage with as-of times, each
 * conversation's platform / organic-or-paid / author / excerpt / counts, the older-page link only when a next position
 * exists, the detail's thread with your account marked, earlier text versions and observed facts — and what they never
 * contain: a form, a button, raw HTML from audience text (escaped as text), an auto-linked URL, the word "interaction",
 * or a position the server did not issue.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConversationViewState, InboxListState } from "@/server/inbox/inbox";
import { t } from "@/server/i18n";
import { displayTime } from "@/server/inbox/inbox";

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const ANCHOR = "33333333-3333-4333-8333-333333333333";
const REPLY = "44444444-4444-4444-8444-444444444444";
const ACCOUNT = "66666666-6666-4666-8666-666666666666";
const T0 = new Date("2026-11-01T10:00:00.000Z");
const T2 = new Date("2026-11-01T10:10:00.000Z");
const T2_SHOWN = displayTime(T2); // "01 NOV 2026 · 10:10 UTC"
const HOSTILE = "<script>alert(1)</script> visit https://example.test/x & <img src=x onerror=alert(2)>";

const env = vi.hoisted((): { list: unknown; detail: unknown } => ({ list: undefined, detail: undefined }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("@/server/inbox/runtime", () => ({
  currentInboxPage: () => Promise.resolve(env.list),
  currentConversation: () => Promise.resolve(env.detail),
  inboxPipeline: () => undefined,
}));

const { default: ListPage } = await import("@/app/workspaces/[workspaceId]/inbox/page");
const { default: DetailPage } = await import("@/app/workspaces/[workspaceId]/inbox/[conversationId]/page");

type Ready = Extract<InboxListState, { kind: "ready" }>;
type ReadyDetail = Extract<ConversationViewState, { kind: "ready" }>;

const text = (message: string): string => message.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const page = (over: Partial<Ready["page"]> = {}): Ready => ({
  kind: "ready",
  workspaceId: WS as never,
  page: {
    items: [
      {
        conversationId: CONVERSATION,
        workflowState: "open",
        platform: "instagram",
        source: "mixed",
        contentKind: "post",
        anchor: { observed: true, author: "audience", authorLabel: "Synthetic Person", excerpt: HOSTILE, presence: "hidden" },
        latestActivityAt: T2,
        observedCount: 3,
        notYetReadCount: 1,
        anyHidden: true,
        anyRemovedAtSource: false,
      },
    ],
    nextCursor: null,
    asOf: T2,
    coverage: [
      {
        connectedAccountId: ACCOUNT,
        platform: "instagram",
        active: true,
        comments: { state: "complete", reason: "VALIDATED_SCOPE_READ", limitationCode: null, scope: "account", coveredUntil: T2 },
        replies: { state: "unavailable", reason: "CAPABILITY_LIMITATION", limitationCode: "REPLIES_NOT_READ", scope: "account", coveredUntil: null },
        asOf: T2,
      },
    ],
    coverageOmitted: false,
    emptyReason: null,
    ...over,
  },
});

const detail = (): ReadyDetail => ({
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
    thread: [
      {
        interactionId: ANCHOR,
        parentInteractionId: null,
        kind: "comment",
        observed: true,
        author: "audience",
        authorLabel: "Synthetic Person",
        text: HOSTILE,
        presence: "present",
        providerCreatedAt: T0,
        providerEditedAt: T2,
        textObservedAt: T2,
        earlierVersions: [{ text: "first words", observedAt: T0, providerEditedAt: null }],
        olderVersionsOmitted: false,
        facts: ["link_present"],
      },
      {
        interactionId: REPLY,
        parentInteractionId: ANCHOR,
        kind: "reply",
        observed: true,
        author: "own_account",
        authorLabel: "Brand",
        text: "Thanks!",
        presence: "removed_at_source",
        providerCreatedAt: T2,
        providerEditedAt: null,
        textObservedAt: T2,
        earlierVersions: [],
        olderVersionsOmitted: false,
        facts: ["author_own_brand"],
      },
      { interactionId: "55555555-5555-4555-8555-555555555555", parentInteractionId: ANCHOR, kind: "reply", observed: false, author: "unknown", authorLabel: null, text: null, presence: "unknown", providerCreatedAt: null, providerEditedAt: null, textObservedAt: null, earlierVersions: [], olderVersionsOmitted: false, facts: [] },
    ],
  },
});

async function renderList(state: InboxListState, cursor?: string): Promise<string> {
  env.list = state;
  return renderToStaticMarkup(await ListPage({ params: Promise.resolve({ workspaceId: WS }), searchParams: Promise.resolve(cursor === undefined ? {} : { cursor }) }));
}
async function renderDetail(state: ConversationViewState): Promise<string> {
  env.detail = state;
  return renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ workspaceId: WS, conversationId: CONVERSATION }) }));
}
const noActions = (html: string): void => {
  expect(html).not.toMatch(/<form\b|<button\b|<input\b/);
  expect(html).not.toMatch(/interaction/i);
  // Audience text is rendered as text: no element ever comes out of it, no URL in it becomes a link.
  expect(html).not.toMatch(/<script|<img/);
  expect(html).not.toMatch(/<a [^>]*href="https?:/);
};

describe("Inbox list page", () => {
  it("closed states render their message and nothing else", async () => {
    for (const [kind, key] of [["verification_required", "auth.status.verification_required"], ["workspace_not_found", "inbox.workspace_not_found"], ["not_allowed", "inbox.not_allowed"], ["unavailable", "inbox.unavailable"]] as const) {
      const html = await renderList({ kind });
      expect(html).toContain(text(t(key)));
      expect(html).not.toContain(text(t("inbox.list.heading")));
      noActions(html);
    }
  });

  it("a ready page: coverage with as-of, each row's platform / organic-or-paid / author / excerpt AS TEXT / counts / hidden, a link to the detail, no older link at the end", async () => {
    const html = await renderList(page());
    expect(T2_SHOWN).toBe("01 NOV 2026 · 10:10 UTC");
    expect(html).toContain(text(t("inbox.coverage.as_of", { time: T2_SHOWN })));
    expect(html).toContain(text(t("inbox.coverage.account", { platform: "Instagram" })));
    expect(html).toContain(text(t("inbox.coverage.comments", { state: t("inbox.coverage.state.complete") })));
    expect(html).toContain(text(t("inbox.coverage.until", { time: T2_SHOWN })));
    expect(html).toContain(text(t("inbox.coverage.replies", { state: t("inbox.coverage.state.unavailable") })));
    expect(html).toContain(text(t("inbox.coverage.reason.limitation")));
    // The row: where it comes from (monogram + name for assistive technology), what and whether it is mixed, who, the excerpt AS TEXT.
    expect(html).toContain('aria-hidden="true">IG</span><span class="wk-sr-only">Instagram</span>');
    expect(html).toContain(`>${text(t("inbox.content.post"))}</span>`);
    expect(html).toContain(`>${text(t("inbox.source.mixed_short"))}</span>`);
    expect(html).not.toContain(text(t("inbox.state.open"))); // Open is the rule, not news: the list does not repeat it
    expect(html).toMatch(/class="[^"]*rowAuthor[^"]*">Synthetic Person</);
    expect(html).toContain(text(t("inbox.presence.hidden")));
    expect(html).toContain(text(HOSTILE));
    expect(html).toContain(`<span aria-hidden="true">${text(t("inbox.item.read_count_short", { count: "3" }))}</span><span class="wk-sr-only">${text(t("inbox.item.read_count", { count: "3" }))}</span>`);
    expect(html).toContain(text(t("inbox.item.not_yet_read_count", { count: "1" })));
    expect(html).toContain(text(t("inbox.ordering")));
    expect(html).not.toContain(text(t("inbox.understanding_pending"))); // the list header is one line; the safety note lives in the detail
    expect(html).toMatch(/datetime="2026-11-01T10:10:00Z"/i);
    expect(html).toContain(`href="/workspaces/${WS}/inbox/${CONVERSATION}#row-${CONVERSATION}"`);
    expect(html).toContain(`id="row-${CONVERSATION}"`);
    expect(html).toContain(text(t("inbox.pagination.end")));
    expect(html).not.toContain(text(t("inbox.pagination.older")));
    noActions(html);
  });

  it("older conversations: the link carries only the server-issued position, URL-encoded", async () => {
    const cursor = `${T0.toISOString()}~${CONVERSATION}`;
    const html = await renderList(page({ nextCursor: cursor }));
    expect(html).toContain(`href="/workspaces/${WS}/inbox?cursor=${encodeURIComponent(cursor)}"`);
    expect(html).toContain(text(t("inbox.pagination.older")));
    noActions(html);
  });

  it("a page opened at a position: each row's link carries that same position, so the detail can draw the list beside it", async () => {
    const cursor = `${T0.toISOString()}~${CONVERSATION}`;
    const html = await renderList(page(), cursor);
    expect(html).toContain(`href="/workspaces/${WS}/inbox/${CONVERSATION}?cursor=${encodeURIComponent(cursor)}#row-${CONVERSATION}"`);
    noActions(html);
  });

  it("more accounts than can be summarized: the page says some accounts are not shown; otherwise it never says so", async () => {
    const omitted = await renderList(page({ coverageOmitted: true }));
    expect(omitted).toContain(text(t("inbox.coverage.omitted")));
    expect(omitted).toContain(text(t("inbox.coverage.account", { platform: "Instagram" })));
    noActions(omitted);
    expect(await renderList(page())).not.toContain(text(t("inbox.coverage.omitted")));
  });

  it("empty states: nothing read yet vs nothing found; a not-yet-read first comment says so", async () => {
    const never = await renderList(page({ items: [], coverage: [], asOf: null, emptyReason: "nothing_read_yet" }));
    expect(never).toContain(text(t("inbox.empty.nothing_read")));
    expect(never).toContain(text(t("inbox.coverage.never")));
    expect(never).not.toContain(text(t("inbox.understanding_pending")));
    const none = await renderList(page({ items: [], emptyReason: "no_conversations_in_coverage" }));
    expect(none).toContain(text(t("inbox.empty.no_conversations")));
    expect(none).toContain(text(t("inbox.coverage.as_of", { time: T2_SHOWN })));
    const ready = page();
    const first = ready.page.items[0];
    if (first === undefined) throw new Error("item");
    const unread = await renderList(page({ items: [{ ...first, anchor: { observed: false } }] }));
    expect(unread).toContain(text(t("inbox.item.anchor_not_read")));
    expect(unread).not.toContain("Synthetic Person");
    noActions(unread);
  });
});

describe("Conversation page", () => {
  it("closed states render their message; a back link to the Inbox always exists", async () => {
    for (const [kind, key] of [["conversation_not_found", "inbox.conversation.not_found"], ["workspace_not_found", "inbox.workspace_not_found"], ["not_allowed", "inbox.not_allowed"], ["unavailable", "inbox.unavailable"]] as const) {
      const html = await renderDetail({ kind });
      expect(html).toContain(text(t(key)));
      expect(html).toContain(`href="/workspaces/${WS}/inbox"`);
      expect(html).not.toContain(text(t("inbox.thread.heading")));
      noActions(html);
    }
  });

  it("a ready conversation: content context first, the thread as text with your account marked, platform states, earlier versions and observed facts", async () => {
    const html = await renderDetail(detail());
    const context = html.slice(html.indexOf('id="conversation"'), html.indexOf(text(t("inbox.thread.heading"))));
    expect(context).toContain('aria-hidden="true">FB</span>');
    expect(context).toContain(">Facebook</span>");
    expect(context).toContain(`>${text(t("inbox.content.post"))}</span>`);
    expect(context).toContain(`>${text(t("inbox.source.organic"))}</span>`);
    expect(context).toContain(text(t("inbox.state.open")));
    expect(html).toContain(text(HOSTILE));
    expect(html).toMatch(new RegExp(`class="[^"]*memberAuthor[^"]*">Synthetic Person</span><span class="[^"]*">· ${text(t("inbox.thread.comment"))}</span>`));
    expect(html).toMatch(new RegExp(`class="[^"]*memberAuthor[^"]*">${text(t("inbox.author.own_account"))}</span><span class="[^"]*">· ${text(t("inbox.thread.reply"))}</span>`));
    expect(html).toContain(text(t("inbox.presence.removed", { platform: "Facebook" })));
    expect(html).toMatch(/class="[^"]*member[^"]*nested[^"]*own[^"]*"/); // the brand's reply: indented one level and marked as its own
    expect(html).not.toContain("Brand");
    expect(html).toContain(text(t("inbox.thread.edited", { time: T2_SHOWN })));
    expect(html).toContain(text(t("inbox.thread.versions", { count: "1" })));
    expect(html).toContain("first words");
    expect(html).toContain(text(t("inbox.facts.heading")));
    expect(html).toContain(text(t("inbox.facts.link_present")));
    // The brand's reply carries the fact in the data but the author line already says "Your account": not drawn twice.
    expect(html).not.toContain(text(t("inbox.facts.author_own_brand")));
    expect(html).toContain(text(t("inbox.understanding_pending")));
    expect(t("inbox.understanding_pending")).toMatch(/not been assessed for safety or priority/);
    expect(html).toContain(text(t("inbox.thread.not_read")));
    expect(html).toContain(text(t("inbox.understanding_pending")));
    expect(html).not.toContain(text(t("inbox.thread.truncated", { count: "3" })));
    noActions(html);
  });

  it("a truncated thread says how many are shown", async () => {
    const state = detail();
    const html = await renderDetail({ ...state, detail: { ...state.detail, truncated: true } });
    expect(html).toContain(text(t("inbox.thread.truncated", { count: "3" })));
  });

  it("a text with more retained versions than are shown says so next to the ones it lists; a complete history is never marked incomplete", async () => {
    const state = detail();
    const [anchor, ...rest] = state.detail.thread;
    if (anchor === undefined) throw new Error("anchor");
    const html = await renderDetail({ ...state, detail: { ...state.detail, thread: [{ ...anchor, olderVersionsOmitted: true }, ...rest] } });
    expect(html).toContain(text(t("inbox.thread.versions_recent", { count: "1" })));
    expect(html).toContain(text(t("inbox.thread.versions_omitted")));
    expect(html).toContain("first words");
    expect(html).not.toContain(text(t("inbox.thread.versions", { count: "1" })));
    noActions(html);
    const complete = await renderDetail(detail());
    expect(complete).toContain(text(t("inbox.thread.versions", { count: "1" })));
    expect(complete).not.toContain(text(t("inbox.thread.versions_omitted")));
  });
});
