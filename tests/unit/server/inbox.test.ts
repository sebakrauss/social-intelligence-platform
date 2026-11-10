/**
 * Inbox read side (Step 7A), offline: the pure view-model assembly, the strict cursor, and the two read commands through
 * the real action pipeline over the in-memory unit of work with injected read sources. Proves: every non-guest role
 * reads, a client guest is PERMISSION_DENIED before any read, a non-member or unknown workspace is NOT_FOUND, Monitor-only
 * does not block reading, inputs are closed (unknown field, bad cursor, bad id → INVALID_INPUT), a missing conversation
 * is NOT_FOUND, nothing is audited or appended, and the surface states map every outcome to a closed kind. The RLS side
 * is proven on PostgreSQL (tests/db/suites/inbox-read.ts). Synthetic identities and text only.
 */
import { describe, expect, it } from "vitest";
import type { WorkspaceRole } from "@/domain/access";
import type { InboxReadSources } from "@/server/pipeline";
import { resolveConversation, resolveInboxPage } from "@/server/inbox/inbox";
import {
  INBOX_COVERAGE_ACCOUNTS,
  INBOX_PAGE_SIZE,
  INBOX_THREAD_LIMIT,
  INBOX_VERSION_LIMIT,
  buildConversationDetail,
  buildCoverage,
  buildInboxPage,
  coverageAccounts,
  encodeCursor,
  excerptOf,
  inboxConversationCommand,
  inboxListCommand,
  parseCursor,
  presenceOf,
  type InboxPageInput,
} from "@/server/queries/inbox";
import { createHarness, errorCode, expectOk } from "../../support/harness";
import { memoryStores } from "../mutations/support";
import { userId } from "../../support/in-memory";

const OWNER = userId(1);
const STRANGER = userId(9);
const WS_OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_2 = "22222222-2222-4222-8222-222222222222";
const ANCHOR = "33333333-3333-4333-8333-333333333333";
const REPLY = "44444444-4444-4444-8444-444444444444";
const CONTENT = "55555555-5555-4555-8555-555555555555";
const ACCOUNT = "66666666-6666-4666-8666-666666666666";
const VERSION_1 = "77777777-7777-4777-8777-777777777777";
const VERSION_2 = "88888888-8888-4888-8888-888888888888";
const T0 = new Date("2026-11-01T10:00:00.000Z");
const T1 = new Date("2026-11-01T10:05:00.000Z");
const T2 = new Date("2026-11-01T10:10:00.000Z");

const summary = (over: Partial<InboxPageInput["anchors"][number]> = {}): InboxPageInput["anchors"][number] => ({
  id: ANCHOR,
  providerInteractionId: "sim_c_anchor",
  conversationId: CONVERSATION,
  contentItemId: CONTENT,
  connectedAccountId: ACCOUNT,
  platform: "facebook",
  observed: true,
  kind: "comment",
  parentInteractionId: null,
  authorRole: "user",
  authorLabel: "Synthetic Person",
  currentSourceTextVersionId: VERSION_2,
  currentText: "Is the blue one back in stock? https://example.test/x <b>bold</b>",
  currentVisibility: "visible",
  currentAvailability: "available",
  providerCreatedAt: T0,
  providerEditedAt: T1,
  textObservedAt: T1,
  firstObservedAt: T0,
  latestObservedAt: T1,
  ...over,
});
const content: InboxPageInput["contents"][number] = { id: CONTENT, platform: "facebook", connectedAccountId: ACCOUNT, providerAssetId: "fb_page", providerContentId: "fb_post_1", contentKind: "post", reportedSource: "unknown", latestObservedAt: T1 };
const coverageRow = (over: Partial<InboxPageInput["coverage"][number]> = {}): InboxPageInput["coverage"][number] => ({
  connectedAccountId: ACCOUNT, contentItemId: null, interactionKind: "comment", state: "COMPLETE", reason: "VALIDATED_SCOPE_READ", limitationCode: null, sliceOutcome: "COMPLETE", intervalStart: T0, intervalEnd: T2, asOf: T2, ...over,
});
const activity = (conversationId: string, latest: Date, over: Partial<InboxPageInput["activity"][number]> = {}): InboxPageInput["activity"][number] => ({
  conversationId, latestActivityAt: latest, observedCount: 1, placeholderCount: 0, anyHidden: false, anyRemovedAtSource: false, ...over,
});
const base = (): InboxPageInput => ({
  activity: [activity(CONVERSATION, T1)],
  conversations: [{ id: CONVERSATION, anchorInteractionId: ANCHOR, workflowState: "OPEN", createdAt: T0 }],
  anchors: [summary()],
  contents: [content],
  coverage: [coverageRow(), coverageRow({ interactionKind: "reply", state: "UNAVAILABLE", reason: "CAPABILITY_LIMITATION", limitationCode: "REPLIES_NOT_READ", asOf: T1 })],
  accounts: [{ id: ACCOUNT, platform: "facebook", status: "ACTIVE" }],
  pageSize: INBOX_PAGE_SIZE,
  coverageAccountLimit: INBOX_COVERAGE_ACCOUNTS,
});
const conversationRow = (): InboxPageInput["conversations"][number] => ({ id: CONVERSATION, anchorInteractionId: ANCHOR, workflowState: "OPEN", createdAt: T0 });
const versionRow = (id: string, observedAt: Date, text = `version ${id}`): { id: string; interactionId: string; sourceText: string; providerEditedAt: Date | null; observedAt: Date } => ({ id, interactionId: ANCHOR, sourceText: text, providerEditedAt: null, observedAt });
const uuidN = (n: number, suffix = "0"): string => `${String(n).padStart(8, "0")}-0000-4000-8000-00000000000${suffix}`;

describe("cursor", () => {
  it("round-trips an exact instant and a canonical UUID, and refuses anything else", () => {
    const cursor = { latestActivityAt: T1, conversationId: CONVERSATION };
    expect(parseCursor(encodeCursor(cursor))).toEqual(cursor);
    for (const bad of [undefined, 42, "", "x", `${T1.toISOString()}~not-a-uuid`, `2026-11-01T10:05:00Z~${CONVERSATION}`, `${T1.toISOString()}~${CONVERSATION}~more`, `${T1.toISOString()}~00000000-0000-0000-0000-000000000000`]) {
      expect(parseCursor(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("pure assembly", () => {
  it("excerpt: whitespace collapsed, grapheme-bounded, null for no text; presence from visibility and availability", () => {
    expect(excerptOf(null)).toBeNull();
    expect(excerptOf("   \n ")).toBeNull();
    expect(excerptOf(" a\n b ")).toBe("a b");
    expect(excerptOf("😀".repeat(200))).toBe(`${"😀".repeat(160)}…`);
    expect(presenceOf("visible", "available")).toBe("present");
    expect(presenceOf("hidden", "available")).toBe("hidden");
    expect(presenceOf("visible", "removed_at_source")).toBe("removed_at_source");
    expect(presenceOf(null, null)).toBe("unknown");
  });

  it("a page: platform, organic/paid from the content, author, excerpt, counts, as-of and per-account coverage", () => {
    const page = buildInboxPage(base());
    expect(page.items).toHaveLength(1);
    const item = page.items[0];
    if (item === undefined) throw new Error("item");
    expect(item).toMatchObject({ conversationId: CONVERSATION, workflowState: "open", platform: "facebook", source: "unknown", contentKind: "post", observedCount: 1, notYetReadCount: 0 });
    expect(item.anchor).toEqual({ observed: true, author: "audience", authorLabel: "Synthetic Person", excerpt: "Is the blue one back in stock? https://example.test/x <b>bold</b>", presence: "present" });
    expect(page.nextCursor).toBeNull();
    expect(page.asOf).toEqual(T2);
    expect(page.emptyReason).toBeNull();
    expect(page.coverage).toEqual([
      {
        connectedAccountId: ACCOUNT,
        platform: "facebook",
        active: true,
        comments: { state: "complete", reason: "VALIDATED_SCOPE_READ", limitationCode: null, scope: "account", coveredUntil: T2 },
        replies: { state: "unavailable", reason: "CAPABILITY_LIMITATION", limitationCode: "REPLIES_NOT_READ", scope: "account", coveredUntil: null },
        asOf: T2,
      },
    ]);
  });

  it("a conversation whose anchor was not read, or whose rows are unreadable, is shown honestly or left out", () => {
    const input = base();
    const page = buildInboxPage({ ...input, anchors: [summary({ observed: false, currentText: null, authorLabel: null })], activity: [activity(CONVERSATION, T1, { observedCount: 0, placeholderCount: 1 })] });
    expect(page.items[0]?.anchor).toEqual({ observed: false });
    expect(page.items[0]?.notYetReadCount).toBe(1);
    // An activity row whose conversation row is not readable is never shown half-built.
    const orphan = buildInboxPage({ ...input, activity: [activity(CONVERSATION_2, T2), ...input.activity] });
    expect(orphan.items.map((i) => i.conversationId)).toEqual([CONVERSATION]);
  });

  it("empty: tells nothing read yet apart from nothing found in what was read", () => {
    const input = base();
    expect(buildInboxPage({ ...input, activity: [], conversations: [], coverage: [] }).emptyReason).toBe("nothing_read_yet");
    expect(buildInboxPage({ ...input, activity: [], conversations: [] }).emptyReason).toBe("no_conversations_in_coverage");
    expect(buildInboxPage({ ...input, activity: [], conversations: [], coverage: [] }).asOf).toBeNull();
  });

  it("pagination: pageSize + 1 rows yield a next cursor at the last SHOWN row; pageSize rows yield none", () => {
    const input = base();
    const rows = Array.from({ length: INBOX_PAGE_SIZE + 1 }, (_, i) => activity(`${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`, new Date(T2.getTime() - i * 1000)));
    const conversations = rows.map((row) => ({ id: row.conversationId, anchorInteractionId: ANCHOR, workflowState: "OPEN", createdAt: T0 }));
    const page = buildInboxPage({ ...input, activity: rows, conversations });
    expect(page.items).toHaveLength(INBOX_PAGE_SIZE);
    const shownLast = rows[INBOX_PAGE_SIZE - 1];
    if (shownLast === undefined) throw new Error("row");
    expect(page.nextCursor).toBe(encodeCursor({ latestActivityAt: shownLast.latestActivityAt, conversationId: shownLast.conversationId }));
    expect(buildInboxPage({ ...input, activity: rows.slice(0, INBOX_PAGE_SIZE), conversations }).nextCursor).toBeNull();
  });

  it("coverage: account-level records win over content-level ones; the newest as-of per kind; unknown without a record; inactive accounts marked", () => {
    const views = buildCoverage(
      [
        coverageRow({ contentItemId: CONTENT, state: "COMPLETE", asOf: T2 }),
        coverageRow({ contentItemId: null, state: "UNKNOWN", reason: "TRAVERSAL_INCOMPLETE", asOf: T1 }),
        coverageRow({ contentItemId: null, state: "FAILED", reason: "PROVIDER_FAILURE", asOf: T0 }),
      ],
      [{ id: ACCOUNT, platform: "facebook", status: "INACTIVE" }, { id: WS_OTHER, platform: "instagram", status: "ACTIVE" }],
    );
    expect(views.map((v) => [v.connectedAccountId, v.platform, v.active])).toEqual([[WS_OTHER, "instagram", true], [ACCOUNT, "facebook", false]]);
    expect(views[1]?.comments).toEqual({ state: "unknown", reason: "TRAVERSAL_INCOMPLETE", limitationCode: null, scope: "account", coveredUntil: null });
    expect(views[1]?.replies).toEqual({ state: "unknown", reason: null, limitationCode: null, scope: "account", coveredUntil: null });
    expect(views[0]?.asOf).toBeNull();
    // Only a content-level record: used, and said to be content-scoped.
    const only = buildCoverage([coverageRow({ contentItemId: CONTENT })], []);
    expect(only[0]?.comments.scope).toBe("content");
  });

  describe("coverage account bound: a deterministic prefix of 250 managed accounts, read and shown exactly; the rest declared, never shown as unknown", () => {
    const accountsOf = (count: number) => Array.from({ length: count }, (_, i) => ({ id: uuidN(i, "c"), platform: "facebook", status: "ACTIVE" }) as const);
    /** One row (account-wide comment) or four (comment/reply × account-wide/one content item) per account; the record states differ per account so fidelity is checkable. */
    const rowsOf = (accounts: readonly { id: string }[], perAccount: 1 | 4) =>
      accounts.flatMap(({ id }, i) => {
        const state = i % 2 === 0 ? "COMPLETE" : "PARTIAL";
        return perAccount === 1
          ? [coverageRow({ connectedAccountId: id, state })]
          : (["comment", "reply"] as const).flatMap((kind) => [coverageRow({ connectedAccountId: id, interactionKind: kind, state }), coverageRow({ connectedAccountId: id, interactionKind: kind, contentItemId: CONTENT, state: "FAILED", asOf: T0 })]);
      });

    for (const total of [INBOX_COVERAGE_ACCOUNTS, INBOX_COVERAGE_ACCOUNTS + 1, INBOX_COVERAGE_ACCOUNTS + 10] as const) {
      for (const perAccount of [1, 4] as const) {
        it(`${String(total)} accounts × ${String(perAccount)} row(s): the first ${String(INBOX_COVERAGE_ACCOUNTS)} are shown with their own state; omitted = ${String(total > INBOX_COVERAGE_ACCOUNTS)}`, () => {
          const accounts = accountsOf(total);
          const included = coverageAccounts(accounts, INBOX_COVERAGE_ACCOUNTS);
          expect(included).toEqual(accounts.slice(0, INBOX_COVERAGE_ACCOUNTS));
          // The store is asked for the included accounts only; rows of any other account would be ignored even if they arrived.
          const rows = rowsOf(accounts, perAccount);
          const page = buildInboxPage({ ...base(), coverage: rows, accounts });
          expect(page.coverageOmitted).toBe(total > INBOX_COVERAGE_ACCOUNTS);
          expect(page.coverage.map((view) => view.connectedAccountId)).toEqual([...included.map((account) => account.id)].sort());
          for (const view of page.coverage) {
            const index = accounts.findIndex((account) => account.id === view.connectedAccountId);
            expect(view.comments, view.connectedAccountId).toMatchObject({ state: index % 2 === 0 ? "complete" : "partial", scope: "account" });
            expect(view.replies.state).toBe(perAccount === 1 ? "unknown" : index % 2 === 0 ? "complete" : "partial");
            expect(view.asOf).toEqual(T2);
          }
          expect(page.coverage.filter((view) => view.comments.state === "unknown")).toEqual([]);
          expect(page.asOf).toEqual(T2);
        });
      }
    }

    it("the command reads coverage for exactly the included accounts (260 managed → 250 ids), and the page shows those 250 with their state", async () => {
      const accounts = accountsOf(INBOX_COVERAGE_ACCOUNTS + 10);
      const input: InboxPageInput = { ...base(), accounts, coverage: rowsOf(accounts, 4) };
      const h = await setup();
      const s = sources({ input });
      h.unitOfWork.inbox = s.inbox;
      h.as("ANALYST_VIEWER");
      const page = expectOk(await h.pipeline.run(inboxListCommand, { workspaceId: h.workspaceId, input: {} }));
      expect(s.coverageRequests).toEqual([accounts.slice(0, INBOX_COVERAGE_ACCOUNTS).map((account) => account.id)]);
      expect(page.coverageOmitted).toBe(true);
      expect(page.coverage).toHaveLength(INBOX_COVERAGE_ACCOUNTS);
      expect(page.coverage.filter((view) => view.comments.state === "unknown")).toEqual([]);
      expect(page.coverage.some((view) => accounts.slice(INBOX_COVERAGE_ACCOUNTS).some((omitted) => omitted.id === view.connectedAccountId))).toBe(false);
    });
  });

  it("text versions beyond the per-comment bound: the most recent earlier ones are shown oldest first and the rest is declared omitted, never dropped silently", () => {
    const current = versionRow(VERSION_2, T2, "current");
    const history = (count: number) => Array.from({ length: count }, (_, i) => versionRow(uuidN(i, "e"), new Date(T0.getTime() + i * 1000), `v${String(i)}`));
    const build = (versions: readonly ReturnType<typeof versionRow>[]) =>
      buildConversationDetail({ conversation: conversationRow(), thread: [summary()], versions, signals: [], content, threadLimit: INBOX_THREAD_LIMIT, versionLimit: INBOX_VERSION_LIMIT }).thread[0];
    // As the store returns them: the current one plus versionLimit + 1 others → one more than can be shown.
    const over = build([current, ...history(INBOX_VERSION_LIMIT + 1)]);
    expect(over?.olderVersionsOmitted).toBe(true);
    expect(over?.earlierVersions).toHaveLength(INBOX_VERSION_LIMIT);
    expect(over?.earlierVersions.map((v) => v.text)).toEqual(history(INBOX_VERSION_LIMIT + 1).slice(1).map((v) => v.sourceText));
    expect(over?.text).toBe(summary().currentText);
    // Exactly versionLimit others: complete history, nothing omitted.
    const exact = build([current, ...history(INBOX_VERSION_LIMIT)]);
    expect(exact?.olderVersionsOmitted).toBe(false);
    expect(exact?.earlierVersions).toHaveLength(INBOX_VERSION_LIMIT);
    // The current version is not among the newest rows (an older text was restored): the others still count honestly.
    const restored = build(history(INBOX_VERSION_LIMIT + 2));
    expect(restored?.olderVersionsOmitted).toBe(true);
    expect(restored?.earlierVersions).toHaveLength(INBOX_VERSION_LIMIT);
    expect(build([])?.olderVersionsOmitted).toBe(false);
  });

  it("a detail: content context, the thread oldest first, your account marked, earlier versions kept apart, facts per current text", () => {
    const anchor = summary();
    const reply = summary({ id: REPLY, kind: "reply", parentInteractionId: ANCHOR, authorRole: "account_identity", authorLabel: "Brand", currentSourceTextVersionId: null, currentText: null, providerCreatedAt: T2, providerEditedAt: null, textObservedAt: null });
    const detail = buildConversationDetail({
      conversation: { id: CONVERSATION, anchorInteractionId: ANCHOR, workflowState: "OPEN", createdAt: T0 },
      thread: [anchor, reply],
      versions: [
        { id: VERSION_2, interactionId: ANCHOR, sourceText: anchor.currentText ?? "", providerEditedAt: T1, observedAt: T1 },
        { id: VERSION_1, interactionId: ANCHOR, sourceText: "Is the blue one back?", providerEditedAt: null, observedAt: T0 },
      ],
      signals: [{ interactionId: ANCHOR, sourceTextVersionId: VERSION_2, kind: "link_present" }, { interactionId: ANCHOR, sourceTextVersionId: VERSION_1, kind: "text_empty" }],
      content,
      threadLimit: INBOX_THREAD_LIMIT,
      versionLimit: INBOX_VERSION_LIMIT,
    });
    expect(detail).toMatchObject({ conversationId: CONVERSATION, workflowState: "open", platform: "facebook", source: "unknown", contentKind: "post", anchorInteractionId: ANCHOR, truncated: false });
    expect(detail.thread.map((m) => [m.kind, m.author, m.text, m.facts, m.earlierVersions.length])).toEqual([
      ["comment", "audience", anchor.currentText, ["link_present"], 1],
      ["reply", "own_account", null, [], 0],
    ]);
    expect(detail.thread[0]?.earlierVersions).toEqual([{ text: "Is the blue one back?", observedAt: T0, providerEditedAt: null }]);
  });

  it("a thread beyond the limit is truncated and says so; a placeholder member has no text, facts or presence", () => {
    const members = Array.from({ length: INBOX_THREAD_LIMIT + 1 }, (_, i) => summary({ id: `${String(i).padStart(8, "0")}-0000-4000-8000-00000000000a`, observed: i !== 3, currentText: i === 3 ? null : "t" }));
    const detail = buildConversationDetail({ conversation: conversationRow(), thread: members, versions: [], signals: [], content: undefined, threadLimit: INBOX_THREAD_LIMIT, versionLimit: INBOX_VERSION_LIMIT });
    expect(detail.truncated).toBe(true);
    expect(detail.thread).toHaveLength(INBOX_THREAD_LIMIT);
    expect(detail.thread[3]).toMatchObject({ observed: false, text: null, presence: "unknown", facts: [] });
    // Neither the anchor nor the content is readable here: the platform is "unknown", never guessed from a member.
    expect(detail.platform).toBe("unknown");
  });
});

// ── The commands through the pipeline ────────────────────────────────────────────────────────────────────────────────

const ROLES: readonly WorkspaceRole[] = ["OWNER", "ADMIN", "MANAGER", "RESPONDER", "ANALYST_VIEWER", "CLIENT_GUEST"];

/** Read sources that answer from fixed rows and count what the commands asked for. */
function sources(options: { readonly conversation?: boolean; readonly input?: InboxPageInput } = {}) {
  const input = options.input ?? base();
  const calls: string[] = [];
  const coverageRequests: (readonly string[])[] = [];
  const note = <T>(name: string, value: T): Promise<T> => {
    calls.push(name);
    return Promise.resolve(value);
  };
  const inbox: InboxReadSources = {
    conversations: {
      findMany: (ids) => note("conversations.findMany", input.conversations.filter((c) => ids.includes(c.id))),
      get: (id) => note("conversations.get", options.conversation === false ? undefined : input.conversations.find((c) => c.id === id)),
    },
    interactions: {
      listConversationActivity: ({ limit, before }) => note(`interactions.listConversationActivity:${String(limit)}:${before === null ? "-" : before.conversationId}`, input.activity),
      summaries: (ids) => note("interactions.summaries", input.anchors.filter((a) => ids.includes(a.id))),
      thread: (conversationId, limit) => note(`interactions.thread:${String(limit)}`, input.anchors.filter((a) => a.conversationId === conversationId)),
      textVersions: (_ids, newestPerInteraction) => note(`interactions.textVersions:${String(newestPerInteraction)}`, []),
    },
    content: { findManyById: () => note("content.findManyById", input.contents) },
    coverage: {
      latestPerAccountAndKind: (ids) => {
        coverageRequests.push(ids);
        return note(`coverage.latestPerAccountAndKind:${String(ids.length)}`, input.coverage.filter((row) => ids.includes(row.connectedAccountId)));
      },
    },
    signals: { forInteractions: () => note("signals.forInteractions", []) },
    accounts: () => note("accounts", input.accounts),
  };
  return { inbox, calls, coverageRequests };
}

async function setup() {
  const h = createHarness();
  // Step 7B-3: the conversation query also resolves the reply affordance through the request-side guards.
  h.unitOfWork.mutations = memoryStores();
  const organizationId = await h.createOrganization(OWNER);
  const workspaceId = await h.createWorkspace(OWNER, organizationId, "MONITOR_ONLY");
  const members: Partial<Record<WorkspaceRole, ReturnType<typeof userId>>> = { OWNER };
  let n = 2;
  for (const role of ROLES.filter((r) => r !== "OWNER")) {
    const member = userId(n++);
    await h.addMember(OWNER, workspaceId, member, role);
    members[role] = member;
  }
  const { inbox, calls } = sources();
  h.unitOfWork.inbox = inbox;
  const audit = h.unitOfWork.state.audit.length;
  const outbox = h.unitOfWork.state.outbox.length;
  const as = (role: WorkspaceRole): void => {
    const member = members[role];
    if (member === undefined) throw new Error(role);
    h.as(member);
  };
  return { ...h, workspaceId, calls, audit, outbox, as };
}

describe("inbox.conversations.list through the pipeline", () => {
  it("every non-guest role reads the page (Monitor-only included); a client guest is PERMISSION_DENIED before any source is read", async () => {
    const h = await setup();
    for (const role of ROLES.filter((r) => r !== "CLIENT_GUEST")) {
      h.as(role);
      h.calls.length = 0;
      const page = expectOk(await h.pipeline.run(inboxListCommand, { workspaceId: h.workspaceId, input: {} }));
      expect(page.items.map((i) => i.conversationId), role).toEqual([CONVERSATION]);
      expect(h.calls[0]).toBe(`interactions.listConversationActivity:${String(INBOX_PAGE_SIZE + 1)}:-`);
      // Coverage is read for the managed accounts (one here), per account and kind — never as a global sample of rows.
      expect(h.calls).toContain("coverage.latestPerAccountAndKind:1");
    }
    h.as("CLIENT_GUEST");
    h.calls.length = 0;
    expect(errorCode(await h.pipeline.run(inboxListCommand, { workspaceId: h.workspaceId, input: {} }))).toBe("PERMISSION_DENIED");
    expect(h.calls).toEqual([]);
    expect(h.unitOfWork.state.audit).toHaveLength(h.audit);
    expect(h.unitOfWork.state.outbox).toHaveLength(h.outbox);
  });

  it("a non-member, an unknown workspace and a malformed id are the same NOT_FOUND; nothing is read", async () => {
    const h = await setup();
    h.as("OWNER");
    h.calls.length = 0;
    expect(errorCode(await h.pipeline.run(inboxListCommand, { workspaceId: WS_OTHER, input: {} }))).toBe("NOT_FOUND");
    expect(errorCode(await h.pipeline.run(inboxListCommand, { workspaceId: "not-a-uuid", input: {} }))).toBe("NOT_FOUND");
    h.identity.user = { id: STRANGER, emailVerified: true };
    expect(errorCode(await h.pipeline.run(inboxListCommand, { workspaceId: h.workspaceId, input: {} }))).toBe("NOT_FOUND");
    expect(h.calls).toEqual([]);
  });

  it("the input is closed: a valid cursor is passed as the keyset position; a bad cursor or an unknown field is INVALID_INPUT", async () => {
    const h = await setup();
    h.as("ANALYST_VIEWER");
    const cursor = encodeCursor({ latestActivityAt: T1, conversationId: CONVERSATION_2 });
    h.calls.length = 0;
    expectOk(await h.pipeline.run(inboxListCommand, { workspaceId: h.workspaceId, input: { cursor } }));
    expect(h.calls[0]).toBe(`interactions.listConversationActivity:${String(INBOX_PAGE_SIZE + 1)}:${CONVERSATION_2}`);
    expect(errorCode(await h.pipeline.run(inboxListCommand, { workspaceId: h.workspaceId, input: { cursor: "garbage" } }))).toBe("INVALID_INPUT");
    expect(errorCode(await h.pipeline.run(inboxListCommand, { workspaceId: h.workspaceId, input: { cursor, limit: 1000 } }))).toBe("INVALID_INPUT");
    expect(errorCode(await h.pipeline.run(inboxListCommand, { workspaceId: h.workspaceId, input: { workspaceId: WS_OTHER } }))).toBe("INVALID_INPUT");
  });
});

describe("inbox.conversation.view through the pipeline", () => {
  it("reads one conversation with the bounded thread; a guest is denied; a missing one is NOT_FOUND (never 'forbidden')", async () => {
    const h = await setup();
    h.as("RESPONDER");
    h.calls.length = 0;
    const detail = expectOk(await h.pipeline.run(inboxConversationCommand, { workspaceId: h.workspaceId, input: { conversationId: CONVERSATION } }));
    expect(detail.thread.map((m) => m.interactionId)).toEqual([ANCHOR]);
    expect(h.calls).toContain(`interactions.thread:${String(INBOX_THREAD_LIMIT + 1)}`);
    // Versions are bounded PER member: the current one, the shown ones and one that only proves older ones exist.
    expect(h.calls).toContain(`interactions.textVersions:${String(INBOX_VERSION_LIMIT + 2)}`);
    expect(errorCode(await h.pipeline.run(inboxConversationCommand, { workspaceId: h.workspaceId, input: { conversationId: "nope" } }))).toBe("INVALID_INPUT");
    h.as("CLIENT_GUEST");
    expect(errorCode(await h.pipeline.run(inboxConversationCommand, { workspaceId: h.workspaceId, input: { conversationId: CONVERSATION } }))).toBe("PERMISSION_DENIED");
    const missing = sources({ conversation: false });
    h.unitOfWork.inbox = missing.inbox;
    h.as("OWNER");
    expect(errorCode(await h.pipeline.run(inboxConversationCommand, { workspaceId: h.workspaceId, input: { conversationId: CONVERSATION } }))).toBe("NOT_FOUND");
    expect(missing.calls).toEqual(["conversations.get"]);
    expect(h.unitOfWork.state.audit).toHaveLength(h.audit);
  });
});

describe("surface states", () => {
  it("list: signed out / unverified / foreign workspace / guest / ready; a browser cursor that the server never issued is ignored", async () => {
    const h = await setup();
    h.identity.user = undefined;
    expect(await resolveInboxPage(h.pipeline, h.workspaceId, undefined)).toEqual({ kind: "signed_out" });
    h.identity.user = { id: OWNER, emailVerified: false };
    expect(await resolveInboxPage(h.pipeline, h.workspaceId, undefined)).toEqual({ kind: "verification_required" });
    h.as("OWNER");
    expect(await resolveInboxPage(h.pipeline, WS_OTHER, undefined)).toEqual({ kind: "workspace_not_found" });
    h.as("CLIENT_GUEST");
    expect(await resolveInboxPage(h.pipeline, h.workspaceId, undefined)).toEqual({ kind: "not_allowed" });
    h.as("MANAGER");
    h.calls.length = 0;
    const ready = await resolveInboxPage(h.pipeline, h.workspaceId, ["array", "value"]);
    expect(ready.kind).toBe("ready");
    expect(h.calls[0]).toBe(`interactions.listConversationActivity:${String(INBOX_PAGE_SIZE + 1)}:-`);
    h.calls.length = 0;
    const positioned = await resolveInboxPage(h.pipeline, h.workspaceId, encodeCursor({ latestActivityAt: T0, conversationId: CONVERSATION_2 }));
    expect(positioned.kind).toBe("ready");
    expect(h.calls[0]).toBe(`interactions.listConversationActivity:${String(INBOX_PAGE_SIZE + 1)}:${CONVERSATION_2}`);
  });

  it("conversation: a non-UUID id never reaches the pipeline; foreign workspace vs missing conversation are told apart only by the routed id's shape", async () => {
    const h = await setup();
    h.as("OWNER");
    h.calls.length = 0;
    expect(await resolveConversation(h.pipeline, h.workspaceId, "nope")).toEqual({ kind: "conversation_not_found" });
    expect(h.calls).toEqual([]);
    expect(await resolveConversation(h.pipeline, "nope", CONVERSATION)).toEqual({ kind: "workspace_not_found" });
    expect(await resolveConversation(h.pipeline, WS_OTHER, CONVERSATION)).toEqual({ kind: "conversation_not_found" });
    const ready = await resolveConversation(h.pipeline, h.workspaceId, CONVERSATION);
    expect(ready.kind).toBe("ready");
    h.as("CLIENT_GUEST");
    expect(await resolveConversation(h.pipeline, h.workspaceId, CONVERSATION)).toEqual({ kind: "not_allowed" });
  });
});
