/**
 * Meta mutation port — Instagram public reply (Step 7B-11). Every case runs against a fake `fetch`: no request ever
 * reaches Meta. What is proven: exactly one POST per call to the documented edge with the token in the body; a 2xx
 * with an id confirms; a Graph error is a definite failure ONLY for an HTTP 4xx with a listed pre-processing code and
 * `is_transient` not true (independent review F1) — everything else after the request left is OutcomeUnknown; every
 * refusal before the request sends nothing; nothing of the credential escapes into errors, receipts or URLs; and, through
 * the real executor (in-memory stores), one intent makes at most one POST and an uncertain result is never resent.
 */
import { describe, expect, it } from "vitest";
import { providerCredential } from "@/integrations/providers/contract/credential";
import {
  CredentialInvalidError,
  OutcomeUnknownError,
  PermanentRejectedError,
  PermissionMissingError,
  RateLimitedError,
  TargetNotEligibleError,
  TargetNotFoundError,
} from "@/integrations/providers/contract/errors";
import { providerObjectRef } from "@/integrations/providers/contract/identity";
import type { ProviderAccess } from "@/integrations/providers/contract/dto";
import { META_GRAPH_VERSION } from "@/integrations/providers/meta/endpoints";
import { createMetaGraphTransport, createMetaGraphWriteTransport, META_INSTAGRAM_REPLY_MAX_CHARS, type MetaGraphFetch } from "@/integrations/providers/meta/graph-transport";
import { createMetaMutationPort } from "@/integrations/providers/meta/mutation-port";
import type { MutationIntent } from "@/mutations/domain/intent";
import { executeIntent, type ExecutorDependencies } from "@/mutations/executor/execute";
import type { OutboundReply, ReplyTarget } from "@/mutations/ports";
import { ACCOUNT, ORGANIZATION, OTHER_WORKSPACE, TARGET, WORKSPACE, fixedClock, guardState, memoryStores, pendingIntent, replyTarget, statusesOf, type GuardState } from "../unit/mutations/support";

const TOKEN = "EAAB-synthetic-user-token-never-real";
const IG_ACCOUNT = "17841400000000001";
const COMMENT = "17900000000000123";
const CREATED = "17900000000000999";
const NOW = new Date("2026-11-10T20:00:00Z");

const access: ProviderAccess = { credential: providerCredential("cred-synthetic", TOKEN), account: providerObjectRef("instagram", "asset", IG_ACCOUNT) };
const target = providerObjectRef("instagram", "interaction", COMMENT);
const HINT = { key: "intent-0001" };

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly contentType: string;
}

type Answer = { readonly status: number; readonly body: unknown } | { readonly throws: Error } | { readonly status: number; readonly raw: string; readonly headers?: Record<string, string> };

function harness(answer: Answer) {
  const calls: Call[] = [];
  const fetch: MetaGraphFetch = (url, init) => {
    calls.push({ url, method: String(init.method), body: typeof init.body === "string" ? init.body : "", contentType: new Headers(init.headers).get("content-type") ?? "" });
    if ("throws" in answer) return Promise.reject(answer.throws);
    if ("raw" in answer) return Promise.resolve(new Response(answer.raw, { status: answer.status, headers: { "content-type": "application/json", ...(answer.headers ?? {}) } }));
    return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } }));
  };
  const port = createMetaMutationPort({ transport: createMetaGraphWriteTransport({ fetch, timeoutMs: 200 }), clock: () => NOW });
  return { calls, port, fetch };
}

const graphError = (code: number, subcode?: number, type = "GraphMethodException", status = 400, extra: Record<string, unknown> = {}) => ({
  status,
  body: { error: { message: "redacted-by-provider", type, code, ...(subcode === undefined ? {} : { error_subcode: subcode }), fbtrace_id: "Axxx", ...extra } },
});

describe("Meta mutation port · Instagram public reply (7B-11)", () => {
  it("success: ONE POST to /{version}/{comment-id}/replies with message + token in the form body (never the URL); the receipt carries the created reply id", async () => {
    const h = harness({ status: 200, body: { id: CREATED } });
    const result = await h.port.replyPublicly(access, target, "Gracias por escribirnos.", HINT);
    expect(h.calls).toHaveLength(1);
    const [call] = h.calls;
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe(`https://graph.facebook.com/${META_GRAPH_VERSION}/${COMMENT}/replies`);
    expect(call?.url).not.toContain(TOKEN);
    expect(call?.contentType).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(call?.body).get("message")).toBe("Gracias por escribirnos.");
    expect(new URLSearchParams(call?.body).get("access_token")).toBe(TOKEN);
    expect(result.data).toEqual({
      kind: "public_reply",
      target,
      createdInteraction: providerObjectRef("instagram", "interaction", CREATED),
      confirmedAt: NOW.toISOString(),
      rawReference: { provider: "meta", apiVersion: META_GRAPH_VERSION, ref: `instagram:comment:${CREATED}` },
    });
    expect(result.budget).toEqual({ kind: "not_reported" });
  });

  it("identity: the receipt's target is the comment that was asked for and the created id is the provider's, verbatim", async () => {
    const h = harness({ status: 200, body: { id: CREATED, extra: "ignored" } });
    const result = await h.port.replyPublicly(access, target, "Hola", HINT);
    expect(result.data.target.id).toBe(COMMENT);
    expect(result.data.createdInteraction?.id).toBe(CREATED);
    expect(result.data.createdInteraction?.platform).toBe("instagram");
  });

  describe("F1 — definite refusals: HTTP 4xx + a listed pre-processing code + is_transient not true → the specific failure, after exactly one request", () => {
    const definite: readonly (readonly [string, ReturnType<typeof graphError>, new (...args: never[]) => Error])[] = [
      ...[4, 17, 32, 341, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80007, 80008].map((code) => [`rate limit ${String(code)}`, graphError(code), RateLimitedError] as const),
      ["permission 10", graphError(10), PermissionMissingError],
      ["permission 200", graphError(200), PermissionMissingError],
      ["permission 299", graphError(299), PermissionMissingError],
      ["credential 190", graphError(190, undefined, "OAuthException"), CredentialInvalidError],
      ["credential 190/463 (expired)", graphError(190, 463, "OAuthException"), CredentialInvalidError],
      ["credential 102", graphError(102, undefined, "OAuthException"), CredentialInvalidError],
      ["policy 368", graphError(368), PermanentRejectedError],
      ["parameter 100", graphError(100), PermanentRejectedError],
      ["parameter 100/33 (object missing or unreachable)", graphError(100, 33), TargetNotFoundError],
      ["is_transient false is not doubted", graphError(100, undefined, "GraphMethodException", 400, { is_transient: false }), PermanentRejectedError],
    ];
    for (const [label, answer, kind] of definite) {
      it(label, async () => {
        const h = harness(answer);
        await expect(h.port.replyPublicly(access, target, "Hola", HINT)).rejects.toBeInstanceOf(kind);
        expect(h.calls).toHaveLength(1);
      });
    }
    it("each definite refusal keeps its specific meaning (reason codes)", async () => {
      const policy = await harness(graphError(368)).port.replyPublicly(access, target, "Hola", HINT).catch((e: unknown) => e);
      expect(policy).toMatchObject({ reasonCode: "content_policy" });
      const parameter = await harness(graphError(100)).port.replyPublicly(access, target, "Hola", HINT).catch((e: unknown) => e);
      expect(parameter).toMatchObject({ reasonCode: "invalid_request" });
      const expired = await harness(graphError(190, 463, "OAuthException")).port.replyPublicly(access, target, "Hola", HINT).catch((e: unknown) => e);
      expect(expired).toMatchObject({ reason: "expired" });
    });
  });

  describe("F1 — any Graph error that is NOT positive evidence of a refusal → OutcomeUnknownError (never FAILED), after exactly one request", () => {
    const unknown: readonly (readonly [string, ReturnType<typeof graphError>, string])[] = [
      ["HTTP 500 + code 100 (a listed code on a 5xx)", graphError(100, undefined, "GraphMethodException", 500), "unrecognized_5xx_response"],
      ["HTTP 500 + code -2", graphError(-2, undefined, "GraphMethodException", 500), "unrecognized_5xx_response"],
      ["HTTP 503 + code 190 (credential code on a 5xx)", graphError(190, undefined, "OAuthException", 503), "unrecognized_5xx_response"],
      ["HTTP 400 + code 100 + is_transient: true", graphError(100, undefined, "GraphMethodException", 400, { is_transient: true }), "unrecognized_4xx_response"],
      ["HTTP 400 + code 613 + is_transient: true", graphError(613, undefined, "GraphMethodException", 400, { is_transient: true }), "unrecognized_4xx_response"],
      ["HTTP 400 + code 9999 (unknown code)", graphError(9999), "unrecognized_4xx_response"],
      ["HTTP 400 + code 1 (temporary)", graphError(1, undefined, "OAuthException"), "unrecognized_4xx_response"],
      ["HTTP 400 + code 2 (temporary)", graphError(2, undefined, "OAuthException"), "unrecognized_4xx_response"],
      ["HTTP 400 + code -1", graphError(-1), "unrecognized_4xx_response"],
      ["HTTP 400 + code -2", graphError(-2), "unrecognized_4xx_response"],
      ["HTTP 400 + code 2207001 (an Instagram-specific code not on the list)", graphError(2207001), "unrecognized_4xx_response"],
      ["HTTP 400 + code 300 (just past the permission range)", graphError(300), "unrecognized_4xx_response"],
      ["HTTP 400 + code 80009 (just past the rate-limit range)", graphError(80009), "unrecognized_4xx_response"],
    ];
    for (const [label, answer, reason] of unknown) {
      it(label, async () => {
        const h = harness(answer);
        const error = await h.port.replyPublicly(access, target, "Hola", HINT).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OutcomeUnknownError);
        expect((error as OutcomeUnknownError).reason).toBe(reason);
        expect(h.calls).toHaveLength(1);
      });
    }
    it("an OAuthException without any code is unknown, never a credential failure", async () => {
      const h = harness({ status: 400, body: { error: { message: "redacted", type: "OAuthException" } } });
      await expect(h.port.replyPublicly(access, target, "Hola", HINT)).rejects.toBeInstanceOf(OutcomeUnknownError);
      expect(h.calls).toHaveLength(1);
    });
    it("an is_transient flag in any form other than exactly false is doubt, never read as 'not transient'", async () => {
      for (const flag of [true, "true", "false", 1, 0, null, {}]) {
        const error = await harness(graphError(100, undefined, "GraphMethodException", 400, { is_transient: flag })).port.replyPublicly(access, target, "Hola", HINT).catch((e: unknown) => e);
        expect(error, JSON.stringify(flag)).toBeInstanceOf(OutcomeUnknownError);
      }
    });
  });

  describe("uncertain results after the request left → OutcomeUnknownError, never a failure, never a second request", () => {
    it("timeout (the platform may have published)", async () => {
      const h = harness({ throws: Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }) });
      await expect(h.port.replyPublicly(access, target, "Hola", HINT)).rejects.toMatchObject({ name: "OutcomeUnknownError", reason: "timeout" });
      expect(h.calls).toHaveLength(1);
    });
    it("network failure or lost response", async () => {
      const h = harness({ throws: new TypeError("fetch failed") });
      const error = await h.port.replyPublicly(access, target, "Hola", HINT).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OutcomeUnknownError);
      expect((error as OutcomeUnknownError).reason).toBe("network_error");
      expect(h.calls).toHaveLength(1);
    });
    it("temporary provider issue (Graph code 1 / 2) is UNKNOWN for a write, not transient", async () => {
      for (const code of [1, 2]) {
        const h = harness({ status: 500, body: { error: { message: "redacted", type: "OAuthException", code } } });
        await expect(h.port.replyPublicly(access, target, "Hola", HINT)).rejects.toBeInstanceOf(OutcomeUnknownError);
        expect(h.calls).toHaveLength(1);
      }
    });
    it("5xx / 4xx without a Graph error body, a redirect, an unreadable or unrecognized 2xx body", async () => {
      const cases: [Answer, string][] = [
        [{ status: 502, raw: "<html>bad gateway</html>" }, "unrecognized_5xx_response"],
        [{ status: 429, raw: "" }, "unrecognized_4xx_response"],
        [{ status: 302, raw: "", headers: { location: "https://example.invalid/" } }, "unexpected_redirect"],
        [{ status: 200, raw: "not json" }, "unrecognized_status_response"],
        [{ status: 200, body: { ok: true } }, "unrecognized_status_response"],
        [{ status: 200, raw: "x".repeat(70 * 1024) }, "response_too_large"],
      ];
      for (const [answer, reason] of cases) {
        const h = harness(answer);
        const error = await h.port.replyPublicly(access, target, "Hola", HINT).catch((e: unknown) => e);
        expect(error, reason).toBeInstanceOf(OutcomeUnknownError);
        expect((error as OutcomeUnknownError).reason, reason).toBe(reason);
        expect(h.calls, reason).toHaveLength(1);
      }
    });
  });

  describe("refusals BEFORE any request (nothing left the process)", () => {
    const never = () => harness({ throws: new Error("must not be called") });

    it("a Facebook target, or a target that is not an interaction, is not eligible for this adapter", async () => {
      const h = never();
      await expect(h.port.replyPublicly(access, providerObjectRef("facebook", "interaction", "123_456"), "Hola", HINT)).rejects.toBeInstanceOf(TargetNotEligibleError);
      await expect(h.port.replyPublicly(access, providerObjectRef("instagram", "content", COMMENT) as never, "Hola", HINT)).rejects.toBeInstanceOf(TargetNotEligibleError);
      expect(h.calls).toHaveLength(0);
    });
    it("the wrong account: a Facebook Page, a non-asset ref or an unparsable id is an invalid request", async () => {
      const h = never();
      const page: ProviderAccess = { ...access, account: providerObjectRef("facebook", "asset", "1234567890") };
      await expect(h.port.replyPublicly(page, target, "Hola", HINT)).rejects.toBeInstanceOf(PermanentRejectedError);
      // A ref that arrives as data (never through the constructor, which already refuses it): the port re-parses the id.
      const malformed: ProviderAccess = { ...access, account: { ...providerObjectRef("instagram", "asset", IG_ACCOUNT), id: "not an id!" } as ProviderAccess["account"] };
      await expect(h.port.replyPublicly(malformed, target, "Hola", HINT)).rejects.toBeInstanceOf(PermanentRejectedError);
      expect(h.calls).toHaveLength(0);
    });
    it("an empty text or one over the platform cap never leaves", async () => {
      const h = never();
      await expect(h.port.replyPublicly(access, target, "   ", HINT)).rejects.toBeInstanceOf(PermanentRejectedError);
      await expect(h.port.replyPublicly(access, target, "x".repeat(META_INSTAGRAM_REPLY_MAX_CHARS + 1), HINT)).rejects.toBeInstanceOf(PermanentRejectedError);
      expect(h.calls).toHaveLength(0);
    });
    it("private reply, hide, unhide, delete and block are refused for Meta today", async () => {
      const h = never();
      await expect(h.port.replyPrivately(access, target, "Hola", HINT)).rejects.toBeInstanceOf(TargetNotEligibleError);
      await expect(h.port.hide(access, target)).rejects.toBeInstanceOf(TargetNotEligibleError);
      await expect(h.port.unhide(access, target)).rejects.toBeInstanceOf(TargetNotEligibleError);
      await expect(h.port.delete(access, target)).rejects.toBeInstanceOf(TargetNotEligibleError);
      await expect(h.port.block(access, providerObjectRef("instagram", "author", "17841400000000002"))).rejects.toBeInstanceOf(TargetNotEligibleError);
      expect(h.calls).toHaveLength(0);
    });
  });

  it("no credential leaks: errors, receipts and the URL never carry the token; the provider's message is discarded", async () => {
    for (const answer of [graphError(190, 463, "OAuthException"), { status: 502, raw: `oops ${TOKEN}` } as Answer, { throws: new Error(`socket ${TOKEN}`) } as Answer]) {
      const h = harness(answer);
      const error = await h.port.replyPublicly(access, target, "Hola", HINT).catch((e: unknown) => e);
      const thrown = error as Error;
      const serialized = JSON.stringify(thrown, Object.getOwnPropertyNames(thrown)) + thrown.message + (thrown.stack ?? "");
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).not.toContain("redacted-by-provider");
      expect(h.calls[0]?.url).not.toContain(TOKEN);
    }
    const ok = harness({ status: 200, body: { id: CREATED } });
    const receipt = await ok.port.replyPublicly(access, target, "Hola", HINT);
    expect(JSON.stringify(receipt)).not.toContain(TOKEN);
  });

  it("the idempotency hint changes nothing on the wire (Meta has no idempotency key on this edge): domain idempotency stays authoritative", async () => {
    const a = harness({ status: 200, body: { id: CREATED } });
    const b = harness({ status: 200, body: { id: CREATED } });
    await a.port.replyPublicly(access, target, "Hola", { key: "k-1" });
    await b.port.replyPublicly(access, target, "Hola", { key: "k-2" });
    expect(a.calls[0]?.body).toBe(b.calls[0]?.body);
    expect(a.calls[0]?.url).toBe(b.calls[0]?.url);
  });
});

describe("F2 — the write lives on its own transport object", () => {
  it("the read transport holds no write; the write transport holds exactly one operation and no read", () => {
    const unused: MetaGraphFetch = () => Promise.reject(new Error("unused"));
    const read = createMetaGraphTransport({ fetch: unused });
    const write = createMetaGraphWriteTransport({ fetch: unused });
    expect(Object.keys(read)).not.toContain("createInstagramCommentReply");
    expect("createInstagramCommentReply" in read).toBe(false);
    expect(Object.keys(write)).toEqual(["createInstagramCommentReply"]);
    expect(Object.isFrozen(write)).toBe(true);
  });
});

/**
 * Through the REAL executor (mutations/executor/execute.ts) with in-memory stores and the Meta port on a fake fetch —
 * the composition a future gate would wire, exercised here without touching jobs/mutations.ts or any runtime.
 */
describe("integration — executor + Meta Instagram port (fake fetch, in-memory stores)", () => {
  const RUN = "run_7b11_0001";
  const IG_TARGET = { platform: "instagram" as const, providerInteractionId: COMMENT, providerAssetId: IG_ACCOUNT, providerContentId: "17800000000000001" };
  const IG_GUARDS = { account: { status: "ACTIVE" as const, platform: "instagram", provider: "meta", providerAssetId: IG_ACCOUNT, connectionStatus: "ACTIVE" as const, credentialId: "cred-ig" } };

  function setup(answer: Answer, options: { readonly guards?: Partial<GuardState>; readonly target?: Partial<ReplyTarget>; readonly intent?: Partial<MutationIntent> } = {}) {
    const stores = memoryStores(guardState({ ...IG_GUARDS, ...options.guards }), [replyTarget({ ...IG_TARGET, ...options.target })]);
    const clock = fixedClock();
    const intent = pendingIntent(clock, options.intent);
    stores.intentRows.set(`${intent.workspaceId}:${intent.id}`, intent);
    const reply: OutboundReply = { id: clock.newId(), organizationId: ORGANIZATION, workspaceId: WORKSPACE, intentId: intent.id, parentInteractionId: TARGET, connectedAccountId: ACCOUNT, platform: "instagram", text: "Gracias por escribirnos.", providerReplyId: null, confirmedAt: null, createdAt: clock.now() };
    stores.replyRows.set(`${WORKSPACE}:${intent.id}`, reply);
    stores.history.push({ intentId: intent.id, from: null, to: "PENDING", attempt: 0, actor: "web", code: null, runReference: null });
    const h = harness(answer);
    const statusAtPost: string[] = [];
    const port = { ...h.port, replyPublicly: (...args: Parameters<typeof h.port.replyPublicly>) => {
      statusAtPost.push(stores.intentRows.get(`${intent.workspaceId}:${intent.id}`)?.status ?? "missing");
      return h.port.replyPublicly(...args);
    } };
    const opened: string[] = [];
    const deps: ExecutorDependencies = {
      inScope: (work) => work(stores),
      credentials: { withAccess: (input, use) => { opened.push(input.connectedAccountId); return use(access); } },
      providers: { mutation: (provider) => (provider === "meta" ? port : undefined) },
      clock,
    };
    const run = (runReference = RUN) => executeIntent(deps, { workspaceId: intent.workspaceId, intentId: intent.id, runReference });
    return { stores, intent, calls: h.calls, statusAtPost, opened, run };
  }

  it("confirmed: EXECUTING is recorded before the ONE POST; the receipt's provider id is linked to the reply; a redelivery sends nothing", async () => {
    const t = setup({ status: 200, body: { id: CREATED } });
    expect(await t.run()).toEqual({ kind: "confirmed", providerReplyId: CREATED });
    expect(t.statusAtPost).toEqual(["EXECUTING"]);
    expect(t.calls).toHaveLength(1);
    expect(t.stores.replyRows.get(`${WORKSPACE}:${t.intent.id}`)?.providerReplyId).toBe(CREATED);
    expect(statusesOf(t.stores)).toEqual(["PENDING", "EXECUTING", "CONFIRMED"]);
    expect((await t.run("run_redelivered")).kind).toBe("noop");
    expect(t.calls).toHaveLength(1);
  });

  it("timeout after the POST started → OUTCOME_UNKNOWN; redelivery and a later run never POST again", async () => {
    const t = setup({ throws: Object.assign(new Error("timeout"), { name: "TimeoutError" }) });
    expect(await t.run()).toEqual({ kind: "outcome_unknown", code: "RESPONSE_LOST" });
    expect(await t.run("run_redelivered")).toEqual({ kind: "noop", status: "OUTCOME_UNKNOWN" });
    expect(t.calls).toHaveLength(1);
    expect(t.stores.replyRows.get(`${WORKSPACE}:${t.intent.id}`)?.providerReplyId).toBeNull();
  });

  it("F1 through the executor: HTTP 500 + code 100 and HTTP 400 + code 9999 are OUTCOME_UNKNOWN (never FAILED); HTTP 400 + code 10 is FAILED PERMISSION_MISSING", async () => {
    for (const answer of [graphError(100, undefined, "GraphMethodException", 500), graphError(9999), graphError(100, undefined, "GraphMethodException", 400, { is_transient: true })]) {
      const t = setup(answer);
      expect((await t.run()).kind).toBe("outcome_unknown");
      expect(t.calls).toHaveLength(1);
    }
    const refused = setup(graphError(10));
    expect(await refused.run()).toEqual({ kind: "failed", code: "PERMISSION_MISSING" });
    expect(refused.calls).toHaveLength(1);
  });

  it("zero POST when a guard refuses: switch disabled, capability unavailable, Monitor-only, a role without reply.public", async () => {
    const cases: readonly [Partial<GuardState>, string][] = [
      [{ switchEnabled: false }, "PROVIDER_ACTIONS_DISABLED"],
      [{ capability: "UNAVAILABLE" }, "CAPABILITY_UNAVAILABLE"],
      [{ mode: "MONITOR_ONLY" }, "MODE_NOT_STANDARD"],
      [{ role: "ANALYST" }, "PERMISSION_DENIED"],
    ];
    for (const [guards, code] of cases) {
      const t = setup({ status: 200, body: { id: CREATED } }, { guards });
      expect(await t.run(), code).toEqual({ kind: "blocked", code });
      expect(t.calls, code).toHaveLength(0);
      expect(t.opened, code).toEqual([]);
    }
  });

  it("zero POST across accounts and workspaces: a target owned by another account or another workspace is BLOCKED", async () => {
    const otherAccount = setup({ status: 200, body: { id: CREATED } }, { target: { connectedAccountId: "8b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d" } });
    expect(await otherAccount.run()).toEqual({ kind: "blocked", code: "TARGET_ACCOUNT_MISMATCH" });
    const otherWorkspace = setup({ status: 200, body: { id: CREATED } }, { target: { workspaceId: OTHER_WORKSPACE } });
    expect(await otherWorkspace.run()).toEqual({ kind: "blocked", code: "TARGET_ACCOUNT_MISMATCH" });
    expect([...otherAccount.calls, ...otherWorkspace.calls]).toHaveLength(0);
  });

  it("zero POST for an invalid or Facebook target, or the brand's own message: refused before any request", async () => {
    const facebook = setup({ status: 200, body: { id: CREATED } }, { target: { platform: "facebook", providerInteractionId: "123_456" } });
    expect(await facebook.run()).toEqual({ kind: "failed", code: "TARGET_NOT_ELIGIBLE" });
    const own = setup({ status: 200, body: { id: CREATED } }, { target: { ownAccount: true } });
    expect(await own.run()).toEqual({ kind: "blocked", code: "TARGET_NOT_PRESENT" });
    const hidden = setup({ status: 200, body: { id: CREATED } }, { target: { presence: "hidden" } });
    expect(await hidden.run()).toEqual({ kind: "blocked", code: "TARGET_NOT_PRESENT" });
    expect([...facebook.calls, ...own.calls, ...hidden.calls]).toHaveLength(0);
  });
});
