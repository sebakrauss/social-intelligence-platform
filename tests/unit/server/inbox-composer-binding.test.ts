/**
 * Inbox 2.0 (Step 7B-15D; audit 7B-15C, P2-B) — what the production conversation page HANDS the reply composer, and
 * when it hands it nothing. The composer is replaced by a probe that records its props, so each case reads the exact
 * binding a real composer would post with: the target comment, the validation mode flag, the start stage. The reply
 * model is not hand-written where the server decides it: the real `buildReplyModel` (the request command's own guard
 * chain) produces it from a role, a workspace mode, the guards and the validation reads, and its answer is what the
 * page renders — so "the address cannot enable anything" is proven across the server decision AND the view.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PermissionKey } from "@/domain/access";
import type { ContentItemRecord } from "@/modules/content";
import type { ProviderActionDecision, RequestGuards, ValidationAuthorityReads } from "@/mutations/request";
import { effectivePermissions } from "@/platform/permissions";
import type { ConversationDetail, ConversationViewState, InboxListState } from "@/server/inbox/inbox";
import { buildReplyModel } from "@/server/queries/inbox";

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "66666666-6666-4666-8666-666666666666";
const COMMENT_A = "a1111111-1111-4111-8111-111111111111";
const OWN = "a2222222-2222-4222-8222-222222222222";
const COMMENT_B = "a4444444-4444-4444-8444-444444444444";
const HIDDEN = "a5555555-5555-4555-8555-555555555555";
const T = new Date("2026-11-13T12:37:00.000Z");
const EXPIRES = new Date("2026-11-13T13:22:54.000Z");

interface Probe {
  readonly target: string;
  readonly conversation: string;
  readonly workspace: string;
  readonly validation: boolean;
  readonly stage: string;
  readonly text: string;
  readonly key: string;
  readonly scope: string | undefined;
}
const env = vi.hoisted((): { list: unknown; detail: unknown; scope: string | undefined; composers: unknown[] } => ({ list: undefined, detail: undefined, scope: "scope-binding", composers: [] }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("@/server/inbox/runtime", () => ({
  currentInboxPage: () => Promise.resolve(env.list),
  currentConversation: () => Promise.resolve(env.detail),
  currentReplyDraftScope: () => Promise.resolve(env.scope),
  inboxPipeline: () => undefined,
}));
// The probe: records exactly what the page passes (defaults made explicit) and draws a marker, never a control.
vi.mock("@/ui/inbox/reply-composer", () => ({
  ReplyComposer: (props: { fields: { workspaceId: string; conversationId: string; targetInteractionId: string; idempotencyKey: string; validation?: true }; initialStage?: string; initialText?: string; draftScope?: string }) => {
    env.composers.push({ target: props.fields.targetInteractionId, conversation: props.fields.conversationId, workspace: props.fields.workspaceId, validation: props.fields.validation === true, stage: props.initialStage ?? "closed", text: props.initialText ?? "", key: props.fields.idempotencyKey, scope: props.draftScope } satisfies Probe);
    return createElement("div", { "data-composer-probe": props.fields.targetInteractionId });
  },
}));

const { default: DetailPage } = await import("@/app/workspaces/[workspaceId]/inbox/[conversationId]/page");
const { replyTargetOf } = await import("@/app/workspaces/[workspaceId]/inbox/views");

const content: ContentItemRecord = { id: "c1", platform: "instagram", connectedAccountId: ACCOUNT, providerAssetId: "ig_acct", providerContentId: "ig_post_1", contentKind: "post", reportedSource: "organic", latestObservedAt: T };
/** Today's DEV posture by default: reply_public not validated (UNAVAILABLE) and no provider-action grant (not_enabled). */
const guards = (over: { capability?: "AVAILABLE" | "UNAVAILABLE"; authorization?: ProviderActionDecision } = {}): RequestGuards => ({
  providerActionAllowed: () => Promise.resolve(over.authorization ?? "not_enabled"),
  account: () => Promise.resolve({ status: "ACTIVE", platform: "instagram", provider: "meta", providerAssetId: "ig_acct", connectionStatus: "ACTIVE", credentialId: "c" }),
  replyCapability: () => Promise.resolve({ state: over.capability ?? "UNAVAILABLE", catalogId: "platform", catalogRevision: 5 }),
});
/** The validation reads as the database would answer them: LIVE authorizations of this member, per target. */
const reads = (live: readonly string[]): ValidationAuthorityReads => ({
  authorization: () => Promise.resolve(undefined),
  catalogValidationPending: () => Promise.resolve(true),
  liveForInitiator: (_workspace: string, _user: string, targets: readonly string[]) =>
    Promise.resolve(live.filter((target) => targets.includes(target)).map((targetInteractionId) => ({ id: `secret-authorization-${targetInteractionId}`, targetInteractionId, expiresAt: EXPIRES }))),
});
const permissions = (role: Parameters<typeof effectivePermissions>[0]): ReadonlySet<PermissionKey> => effectivePermissions(role, []);

const member = (interactionId: string, over: Partial<ConversationDetail["thread"][number]> = {}): ConversationDetail["thread"][number] => ({
  interactionId,
  parentInteractionId: null,
  kind: "comment",
  observed: true,
  author: "audience",
  authorLabel: "Synthetic Person",
  text: "synthetic text",
  presence: "present",
  providerCreatedAt: T,
  providerEditedAt: null,
  textObservedAt: T,
  earlierVersions: [],
  olderVersionsOmitted: false,
  facts: [],
  ...over,
});
const THREAD = [member(COMMENT_A), member(OWN, { parentInteractionId: COMMENT_A, kind: "reply", author: "own_account", authorLabel: null }), member(COMMENT_B), member(HIDDEN, { presence: "hidden" })];

/** The server's own decision for this member, mode and thread — exactly as readConversation asks for it. */
async function serverReply(input: { role: Parameters<typeof effectivePermissions>[0]; mode: "STANDARD" | "MONITOR_ONLY"; live?: readonly string[]; thread?: ConversationDetail["thread"]; guards?: RequestGuards }): Promise<ConversationDetail["reply"]> {
  const thread = input.thread ?? THREAD;
  return buildReplyModel({
    permissions: permissions(input.role),
    mode: input.mode,
    content,
    guards: input.guards ?? guards(),
    ...(input.live === undefined ? {} : { validation: { reads: reads(input.live), workspaceId: WS, userId: "u", targets: thread.map((item) => item.interactionId) } }),
  });
}
async function render(reply: ConversationDetail["reply"], query: Record<string, string>, thread: ConversationDetail["thread"] = THREAD): Promise<{ html: string; composers: Probe[] }> {
  const state: ConversationViewState = { kind: "ready", workspaceId: WS as never, detail: { conversationId: CONVERSATION, workflowState: "open", platform: "instagram", source: "organic", contentKind: "post", anchorInteractionId: COMMENT_A, truncated: false, reply, outbound: [], thread } };
  env.detail = state;
  env.list = undefined satisfies InboxListState | undefined;
  env.composers = [];
  const html = renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ workspaceId: WS, conversationId: CONVERSATION }), searchParams: Promise.resolve(query) }));
  return { html, composers: env.composers as Probe[] };
}
const ADDRESSES: readonly Record<string, string>[] = [{}, { reply: COMMENT_A }, { reply: COMMENT_B }, { reply: OWN }, { reply: HIDDEN }, { reply: "99999999-9999-4999-8999-999999999999" }, { reply: "not-an-id" }, { reply: COMMENT_A, validation: "1" }, { reply: COMMENT_B, validationAuthorizationId: "5f669a69-6345-4c60-b817-96b481e6d565" }];
const noPublishingSurface = (html: string): void => {
  expect(html).not.toMatch(/<form\b|<button\b|<input\b|<textarea\b|data-composer-probe|reply=/);
};

describe("A. Monitor-only: the address exposes nothing", () => {
  it("the server answers monitor_only for every replying role — even with a LIVE validation authorization and an enabled platform — and no address draws a composer, a link or a validation mode", async () => {
    for (const role of ["OWNER", "ADMIN", "MANAGER", "RESPONDER"] as const) {
      for (const posture of [guards(), guards({ capability: "AVAILABLE", authorization: "allowed" })]) {
        const reply = await serverReply({ role, mode: "MONITOR_ONLY", live: [COMMENT_A, COMMENT_B], guards: posture });
        expect(reply).toEqual({ kind: "unavailable", reason: "monitor_only", platform: "instagram" });
        for (const address of ADDRESSES) {
          const { html, composers } = await render(reply, address);
          expect(composers, JSON.stringify(address)).toEqual([]);
          noPublishingSurface(html);
          expect(html).toContain("This workspace is Monitor-only.");
          expect(html).not.toMatch(/validation/i);
        }
      }
    }
  });

  it("the same member in a STANDARD workspace with the same live authorization DOES get the composer (the test above is not passing by drawing nothing at all)", async () => {
    const reply = await serverReply({ role: "RESPONDER", mode: "STANDARD", live: [COMMENT_A] });
    const { composers } = await render(reply, { reply: COMMENT_A });
    expect(composers.map((composer) => [composer.target, composer.validation, composer.stage])).toEqual([[COMMENT_A, true, "write"]]);
  });
});

describe("B. A conversation with no thread members", () => {
  it("renders safely for every reply model and address: the context and the thread heading, no reply target, no composer, no link", async () => {
    const models: ConversationDetail["reply"][] = [
      { kind: "hidden" },
      { kind: "unavailable", reason: "platform_unavailable", platform: "instagram" },
      { kind: "available", connectedAccountId: ACCOUNT, platform: "instagram", maxChars: 2200, limitation: null },
      // Incoherent on purpose: a validation model naming a comment the (empty) thread does not contain.
      { kind: "validation", connectedAccountId: ACCOUNT, platform: "instagram", maxChars: 2200, targets: [{ targetInteractionId: COMMENT_A, expiresAt: EXPIRES }] },
      await serverReply({ role: "OWNER", mode: "STANDARD", live: [COMMENT_A], thread: [] }),
    ];
    for (const reply of models) {
      for (const address of ADDRESSES) {
        const { html, composers } = await render(reply, address, []);
        expect(composers).toEqual([]);
        noPublishingSurface(html);
        expect(html).toContain('id="conversation"');
        expect(html).toMatch(/<ol[^>]*aria-labelledby="thread"[^>]*><\/ol>/);
        expect(html).not.toContain('id="member-');
        expect(replyTargetOf({ conversationId: CONVERSATION, workflowState: "open", platform: "instagram", source: "organic", contentKind: "post", anchorInteractionId: COMMENT_A, truncated: false, reply, outbound: [], thread: [] }, address["reply"])).toBeUndefined();
      }
    }
    // With no shown targets the server never even asks for a live authorization: the ordinary answer stands.
    expect(models.at(-1)).toEqual({ kind: "unavailable", reason: "platform_unavailable", platform: "instagram" });
  });
});

describe("C. A validation authorization for comment A never enables comment B", () => {
  it("the server's model names A only; whatever the address says, the ONE composer is bound to A with the validation flag — B gets no composer, no link and no flag", async () => {
    const reply = await serverReply({ role: "RESPONDER", mode: "STANDARD", live: [COMMENT_A] });
    expect(reply).toMatchObject({ kind: "validation", targets: [{ targetInteractionId: COMMENT_A }] });
    for (const address of ADDRESSES) {
      const { html, composers } = await render(reply, address);
      expect(composers.map((composer) => composer.target), JSON.stringify(address)).toEqual([COMMENT_A]);
      const [composer] = composers;
      expect(composer).toMatchObject({ target: COMMENT_A, conversation: CONVERSATION, workspace: WS, validation: true, text: "" });
      // Open-to-write only when the address names A itself; asking for B (or anything else) opens nothing.
      expect(composer?.stage).toBe(address["reply"] === COMMENT_A ? "write" : "closed");
      // The probe sits inside A's own thread member, and nowhere under B.
      const underA = html.slice(html.indexOf(`id="member-${COMMENT_A}"`), html.indexOf(`id="member-${OWN}"`));
      const underB = html.slice(html.indexOf(`id="member-${COMMENT_B}"`), html.indexOf(`id="member-${HIDDEN}"`));
      expect(underA).toContain(`data-composer-probe="${COMMENT_A}"`);
      expect(underB).not.toMatch(/data-composer-probe|<a\b|reply=/);
      expect(html).not.toContain(`reply=${COMMENT_B}`);
      // Never the authorization's identifier, in any prop or anywhere in the page.
      expect(html).not.toMatch(/secret-authorization|5f669a69|authorizationId/i);
      expect(JSON.stringify(composers)).not.toMatch(/secret-authorization/);
    }
  });

  it("the mirror case: an authorization for B puts the composer under B only, and ?reply=A opens nothing under A", async () => {
    const reply = await serverReply({ role: "RESPONDER", mode: "STANDARD", live: [COMMENT_B] });
    const { html, composers } = await render(reply, { reply: COMMENT_A });
    expect(composers.map((composer) => [composer.target, composer.validation, composer.stage])).toEqual([[COMMENT_B, true, "closed"]]);
    expect(html.slice(html.indexOf(`id="member-${COMMENT_A}"`), html.indexOf(`id="member-${OWN}"`))).not.toMatch(/data-composer-probe|reply=/);
  });

  it("an expired or absent authorization (the database lists none): the ordinary 'not enabled' answer, and no address brings a composer back", async () => {
    const reply = await serverReply({ role: "RESPONDER", mode: "STANDARD", live: [] });
    expect(reply).toEqual({ kind: "unavailable", reason: "platform_unavailable", platform: "instagram" });
    for (const address of ADDRESSES) {
      const { html, composers } = await render(reply, address);
      expect(composers).toEqual([]);
      noPublishingSurface(html);
    }
  });

  it("an ordinary (non-validation) composer never carries the validation flag, wherever the address places it", async () => {
    const reply = await serverReply({ role: "RESPONDER", mode: "STANDARD", guards: guards({ capability: "AVAILABLE", authorization: "allowed" }) });
    expect(reply.kind).toBe("available");
    for (const address of ADDRESSES) {
      const { composers } = await render(reply, address);
      expect(composers).toHaveLength(1);
      expect(composers[0]?.validation).toBe(false);
    }
  });
});

describe("D. The start stage the production page passes", () => {
  it('is "write" only when the address names the comment the composer is under, "closed" otherwise — never "review" or "done", never a text; each render issues a fresh server key', async () => {
    const models = [
      await serverReply({ role: "OWNER", mode: "STANDARD", guards: guards({ capability: "AVAILABLE", authorization: "allowed" }) }),
      await serverReply({ role: "OWNER", mode: "STANDARD", live: [COMMENT_A, COMMENT_B] }),
    ];
    const keys = new Set<string>();
    let rendered = 0;
    for (const reply of models) {
      for (const address of [...ADDRESSES, { reply: COMMENT_A, stage: "review" }, { reply: COMMENT_A, initialStage: "review", initialText: "injected" }, { reply: COMMENT_B, initialStage: "done" }]) {
        const { composers } = await render(reply, address);
        expect(composers).toHaveLength(1);
        const [composer] = composers;
        if (composer === undefined) throw new Error("composer");
        expect(["closed", "write"]).toContain(composer.stage);
        expect(composer.stage).toBe(address["reply"] === composer.target ? "write" : "closed");
        expect(composer.text).toBe("");
        expect(composer.key).toMatch(/^rk-[0-9a-f-]{36}$/);
        keys.add(composer.key);
        rendered += 1;
      }
    }
    expect(keys.size).toBe(rendered);
  });
});

describe("E. The reply-draft scope the production page passes (Step 7B-15F)", () => {
  it("the ONE composer gets the server's opaque scope — ordinary or validation — and none when there is no verified person; Monitor-only draws no composer to give it to", async () => {
    const ordinary = await serverReply({ role: "RESPONDER", mode: "STANDARD", guards: guards({ capability: "AVAILABLE", authorization: "allowed" }) });
    const validation = await serverReply({ role: "RESPONDER", mode: "STANDARD", live: [COMMENT_A] });
    for (const reply of [ordinary, validation]) {
      const { composers } = await render(reply, { reply: COMMENT_A });
      expect(composers.map((composer) => composer.scope)).toEqual(["scope-binding"]);
    }
    env.scope = undefined;
    try {
      const { composers } = await render(ordinary, { reply: COMMENT_A });
      expect(composers.map((composer) => composer.scope)).toEqual([undefined]);
    } finally {
      env.scope = "scope-binding";
    }
    const monitor = await serverReply({ role: "OWNER", mode: "MONITOR_ONLY", live: [COMMENT_A] });
    expect((await render(monitor, { reply: COMMENT_A })).composers).toEqual([]);
  });
});
