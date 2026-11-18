/**
 * Workspace › Comments (COMMENTS-INT-03A) — the redesigned list piloted beside the Inbox, rendered on the server with
 * the Inbox read replaced in-process. Proves the isolation contract (a server-side allowlist that fails closed, applied
 * only AFTER the Inbox read authorized the caller, so an unauthorized caller can never learn whether a workspace is
 * listed), that the route reads nothing the Inbox does not, and that it shows the SAME conversations, order, positions
 * and states as the Inbox — with no form, button, composer, synthetic data, account name, caption or total count.
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
    expect(html).not.toContain("Open this conversation in the Inbox");
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

  it("the selection lives in the address: the selected row is marked, the conversation area is a plain placeholder", async () => {
    allow(WS);
    env.list = ready();
    const none = await listPage(WS);
    expect(none).toContain('data-selected="false"');
    expect(none).not.toContain('aria-current="page"');
    expect(none).toContain("Select a conversation to read it here.");
    expect(none).toContain(`href="/workspaces/${WS}/comments/${C2}#row-${C2}"`);
    env.detail = conversationReady(C2);
    const selected = await selectedPage(WS, C2, NEXT);
    expect(selected).toContain('data-selected="true"');
    expect([...selected.matchAll(/aria-current="page"/g)]).toHaveLength(1);
    expect(rowHtml(selected, C2)).toContain('aria-current="page"');
    expect(selected).toContain("Reading a conversation here isn&#x27;t part of this preview yet.");
    expect(selected).toContain(`href="/workspaces/${WS}/inbox/${C2}#row-${C2}"`); // the Inbox, where it is read
    expect(selected).toContain(`href="/workspaces/${WS}/comments?cursor=${encodeURIComponent(NEXT)}#row-${C2}"`); // back, same position
    expect(selected).not.toMatch(/<form|<button|<textarea/);
  });
});

/* ───────────── addresses and boundaries ───────────── */

describe("Workspace › Comments: addresses and what the route may import", () => {
  it("paths exist only for canonical ids; the cursor is carried as issued", () => {
    expect(workspaceCommentsPath(WS)).toBe(`/workspaces/${WS}/comments`);
    expect(workspaceCommentsPath("nope")).toBeUndefined();
    expect(workspaceCommentsPagePath(WS, NEXT)).toBe(`/workspaces/${WS}/comments?cursor=${encodeURIComponent(NEXT)}`);
    expect(workspaceCommentsConversationPath(WS, C1)).toBe(`/workspaces/${WS}/comments/${C1}#row-${C1}`);
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
