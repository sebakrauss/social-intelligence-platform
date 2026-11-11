/**
 * Step 7B-1 — the request side (mutations/request): the request-time guard chain refuses before anything is written,
 * a created request writes the PENDING intent, its reply text and its first history row with the capability state it
 * relied on, a repeated key answers the existing intent unchanged, and the dispatch is identifiers only.
 */
import { describe, expect, it } from "vitest";
import { createOutboxMessage } from "@/platform/outbox";
import { EXECUTE_INTENT_TASK, REPLY_TEXT_MAX_CHARS, executeIntentDispatch, requestPublicReply, type PublicReplyRequest } from "@/mutations/request";
import { CORRELATION, ORGANIZATION, OTHER_WORKSPACE, TARGET, USER, WORKSPACE, fixedClock, guardState, memoryStores, replyTarget } from "./support";

const context = { organizationId: ORGANIZATION, workspaceId: WORKSPACE, userId: USER, correlationId: CORRELATION };
const request = (overrides: Partial<PublicReplyRequest> = {}): PublicReplyRequest => ({ targetInteractionId: TARGET, text: "Gracias por escribirnos.", idempotencyKey: "form-render-0001", ...overrides });

describe("7B-1: a created request", () => {
  it("writes the PENDING intent (attempt 0, no run, no outcome), the reply text and ONE web history row, with the capability state it relied on", async () => {
    const stores = memoryStores();
    const clock = fixedClock();
    const outcome = await requestPublicReply(stores, clock, context, request());
    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") return;
    expect(outcome.intent).toMatchObject({ kind: "reply_public", requestType: "human", status: "PENDING", attempt: 0, runReference: null, outcomeCode: null, targetInteractionId: TARGET, initiatorUserId: USER, workspaceId: WORKSPACE, organizationId: ORGANIZATION, capabilityCatalogId: "simulator", capabilityCatalogRevision: 2, correlationId: CORRELATION, idempotencyKey: "form-render-0001" });
    expect(outcome.reply).toMatchObject({ intentId: outcome.intent.id, organizationId: ORGANIZATION, workspaceId: WORKSPACE, parentInteractionId: TARGET, text: "Gracias por escribirnos.", providerReplyId: null, confirmedAt: null, platform: "facebook" });
    expect(stores.history).toEqual([expect.objectContaining({ intentId: outcome.intent.id, from: null, to: "PENDING", attempt: 0, actor: "web", code: null, runReference: null })]);
    // The switch was asked for the target's platform; the capability for the target's own content kind and source.
    // Step 7B-12A: the request consults the authorization for the EXACT platform:action, never a platform-wide flag.
    expect(stores.calls).toContain("switch:facebook:public_reply");
    expect(stores.calls).toContain("capability:post/mixed");
  });

  it("the same key with the SAME payload answers the existing intent unchanged and writes nothing", async () => {
    const stores = memoryStores();
    const clock = fixedClock();
    const first = await requestPublicReply(stores, clock, context, request());
    const second = await requestPublicReply(stores, clock, context, request());
    expect(second.kind).toBe("existing");
    if (first.kind !== "created" || second.kind !== "existing") return;
    expect(second.intent).toEqual(first.intent);
    expect(stores.intentRows.size).toBe(1);
    expect(stores.replyRows.size).toBe(1);
    expect(stores.history).toHaveLength(1);
  });

  it("the same key with a different text, target or user is refused as a key reuse — never another request's intent", async () => {
    const stores = memoryStores(guardState(), [replyTarget(), replyTarget({ interactionId: "0b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d" })]);
    const clock = fixedClock();
    expect((await requestPublicReply(stores, clock, context, request())).kind).toBe("created");
    expect(await requestPublicReply(stores, clock, context, request({ text: "A different text" }))).toEqual({ kind: "refused", reason: "IDEMPOTENCY_KEY_REUSED" });
    expect(await requestPublicReply(stores, clock, context, request({ targetInteractionId: "0b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d" }))).toEqual({ kind: "refused", reason: "IDEMPOTENCY_KEY_REUSED" });
    expect(await requestPublicReply(stores, clock, { ...context, userId: "0a2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d" }, request())).toEqual({ kind: "refused", reason: "IDEMPOTENCY_KEY_REUSED" });
    expect(stores.intentRows.size).toBe(1);
    expect(stores.history).toHaveLength(1);
  });

  it("the dispatch names the executor's topic, the workspace, the intent and the account — identifiers only, never the text", () => {
    const clock = fixedClock();
    const intent = { ...replyTarget(), id: "8b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d" };
    const dispatch = executeIntentDispatch({ id: "9b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5e", now: clock.now(), intent: { id: intent.id, organizationId: ORGANIZATION, workspaceId: WORKSPACE, kind: "reply_public", requestType: "human", targetInteractionId: TARGET, connectedAccountId: intent.connectedAccountId, initiatorUserId: USER, idempotencyKey: "form-render-0001", status: "PENDING", attempt: 0, runReference: null, outcomeCode: null, capabilityCatalogId: "simulator", capabilityCatalogRevision: 2, correlationId: CORRELATION, createdAt: clock.now(), updatedAt: clock.now(), validationAuthorizationId: null } });
    expect(dispatch.topic).toBe(EXECUTE_INTENT_TASK);
    expect(dispatch.topic).toBe("mutations.execute_intent");
    expect(Object.keys(dispatch.subjectIds).sort()).toEqual(["connected_account_id", "mutation_intent_id"]);
    expect(dispatch.initiator).toEqual({ type: "user", userId: USER });
    expect(dispatch.dispatchKey).toBe(`mutations.execute_intent:${WORKSPACE}:${intent.id}`);
    // The outbox's own validator accepts it: declared fields, UUID subjects, trace-shaped keys.
    expect(() => createOutboxMessage(dispatch)).not.toThrow();
    expect(JSON.stringify(dispatch)).not.toMatch(/Gracias|text/);
  });
});

describe("7B-1: the request-time guard chain refuses before any write", () => {
  const cases: readonly [string, Parameters<typeof memoryStores>, Partial<PublicReplyRequest>, string][] = [
    ["empty text", [guardState(), [replyTarget()]], { text: "   " }, "TEXT_EMPTY"],
    ["text over the limit", [guardState(), [replyTarget()]], { text: "x".repeat(REPLY_TEXT_MAX_CHARS + 1) }, "TEXT_TOO_LONG"],
    ["unknown target", [guardState(), []], {}, "TARGET_NOT_FOUND"],
    ["another workspace's target (fails exactly like an unknown one)", [guardState(), [replyTarget({ workspaceId: OTHER_WORKSPACE })]], {}, "TARGET_NOT_FOUND"],
    ["a placeholder never read with its content", [guardState(), [replyTarget({ observed: false, presence: "unknown" })]], {}, "TARGET_NOT_READ"],
    ["a hidden target", [guardState(), [replyTarget({ presence: "hidden" })]], {}, "TARGET_NOT_PRESENT"],
    ["a target removed at source", [guardState(), [replyTarget({ presence: "removed_at_source" })]], {}, "TARGET_NOT_PRESENT"],
    ["the brand's own message", [guardState(), [replyTarget({ ownAccount: true })]], {}, "TARGET_OWN_ACCOUNT"],
    ["provider actions switched off", [guardState({ switchEnabled: false }), [replyTarget()]], {}, "PROVIDER_ACTIONS_DISABLED"],
    ["an inactive account", [guardState({ account: { status: "INACTIVE", platform: "facebook", provider: "simulator", providerAssetId: "fb_page_aurora", connectionStatus: "ACTIVE", credentialId: "c" } }), [replyTarget()]], {}, "ACCOUNT_INACTIVE"],
    ["an unknown account", [guardState({ account: undefined }), [replyTarget()]], {}, "ACCOUNT_INACTIVE"],
    ["a degraded connection", [guardState({ account: { status: "ACTIVE", platform: "facebook", provider: "simulator", providerAssetId: "fb_page_aurora", connectionStatus: "DEGRADED", credentialId: "c" } }), [replyTarget()]], {}, "CONNECTION_UNAVAILABLE"],
    ["capability unavailable (e.g. the platform catalog has no reply_public)", [guardState({ capability: "UNAVAILABLE" }), [replyTarget()]], {}, "CAPABILITY_UNAVAILABLE"],
    ["capability temporarily unavailable", [guardState({ capability: "TEMPORARILY_UNAVAILABLE" }), [replyTarget()]], {}, "CAPABILITY_UNAVAILABLE"],
  ];
  for (const [name, storeArgs, overrides, reason] of cases) {
    it(`${name} → ${reason}, nothing written`, async () => {
      const stores = memoryStores(...storeArgs);
      const outcome = await requestPublicReply(stores, fixedClock(), context, request(overrides));
      expect(outcome).toEqual({ kind: "refused", reason });
      expect(stores.intentRows.size).toBe(0);
      expect(stores.replyRows.size).toBe(0);
      expect(stores.history).toEqual([]);
    });
  }

  it("Step 7B-13C (F1): Instagram admits a reply to a TOP-LEVEL comment only — decided on the persisted target, refused before any write", async () => {
    const IG = { platform: "instagram", providerInteractionId: "17900000000000123", providerAssetId: "17841400000000001" } as const;
    const IG_ACCOUNT = guardState({ account: { status: "ACTIVE", platform: "instagram", provider: "meta", providerAssetId: IG.providerAssetId, connectionStatus: "ACTIVE", credentialId: "c" } });
    const refusedTargets: readonly [string, Parameters<typeof replyTarget>[0]][] = [
      ["a nested reply", { ...IG, kind: "reply", parentProviderInteractionId: "17900000000000100" }],
      ["a reply whose parent is unknown here", { ...IG, kind: "reply", parentProviderInteractionId: null }],
      ["a 'comment' that names a parent (inconsistent data)", { ...IG, kind: "comment", parentProviderInteractionId: "17900000000000100" }],
      ["an unknown kind", { ...IG, kind: "unknown", parentProviderInteractionId: null }],
    ];
    for (const [label, target] of refusedTargets) {
      const stores = memoryStores(IG_ACCOUNT, [replyTarget(target)]);
      expect(await requestPublicReply(stores, fixedClock(), context, request()), label).toEqual({ kind: "refused", reason: "TARGET_NOT_REPLYABLE" });
      expect(stores.intentRows.size, label).toBe(0);
      expect(stores.history, label).toEqual([]);
      // Refused on the target's shape, before the authorization or the capability is even asked.
      expect(stores.calls.filter((call) => call.startsWith("switch:") || call.startsWith("capability:")), label).toEqual([]);
    }
    // A top-level Instagram comment passes this rule (every other guard still applies).
    const topLevel = memoryStores(IG_ACCOUNT, [replyTarget({ ...IG, kind: "comment", parentProviderInteractionId: null })]);
    expect((await requestPublicReply(topLevel, fixedClock(), context, request())).kind).toBe("created");
  });

  it("Step 7B-13C (F1): Facebook (and the simulator's Facebook) keep their rule — a reply to a reply may be requested", async () => {
    const stores = memoryStores(guardState(), [replyTarget({ kind: "reply", parentProviderInteractionId: "fb_c_009" })]);
    expect((await requestPublicReply(stores, fixedClock(), context, request())).kind).toBe("created");
  });

  it("AVAILABLE_WITH_LIMITATION is enough to request (the limitation is shown, not a refusal)", async () => {
    const stores = memoryStores(guardState({ capability: "AVAILABLE_WITH_LIMITATION" }));
    expect((await requestPublicReply(stores, fixedClock(), context, request())).kind).toBe("created");
  });
});
