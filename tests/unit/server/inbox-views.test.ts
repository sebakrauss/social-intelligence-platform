/**
 * COMMENTS-INT-03C-2, reworked by WORKFLOW-WF-2B — the list query in one workflow state (Open, Done) or all of them,
 * offline, through the real action pipeline over the in-memory unit of work. Since WF-2B the page is chosen by the
 * WORKFLOW QUEUE: the fake below answers like workflow/persistence/read-store.ts — a real keyset over the work items
 * (newest activity first, then id, strictly before a position, at most `limit` rows) in the requested state, and NOTHING
 * for any workspace but the bound one (it is an explicit predicate there). Proves that a view is chosen before the page
 * is cut, that walking a view yields exactly that state's conversations once each in list order, that ties and page
 * boundaries are stable, that every page is one bounded read and is never partial, that a position is honoured only by
 * the view it was issued for, that an unreadable conversation is never shown half-built, and that authorization is
 * unchanged. Synthetic identities only.
 */
import { describe, expect, it } from "vitest";
import type { WorkspaceRole } from "@/domain/access";
import type { InboxReadSources, WorkflowSources } from "@/server/pipeline";
import { resolveInboxPage } from "@/server/inbox/inbox";
import { commentsPosition, COMMENTS_VIEW_STATES } from "@/server/inbox/comments";
import { COMMENTS_DEFAULT_VIEW, parseCommentsView, workspaceCommentsConversationPath, workspaceCommentsViewPath } from "@/server/routes";
import {
  INBOX_PAGE_SIZE,
  encodeCursor,
  encodeListCursor,
  inboxListCommand,
  parseCursor,
  parseListCursor,
  type InboxPage,
  type InboxStateFilter,
} from "@/server/queries/inbox";
import { createHarness, errorCode, expectOk } from "../../support/harness";
import { memoryStores } from "../mutations/support";
import { userId } from "../../support/in-memory";

const OWNER = userId(1);
const STRANGER = userId(9);
const WS_OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const ACCOUNT = "66666666-6666-4666-8666-666666666666";
const CONTENT = "55555555-5555-4555-8555-555555555555";
const START = Date.parse("2026-11-01T12:00:00.000Z");

/** A work item is OPEN or DONE (0034 admits nothing else); UNREADABLE: an OPEN work item whose conversation row is not readable. */
type State = "OPEN" | "DONE" | "UNREADABLE";

/** Conversation n: a canonical id whose order matches n (later n = smaller id), its anchor, and its activity. */
const idOf = (n: number): string => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000001`;
const anchorOf = (n: number): string => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000002`;

interface Row {
  readonly n: number;
  readonly state: State;
  /** Minutes before START; equal values make ties (ordered by id, descending). */
  readonly minutes: number;
}

/** A workspace of conversations in the given states; `tie` groups consecutive conversations on the same instant. */
function dataset(states: readonly State[], tie = 1): Row[] {
  return states.map((state, i) => ({ n: i + 1, state, minutes: Math.floor(i / tie) }));
}

/** Read sources that behave like the stores: the workflow queue (a real keyset per state, explicit workspace), then owners. */
function sources(rows: readonly Row[], boundWorkspace: () => string) {
  const calls: string[] = [];
  const at = (row: Row): Date => new Date(START - row.minutes * 60_000);
  // Newest activity first, then id descending — the queue's `order by latest_activity_at desc, id desc`.
  const ordered = [...rows].sort((a, b) => at(b).getTime() - at(a).getTime() || (idOf(a.n) < idOf(b.n) ? 1 : -1));
  const itemState = (row: Row): "OPEN" | "DONE" => (row.state === "DONE" ? "DONE" : "OPEN");
  const note = <T>(name: string, value: T): Promise<T> => {
    calls.push(name);
    return Promise.resolve(value);
  };
  const workflow: WorkflowSources = {
    reads: {
      queue: ({ workspaceId, view, before, limit }) => {
        // The explicit predicate: another workspace's id reads nothing (RLS would refuse it too).
        const visible = workspaceId === boundWorkspace() ? ordered : [];
        const inView = visible.filter((row) => view === "all" || itemState(row) === (view === "open" ? "OPEN" : "DONE"));
        const after = before === null ? inView : inView.filter((row) => at(row).getTime() < before.latestActivityAt.getTime() || (at(row).getTime() === before.latestActivityAt.getTime() && idOf(row.n) < before.id));
        return note(`workflow.queue:${view}:${String(limit)}:${before === null ? "-" : before.id}`, after.slice(0, limit).map((row) => ({ id: idOf(row.n), latestActivityAt: at(row), state: itemState(row), version: 1 })));
      },
      findMany: () => note("workflow.findMany", []),
    },
    changes: { changeState: () => Promise.reject(new Error("not used here")) },
  };
  const inbox: InboxReadSources = {
    conversations: {
      // Unreadable conversations are absent (RLS hides them). Their legacy column is OPEN: the work item is the authority.
      findMany: (ids) => note(`conversations.findMany:${String(ids.length)}`, rows.filter((row) => row.state !== "UNREADABLE" && ids.includes(idOf(row.n))).map((row) => ({ id: idOf(row.n), anchorInteractionId: anchorOf(row.n), workflowState: "OPEN", createdAt: at(row) }))),
      get: () => note("conversations.get", undefined),
    },
    interactions: {
      listConversationActivity: () => note("interactions.listConversationActivity", []),
      conversationActivity: (ids) => note(`interactions.conversationActivity:${String(ids.length)}`, rows.filter((row) => ids.includes(idOf(row.n))).map((row) => ({ conversationId: idOf(row.n), latestActivityAt: at(row), observedCount: 1, placeholderCount: 0, anyHidden: false, anyRemovedAtSource: false }))),
      summaries: (ids) => note("interactions.summaries", ids.map((id) => ({ id, providerInteractionId: `sim_${id}`, conversationId: null, contentItemId: CONTENT, connectedAccountId: ACCOUNT, platform: "instagram", observed: true, kind: "comment", parentInteractionId: null, authorRole: "user", authorLabel: "Synthetic Person", currentSourceTextVersionId: null, currentText: "synthetic", currentVisibility: "visible", currentAvailability: "available", providerCreatedAt: null, providerEditedAt: null, textObservedAt: null, firstObservedAt: null, latestObservedAt: null }))),
      thread: () => note("interactions.thread", []),
      textVersions: () => note("interactions.textVersions", []),
    },
    content: { findManyById: () => note("content.findManyById", [{ id: CONTENT, platform: "instagram", connectedAccountId: ACCOUNT, providerAssetId: "ig", providerContentId: "ig_1", contentKind: "post", reportedSource: "organic", latestObservedAt: new Date(START) }]) },
    coverage: { latestPerAccountAndKind: () => note("coverage.latestPerAccountAndKind", [{ connectedAccountId: ACCOUNT, contentItemId: null, interactionKind: "comment", state: "COMPLETE", reason: "VALIDATED_SCOPE_READ", limitationCode: null, sliceOutcome: "COMPLETE", intervalStart: new Date(START - 1e9), intervalEnd: new Date(START), asOf: new Date(START) }]) },
    signals: { forInteractions: () => note("signals.forInteractions", []) },
    accounts: () => note("accounts", [{ id: ACCOUNT, platform: "instagram", status: "ACTIVE" }]),
  };
  return { inbox, workflow, calls, ordered: ordered.map((row) => ({ id: idOf(row.n), state: row.state })) };
}

const ROLES: readonly WorkspaceRole[] = ["OWNER", "ADMIN", "MANAGER", "RESPONDER", "ANALYST_VIEWER", "CLIENT_GUEST"];

async function setup(rows: readonly Row[]) {
  const h = createHarness();
  h.unitOfWork.mutations = memoryStores();
  const organizationId = await h.createOrganization(OWNER);
  const workspaceId = await h.createWorkspace(OWNER, organizationId);
  const members: Partial<Record<WorkspaceRole, ReturnType<typeof userId>>> = { OWNER };
  let n = 2;
  for (const role of ROLES.filter((r) => r !== "OWNER")) {
    const member = userId(n++);
    await h.addMember(OWNER, workspaceId, member, role);
    members[role] = member;
  }
  const source = sources(rows, () => workspaceId);
  h.unitOfWork.inbox = source.inbox;
  h.unitOfWork.workflow = source.workflow;
  const audit = h.unitOfWork.state.audit.length;
  const outbox = h.unitOfWork.state.outbox.length;
  const as = (role: WorkspaceRole): void => {
    const member = members[role];
    if (member === undefined) throw new Error(role);
    h.as(member);
  };
  as("RESPONDER");
  const list = async (input: { readonly cursor?: string; readonly state?: InboxStateFilter }): Promise<InboxPage> => expectOk(await h.pipeline.run(inboxListCommand, { workspaceId, input }));
  /** Every page of one view, following the positions it issues; asserts the view's own positions only. */
  const walk = async (state: InboxStateFilter | undefined): Promise<{ readonly ids: string[]; readonly pages: InboxPage[] }> => {
    const ids: string[] = [];
    const pages: InboxPage[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 200; guard += 1) {
      const page = await list(state === undefined ? (cursor === undefined ? {} : { cursor }) : cursor === undefined ? { state } : { cursor, state });
      pages.push(page);
      ids.push(...page.items.map((item) => item.conversationId));
      if (page.nextCursor === null) return { ids, pages };
      expect(parseListCursor(page.nextCursor)?.state).toBe(state);
      cursor = page.nextCursor;
    }
    throw new Error("the walk did not end");
  };
  return { ...h, workspaceId, calls: source.calls, ordered: source.ordered, audit, outbox, as, list, walk };
}

const of = (ordered: readonly { readonly id: string; readonly state: State }[], ...states: State[]): string[] => ordered.filter((row) => states.includes(row.state)).map((row) => row.id);
const mixed = (count: number): State[] => Array.from({ length: count }, (_, i): State => (i % 11 === 5 ? "UNREADABLE" : i % 3 === 0 ? "DONE" : "OPEN"));
const queueCalls = (calls: readonly string[]): string[] => calls.filter((call) => call.startsWith("workflow.queue:"));

/* ───────────── each view is exactly its state ───────────── */

describe("Open, Done and All: each view is exactly its work items' state", () => {
  it("Open holds only OPEN, Done only DONE, All every readable conversation — walked page by page, in list order, once each", async () => {
    const h = await setup(dataset(mixed(160)));
    const open = await h.walk("open");
    const done = await h.walk("done");
    const all = await h.walk(undefined);
    expect(open.ids).toEqual(of(h.ordered, "OPEN"));
    expect(done.ids).toEqual(of(h.ordered, "DONE"));
    expect(all.ids).toEqual(of(h.ordered, "OPEN", "DONE"));
    for (const view of [open, done, all]) expect(new Set(view.ids).size).toBe(view.ids.length);
    expect(open.pages.flatMap((page) => page.items).every((item) => item.workflowState === "open")).toBe(true);
    expect(done.pages.flatMap((page) => page.items).every((item) => item.workflowState === "done")).toBe(true);
    // Never partial: a page is chosen in one bounded read (the field no longer exists).
    for (const view of [open, done, all]) expect(view.pages.every((page) => !("partial" in page))).toBe(true);
  });

  it("the state shown is the WORK ITEM's, never the conversation's legacy column (which says OPEN for every one here)", async () => {
    const h = await setup(dataset(["DONE", "OPEN", "DONE"]));
    expect((await h.list({})).items.map((item) => item.workflowState)).toEqual(["done", "open", "done"]);
  });

  it("the view precedes pagination: a first page of Done conversations never empties Open", async () => {
    // The 60 most recent are Done, then 40 Open: the unfiltered first page holds no Open conversation at all.
    const h = await setup(dataset([...Array.from({ length: 60 }, (): State => "DONE"), ...Array.from({ length: 40 }, (): State => "OPEN")]));
    const firstUnfiltered = await h.list({});
    expect(firstUnfiltered.items.every((item) => item.workflowState === "done")).toBe(true);
    const open = await h.list({ state: "open" });
    expect(open.items).toHaveLength(INBOX_PAGE_SIZE);
    expect(open.items.map((item) => item.conversationId)).toEqual(of(h.ordered, "OPEN").slice(0, INBOX_PAGE_SIZE));
    expect(open.nextCursor).not.toBeNull();
    const second = await h.list({ state: "open", cursor: open.nextCursor ?? "" });
    expect(second.items.map((item) => item.conversationId)).toEqual(of(h.ordered, "OPEN").slice(INBOX_PAGE_SIZE));
    expect(second.nextCursor).toBeNull();
  });

  it("ties: conversations on the same instant are ordered by id and never skipped or repeated across page boundaries", async () => {
    // Groups of 7 on the same instant, so ties straddle every page boundary.
    const h = await setup(dataset(mixed(140), 7));
    for (const state of ["open", "done"] as const) {
      const walked = await h.walk(state);
      expect(walked.ids).toEqual(of(h.ordered, state === "open" ? "OPEN" : "DONE"));
    }
    expect((await h.walk(undefined)).ids).toEqual(of(h.ordered, "OPEN", "DONE"));
  });

  it("page boundaries: exactly a page of matches has no older page; one more has one, positioned at the last shown row", async () => {
    const exact = await setup(dataset([...Array.from({ length: INBOX_PAGE_SIZE }, (): State => "OPEN"), ...Array.from({ length: 30 }, (): State => "DONE")]));
    const page = await exact.list({ state: "open" });
    expect(page.items).toHaveLength(INBOX_PAGE_SIZE);
    expect(page.nextCursor).toBeNull();
    const more = await setup(dataset([...Array.from({ length: INBOX_PAGE_SIZE + 1 }, (): State => "OPEN"), ...Array.from({ length: 30 }, (): State => "DONE")]));
    const first = await more.list({ state: "open" });
    const last = first.items.at(-1);
    expect(first.nextCursor).toBe(last === undefined ? "" : encodeListCursor("open", { latestActivityAt: last.latestActivityAt, conversationId: last.conversationId }));
    const second = await more.list({ state: "open", cursor: first.nextCursor ?? "" });
    expect(second.items.map((item) => item.conversationId)).toEqual(of(more.ordered, "OPEN").slice(INBOX_PAGE_SIZE));
  });

  it("empty views: no conversation of that state says nothing was found — no older page", async () => {
    const h = await setup(dataset(Array.from({ length: 40 }, (): State => "OPEN")));
    const done = await h.list({ state: "done" });
    expect(done.items).toEqual([]);
    expect(done.nextCursor).toBeNull();
    expect(done.emptyReason).toBe("no_conversations_in_coverage");
    const nothing = await setup([]);
    expect((await nothing.list({ state: "open" })).emptyReason).toBe("no_conversations_in_coverage");
  });

  it("a conversation that cannot be read is never shown half-built (left out of its page), in any view", async () => {
    const h = await setup(dataset(["UNREADABLE", "OPEN", "DONE", "UNREADABLE"]));
    expect((await h.list({ state: "open" })).items.map((item) => item.conversationId)).toEqual(of(h.ordered, "OPEN"));
    expect((await h.list({ state: "done" })).items.map((item) => item.conversationId)).toEqual(of(h.ordered, "DONE"));
    expect((await h.list({})).items.map((item) => item.workflowState)).toEqual(["open", "done"]);
  });
});

/* ───────────── one bounded read per page ───────────── */

describe("WORKFLOW-WF-2B: every page is ONE bounded queue read, with the bound workspace as an explicit predicate, and is never partial", () => {
  it("whatever the size: one queue read of a page plus one, then only the shown rows are completed (no batch scan)", async () => {
    const h = await setup(dataset(Array.from({ length: 1500 }, (_, i): State => (i % 2 === 0 ? "OPEN" : "DONE"))));
    for (const state of ["open", "done", undefined] as const) {
      h.calls.length = 0;
      const page = await h.list(state === undefined ? {} : { state });
      expect(page.items).toHaveLength(INBOX_PAGE_SIZE);
      expect(queueCalls(h.calls)).toEqual([`workflow.queue:${state ?? "all"}:${String(INBOX_PAGE_SIZE + 1)}:-`]);
      expect(h.calls.filter((call) => call.startsWith("conversations.findMany") || call.startsWith("interactions.conversationActivity"))).toEqual([`conversations.findMany:${String(INBOX_PAGE_SIZE)}`, `interactions.conversationActivity:${String(INBOX_PAGE_SIZE)}`]);
      expect(h.calls.filter((call) => call.startsWith("interactions.listConversationActivity"))).toEqual([]);
    }
  });

  it("matches far apart (1 Open among 1,200 Done) are a COMPLETE page in one read — what the 500 × 2 check showed as partial", async () => {
    const h = await setup(dataset(Array.from({ length: 1200 }, (_, i): State => (i === 1100 ? "OPEN" : "DONE"))));
    h.calls.length = 0;
    const page = await h.list({ state: "open" });
    expect(page.items.map((item) => item.conversationId)).toEqual(of(h.ordered, "OPEN"));
    expect(page.nextCursor).toBeNull();
    expect(queueCalls(h.calls)).toHaveLength(1);
  });
});

/* ───────────── positions belong to their view ───────────── */

describe("a position is honoured only by the view it was issued for", () => {
  it("positions carry their view: plain for the unfiltered list (as before), prefixed for Open and Done; strict parsing", () => {
    const at = { latestActivityAt: new Date(START), conversationId: idOf(1) };
    expect(encodeListCursor(undefined, at)).toBe(encodeCursor(at));
    expect(encodeListCursor("open", at)).toBe(`open.${encodeCursor(at)}`);
    expect(parseListCursor(encodeCursor(at))).toEqual({ state: undefined, cursor: at });
    expect(parseListCursor(`done.${encodeCursor(at)}`)).toEqual({ state: "done", cursor: at });
    for (const bad of [`attention.${encodeCursor(at)}`, `open.`, `open.open.${encodeCursor(at)}`, `OPEN.${encodeCursor(at)}`, `.${encodeCursor(at)}`, "garbage", 7, undefined]) expect(parseListCursor(bad), String(bad)).toBeUndefined();
    // The Inbox's own parser still refuses every view-issued position.
    expect(parseCursor(`open.${encodeCursor(at)}`)).toBeUndefined();
  });

  it("the command refuses a position issued for another view (or a view's for the Inbox) as INVALID_INPUT, and an unknown state", async () => {
    const h = await setup(dataset(mixed(80)));
    const open = await h.list({ state: "open" });
    const all = await h.list({});
    const openCursor = open.nextCursor ?? "";
    const plainCursor = all.nextCursor ?? "";
    expect(errorCode(await h.pipeline.run(inboxListCommand, { workspaceId: h.workspaceId, input: { cursor: openCursor, state: "done" } }))).toBe("INVALID_INPUT");
    expect(errorCode(await h.pipeline.run(inboxListCommand, { workspaceId: h.workspaceId, input: { cursor: openCursor } }))).toBe("INVALID_INPUT");
    expect(errorCode(await h.pipeline.run(inboxListCommand, { workspaceId: h.workspaceId, input: { cursor: plainCursor, state: "open" } }))).toBe("INVALID_INPUT");
    for (const state of ["attention", "assigned", "escalated", "all", "OPEN", "", 1]) expect(errorCode(await h.pipeline.run(inboxListCommand, { workspaceId: h.workspaceId, input: { state } })), String(state)).toBe("INVALID_INPUT");
  });

  it("the surface ignores another view's position (the first page, like any position it never issued) and keeps its own", async () => {
    const h = await setup(dataset(mixed(80)));
    const openCursor = (await h.list({ state: "open" })).nextCursor ?? "";
    h.calls.length = 0;
    const done = await resolveInboxPage(h.pipeline, h.workspaceId, openCursor, "done");
    expect(done.kind).toBe("ready");
    expect(h.calls[0]).toBe(`workflow.queue:done:${String(INBOX_PAGE_SIZE + 1)}:-`);
    h.calls.length = 0;
    await resolveInboxPage(h.pipeline, h.workspaceId, openCursor, "open");
    expect(h.calls[0]).toBe(`workflow.queue:open:${String(INBOX_PAGE_SIZE + 1)}:${parseListCursor(openCursor)?.cursor.conversationId ?? "?"}`);
    // The Inbox (no state) ignores a view's position too.
    h.calls.length = 0;
    await resolveInboxPage(h.pipeline, h.workspaceId, openCursor);
    expect(h.calls[0]).toBe(`workflow.queue:all:${String(INBOX_PAGE_SIZE + 1)}:-`);
  });

  it("the route keeps a position only for its own view; the view comes from the address, anything unknown is Open", () => {
    const at = { latestActivityAt: new Date(START), conversationId: idOf(3) };
    const plain = encodeCursor(at);
    expect(commentsPosition("open", `open.${plain}`)).toBe(`open.${plain}`);
    expect(commentsPosition("done", `open.${plain}`)).toBeUndefined();
    expect(commentsPosition("all", `open.${plain}`)).toBeUndefined();
    expect(commentsPosition("all", plain)).toBe(plain);
    expect(commentsPosition("open", plain)).toBeUndefined();
    expect(commentsPosition("done", ["x"])).toBeUndefined();
    expect(COMMENTS_VIEW_STATES).toEqual({ open: "open", done: "done", all: undefined });
    expect(COMMENTS_DEFAULT_VIEW).toBe("open");
    expect([undefined, "", "open", "done", "all", "attention", "assigned", "escalated", "DONE", ["done"], "all "].map(parseCommentsView)).toEqual(["open", "open", "open", "done", "all", "open", "open", "open", "open", "open", "open"]);
    const ws = "3b241101-e2bb-4255-8caf-4136c566a962";
    expect(workspaceCommentsViewPath(ws, "open")).toBe(`/workspaces/${ws}/comments`);
    expect(workspaceCommentsViewPath(ws, "done")).toBe(`/workspaces/${ws}/comments?view=done`);
    expect(workspaceCommentsViewPath(ws, "all", plain)).toBe(`/workspaces/${ws}/comments?view=all&cursor=${encodeURIComponent(plain)}`);
    expect(workspaceCommentsViewPath(ws, "open", `open.${plain}`)).toBe(`/workspaces/${ws}/comments?cursor=${encodeURIComponent(`open.${plain}`)}`);
    expect(workspaceCommentsViewPath("nope", "done")).toBeUndefined();
    expect(workspaceCommentsConversationPath(ws, idOf(3), `done.${plain}`, "conversation", "done")).toBe(`/workspaces/${ws}/comments/${idOf(3)}?view=done&cursor=${encodeURIComponent(`done.${plain}`)}#conversation`);
  });
});

/* ───────────── authorization and the Inbox, unchanged ───────────── */

describe("authorization and the Inbox are unchanged", () => {
  it("every non-guest role reads a view; a guest is PERMISSION_DENIED and another workspace NOT_FOUND before anything is read; nothing is audited", async () => {
    const h = await setup(dataset(mixed(40)));
    for (const role of ROLES.filter((r) => r !== "CLIENT_GUEST")) {
      h.as(role);
      expectOk(await h.pipeline.run(inboxListCommand, { workspaceId: h.workspaceId, input: { state: "done" } }));
    }
    h.calls.length = 0;
    h.as("CLIENT_GUEST");
    expect(errorCode(await h.pipeline.run(inboxListCommand, { workspaceId: h.workspaceId, input: { state: "open" } }))).toBe("PERMISSION_DENIED");
    h.as("OWNER");
    expect(errorCode(await h.pipeline.run(inboxListCommand, { workspaceId: WS_OTHER, input: { state: "open" } }))).toBe("NOT_FOUND");
    h.identity.user = { id: STRANGER, emailVerified: true };
    expect(errorCode(await h.pipeline.run(inboxListCommand, { workspaceId: h.workspaceId, input: { state: "done" } }))).toBe("NOT_FOUND");
    expect(h.calls).toEqual([]);
    expect(h.unitOfWork.state.audit).toHaveLength(h.audit);
    expect(h.unitOfWork.state.outbox).toHaveLength(h.outbox);
  });

  it("without a state the list is All conversations: the same reads in the same order as every view, plain positions", async () => {
    const h = await setup(dataset(mixed(60)));
    h.calls.length = 0;
    const page = await h.list({});
    expect(h.calls).toEqual([
      `workflow.queue:all:${String(INBOX_PAGE_SIZE + 1)}:-`,
      `conversations.findMany:${String(INBOX_PAGE_SIZE)}`,
      `interactions.conversationActivity:${String(INBOX_PAGE_SIZE)}`,
      "interactions.summaries",
      "content.findManyById",
      "accounts",
      "coverage.latestPerAccountAndKind",
    ]);
    expect(Object.keys(page).sort()).toEqual(["asOf", "coverage", "coverageOmitted", "emptyReason", "items", "nextCursor"]);
    expect(parseCursor(page.nextCursor)).toBeDefined();
    // The Inbox's surface passes no state at all.
    h.calls.length = 0;
    await resolveInboxPage(h.pipeline, h.workspaceId, page.nextCursor);
    expect(h.calls[0]).toBe(`workflow.queue:all:${String(INBOX_PAGE_SIZE + 1)}:${parseCursor(page.nextCursor)?.conversationId ?? "?"}`);
  });
});
