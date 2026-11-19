/**
 * Workspace › Comments (COMMENTS-INT-03A) — the redesigned list piloted beside the Inbox, rendered on the server with
 * the Inbox read replaced in-process. Proves the isolation contract (a server-side allowlist that fails closed, applied
 * only AFTER the Inbox read authorized the caller, so an unauthorized caller can never learn whether a workspace is
 * listed), that the route reads nothing the Inbox does not, and that it shows the SAME conversations, order, positions
 * and states as the Inbox — with no form, button, composer, synthetic data, account name, caption or total count.
 * COMMENTS-INT-03B: the selected conversation is drawn READ ONLY in the pane from the Inbox's own conversation answer —
 * the same thread records, order and times as the Inbox, nothing invented, nothing writable, nothing from another
 * workspace.
 */
import { existsSync, readFileSync } from "node:fs";
import nodePath from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMENTS_WORKSPACES_ENV, COMMENTS_WORKSPACES_LIMIT, commentsOfferedFor, parseCommentsAllowlist } from "@/server/inbox/comments-access";
import { offeredList } from "@/server/inbox/comments";
import type { ConversationViewState, InboxListState } from "@/server/inbox/inbox";
import { workspaceCommentsConversationPath, workspaceCommentsPagePath, workspaceCommentsPath } from "@/server/routes";

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const OTHER_WS = "9c1f0c7e-5a3e-4d1b-8f0a-2b6d7c8e9f10";
const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const C3 = "33333333-3333-4333-8333-333333333333";
const FOREIGN = "77777777-7777-4777-8777-777777777777";
const ACCOUNT = "66666666-6666-4666-8666-666666666666";
const T1 = new Date("2026-11-01T10:00:00.000Z");
const T2 = new Date("2026-11-01T10:10:00.000Z");
const T3 = new Date("2026-11-01T10:20:00.000Z");
const HOSTILE = "<script>alert(1)</script> visit https://example.test/x";
const NEXT = "2026-11-01T10:00:00.000Z~11111111-1111-4111-8111-111111111111";

class NotFoundSignal extends Error {}
const env = vi.hoisted((): { list: unknown; detail: unknown; listCalls: unknown[][]; detailCalls: unknown[][] } => ({ list: undefined, detail: undefined, listCalls: [], detailCalls: [] }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new NotFoundSignal("not-found");
  },
}));
vi.mock("@/server/inbox/runtime", () => ({
  currentInboxPage: (...args: unknown[]) => {
    env.listCalls.push(args);
    return Promise.resolve(env.list);
  },
  currentConversation: (...args: unknown[]) => {
    env.detailCalls.push(args);
    return Promise.resolve(env.detail);
  },
  currentReplyDraftScope: () => Promise.resolve(undefined),
  inboxPipeline: () => undefined,
}));

const { default: CommentsPage } = await import("@/app/workspaces/[workspaceId]/comments/page");
const { default: CommentsConversationPage } = await import("@/app/workspaces/[workspaceId]/comments/[conversationId]/page");
const { default: InboxPage } = await import("@/app/workspaces/[workspaceId]/inbox/page");
const { default: InboxConversationPage } = await import("@/app/workspaces/[workspaceId]/inbox/[conversationId]/page");

type Ready = Extract<InboxListState, { kind: "ready" }>;
type Item = Ready["page"]["items"][number];

const item = (conversationId: string, over: Partial<Item> = {}): Item => ({
  conversationId,
  workflowState: "open",
  platform: "instagram",
  source: "unknown",
  contentKind: "post",
  anchor: { observed: true, author: "audience", authorLabel: "Synthetic Person", excerpt: "A real excerpt", presence: "present" },
  latestActivityAt: T2,
  observedCount: 1,
  notYetReadCount: 0,
  anyHidden: false,
  anyRemovedAtSource: false,
  ...over,
});

const ready = (workspaceId: string = WS, over: Partial<Ready["page"]> = {}): Ready => ({
  kind: "ready",
  workspaceId: workspaceId as never,
  page: {
    items: [
      item(C3, { latestActivityAt: T3, platform: "facebook", anchor: { observed: true, author: "audience", authorLabel: "Newest Author", excerpt: HOSTILE, presence: "hidden" }, observedCount: 3, notYetReadCount: 1, anyHidden: true, source: "mixed" }),
      item(C2, { latestActivityAt: T2, workflowState: "done", contentKind: "reel", anchor: { observed: true, author: "audience", authorLabel: "Middle Author", excerpt: null, presence: "removed_at_source" }, anyRemovedAtSource: true }),
      item(C1, { latestActivityAt: T1, anchor: { observed: false }, contentKind: null }),
    ],
    nextCursor: NEXT,
    asOf: T3,
    coverage: [
      {
        connectedAccountId: ACCOUNT,
        platform: "instagram",
        active: true,
        comments: { state: "complete", reason: "VALIDATED_SCOPE_READ", limitationCode: null, scope: "account", coveredUntil: T3 },
        replies: { state: "unavailable", reason: "CAPABILITY_LIMITATION", limitationCode: "REPLIES_NOT_READ", scope: "account", coveredUntil: null },
        asOf: T3,
      },
    ],
    coverageOmitted: false,
    emptyReason: null,
    ...over,
  },
});

const conversationReady = (conversationId: string): ConversationViewState => ({
  kind: "ready",
  workspaceId: WS as never,
  detail: { conversationId, workflowState: "open", platform: "instagram", source: "unknown", contentKind: "post", anchorInteractionId: C1, thread: [], truncated: false, reply: { kind: "hidden" }, outbound: [] },
});

const listPage = async (workspaceId: string, cursor?: string): Promise<string> => renderToStaticMarkup(await CommentsPage({ params: Promise.resolve({ workspaceId }), searchParams: Promise.resolve(cursor === undefined ? {} : { cursor }) }));
const selectedPage = async (workspaceId: string, conversationId: string, cursor?: string): Promise<string> =>
  renderToStaticMarkup(await CommentsConversationPage({ params: Promise.resolve({ workspaceId, conversationId }), searchParams: Promise.resolve(cursor === undefined ? {} : { cursor }) }));
const inboxPage = async (workspaceId: string, cursor?: string): Promise<string> => renderToStaticMarkup(await InboxPage({ params: Promise.resolve({ workspaceId }), searchParams: Promise.resolve(cursor === undefined ? {} : { cursor }) }));
const rowHtmlOf = (html: string, id: string): string => {
  const start = html.indexOf(">", html.indexOf(`id="row-${id}"`)) + 1;
  return html.slice(start, html.indexOf("</li>", start));
};
const allow = (value: string | undefined): void => {
  vi.stubEnv(COMMENTS_WORKSPACES_ENV, value);
};

beforeEach(() => {
  env.list = undefined;
  env.detail = undefined;
  env.listCalls = [];
  env.detailCalls = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/* ───────────── the allowlist: deployment configuration, fail closed ───────────── */

describe("the Comments allowlist fails closed", () => {
  it("absent, empty or whitespace: nobody", () => {
    for (const raw of [undefined, "", "   ", "\n"]) expect(parseCommentsAllowlist(raw).size, String(raw)).toBe(0);
    expect(commentsOfferedFor(WS as never, {})).toBe(false);
    expect(commentsOfferedFor(WS as never, { [COMMENTS_WORKSPACES_ENV]: "" })).toBe(false);
  });

  it("malformed in any way: nobody — one bad entry voids the whole list, it never half-applies", () => {
    const malformed = [`${WS},not-a-uuid`, `${WS},`, `,${WS}`, `${WS};${OTHER_WS}`, WS.toUpperCase(), `"${WS}"`, `[${WS}]`, "*", "all", "true", `${WS} ${OTHER_WS}`, `${WS},${WS.slice(0, 35)}`, `${WS}\u0000`];
    for (const raw of malformed) {
      expect(parseCommentsAllowlist(raw).size, raw).toBe(0);
      expect(commentsOfferedFor(WS as never, { [COMMENTS_WORKSPACES_ENV]: raw }), raw).toBe(false);
    }
    const tooMany = Array.from({ length: COMMENTS_WORKSPACES_LIMIT + 1 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`).join(",");
    expect(parseCommentsAllowlist(tooMany).size).toBe(0);
  });

  it("a well-formed list offers exactly its workspaces", () => {
    const listed = { [COMMENTS_WORKSPACES_ENV]: ` ${WS} , ${OTHER_WS} ` };
    expect(commentsOfferedFor(WS as never, listed)).toBe(true);
    expect(commentsOfferedFor(OTHER_WS as never, listed)).toBe(true);
    expect(commentsOfferedFor(FOREIGN as never, listed)).toBe(false);
    expect(commentsOfferedFor(WS as never, { [COMMENTS_WORKSPACES_ENV]: OTHER_WS })).toBe(false);
  });

  it("only an authorized (ready) answer can be withheld; every other answer passes through unchanged, listed or not", () => {
    const closed: InboxListState[] = [{ kind: "signed_out" }, { kind: "verification_required" }, { kind: "workspace_not_found" }, { kind: "not_allowed" }, { kind: "unavailable" }];
    for (const state of closed) {
      expect(offeredList(state, { [COMMENTS_WORKSPACES_ENV]: WS })).toBe(state);
      expect(offeredList(state, {})).toBe(state);
    }
    const page = ready();
    expect(offeredList(page, { [COMMENTS_WORKSPACES_ENV]: WS })).toBe(page);
    expect(offeredList(page, {})).toEqual({ kind: "not_offered" });
    expect(offeredList(page, { [COMMENTS_WORKSPACES_ENV]: OTHER_WS })).toEqual({ kind: "not_offered" });
    expect(offeredList(page, { [COMMENTS_WORKSPACES_ENV]: `${WS},oops` })).toEqual({ kind: "not_offered" });
  });
});

/* ───────────── the route: authorization first, then the allowlist ───────────── */

describe("Workspace › Comments: who reaches it", () => {
  it("an authorized member of a workspace that is not listed gets 404 — also when the list is absent or malformed", async () => {
    env.list = ready();
    for (const value of [undefined, "", OTHER_WS, `${WS},broken`]) {
      allow(value);
      await expect(listPage(WS), String(value)).rejects.toBeInstanceOf(NotFoundSignal);
      await expect(selectedPage(WS, C2), String(value)).rejects.toBeInstanceOf(NotFoundSignal);
    }
    // The conversation is never read for a workspace the route is not offered to.
    expect(env.detailCalls).toHaveLength(0);
  });

  it("a caller the Inbox does not authorize sees the SAME answer whether or not the workspace is listed (no oracle)", async () => {
    const closed: InboxListState[] = [{ kind: "workspace_not_found" }, { kind: "not_allowed" }, { kind: "verification_required" }, { kind: "unavailable" }];
    for (const state of closed) {
      env.list = state;
      allow(WS);
      const listed = [await listPage(WS), await selectedPage(WS, C2)];
      allow(undefined);
      const unlisted = [await listPage(WS), await selectedPage(WS, C2)];
      allow(`${WS},broken`);
      const malformed = [await listPage(WS), await selectedPage(WS, C2)];
      expect(listed, state.kind).toEqual(unlisted);
      expect(listed, state.kind).toEqual(malformed);
      expect(listed[0]).not.toMatch(/row-|<ol|Synthetic|Preview of the new/);
    }
    expect(env.detailCalls).toHaveLength(0); // never the conversation query without an authorized, offered list
  });

  it("a client guest (no operational read) is refused exactly as in the Inbox; a signed-out caller is sent to sign in", async () => {
    allow(WS);
    env.list = { kind: "not_allowed" };
    const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const refused = text(await listPage(WS));
    expect(refused).not.toBe("");
    expect(text(await inboxPage(WS))).toContain(refused); // the Inbox's own sentence, nothing more
    expect(await listPage(WS)).not.toMatch(/row-|<ol|Preview of the new/);
    env.list = { kind: "signed_out" };
    await expect(listPage(WS)).rejects.toThrow("redirect:/sign-in");
    await expect(selectedPage(WS, C2)).rejects.toThrow("redirect:/sign-in");
  });

  it("the route passes the SAME workspace and cursor to the Inbox read and adds no read of its own", async () => {
    allow(WS);
    env.list = ready();
    await listPage(WS, NEXT);
    expect(env.listCalls).toEqual([[WS, NEXT]]);
    expect(env.detailCalls).toHaveLength(0);
    env.detail = conversationReady(C2);
    await selectedPage(WS, C2, NEXT);
    expect(env.listCalls.at(-1)).toEqual([WS, NEXT]);
    expect(env.detailCalls).toEqual([[WS, C2]]);
  });

  it("another workspace's conversation (or an unknown one) is the Inbox's own 'not found': no row selected, nothing of it drawn", async () => {
    allow(WS);
    env.list = ready();
    env.detail = { kind: "conversation_not_found" };
    const html = await selectedPage(WS, FOREIGN);
    expect(html).not.toContain('aria-current="page"');
    expect(html).not.toContain(FOREIGN);
    expect(html).not.toContain("View conversation in Inbox");
    expect(html).toContain("row-" + C3); // the list itself is still the caller's own
  });

  it("the allowlist never reaches the page: no listed id other than the routed workspace, no configuration name", async () => {
    allow(`${WS},${OTHER_WS}`);
    env.list = ready();
    env.detail = conversationReady(C2);
    for (const html of [await listPage(WS), await selectedPage(WS, C2)]) {
      expect(html).not.toContain(OTHER_WS);
      expect(html).not.toContain(COMMENTS_WORKSPACES_ENV);
    }
  });
});

/* ───────────── the list: the Inbox's real data, in the Direction C shape ───────────── */

describe("Workspace › Comments: the same conversations as the Inbox", () => {
  const rowsOf = (html: string): string[] => [...html.matchAll(/id="row-([0-9a-f-]{36})"/g)].map((match) => match[1] ?? "");
  const rowHtml = (html: string, id: string): string => {
    const start = html.indexOf(">", html.indexOf(`id="row-${id}"`)) + 1;
    return html.slice(start, html.indexOf("</li>", start));
  };
  const words = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  it("same conversations, same order (newest activity first), same position link as the Inbox", async () => {
    allow(WS);
    env.list = ready();
    const [comments, inbox] = [await listPage(WS), await inboxPage(WS)];
    expect(rowsOf(comments)).toEqual([C3, C2, C1]);
    expect(rowsOf(comments)).toEqual(rowsOf(inbox));
    // The older page: the same server-issued position, on each route's own address.
    expect(comments).toContain(`href="/workspaces/${WS}/comments?cursor=${encodeURIComponent(NEXT)}"`);
    expect(inbox).toContain(`href="/workspaces/${WS}/inbox?cursor=${encodeURIComponent(NEXT)}"`);
    env.list = ready(WS, { nextCursor: null });
    expect(await listPage(WS)).toContain("No older conversations.");
  });

  it("every row says what the Inbox row says: author, excerpt, time, kind, state, read counts, hidden and removed", async () => {
    allow(WS);
    env.list = ready();
    const [comments, inbox] = [await listPage(WS), await inboxPage(WS)];
    for (const id of [C3, C2, C1]) {
      const [mine, theirs] = [rowHtml(comments, id), rowHtml(inbox, id)];
      // The same instant, the same server reading.
      expect(mine.match(/dateTime="[^"]+"|datetime="[^"]+"/i)?.[0]).toBe(theirs.match(/dateTime="[^"]+"|datetime="[^"]+"/i)?.[0]);
      // Every word of the Inbox row is in the Comments row (the avatar's initials are the only thing not carried over).
      const initials = theirs.match(/aria-hidden="true">([A-Z]{1,2})<\/span>/)?.[1];
      const expected = words(theirs).split(" ").filter((word) => word !== initials);
      for (const word of expected) expect(words(mine), `${id}: ${word}`).toContain(word);
    }
    const newest = words(rowHtml(comments, C3));
    expect(newest).toContain("Newest Author");
    expect(newest).toContain("Mixed");
    expect(newest).toContain("3 read");
    expect(newest).toContain("1 not read yet");
    expect(newest).toContain("Hidden");
    expect(words(rowHtml(comments, C2))).toContain("Done");
    expect(words(rowHtml(comments, C2))).toContain("No text to show");
    expect(words(rowHtml(comments, C1))).toContain("The first comment hasn&#x27;t been read yet.");
    // An Open conversation says nothing about its state (as in the Inbox); no transition is offered anywhere.
    expect(words(rowHtml(comments, C3))).not.toMatch(/\bOpen\b|Done/);
  });

  it("audience text is escaped as text and never linked; the page has no form, button, composer or management control", async () => {
    allow(WS);
    env.list = ready();
    const html = await listPage(WS);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toMatch(/href="https:\/\/example\.test/);
    expect(html).not.toMatch(/<form|<button|<textarea|<input|<select/);
    expect(html).not.toMatch(/Mark done|Urgent|Assign|Escalate|Needs attention|Label|Filters|Search/);
    // Nothing the read model does not carry: no account name, caption, total count or prototype data.
    expect(html).not.toMatch(/Lumen|Ramiro|\bon @|\d+ of \d+|Simulated|PROTOTYPE/);
  });

  it("empty lists keep the Inbox's two honest reasons, and coverage is the Inbox's own block", async () => {
    allow(WS);
    env.list = ready(WS, { items: [], nextCursor: null, emptyReason: "nothing_read_yet" });
    expect(await listPage(WS)).toContain("All comments");
    const nothingRead = words(await listPage(WS));
    env.list = ready(WS, { items: [], nextCursor: null, emptyReason: "no_conversations_in_coverage" });
    const nothingFound = words(await listPage(WS));
    expect(nothingRead).not.toBe(nothingFound);
    env.list = ready();
    const [comments, inbox] = [await listPage(WS), await inboxPage(WS)];
    const coverage = (html: string): string => words(html.slice(html.indexOf("<details"), html.indexOf("</details>")));
    expect(coverage(comments)).toBe(coverage(inbox));
  });

  it("the selection lives in the address: the selected row is marked, the conversation is drawn read only beside it", async () => {
    allow(WS);
    env.list = ready();
    const none = await listPage(WS);
    expect(none).toContain('data-selected="false"');
    expect(none).not.toContain('aria-current="page"');
    expect(none).toContain("Select a conversation to read it here.");
    expect(none).toContain(`href="/workspaces/${WS}/comments/${C2}#conversation"`);
    env.detail = conversationReady(C2);
    const selected = await selectedPage(WS, C2, NEXT);
    expect(selected).toContain('data-selected="true"');
    expect([...selected.matchAll(/aria-current="page"/g)]).toHaveLength(1);
    expect(rowHtml(selected, C2)).toContain('aria-current="page"');
    expect(selected).toContain("View conversation in Inbox");
    expect(selected).toContain('data-content="conversation"');
    expect(selected).toContain(`href="/workspaces/${WS}/inbox/${C2}#row-${C2}"`); // the Inbox, where replies are written
    expect(selected).toContain(`href="/workspaces/${WS}/comments?cursor=${encodeURIComponent(NEXT)}#row-${C2}"`); // back, same position
    expect(selected).not.toMatch(/<form|<button|<textarea/);
  });
});

/* ───────────── COMMENTS-INT-03B: the selected conversation, read only ───────────── */

describe("Workspace › Comments: the selected conversation, read only (COMMENTS-INT-03B)", () => {
  type Detail = Extract<ConversationViewState, { kind: "ready" }>["detail"];
  type Member = Detail["thread"][number];
  /** Member and request ids, from hex letters: never equal to a conversation, account or workspace id of this file. */
  const M = (n: number): string => {
    const c = "abcdef0589"[n - 1] ?? "f";
    return `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
  };
  const at = (minute: number): Date => new Date(Date.UTC(2026, 10, 1, 10, minute));
  const member = (n: number, over: Partial<Member> = {}): Member => ({
    interactionId: M(n),
    parentInteractionId: null,
    kind: "comment",
    observed: true,
    author: "audience",
    authorLabel: `Person ${String(n)}`,
    text: `Text of ${String(n)}`,
    presence: "present",
    providerCreatedAt: at(n),
    providerEditedAt: null,
    textObservedAt: at(n + 30),
    earlierVersions: [],
    olderVersionsOmitted: false,
    facts: [],
    ...over,
  });
  /** A root comment (1) with a reply (2) and a reply to that reply (3); a second root comment (4); a reply whose parent
   *  was not read (5); a request made from Wrenkind under 1, and one under a comment not in the thread. */
  const detail = (over: Partial<Detail> = {}): Detail => ({
    conversationId: C2,
    workflowState: "open",
    platform: "instagram",
    source: "paid",
    contentKind: "reel",
    anchorInteractionId: M(1),
    thread: [
      member(1, { authorLabel: "Root Author", text: HOSTILE, earlierVersions: [{ text: "First wording", observedAt: at(0), providerEditedAt: null }], providerEditedAt: at(3), facts: ["link_present"] }),
      member(2, { kind: "reply", parentInteractionId: M(1), author: "own_account", authorLabel: null }),
      member(3, { kind: "reply", parentInteractionId: M(2), authorLabel: "Root Author", presence: "hidden" }),
      member(4, { authorLabel: "Second Root" }),
      member(5, { kind: "reply", parentInteractionId: M(8), presence: "removed_at_source", text: null }),
    ],
    truncated: false,
    reply: { kind: "hidden" },
    outbound: [
      { intentId: M(6), parentInteractionId: M(1), text: "Our pending reply", state: "checking", outcomeCode: null, createdAt: new Date(at(1).getTime() + 30_000), confirmedAt: null },
      { intentId: M(7), parentInteractionId: M(9), text: "Our sent reply", state: "sent", outcomeCode: null, createdAt: at(4), confirmedAt: at(5) },
    ],
    ...over,
  });
  const readyDetail = (over: Partial<Detail> = {}, workspaceId: string = WS): ConversationViewState => ({ kind: "ready", workspaceId: workspaceId as never, detail: detail(over) });
  const words = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const paneOf = (html: string): string => html.slice(html.indexOf('<section id="conversation"'), html.indexOf("</section>", html.indexOf('<section id="conversation"')));
  /** The thread's own list, nested lists included. */
  const threadOf = (html: string): string => {
    const start = html.lastIndexOf("<ol", html.indexOf('aria-labelledby="thread"'));
    if (start === -1 || !html.includes('aria-labelledby="thread"')) return "";
    let depth = 0;
    for (const match of html.slice(start).matchAll(/<ol\b|<\/ol>/g)) {
      depth += match[0] === "</ol>" ? -1 : 1;
      if (depth === 0) return html.slice(start, start + match.index + 5);
    }
    return "";
  };
  const memberOrder = (html: string): string[] => [...threadOf(html).matchAll(/id="member-([0-9a-f-]{36})"/g)].map((match) => match[1] ?? "");
  const show = async (state: ConversationViewState, conversationId: string = C2): Promise<string> => {
    allow(WS);
    env.list = ready();
    env.detail = state;
    return selectedPage(WS, conversationId);
  };

  it("resolves the conversation the address names, in the workspace the list authorized, and only then", async () => {
    const html = await show(readyDetail());
    expect(env.listCalls).toEqual([[WS, undefined]]);
    expect(env.detailCalls).toEqual([[WS, C2]]); // one Inbox conversation read, after the list
    expect(rowHtmlOf(html, C2)).toContain('aria-current="page"');
    expect([...html.matchAll(/aria-current="page"/g)]).toHaveLength(1);
    const pane = paneOf(html);
    expect(pane).toContain('id="conversation-title"');
    expect(words(pane)).toContain("Root Author"); // who started it: the first comment's author, as the Inbox names them
    expect(memberOrder(html)).toHaveLength(5);
  });

  it("the thread is the Inbox's own: same records, same order (root, its replies, then the next root), same times and states", async () => {
    const comments = await show(readyDetail());
    const inbox = renderToStaticMarkup(await InboxConversationPage({ params: Promise.resolve({ workspaceId: WS, conversationId: C2 }), searchParams: Promise.resolve({}) }));
    expect(threadOf(comments)).not.toBe("");
    expect(threadOf(comments)).toBe(threadOf(inbox)); // byte for byte: no composer here, and none there for this member
    expect(memberOrder(comments)).toEqual([M(1), M(2), M(3), M(4), M(5)]);
    const thread = words(threadOf(comments));
    expect(thread).toMatch(/Replying to Person 1|Replying to Your account|Replying to/); // 3 answers 2, not the root
    expect(thread).toContain("Replying to a comment that isn&#x27;t shown here"); // 5: its parent was not read
    expect(thread.indexOf("Our pending reply")).toBeLessThan(thread.indexOf("Text of 2")); // requested before 2 was written
    expect(thread.indexOf("Our sent reply")).toBeGreaterThan(thread.indexOf("Text of 5")); // its comment is not in the thread: last
  });

  it("replies stay inside their conversation: they are never listed as conversations of their own", async () => {
    const html = await show(readyDetail());
    const rows = [...html.matchAll(/id="row-([0-9a-f-]{36})"/g)].map((match) => match[1]);
    expect(rows).toEqual([C3, C2, C1]); // the list is the Inbox list, unchanged
    for (const reply of [M(2), M(3), M(5)]) expect(rows).not.toContain(reply);
  });

  it("states are the server's: hidden, removed, edited, earlier versions and facts as read; a Wrenkind reply shows its real state, never optimistic", async () => {
    const thread = words(threadOf(await show(readyDetail())));
    expect(thread).toContain("Hidden");
    expect(thread).toContain("Edited");
    expect(thread).toContain("First wording");
    expect(thread).toContain("Checking"); // OUTCOME_UNKNOWN → checking: not "sent"
    expect(thread).toContain("Sent");
    expect(thread).not.toMatch(/Sending…|Publishing/);
  });

  it("audience text is text: escaped, never linked; the pane has no form, button, field or management control", async () => {
    const pane = paneOf(await show(readyDetail({ reply: { kind: "available", connectedAccountId: ACCOUNT, platform: "instagram", maxChars: 2200, limitation: null } })));
    expect(pane).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(pane).not.toContain("<script>alert(1)");
    expect(pane).not.toMatch(/href="https:\/\/example\.test/);
    // Even where the Inbox would offer this member a reply, the Comments pane writes nothing.
    expect(pane).not.toMatch(/<form|<button|<textarea|<input|<select|Publish reply|Reply publicly|Review reply|Your reply|Reply to this comment/);
    expect(pane).not.toMatch(/Mark done|Reopen|Urgent|Assign|Escalate|Hide|Delete|Block|Add label|Labels/);
    expect(pane).toContain("View conversation in Inbox");
    expect(pane).not.toMatch(/to reply|can reply|Reply here/i); // never implies a reply the contract does not offer here
  });

  it("missing publication metadata is said, never invented: unknown platform, kind and source; no caption, link or account name", async () => {
    const pane = words(paneOf(await show(readyDetail({ platform: "unknown", contentKind: null, source: "unknown" }))));
    expect(pane).toContain("Content");
    expect(pane).toContain("Organic or paid: not known");
    expect(pane).toContain("Post details aren&#x27;t available yet.");
    expect(pane).not.toMatch(/Lumen|caption|permalink|instagram\.com|facebook\.com|\bon @/i);
  });

  it("a first comment that was not read, an empty thread and a longer thread each say so in the Inbox's words", async () => {
    const unread = await show(readyDetail({ thread: [member(1, { observed: false, text: null })] }));
    let pane = words(paneOf(unread));
    expect(pane).toContain("Not read yet: only its place in the conversation is known.");
    // The title's name (beside the platform mark): its own name, never an invented author.
    expect(unread.match(/class="[^"]*titleName[^"]*">([^<]*)</)?.[1]).toBe("Conversation");
    pane = words(paneOf(await show(readyDetail({ thread: [], outbound: [] }))));
    expect(pane).toContain("No comment of this conversation has been read yet.");
    pane = words(paneOf(await show(readyDetail({ truncated: true }))));
    expect(pane).toContain("Showing the first 5 comments and replies; this conversation has more.");
  });

  it("a conversation that can't be read is the Inbox's own closed state — not found, not allowed, unavailable — with nothing of it drawn", async () => {
    for (const state of [{ kind: "conversation_not_found" }, { kind: "not_allowed" }, { kind: "unavailable" }, { kind: "workspace_not_found" }] as ConversationViewState[]) {
      const html = await show(state);
      expect(html, state.kind).not.toContain('data-content="conversation"');
      expect(threadOf(html), state.kind).toBe("");
      expect(html, state.kind).not.toContain('aria-current="page"');
    }
    await expect(show({ kind: "signed_out" })).rejects.toThrow("redirect:/sign-in");
  });

  it("another workspace's conversation is never drawn — even an answer that named another workspace or another conversation", async () => {
    // The query is scoped (RLS, NOT_FOUND across workspaces); the page also refuses an answer that is not for this address.
    for (const state of [readyDetail({}, OTHER_WS), readyDetail({ conversationId: FOREIGN })]) {
      const html = await show(state);
      expect(threadOf(html)).toBe("");
      expect(html).not.toContain("Root Author");
      expect(words(html)).toContain("This conversation isn&#x27;t available.");
    }
    // An unlisted workspace never reaches the conversation read at all.
    env.detailCalls = [];
    allow(OTHER_WS);
    env.list = ready();
    env.detail = readyDetail();
    await expect(selectedPage(WS, C2)).rejects.toBeInstanceOf(NotFoundSignal);
    expect(env.detailCalls).toHaveLength(0);
  });

  it("navigation stays consistent: each address draws its own conversation and marks only its own row; back keeps the list position", async () => {
    allow(WS);
    env.list = ready();
    env.detail = readyDetail({ conversationId: C3, thread: [member(4, { authorLabel: "Third Author" })], outbound: [] });
    const third = await selectedPage(WS, C3, NEXT);
    env.detail = readyDetail();
    const second = await selectedPage(WS, C2, NEXT);
    expect(rowHtmlOf(third, C3)).toContain('aria-current="page"');
    expect(rowHtmlOf(third, C2)).not.toContain('aria-current="page"');
    expect(words(paneOf(third))).toContain("Third Author");
    expect(words(paneOf(third))).not.toContain("Root Author");
    expect(rowHtmlOf(second, C2)).toContain('aria-current="page"');
    expect(words(paneOf(second))).toContain("Root Author");
    expect(second).toContain(`href="/workspaces/${WS}/comments?cursor=${encodeURIComponent(NEXT)}#row-${C2}"`);
    // A row's link names its conversation: Back and Forward move between addresses, each drawn by the server from its own.
    expect(second).toContain(`href="/workspaces/${WS}/comments/${C3}?cursor=${encodeURIComponent(NEXT)}#conversation"`);
  });
});

/* ───────────── COMMENTS-INT-03B-FIX: where a conversation opens (M-1) and what the pane says about replies (L-2) ───────────── */

describe("Workspace › Comments: a conversation opens at its start, and the pane says only what the contract says (COMMENTS-INT-03B-FIX)", () => {
  const words = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const paneOf = (html: string): string => html.slice(html.indexOf('<section id="conversation"'), html.indexOf("</section>", html.indexOf('<section id="conversation"')));
  const withReply = (reply: Extract<ConversationViewState, { kind: "ready" }>["detail"]["reply"]): ConversationViewState => {
    const state = conversationReady(C2);
    return state.kind === "ready" ? { ...state, detail: { ...state.detail, reply } } : state;
  };
  const both = async (state: ConversationViewState): Promise<{ readonly comments: string; readonly inbox: string }> => {
    allow(WS);
    env.list = ready();
    env.detail = state;
    return { comments: await selectedPage(WS, C2), inbox: renderToStaticMarkup(await InboxConversationPage({ params: Promise.resolve({ workspaceId: WS, conversationId: C2 }), searchParams: Promise.resolve({}) })) };
  };
  const fragment = (html: string, cls: string): string[] => [...html.matchAll(new RegExp(`<p class="[^"]*${cls}[^"]*">.*?</p>`, "g"))].map((match) => match[0]);

  it("M-1: every link to a conversation goes to the conversation's own anchor — the pane — never to a row the list scrolls or hides", async () => {
    allow(WS);
    env.list = ready();
    const list = await listPage(WS, NEXT);
    env.detail = conversationReady(C2);
    const selected = await selectedPage(WS, C2, NEXT);
    // Every row goes to the conversation's anchor; Previous / Next (COMMENTS-INT-03C-1) to their own, at the same place.
    for (const html of [list, selected]) {
      const rows = [...html.matchAll(/<li id="row-[^"]+"[^>]*><a[^>]*href="([^"]+)"/g)].map((match) => match[1] ?? "");
      expect(rows).toHaveLength(3);
      for (const link of rows) expect(link).toMatch(/#conversation$/);
    }
    const moves = [...selected.matchAll(/href="(\/workspaces\/[^"]+\/comments\/[0-9a-f-]{36}[^"]*)"/g)].map((match) => match[1] ?? "").filter((link) => !link.endsWith("#conversation"));
    expect(moves.map((link) => link.slice(link.indexOf("#")))).toEqual(["#conversation-previous", "#conversation-next"]);
    expect(selected).toContain('id="conversation-previous"');
    expect(selected).toContain('id="conversation-next"');
    expect(selected).toContain('<section id="conversation"');
    expect([...selected.matchAll(/id="conversation"/g)]).toHaveLength(1);
    // The way back still returns to the row, at the same list position (the list is the page there; it is not sticky).
    expect(selected).toContain(`href="/workspaces/${WS}/comments?cursor=${encodeURIComponent(NEXT)}#row-${C2}"`);
  });

  it("L-2: the Inbox's review note is the Inbox's own, on the same condition (the read model carries no assessment: every conversation)", async () => {
    const { comments, inbox } = await both(conversationReady(C2));
    const note = "Not automatically reviewed yet: safety and priority haven&#x27;t been assessed.";
    expect(words(paneOf(comments))).toContain(note);
    expect(fragment(comments, "quietNote")).toEqual(fragment(inbox, "quietNote"));
    expect(fragment(comments, "quietNote")).toHaveLength(1);
  });

  it("L-2: a verified reason a reply is unavailable is said in the Inbox's words; an offered or hidden reply is not mentioned at all", async () => {
    for (const reason of ["monitor_only", "account_inactive", "paused", "connection", "platform_unavailable"] as const) {
      const { comments, inbox } = await both(withReply({ kind: "unavailable", reason, platform: "instagram" }));
      const said = fragment(comments, "replyUnavailable");
      expect(said, reason).toHaveLength(1);
      expect(said, reason).toEqual(fragment(inbox, "replyUnavailable"));
    }
    expect(words(paneOf((await both(withReply({ kind: "unavailable", reason: "monitor_only", platform: "instagram" }))).comments))).toContain("Reply not available This workspace is Monitor-only.");
    const offered: Extract<ConversationViewState, { kind: "ready" }>["detail"]["reply"][] = [
      { kind: "hidden" },
      { kind: "available", connectedAccountId: ACCOUNT, platform: "instagram", maxChars: 2200, limitation: null },
      { kind: "validation", connectedAccountId: ACCOUNT, platform: "instagram", maxChars: 2200, targets: [] },
    ];
    for (const reply of offered) {
      const pane = paneOf((await both(withReply(reply))).comments);
      expect(fragment(pane, "replyUnavailable"), reply.kind).toEqual([]);
      expect(pane, reply.kind).not.toMatch(/Reply not available|isn&#x27;t available yet|to reply|Reply publicly|Publish reply|<form|<button|<textarea/);
      expect(words(pane), reply.kind).toContain("View conversation in Inbox");
    }
  });
});

/* ───────────── COMMENTS-INT-03C-1: the approved conversation header and its navigation ───────────── */

describe("Workspace › Comments: the conversation header — identity, management, navigation (COMMENTS-INT-03C-1)", () => {
  const words = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  /** The conversation's own header (inside its article; the page has a header of its own above). */
  const headOf = (html: string): string => {
    const start = html.indexOf("<header", html.indexOf("<article"));
    return html.indexOf("<article") === -1 ? "" : html.slice(start, html.indexOf("</header>", start));
  };
  const zone = (html: string, name: string): string => {
    const start = html.indexOf(`class="${name}`) === -1 ? html.search(new RegExp(`class="[^"]*${name}`)) : html.indexOf(`class="${name}`);
    return start === -1 ? "" : html.slice(html.indexOf(">", start) + 1, html.indexOf("</div>", start));
  };
  const navOf = (html: string): string => {
    const head = headOf(html);
    const start = head.indexOf("<nav");
    return start === -1 ? "" : head.slice(start, head.indexOf("</nav>", start));
  };
  const open = async (conversationId: string, list: Ready = ready(), cursor?: string): Promise<string> => {
    allow(WS);
    env.list = list;
    env.detail = conversationReady(conversationId);
    return selectedPage(WS, conversationId, cursor);
  };
  const moves = (nav: string): string[] => [...nav.matchAll(/href="([^"]+)"/g)].map((match) => match[1] ?? "");

  it("identity: the platform mark and who started it in the title, and the real workflow state beside it", async () => {
    allow(WS);
    env.list = ready();
    const state = conversationReady(C2);
    if (state.kind !== "ready") throw new Error("ready");
    env.detail = { ...state, detail: { ...state.detail, workflowState: "done", thread: [{ interactionId: C1, parentInteractionId: null, kind: "comment", observed: true, author: "audience", authorLabel: "Header Author", text: "hi", presence: "present", providerCreatedAt: T1, providerEditedAt: null, textObservedAt: T1, earlierVersions: [], olderVersionsOmitted: false, facts: [] }] } };
    const head = headOf(await selectedPage(WS, C2));
    const title = head.slice(head.indexOf('id="conversation-title"'), head.indexOf("</h2>"));
    expect(title).toContain('tabindex="-1"'); // where Escape brings the focus when the row is not drawn
    expect(words(title)).toContain("Instagram"); // the platform mark's name
    expect(head).toMatch(/class="[^"]*titleName[^"]*">Header Author</);
    expect(words(zone(head, "headIdentity"))).toContain("Done");
  });

  it("management: no control that cannot act — only the real way to act on it today, viewing it in the Inbox", async () => {
    const head = headOf(await open(C2));
    const manage = zone(head, "headManage");
    expect(words(manage)).toBe("View conversation in Inbox");
    expect(manage).toContain(`href="/workspaces/${WS}/inbox/${C2}#row-${C2}"`);
    expect(head).not.toMatch(/<button|<form|<input|<select|<textarea/);
    expect(words(head)).not.toMatch(/Assign|Urgent|Escalat|Mark done|Reopen|Label|More actions/);
  });

  it("navigation: its place among the LOADED rows, Previous / Next to its neighbours on that page, each to its own anchor", async () => {
    // ready(): C3, C2, C1 on this page, and an older page exists → "on this page".
    const nav = navOf(await open(C2, ready(), NEXT));
    expect(nav).toContain('aria-label="Move between conversations"');
    expect(words(nav)).toContain("2 of 3 on this page");
    expect(moves(nav)).toEqual([
      `/workspaces/${WS}/comments/${C3}?cursor=${encodeURIComponent(NEXT)}#conversation-previous`,
      `/workspaces/${WS}/comments/${C1}?cursor=${encodeURIComponent(NEXT)}#conversation-next`,
    ]);
    expect(words(nav)).toContain("Previous");
    expect(words(nav)).toContain("Next");
  });

  it("navigation ends at the loaded page: the first has no Previous, the last no Next — never the older page or an unread conversation", async () => {
    const first = navOf(await open(C3));
    expect(moves(first)).toEqual([`/workspaces/${WS}/comments/${C2}#conversation-next`]);
    expect(words(first)).toContain("1 of 3 on this page");
    const last = navOf(await open(C1));
    expect(moves(last)).toEqual([`/workspaces/${WS}/comments/${C2}#conversation-previous`]);
    expect(last).not.toContain("cursor="); // the older page exists (NEXT), but Next does not lead there
    expect(words(last)).toContain("3 of 3 on this page");
    // Every page of the list loaded: plain "n of N".
    expect(words(navOf(await open(C2, ready(WS, { nextCursor: null }))))).toContain("2 of 3");
    expect(words(navOf(await open(C2, ready(WS, { nextCursor: null }))))).not.toContain("on this page");
  });

  it("no navigation where the place is not known: a conversation that is not on the loaded page, or the only one", async () => {
    expect(navOf(await open(FOREIGN.replace(/^7/, "8")))).toBe("");
    const only = ready(WS, { items: [item(C2)], nextCursor: null });
    expect(navOf(await open(C2, only))).toBe("");
  });

  it("the anchors Previous / Next lead to sit at the very start of the conversation area, as its own does", async () => {
    const html = await open(C2);
    const pane = html.slice(html.indexOf('<section id="conversation"'));
    expect(pane.indexOf('id="conversation-previous"')).toBeLessThan(pane.indexOf("<article"));
    expect(pane.indexOf('id="conversation-next"')).toBeLessThan(pane.indexOf("<article"));
    // A closed answer (not found) draws neither anchor: nothing to move to.
    allow(WS);
    env.list = ready();
    env.detail = { kind: "conversation_not_found" };
    const closed = await selectedPage(WS, FOREIGN);
    expect(closed).not.toContain('id="conversation-next"');
    expect(navOf(closed)).toBe("");
  });
});

/* ───────────── addresses and boundaries ───────────── */

describe("Workspace › Comments: addresses and what the route may import", () => {
  it("paths exist only for canonical ids; the cursor is carried as issued", () => {
    expect(workspaceCommentsPath(WS)).toBe(`/workspaces/${WS}/comments`);
    expect(workspaceCommentsPath("nope")).toBeUndefined();
    expect(workspaceCommentsPagePath(WS, NEXT)).toBe(`/workspaces/${WS}/comments?cursor=${encodeURIComponent(NEXT)}`);
    expect(workspaceCommentsConversationPath(WS, C1)).toBe(`/workspaces/${WS}/comments/${C1}#conversation`);
    expect(workspaceCommentsConversationPath(WS, "x")).toBeUndefined();
    expect(workspaceCommentsConversationPath("x", C1)).toBeUndefined();
  });

  it("the route reaches no action, composer, mutation, persistence, provider or prototype code, and the list reads configuration only on the server", () => {
    const files = ["app/workspaces/[workspaceId]/comments/page.tsx", "app/workspaces/[workspaceId]/comments/[conversationId]/page.tsx", "app/workspaces/[workspaceId]/comments/views.tsx", "app/workspaces/[workspaceId]/comments/layout.tsx", "ui/inbox/comments.tsx", "server/inbox/comments.ts", "server/inbox/comments-access.ts"];
    for (const file of files) {
      const code = readFileSync(file, "utf8");
      const imports = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");
      for (const specifier of imports) expect(specifier, `${file} → ${specifier}`).not.toMatch(/actions|reply-composer|reply-drafts|mutations|persistence|platform\/db|integrations|modules\/|jobs|dev\/ui-reference|fixtures/);
      expect(code, file).not.toMatch(/"use client"|"use server"|<form|fetch\(|NEXT_PUBLIC/);
      if (file !== "server/inbox/comments-access.ts" && file !== "server/inbox/comments.ts") expect(code, file).not.toMatch(/process\.env/);
    }
    // The allowlist is read in exactly one place.
    expect(readFileSync("server/inbox/comments-access.ts", "utf8").match(/process\.env/g)).toHaveLength(1);
  });
});

/* ───────────── COMMENTS-INT-03A-FIX (audit M-1): the route's TRANSITIVE module graph registers no reply action ───────────── */

describe("Workspace › Comments: nothing it imports, directly or through other modules, carries the reply composer or its action", () => {
  const ROOT = process.cwd();

  /** Value imports and re-exports of a module (a whole-statement `import type` / `export type` is not a runtime edge). */
  const edgesOf = (file: string): string[] => {
    const code = readFileSync(nodePath.join(ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const specifiers = [...code.matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm), ...code.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1] ?? "");
    const resolved: string[] = [];
    for (const specifier of specifiers) {
      const base = specifier.startsWith("@/") ? specifier.slice(2) : specifier.startsWith(".") ? nodePath.join(nodePath.dirname(file), specifier) : undefined;
      if (base === undefined) continue; // a package
      const hit = [base, `${base}.ts`, `${base}.tsx`, nodePath.join(base, "index.ts"), nodePath.join(base, "index.tsx")].find((candidate) => /\.tsx?$/.test(candidate) && existsSync(nodePath.join(ROOT, candidate)));
      if (hit !== undefined) resolved.push(nodePath.normalize(hit));
    }
    return resolved;
  };
  const reachableFrom = (entries: readonly string[]): Set<string> => {
    const seen = new Set<string>();
    const queue = [...entries];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      queue.push(...edgesOf(file));
    }
    return seen;
  };
  const isAction = (file: string): boolean => /^\s*["']use server["'];/m.test(readFileSync(nodePath.join(ROOT, file), "utf8"));

  const COMMENTS = ["app/workspaces/[workspaceId]/comments/page.tsx", "app/workspaces/[workspaceId]/comments/[conversationId]/page.tsx", "app/workspaces/[workspaceId]/comments/layout.tsx"];
  const INBOX = ["app/workspaces/[workspaceId]/inbox/page.tsx", "app/workspaces/[workspaceId]/inbox/[conversationId]/page.tsx", "app/workspaces/[workspaceId]/inbox/layout.tsx"];
  const COMPOSER = ["server/inbox/actions.ts", "ui/inbox/reply-composer.tsx", "ui/inbox/reply-drafts-boundary.tsx", "ui/inbox/reply-drafts-scope.tsx", "server/commands/mutations.ts", "app/workspaces/[workspaceId]/inbox/views.tsx"];

  it("the walker sees transitive imports: the Inbox pages DO reach the composer and publishReplyAction (unchanged)", () => {
    const graph = reachableFrom(INBOX);
    for (const file of ["server/inbox/actions.ts", "ui/inbox/reply-composer.tsx", "app/workspaces/[workspaceId]/inbox/views.tsx", "app/workspaces/[workspaceId]/inbox/read-views.tsx"]) expect(graph.has(file), file).toBe(true);
    expect(readFileSync("server/inbox/actions.ts", "utf8")).toMatch(/export async function publishReplyAction/);
  });

  it("the Comments pages and layout reach none of them — through any chain of imports", () => {
    const graph = reachableFrom(COMMENTS);
    expect(graph.size).toBeGreaterThan(30); // a real graph (the pipeline, queries and UI), not an unresolved stub
    expect(graph.has("server/queries/inbox.ts")).toBe(true);
    expect(graph.has("app/workspaces/[workspaceId]/inbox/read-views.tsx")).toBe(true);
    for (const file of COMPOSER) expect(graph.has(file), `${file} is reachable from the Comments route`).toBe(false);
    // The only Server Actions in the graph are the shell's account actions (sign out), as on every workspace page.
    expect([...graph].filter(isAction).sort()).toEqual(["server/auth/actions.ts"]);
  });

  it("the shared read-only module itself carries no action, composer, drafts or command", () => {
    const graph = reachableFrom(["app/workspaces/[workspaceId]/inbox/read-views.tsx"]);
    expect([...graph].filter(isAction)).toEqual([]);
    // (ui/inbox/reply-drafts.ts is reachable: the in-app link reads whether the tab keeps a draft. It is a memory-only
    // store with no action; the composer, its boundary and its scope are not.)
    for (const file of graph) expect(file).not.toMatch(/reply-composer|reply-drafts-(boundary|scope)|server\/inbox\/actions|server\/commands\//);
  });
});
