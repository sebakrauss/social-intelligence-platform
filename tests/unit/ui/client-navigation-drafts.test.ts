// @vitest-environment happy-dom
/**
 * Step 7B-17K — in-app navigation and the Phase 1 draft contract (UX-20), in a REAL client runtime (React's client
 * renderer, happy-dom). Before this step every move to another conversation reloaded the document, so this tab's
 * memory (and with it every unsent draft) ended; in-app moves keep the memory, so:
 *
 * - the conversation boundary (ui/inbox/reply-drafts-scope.tsx) forgets every draft when the conversation on screen
 *   changes, when the list is shown and when the Inbox is left, and a late answer for a conversation that was left
 *   never refills the store; an uncertain outcome is never forgotten by a navigation (no resurrection);
 * - while a draft is kept, the in-app link (ui/navigation/app-link.tsx) is a plain <a href>, so leaving is a full
 *   navigation guarded by the browser's own leave confirmation — exactly as before; without a draft it is the
 *   framework's link, never prefetched, with its pending signal.
 *
 * Synthetic identifiers only; no action here can reach a server.
 */
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyActionState } from "@/server/inbox/reply-state";
import type * as DraftsModule from "@/ui/inbox/reply-drafts";
import type * as LinkModule from "@/ui/navigation/app-link";
import type * as ScopeModule from "@/ui/inbox/reply-drafts-scope";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const WS_2 = "4c352212-f3cc-4366-9dd0-5247d673b073";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_2 = "22222222-2222-4222-8222-222222222222";
const A = "a1111111-1111-4111-8111-111111111111";
const B = "a4444444-4444-4444-8444-444444444444";
const SCOPE = "scope-navigation";
const field = (target: string, workspaceId = WS, conversationId = CONVERSATION) => ({ workspaceId, conversationId, targetInteractionId: target });

/** The route segments the boundary reads from the address (next/navigation's useParams), changed by each "move". */
const route = vi.hoisted((): { params: Record<string, string> } => ({ params: {} }));
vi.mock("next/navigation", () => ({ useParams: () => route.params }));

async function settle(run: () => void): Promise<void> {
  await act(async () => {
    run();
    await Promise.resolve();
  });
}

let drafts: typeof DraftsModule;
let scope: typeof ScopeModule;
let links: typeof LinkModule;
let container: HTMLElement;
let root: Root | undefined;

beforeEach(async () => {
  vi.resetModules();
  route.params = {};
  drafts = await import("@/ui/inbox/reply-drafts");
  scope = await import("@/ui/inbox/reply-drafts-scope");
  links = await import("@/ui/navigation/app-link");
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(async () => {
  await settle(() => {
    root?.unmount();
  });
  root = undefined;
  container.remove();
});

/** Draws the Inbox layout's boundary for the route now in `route.params` (a re-render is an in-app move). */
async function showRoute(params: Record<string, string>): Promise<void> {
  route.params = params;
  await settle(() => {
    root ??= createRoot(container);
    root.render(h(scope.ReplyDraftsConversationScope));
  });
}

describe("the conversation boundary: drafts never outlive their conversation under in-app navigation", () => {
  it("a draft survives moving the composer inside its conversation (same route), and is forgotten when another conversation is shown", async () => {
    const { keepReplyDraft, restoreReplyDraft, replyDraftKey, hasReplyDrafts } = drafts;
    await showRoute({ workspaceId: WS, conversationId: CONVERSATION });
    const a = replyDraftKey(SCOPE, field(A));
    const b = replyDraftKey(SCOPE, field(B));
    keepReplyDraft(a, "draft for A");
    // Moving the one composer to another comment (?reply=) keeps the route: the boundary does nothing.
    await showRoute({ workspaceId: WS, conversationId: CONVERSATION });
    keepReplyDraft(b, "draft for B");
    expect(restoreReplyDraft(a)).toBe("draft for A");
    expect(restoreReplyDraft(b)).toBe("draft for B");
    expect(hasReplyDrafts()).toBe(true);
    // Another conversation: everything kept for the first one is gone…
    await showRoute({ workspaceId: WS, conversationId: CONVERSATION_2 });
    expect(restoreReplyDraft(a)).toBeUndefined();
    expect(restoreReplyDraft(b)).toBeUndefined();
    expect(hasReplyDrafts()).toBe(false);
    // …and does not come back when the person returns to it (Back, or its row again).
    await showRoute({ workspaceId: WS, conversationId: CONVERSATION });
    expect(restoreReplyDraft(a)).toBeUndefined();
  });

  it("the list, another workspace and leaving the Inbox (the boundary unmounts) each forget every draft", async () => {
    const { keepReplyDraft, restoreReplyDraft, replyDraftKey } = drafts;
    const a = replyDraftKey(SCOPE, field(A));
    await showRoute({ workspaceId: WS, conversationId: CONVERSATION });
    keepReplyDraft(a, "one");
    await showRoute({ workspaceId: WS });
    expect(restoreReplyDraft(a)).toBeUndefined();

    await showRoute({ workspaceId: WS, conversationId: CONVERSATION });
    keepReplyDraft(a, "two");
    await showRoute({ workspaceId: WS_2, conversationId: CONVERSATION });
    expect(restoreReplyDraft(a)).toBeUndefined();

    await showRoute({ workspaceId: WS, conversationId: CONVERSATION });
    keepReplyDraft(a, "three");
    await settle(() => {
      root?.unmount();
    });
    root = undefined;
    expect(restoreReplyDraft(a)).toBeUndefined();
    expect(drafts.hasReplyDrafts()).toBe(false);
  });

  it("only the conversation on screen keeps a draft: typing for another one is refused", async () => {
    const { keepReplyDraft, restoreReplyDraft, replyDraftKey } = drafts;
    await showRoute({ workspaceId: WS, conversationId: CONVERSATION_2 });
    const elsewhere = replyDraftKey(SCOPE, field(A));
    keepReplyDraft(elsewhere, "not on screen");
    expect(restoreReplyDraft(elsewhere)).toBeUndefined();
    await showRoute({ workspaceId: WS });
    keepReplyDraft(elsewhere, "on the list");
    expect(restoreReplyDraft(elsewhere)).toBeUndefined();
  });

  it("a late 'nothing created' answer for a conversation that was left never refills the store", async () => {
    const { keepReplyDraft, restoreReplyDraft, replyDraftKey, settleReplyDraft } = drafts;
    await showRoute({ workspaceId: WS, conversationId: CONVERSATION });
    const a = replyDraftKey(SCOPE, field(A));
    keepReplyDraft(a, "text");
    let answer: (value: ReplyActionState) => void = () => undefined;
    const action = settleReplyDraft(() => new Promise<ReplyActionState>((resolve) => (answer = resolve)), a);
    const form = new FormData();
    form.set("text", "text");
    const sent = action({ kind: "idle" }, form);
    // The person moves on while the request is in flight; the answer says nothing was created.
    await showRoute({ workspaceId: WS, conversationId: CONVERSATION_2 });
    answer({ kind: "refused", reason: "TARGET_NOT_PRESENT" });
    await sent;
    expect(restoreReplyDraft(a)).toBeUndefined();
    expect(drafts.hasReplyDrafts()).toBe(false);
    // Coming back does not bring it either.
    await showRoute({ workspaceId: WS, conversationId: CONVERSATION });
    expect(restoreReplyDraft(a)).toBeUndefined();
  });

  it("an uncertain outcome is never forgotten by a navigation: after moving away and back, that comment still keeps no draft", async () => {
    const { keepReplyDraft, restoreReplyDraft, replyDraftKey, settleReplyDraft } = drafts;
    await showRoute({ workspaceId: WS, conversationId: CONVERSATION });
    const a = replyDraftKey(SCOPE, field(A));
    const action = settleReplyDraft(() => Promise.resolve<ReplyActionState>({ kind: "unavailable" }), a);
    const form = new FormData();
    form.set("text", "maybe published");
    await action({ kind: "idle" }, form);
    await showRoute({ workspaceId: WS, conversationId: CONVERSATION_2 });
    await showRoute({ workspaceId: WS, conversationId: CONVERSATION });
    keepReplyDraft(a, "written again");
    expect(restoreReplyDraft(a)).toBeUndefined();
  });

  it("subscribers hear when 'a draft is kept' turns on and off — and only then", async () => {
    const { keepReplyDraft, forgetReplyDraft, replyDraftKey, subscribeReplyDrafts } = drafts;
    await showRoute({ workspaceId: WS, conversationId: CONVERSATION });
    const heard: number[] = [];
    const stop = subscribeReplyDrafts(() => heard.push(1));
    const a = replyDraftKey(SCOPE, field(A));
    keepReplyDraft(a, "x");
    keepReplyDraft(a, "xy");
    expect(heard).toHaveLength(1);
    forgetReplyDraft(a);
    expect(heard).toHaveLength(2);
    stop();
    keepReplyDraft(a, "z");
    expect(heard).toHaveLength(2);
  });
});

describe("the in-app link", () => {
  async function drawLink(props: Partial<LinkModule.AppLinkProps> = {}): Promise<HTMLAnchorElement> {
    await settle(() => {
      root ??= createRoot(container);
      root.render(h(links.AppLink, { href: `/workspaces/${WS}/inbox/${CONVERSATION}#row-${CONVERSATION}`, className: "row", pendingClassName: "pending", ...props, children: "Open" }));
    });
    const anchor = container.querySelector("a");
    if (anchor === null) throw new Error("no link drawn");
    return anchor;
  }

  it("is one <a href> with its pending signal (idle) and aria-current only when current", async () => {
    const anchor = await drawLink({ current: true });
    expect(anchor.getAttribute("href")).toBe(`/workspaces/${WS}/inbox/${CONVERSATION}#row-${CONVERSATION}`);
    expect(anchor.getAttribute("aria-current")).toBe("page");
    const signal = anchor.querySelector("span.pending");
    expect(signal?.getAttribute("data-pending")).toBe("false");
    expect(signal?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelectorAll("a")).toHaveLength(1);
    const plain = await drawLink({ current: false, pendingClassName: undefined });
    expect(plain.hasAttribute("aria-current")).toBe(false);
    expect(plain.querySelector("span")).toBeNull();
  });

  it("while a draft is kept it becomes a plain link (a full navigation, guarded by the leave confirmation) and turns back when none is", async () => {
    await showRouteBeside({ workspaceId: WS, conversationId: CONVERSATION });
    const before = await drawLink();
    expect(before.querySelector("span.pending")).not.toBeNull();
    const a = drafts.replyDraftKey(SCOPE, field(A));
    await settle(() => {
      drafts.keepReplyDraft(a, "unsent");
    });
    const during = container.querySelector("a");
    expect(during?.getAttribute("href")).toBe(`/workspaces/${WS}/inbox/${CONVERSATION}#row-${CONVERSATION}`);
    expect(during?.querySelector("span.pending")).toBeNull();
    expect(during?.textContent).toBe("Open");
    await settle(() => {
      drafts.forgetReplyDraft(a);
    });
    expect(container.querySelector("a span.pending")).not.toBeNull();
  });

  /** The boundary drawn in its own root beside the link (the layout draws both). */
  let scopeRoot: Root | undefined;
  async function showRouteBeside(params: Record<string, string>): Promise<void> {
    route.params = params;
    const host = document.createElement("div");
    document.body.appendChild(host);
    await settle(() => {
      scopeRoot = createRoot(host);
      scopeRoot.render(h(scope.ReplyDraftsConversationScope));
    });
  }
  afterEach(async () => {
    await settle(() => {
      scopeRoot?.unmount();
    });
    scopeRoot = undefined;
  });
});
