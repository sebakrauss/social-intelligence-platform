/**
 * Step 7B-3 — the reply affordance of the conversation view model, resolved with the SAME guards the request command
 * uses (IA §18 precedence: role → Monitor-only → account → switch → capability/connection), the outbound replies'
 * closed states with the canonical read-back dedupe, and the per-member eligibility (own, unread, hidden, removed,
 * Instagram replies-to-replies offer nothing).
 */
import { describe, expect, it } from "vitest";
import type { PermissionKey } from "@/domain/access";
import type { ContentItemRecord } from "@/modules/content";
import type { OutboundReplyView, ProviderActionDecision, RequestGuards, ValidationAuthorityReads } from "@/mutations/request";
import { effectivePermissions } from "@/platform/permissions";
import { OUTBOUND_STATE_OF, buildOutbound, buildReplyModel } from "@/server/queries/inbox";
import { replyEligible } from "@/app/workspaces/[workspaceId]/inbox/views";

const ACCOUNT = "66666666-6666-4666-8666-666666666666";
const content: ContentItemRecord = { id: "c1", platform: "instagram", connectedAccountId: ACCOUNT, providerAssetId: "ig_acct", providerContentId: "ig_post_1", contentKind: "post", reportedSource: "paid", latestObservedAt: new Date() };

function guards(over: { capability?: "AVAILABLE" | "AVAILABLE_WITH_LIMITATION" | "UNAVAILABLE" | "TEMPORARILY_UNAVAILABLE"; switch?: boolean; authorization?: ProviderActionDecision; account?: Awaited<ReturnType<RequestGuards["account"]>>; scopes?: string[] } = {}): RequestGuards {
  return {
    providerActionAllowed: () => Promise.resolve(over.authorization ?? (over.switch === false ? "paused" : "allowed")),
    account: () => Promise.resolve(over.account === undefined && !("account" in over) ? { status: "ACTIVE", platform: "instagram", provider: "simulator", providerAssetId: "ig_acct", connectionStatus: "ACTIVE", credentialId: "c" } : over.account),
    replyCapability: (_id, scope) => {
      over.scopes?.push(`${scope.contentKind}/${scope.reportedSource}`);
      return Promise.resolve({ state: over.capability ?? "AVAILABLE", catalogId: "simulator", catalogRevision: 2 });
    },
  };
}
const permissions = (role: Parameters<typeof effectivePermissions>[0]): ReadonlySet<PermissionKey> => effectivePermissions(role, []);

describe("7B-3: the reply model follows the availability precedence", () => {
  it("a role without reply.public sees no affordance at all (hidden), whatever else holds", async () => {
    for (const role of ["ANALYST_VIEWER", "CLIENT_GUEST"] as const) {
      expect(await buildReplyModel({ permissions: permissions(role), mode: "STANDARD", content, guards: guards() })).toEqual({ kind: "hidden" });
    }
  });

  it("Monitor-only is the first visible reason, before any account or capability read", async () => {
    const scopes: string[] = [];
    const model = await buildReplyModel({ permissions: permissions("RESPONDER"), mode: "MONITOR_ONLY", content, guards: guards({ scopes }) });
    expect(model).toEqual({ kind: "unavailable", reason: "monitor_only", platform: "instagram" });
    expect(scopes).toEqual([]);
  });

  it("then the account, the capability (platform unavailable vs connection), the provider-action authorization — one reason", async () => {
    const owner = permissions("OWNER");
    expect(await buildReplyModel({ permissions: owner, mode: "STANDARD", content: undefined, guards: guards() })).toMatchObject({ kind: "unavailable", reason: "account_inactive" });
    expect(await buildReplyModel({ permissions: owner, mode: "STANDARD", content, guards: guards({ account: undefined }) })).toMatchObject({ kind: "unavailable", reason: "account_inactive" });
    expect(await buildReplyModel({ permissions: owner, mode: "STANDARD", content, guards: guards({ switch: false }) })).toMatchObject({ kind: "unavailable", reason: "paused" });
    // The Meta catalog today: no reply_public → UNAVAILABLE → the platform reason, never a dead control.
    expect(await buildReplyModel({ permissions: owner, mode: "STANDARD", content, guards: guards({ capability: "UNAVAILABLE" }) })).toEqual({ kind: "unavailable", reason: "platform_unavailable", platform: "instagram" });
    expect(await buildReplyModel({ permissions: owner, mode: "STANDARD", content, guards: guards({ capability: "TEMPORARILY_UNAVAILABLE" }) })).toMatchObject({ kind: "unavailable", reason: "connection" });
  });

  it("Step 7B-12A: what the platform and the connection allow comes BEFORE the operational authorization; 'not enabled' reads as not available yet, a block as paused", async () => {
    const owner = permissions("OWNER");
    const model = (over: Parameters<typeof guards>[0]) => buildReplyModel({ permissions: owner, mode: "STANDARD", content, guards: guards(over) });
    // The platform reason wins over any switch state (the Meta catalog today: reply_public UNAVAILABLE).
    expect(await model({ capability: "UNAVAILABLE", authorization: "paused" })).toEqual({ kind: "unavailable", reason: "platform_unavailable", platform: "instagram" });
    expect(await model({ capability: "UNAVAILABLE", authorization: "not_enabled" })).toEqual({ kind: "unavailable", reason: "platform_unavailable", platform: "instagram" });
    expect(await model({ capability: "TEMPORARILY_UNAVAILABLE", authorization: "paused" })).toMatchObject({ reason: "connection" });
    // Capability available: nothing granted → "not enabled in Wrenkind yet"; the emergency block or bad config → "paused".
    expect(await model({ authorization: "not_enabled" })).toEqual({ kind: "unavailable", reason: "platform_unavailable", platform: "instagram" });
    expect(await model({ authorization: "paused" })).toEqual({ kind: "unavailable", reason: "paused", platform: "instagram" });
    expect(await model({ authorization: "allowed" })).toMatchObject({ kind: "available" });
  });

  it("available carries the account, the platform and the real limit; the capability is asked for the content's own kind and source", async () => {
    const scopes: string[] = [];
    for (const role of ["OWNER", "ADMIN", "MANAGER", "RESPONDER"] as const) {
      expect(await buildReplyModel({ permissions: permissions(role), mode: "STANDARD", content, guards: guards({ scopes }) })).toEqual({ kind: "available", connectedAccountId: ACCOUNT, platform: "instagram", maxChars: 2200, limitation: null });
    }
    expect(new Set(scopes)).toEqual(new Set(["post/paid"]));
    expect(await buildReplyModel({ permissions: permissions("OWNER"), mode: "STANDARD", content, guards: guards({ capability: "AVAILABLE_WITH_LIMITATION" }) })).toMatchObject({ kind: "available", limitation: "limited" });
  });
});

describe("7B-14I2: the exceptional validation composer — only where the ordinary chain stops at 'platform unavailable', only for a live authorization naming this member", () => {
  const TARGET_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const TARGET_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const expiresAt = new Date("2026-11-12T16:00:00.000Z");
  const reads = (over: { live?: readonly string[]; pending?: boolean; absent?: boolean } = {}): ValidationAuthorityReads & { asked: string[][] } => {
    const asked: string[][] = [];
    return {
      asked,
      authorization: () => Promise.resolve(undefined),
      catalogValidationPending: () => Promise.resolve(over.pending ?? true),
      ...(over.absent === true ? {} : { liveForInitiator: (_w: string, _u: string, targets: readonly string[]) => {
        asked.push([...targets]);
        return Promise.resolve((over.live ?? [TARGET_A]).map((targetInteractionId) => ({ id: `auth-${targetInteractionId}`, targetInteractionId, expiresAt })));
      } }),
    };
  };
  const model = (over: Parameters<typeof guards>[0], validationReads: ValidationAuthorityReads | undefined, role: Parameters<typeof permissions>[0] = "RESPONDER", mode: "STANDARD" | "MONITOR_ONLY" = "STANDARD") =>
    buildReplyModel({ permissions: permissions(role), mode, content, guards: guards(over), ...(validationReads === undefined ? {} : { validation: { reads: validationReads, workspaceId: "w", userId: "u", targets: [TARGET_A, TARGET_B] } }) });

  it("today's DEV state (no grant, catalog not validated) + a live authorization for one shown comment → validation, for that comment only; never its identifier", async () => {
    const r = reads();
    const result = await model({ capability: "UNAVAILABLE", authorization: "not_enabled" }, r);
    expect(result).toEqual({ kind: "validation", connectedAccountId: ACCOUNT, platform: "instagram", maxChars: 2200, targets: [{ targetInteractionId: TARGET_A, expiresAt }] });
    expect(JSON.stringify(result)).not.toMatch(/auth-/);
    expect(r.asked).toEqual([[TARGET_A, TARGET_B]]);
  });

  it("no live authorization, no validation reads, or the reads lacking the live query → the ordinary answer, unchanged", async () => {
    const ordinary = { kind: "unavailable", reason: "platform_unavailable", platform: "instagram" };
    expect(await model({ capability: "UNAVAILABLE", authorization: "not_enabled" }, reads({ live: [] }))).toEqual(ordinary);
    expect(await model({ capability: "UNAVAILABLE", authorization: "not_enabled" }, undefined)).toEqual(ordinary);
    expect(await model({ capability: "UNAVAILABLE", authorization: "not_enabled" }, reads({ absent: true }))).toEqual(ordinary);
  });

  it("never overrides: no permission (hidden), Monitor-only, an inactive account, a pause or the emergency block, an unhealthy connection, or a capability unusable for another reason", async () => {
    expect(await model({ capability: "UNAVAILABLE", authorization: "not_enabled" }, reads(), "ANALYST_VIEWER")).toEqual({ kind: "hidden" });
    expect(await model({ capability: "UNAVAILABLE", authorization: "not_enabled" }, reads(), "RESPONDER", "MONITOR_ONLY")).toMatchObject({ reason: "monitor_only" });
    expect(await model({ account: undefined }, reads())).toMatchObject({ reason: "account_inactive" });
    expect(await model({ capability: "UNAVAILABLE", authorization: "paused" }, reads())).toMatchObject({ kind: "unavailable" });
    expect(await model({ authorization: "paused" }, reads())).toMatchObject({ kind: "unavailable", reason: "paused" });
    expect(await model({ capability: "TEMPORARILY_UNAVAILABLE", authorization: "not_enabled" }, reads())).toMatchObject({ kind: "unavailable", reason: "connection" });
    expect(await model({ capability: "UNAVAILABLE", authorization: "not_enabled" }, reads({ pending: false }))).toMatchObject({ kind: "unavailable", reason: "platform_unavailable" });
    // Ordinary availability stays ordinary: an exact grant and a usable capability never become "validation".
    expect(await model({ authorization: "allowed" }, reads())).toMatchObject({ kind: "available" });
  });
});

describe("7B-3: outbound replies show real states and never duplicate a read-back member", () => {
  const view = (over: Partial<OutboundReplyView>): OutboundReplyView => ({ intentId: "i1", parentInteractionId: "p1", connectedAccountId: ACCOUNT, platform: "instagram", text: "Hola", status: "PENDING", outcomeCode: null, providerReplyId: null, initiatorUserId: "u1", createdAt: new Date("2026-11-09T10:00:00Z"), confirmedAt: null, ...over });

  it("maps every intent status onto a closed display state; Sending is never Sent", () => {
    expect(OUTBOUND_STATE_OF).toEqual({ PENDING: "sending", EXECUTING: "sending", CONFIRMED: "sent", FAILED: "failed", BLOCKED: "blocked", OUTCOME_UNKNOWN: "checking" });
    expect(buildOutbound([view({ status: "EXECUTING" }), view({ intentId: "i2", status: "OUTCOME_UNKNOWN", outcomeCode: "RESPONSE_LOST" })], []).map((item) => [item.intentId, item.state, item.outcomeCode])).toEqual([["i1", "sending", null], ["i2", "checking", "RESPONSE_LOST"]]);
  });

  it("a confirmed reply already read back as a canonical member (same provider id) is dropped; an unconfirmed one stays", () => {
    const items = buildOutbound([view({ status: "CONFIRMED", providerReplyId: "ig_r_1", confirmedAt: new Date() }), view({ intentId: "i2", status: "CONFIRMED", providerReplyId: "ig_r_2", confirmedAt: new Date() }), view({ intentId: "i3" })], [{ providerInteractionId: "ig_r_1" }, { providerInteractionId: "ig_c_1" }]);
    expect(items.map((item) => item.intentId)).toEqual(["i2", "i3"]);
  });
});

describe("7B-3: member eligibility", () => {
  const base = { observed: true, presence: "present" as const, author: "audience" as const, parentInteractionId: null };
  it("audience comments present on the platform may be replied to; own, unread, hidden and removed may not", () => {
    expect(replyEligible(base, "facebook")).toBe(true);
    expect(replyEligible({ ...base, author: "own_account" }, "facebook")).toBe(false);
    expect(replyEligible({ ...base, observed: false, presence: "unknown" }, "facebook")).toBe(false);
    expect(replyEligible({ ...base, presence: "hidden" }, "facebook")).toBe(false);
    expect(replyEligible({ ...base, presence: "removed_at_source" }, "facebook")).toBe(false);
  });
  it("on Instagram only top-level comments receive replies; on Facebook a reply to a reply is allowed", () => {
    expect(replyEligible({ ...base, parentInteractionId: "parent" }, "instagram")).toBe(false);
    expect(replyEligible(base, "instagram")).toBe(true);
    expect(replyEligible({ ...base, parentInteractionId: "parent" }, "facebook")).toBe(true);
  });
});
