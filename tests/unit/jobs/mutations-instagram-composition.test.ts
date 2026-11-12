/**
 * Step 7B-13A — the Instagram public-reply composition, end to end, with NO request to Meta: the REAL request side
 * (mutations/request), the REAL executor, the REAL port selection of the integration plane (jobs/mutations.ts
 * selectMutationPorts), the REAL Meta mutation port and its REAL Graph write transport over a fake `fetch`, and the
 * REAL fail-closed resolver (platform/flags) for mutation.provider_action over local fixture rows. Persistence is
 * in-memory (tests/unit/mutations/support.ts); the PostgreSQL side is tests/db/suites/mutations.ts.
 *
 * Every positive authorization below (an exact `instagram:public_reply` grant, an AVAILABLE capability) exists ONLY in
 * these local fixtures: nothing is written to any database, and the productive Meta catalog is evaluated as it is
 * (reply_public not published → UNAVAILABLE).
 *
 *   A  all guards valid → one intent, one EXECUTING, exactly one POST, a receipt with the reply id, CONFIRMED
 *   B  a timeout after the POST started → OUTCOME_UNKNOWN, no second POST, no retry
 *   C  redelivery of the same intent (after an outcome, or after a crash in EXECUTING) → no second publication
 *   D  authorization revoked (or the emergency block set) before execution → BLOCKED, zero POST
 *   E  Facebook (and TikTok) → no write path: no port, BLOCKED before any credential, zero POST
 *   F  wrong tenant / target / account, role, mode, credential, connection → BLOCKED, zero POST
 *   G  today's Meta catalog (reply_public UNKNOWN_NOT_VALIDATED) → CAPABILITY_UNAVAILABLE, zero POST
 *   H  today's switches (no grant) → PROVIDER_ACTIONS_DISABLED, zero POST
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerCredential } from "@/integrations/providers/contract/credential";
import { providerObjectRef } from "@/integrations/providers/contract/identity";
import type { ProviderAccess } from "@/integrations/providers/contract/dto";
import type { ProviderMutationPort } from "@/integrations/providers/contract/mutation-port";
import { createMetaGraphWriteTransport, type MetaGraphFetch } from "@/integrations/providers/meta/graph-transport";
import { createMetaMutationPort } from "@/integrations/providers/meta/mutation-port";
import { PLATFORM_CATALOG, effectiveAvailability, evaluateProfile, resolveEntry } from "@/modules/capability";
import { composeMutationProviders, selectMutationPorts } from "@/jobs/mutations";
import { CredentialUnreadable, executeIntent, type ExecutorDependencies } from "@/mutations/executor/execute";
import type { ProviderActionDecision } from "@/mutations/ports";
import { requestPublicReply } from "@/mutations/request";
import type { MutationIntent } from "@/mutations/domain/intent";
import { resolveSwitch, type SwitchRowInput } from "@/platform/flags/resolver";
import { ACCOUNT, CORRELATION, ORGANIZATION, OTHER_WORKSPACE, TARGET, USER, WORKSPACE, fixedClock, guardState, memoryStores, pendingIntent, replyTarget, statusesOf, type GuardState, type MemoryStores } from "../mutations/support";

const TOKEN = "EAAB-synthetic-7b13a-token-never-real";
const IG_ACCOUNT = "17841400000000077";
const COMMENT = "17900000000000777";
const CREATED = "17900000000000888";
const TEXT = "Gracias por escribirnos (7B-13A).";
const RUN = "run_7b13a_0001";

/** The DEV Instagram account's granted permissions as stored today (identifiers only). */
const IG_PERMISSIONS = ["business_management", "instagram_basic", "instagram_manage_comments", "pages_read_engagement", "pages_read_user_content", "pages_show_list", "public_profile"];

const IG_ACCOUNT_GUARD = { status: "ACTIVE" as const, platform: "instagram", provider: "meta", providerAssetId: IG_ACCOUNT, connectionStatus: "ACTIVE", credentialId: "cred-ig-7b13a" };
const IG_TARGET = { platform: "instagram", providerInteractionId: COMMENT, providerAssetId: IG_ACCOUNT, providerContentId: "17800000000000777", contentKind: "post", reportedSource: "organic" };

// ── mutation.provider_action fixture rows (LOCAL ONLY) ──────────────────────────────────────────────────────────────
const row = (qualifier: string, enabled: boolean): SwitchRowInput => ({ switchKey: "mutation.provider_action", qualifier, scope: "global", organizationId: null, workspaceId: null, value: { enabled } });
const GRANT_IG = row("instagram:public_reply", true);
const GRANT_FB = row("facebook:public_reply", true);
const EMERGENCY = row("*", false);

/** The production decision (server/persistence/mutations.ts sharedGuards) over the REAL resolver, on fixture rows. */
function decide(rows: readonly SwitchRowInput[], platform: string, action: string): ProviderActionDecision {
  const resolved = resolveSwitch(rows, "mutation.provider_action", { qualifier: `${platform}:${action}` });
  if (resolved.value.enabled && !resolved.failSafe) return "allowed";
  return resolved.source === "default" ? "not_enabled" : "paused";
}

/** reply_public for an Instagram post as the PRODUCTIVE Meta catalog evaluates it today (no fixture catalog). */
function productiveInstagramReplyCapability(): GuardState["capability"] {
  const profile = evaluateProfile({
    catalog: PLATFORM_CATALOG,
    platform: "instagram",
    assetClass: "content_bearing",
    facts: { kind: "available", assetClass: "content_bearing", grantedPermissions: IG_PERMISSIONS, linkedAdAccountIds: [], accountIdentityKnown: true, obtainedAt: new Date("2026-11-10T00:00:00Z") },
    observations: [],
    evaluatedAt: new Date("2026-11-10T00:00:00Z"),
  });
  const entry = resolveEntry(profile.entries, "reply_public", "post", "organic");
  return effectiveAvailability(entry, "ACTIVE", "reply_public", null).state;
}

// ── No request may reach the network: the global fetch is a tripwire for the whole file ────────────────────────────
let globalFetchCalls = 0;
beforeEach(() => {
  globalFetchCalls = 0;
  vi.stubGlobal("fetch", () => {
    globalFetchCalls += 1;
    return Promise.reject(new Error("network forbidden in tests"));
  });
});
afterEach(() => {
  expect(globalFetchCalls).toBe(0);
  vi.unstubAllGlobals();
});

type Answer = { readonly status: number; readonly body: unknown } | { readonly throws: Error } | { readonly hang: true };

interface Post {
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly statusAtPost: string;
}

interface Setup {
  readonly guards?: Partial<GuardState>;
  readonly target?: Parameters<typeof replyTarget>[0];
  readonly rows?: readonly SwitchRowInput[];
  readonly answer?: Answer;
  readonly credential?: "ok" | "unreadable";
}

/** One harness: in-memory stores, the composed selection, the real Meta port + write transport over a fake fetch. */
function harness(setup: Setup = {}) {
  const stores: MemoryStores = memoryStores(guardState({ account: IG_ACCOUNT_GUARD, ...setup.guards }), [replyTarget({ ...IG_TARGET, ...setup.target })]);
  const rows: SwitchRowInput[] = [...(setup.rows ?? [GRANT_IG])];
  const asked: string[] = [];
  const guards = stores.guards as { providerActionAllowed: (platform: string, action: "public_reply") => Promise<ProviderActionDecision> };
  guards.providerActionAllowed = (platform, action) => {
    asked.push(`${platform}:${action}`);
    stores.calls.push(`switch:${platform}:${action}`);
    return Promise.resolve(decide(rows, platform, action));
  };
  const clock = fixedClock();
  const posts: Post[] = [];
  const answer = setup.answer ?? { status: 200, body: { id: CREATED } };
  const intentKey = (): string => [...stores.intentRows.keys()][0] ?? "";
  const fetch: MetaGraphFetch = (url, init) => {
    posts.push({ url, method: String(init.method), body: typeof init.body === "string" ? init.body : "", statusAtPost: stores.intentRows.get(intentKey())?.status ?? "missing" });
    stores.calls.push("provider:POST");
    if ("throws" in answer) return Promise.reject(answer.throws);
    if ("hang" in answer) {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error("aborted"));
        });
      });
    }
    return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } }));
  };
  const instagram: ProviderMutationPort = createMetaMutationPort({ transport: createMetaGraphWriteTransport({ fetch, timeoutMs: 40 }), clock: () => new Date("2026-11-10T20:00:00Z") });
  const opened: string[] = [];
  const access: ProviderAccess = { credential: providerCredential("cred-ig-7b13a", TOKEN), account: providerObjectRef("instagram", "asset", IG_ACCOUNT) };
  const deps: ExecutorDependencies = {
    inScope: (work) => work(stores),
    credentials: {
      withAccess: (input, use) => {
        if (setup.credential === "unreadable") return Promise.reject(new CredentialUnreadable());
        opened.push(input.connectedAccountId);
        stores.calls.push("credential:open");
        return use(access, { credentialId: "cred-1" });
      },
    },
    providers: selectMutationPorts({ simulator: undefined, instagram }),
    clock,
  };
  const request = (key = "form-7b13a-0001") => requestPublicReply(stores, clock, { organizationId: ORGANIZATION, workspaceId: WORKSPACE, userId: USER, correlationId: CORRELATION }, { targetInteractionId: TARGET, text: TEXT, idempotencyKey: key });
  /** An intent that is already PENDING (e.g. queued before a change), seeded the way the request side writes it. */
  const seed = (overrides: Partial<MutationIntent> = {}): MutationIntent => {
    const intent = pendingIntent(clock, overrides);
    stores.intentRows.set(`${intent.workspaceId}:${intent.id}`, intent);
    stores.replyRows.set(`${WORKSPACE}:${intent.id}`, { id: clock.newId(), organizationId: ORGANIZATION, workspaceId: WORKSPACE, intentId: intent.id, parentInteractionId: TARGET, connectedAccountId: ACCOUNT, platform: "instagram", text: TEXT, providerReplyId: null, confirmedAt: null, createdAt: clock.now() });
    stores.history.push({ intentId: intent.id, from: null, to: "PENDING", attempt: 0, actor: "web", code: null, runReference: null });
    return intent;
  };
  const execute = (intentId: string, runReference = RUN) => executeIntent(deps, { workspaceId: WORKSPACE, intentId, runReference });
  return { stores, rows, asked, posts, opened, request, seed, execute };
}

async function requested(h: ReturnType<typeof harness>): Promise<MutationIntent> {
  const created = await h.request();
  if (created.kind !== "created") throw new Error(`unexpected ${created.kind}`);
  return created.intent;
}

/** Nothing of the token in anything the executor kept or returned. */
function expectNoToken(h: ReturnType<typeof harness>, ...values: unknown[]): void {
  const kept = JSON.stringify([...h.stores.intentRows.values(), ...h.stores.replyRows.values(), h.stores.history, h.stores.events, values]);
  expect(kept).not.toContain(TOKEN);
  expect(kept).not.toContain("EAAB");
  for (const post of h.posts) expect(post.url).not.toContain(TOKEN);
}

describe("Step 7B-13A · the integration plane's port selection", () => {
  const sentinel = { provider: "meta" } as unknown as ProviderMutationPort;
  const simulator = { provider: "simulator" } as unknown as ProviderMutationPort;

  it("serves Meta's port for exactly provider meta + platform instagram; Facebook, TikTok and unknown pairs get none", () => {
    const providers = selectMutationPorts({ simulator, instagram: sentinel });
    expect(providers.mutation("meta", "instagram")).toBe(sentinel);
    for (const [provider, platform] of [["meta", "facebook"], ["meta", "tiktok"], ["meta", "Instagram"], ["meta", ""], ["tiktok", "tiktok"], ["tiktok", "instagram"], ["instagram", "instagram"], ["unknown", "instagram"]] as const) {
      expect(providers.mutation(provider, platform), `${provider}/${platform}`).toBeUndefined();
    }
    expect(providers.mutation("simulator", "facebook")).toBe(simulator);
    expect(selectMutationPorts({ simulator: undefined, instagram: undefined }).mutation("meta", "instagram")).toBeUndefined();
  });

  it("the composed integration plane builds the Meta Instagram port (no request is made); the staging stub composes none", () => {
    const local = composeMutationProviders({ NODE_ENV: "test", LOCAL_KEYRING_KEY: Buffer.alloc(32, 7).toString("base64url") });
    expect(local.providers.mutation("meta", "instagram")?.provider).toBe("meta");
    expect(local.providers.mutation("meta", "facebook")).toBeUndefined();
    expect(local.providers.mutation("tiktok", "tiktok")).toBeUndefined();
    const staged = composeMutationProviders({ NODE_ENV: "production", CAPABILITY_PROVIDER_MODE: "staging_stub", APP_DEPLOYMENT_ENV: "staging" });
    expect(staged.providers.mutation("meta", "instagram")).toBeUndefined();
    expect(staged.providers.mutation("meta", "facebook")).toBeUndefined();
  });
});

describe("A · Instagram, every guard valid, an exact local grant and a simulated AVAILABLE capability", () => {
  it("one intent → one EXECUTING → exactly ONE POST (EXECUTING already committed) → a receipt with the reply id → CONFIRMED", async () => {
    const h = harness();
    const intent = await requested(h);
    expect(h.stores.intentRows.size).toBe(1);
    const result = await h.execute(intent.id);
    expect(result).toEqual({ kind: "confirmed", providerReplyId: CREATED });
    expect(statusesOf(h.stores)).toEqual(["PENDING", "EXECUTING", "CONFIRMED"]);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.method).toBe("POST");
    expect(h.posts[0]?.url).toMatch(new RegExp(`^https://graph\\.facebook\\.com/v\\d+\\.\\d+/${COMMENT}/replies$`));
    expect(h.posts[0]?.statusAtPost).toBe("EXECUTING");
    expect(new URLSearchParams(h.posts[0]?.body).get("message")).toBe(TEXT);
    expect(h.stores.replyRows.get(`${WORKSPACE}:${intent.id}`)?.providerReplyId).toBe(CREATED);
    // The authorization was asked for the exact pair, at the request AND again before the credential opened.
    expect(h.asked).toEqual(["instagram:public_reply", "instagram:public_reply"]);
    const calls = h.stores.calls;
    expect(calls.lastIndexOf("switch:instagram:public_reply")).toBeLessThan(calls.indexOf("credential:open"));
    expect(calls.indexOf("credential:open")).toBeLessThan(calls.indexOf("provider:POST"));
    expect(h.opened).toEqual([ACCOUNT]);
    expectNoToken(h, result);
  });
});

describe("B · a timeout after the POST started", () => {
  it.each<[string, Answer]>([
    ["the transport's own timeout (no response)", { hang: true }],
    ["a timeout error from the network layer", { throws: Object.assign(new Error("timeout"), { name: "TimeoutError" }) }],
    ["a network failure (no HTTP response is not a definite failure)", { throws: new TypeError("fetch failed") }],
  ])("%s → OUTCOME_UNKNOWN; no second POST, no retry, nothing thrown for a runtime to retry", async (_label, answer) => {
    const h = harness({ answer });
    const intent = await requested(h);
    const result = await h.execute(intent.id);
    expect(result.kind).toBe("outcome_unknown");
    expect(h.posts).toHaveLength(1);
    expect(statusesOf(h.stores)).toEqual(["PENDING", "EXECUTING", "OUTCOME_UNKNOWN"]);
    expect(h.stores.replyRows.get(`${WORKSPACE}:${intent.id}`)?.providerReplyId).toBeNull();
    expect(await h.execute(intent.id, "run_7b13a_redelivered")).toEqual({ kind: "noop", status: "OUTCOME_UNKNOWN" });
    expect(h.posts).toHaveLength(1);
    expectNoToken(h, result);
  });
});

describe("C · redelivery of the same intent never publishes twice", () => {
  it("after CONFIRMED a redelivered run is a no-op: still exactly one POST", async () => {
    const h = harness();
    const intent = await requested(h);
    await h.execute(intent.id);
    expect(await h.execute(intent.id, "run_7b13a_again")).toEqual({ kind: "noop", status: "CONFIRMED" });
    expect(h.posts).toHaveLength(1);
  });

  it("a run that died after EXECUTING committed is OUTCOME_UNKNOWN on redelivery: zero POST, no credential", async () => {
    const h = harness();
    const intent = h.seed({ status: "EXECUTING", attempt: 1, runReference: "run_crashed" });
    expect(await h.execute(intent.id, "run_7b13a_redelivered")).toEqual({ kind: "outcome_unknown", code: "RUN_INTERRUPTED" });
    expect(h.posts).toHaveLength(0);
    expect(h.opened).toEqual([]);
  });

  it("the same idempotency key answers the existing intent: one intent, one POST", async () => {
    const h = harness();
    const first = await requested(h);
    expect(await h.request()).toMatchObject({ kind: "existing", intent: { id: first.id } });
    expect(h.stores.intentRows.size).toBe(1);
    await h.execute(first.id);
    expect(h.posts).toHaveLength(1);
  });
});

describe("D · authorization revoked before execution", () => {
  it.each<[string, (rows: SwitchRowInput[]) => void, ProviderActionDecision]>([
    ["the exact grant cleared", (rows) => rows.splice(0, rows.length), "not_enabled"],
    ["the grant set to enabled:false", (rows) => rows.splice(0, rows.length, row("instagram:public_reply", false)), "paused"],
    ["the emergency block set (grant kept)", (rows) => rows.push(EMERGENCY), "paused"],
    ["a wildcard grant instead of the exact one (never grants)", (rows) => rows.splice(0, rows.length, row("*", true)), "paused"],
  ])("%s → BLOCKED PROVIDER_ACTIONS_DISABLED, no credential, zero POST", async (_label, revoke, decision) => {
    const h = harness();
    const intent = await requested(h);
    revoke(h.rows);
    expect(decide(h.rows, "instagram", "public_reply")).toBe(decision);
    expect(await h.execute(intent.id)).toEqual({ kind: "blocked", code: "PROVIDER_ACTIONS_DISABLED" });
    expect(h.opened).toEqual([]);
    expect(h.posts).toHaveLength(0);
  });
});

describe("E · Facebook and TikTok have no write path", () => {
  it("a Meta Facebook account, even with an exact facebook:public_reply grant and an AVAILABLE capability, gets no port: BLOCKED before any credential, zero POST", async () => {
    const h = harness({
      guards: { account: { ...IG_ACCOUNT_GUARD, platform: "facebook", providerAssetId: "fb_page_7b13a" } },
      target: { platform: "facebook", providerInteractionId: "123_456", providerAssetId: "fb_page_7b13a" },
      rows: [GRANT_FB],
    });
    const intent = h.seed();
    expect(await h.execute(intent.id)).toEqual({ kind: "blocked", code: "PROVIDER_MUTATION_UNSUPPORTED" });
    expect(h.asked).toEqual(["facebook:public_reply"]);
    expect(h.opened).toEqual([]);
    expect(h.posts).toHaveLength(0);
  });

  it("a TikTok account gets no port either: BLOCKED, zero POST", async () => {
    const h = harness({
      guards: { account: { ...IG_ACCOUNT_GUARD, platform: "tiktok", provider: "tiktok", providerAssetId: "tt_7b13a" } },
      target: { platform: "tiktok", providerInteractionId: "tt_c_1", providerAssetId: "tt_7b13a" },
      rows: [row("tiktok:public_reply", true)],
    });
    const intent = h.seed();
    expect(await h.execute(intent.id)).toEqual({ kind: "blocked", code: "PROVIDER_MUTATION_UNSUPPORTED" });
    expect(h.opened).toEqual([]);
    expect(h.posts).toHaveLength(0);
  });

  it("an Instagram account answering a Facebook target is refused by the port before any request", async () => {
    const h = harness({ target: { platform: "facebook", providerInteractionId: "123_456" } });
    const intent = h.seed();
    expect(await h.execute(intent.id)).toEqual({ kind: "failed", code: "TARGET_NOT_ELIGIBLE" });
    expect(h.posts).toHaveLength(0);
  });
});

describe("F · wrong tenant, target or account; role, mode, credential and connection", () => {
  it.each<[string, Setup, string]>([
    ["a target owned by another account", { target: { connectedAccountId: "8b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d" } }, "TARGET_ACCOUNT_MISMATCH"],
    ["a target in another workspace", { target: { workspaceId: OTHER_WORKSPACE } }, "TARGET_ACCOUNT_MISMATCH"],
    ["a role without reply.public", { guards: { role: "ANALYST_VIEWER" } }, "PERMISSION_DENIED"],
    ["the initiator is no longer a member", { guards: { role: undefined } }, "INITIATOR_NOT_MEMBER"],
    ["a Monitor-only workspace", { guards: { mode: "MONITOR_ONLY" } }, "MODE_NOT_STANDARD"],
    ["an inactive account", { guards: { account: { ...IG_ACCOUNT_GUARD, status: "INACTIVE" } } }, "ACCOUNT_INACTIVE"],
    ["an inactive connection", { guards: { account: { ...IG_ACCOUNT_GUARD, connectionStatus: "REAUTH_REQUIRED" } } }, "CONNECTION_UNAVAILABLE"],
    ["no active credential", { guards: { account: { ...IG_ACCOUNT_GUARD, credentialId: null } } }, "CONNECTION_UNAVAILABLE"],
    ["an unreadable credential (opened before any request)", { credential: "unreadable" }, "CREDENTIAL_UNREADABLE"],
    ["the brand's own comment", { target: { ownAccount: true } }, "TARGET_NOT_PRESENT"],
    ["a hidden comment", { target: { presence: "hidden" } }, "TARGET_NOT_PRESENT"],
  ])("%s → BLOCKED %s… zero POST", async (_label, setup, code) => {
    const h = harness(setup);
    const intent = h.seed();
    expect(await h.execute(intent.id)).toEqual({ kind: "blocked", code });
    expect(h.posts).toHaveLength(0);
    if (code !== "CREDENTIAL_UNREADABLE") expect(h.opened).toEqual([]);
  });

  it("an intent of another workspace is never executed for this one", async () => {
    const h = harness();
    const intent = h.seed({ workspaceId: OTHER_WORKSPACE });
    expect(await h.execute(intent.id)).toEqual({ kind: "noop", status: "missing" });
    expect(h.posts).toHaveLength(0);
  });
});

describe("G · today's Meta catalog: reply_public is not published", () => {
  it("the productive catalog evaluates Instagram reply_public as UNAVAILABLE for the DEV account's real permissions", () => {
    expect(productiveInstagramReplyCapability()).toBe("UNAVAILABLE");
  });

  it("with an exact local grant, the request is refused and a queued intent is BLOCKED CAPABILITY_UNAVAILABLE: zero POST", async () => {
    const h = harness({ guards: { capability: productiveInstagramReplyCapability() } });
    expect(await h.request()).toEqual({ kind: "refused", reason: "CAPABILITY_UNAVAILABLE" });
    expect(h.stores.intentRows.size).toBe(0);
    const intent = h.seed();
    expect(await h.execute(intent.id)).toEqual({ kind: "blocked", code: "CAPABILITY_UNAVAILABLE" });
    expect(h.opened).toEqual([]);
    expect(h.posts).toHaveLength(0);
  });
});

describe("H · today's switches: no grant exists", () => {
  it("with no mutation.provider_action rows the request is refused and a queued intent is BLOCKED PROVIDER_ACTIONS_DISABLED: zero POST", async () => {
    const h = harness({ rows: [] });
    expect(decide([], "instagram", "public_reply")).toBe("not_enabled");
    expect(await h.request()).toEqual({ kind: "refused", reason: "PROVIDER_ACTIONS_DISABLED" });
    expect(h.stores.intentRows.size).toBe(0);
    const intent = h.seed();
    expect(await h.execute(intent.id)).toEqual({ kind: "blocked", code: "PROVIDER_ACTIONS_DISABLED" });
    expect(h.opened).toEqual([]);
    expect(h.posts).toHaveLength(0);
  });

  it("today's DEV state in full — no grant AND the productive catalog — blocks at the authorization first: zero POST", async () => {
    const h = harness({ rows: [], guards: { capability: productiveInstagramReplyCapability() } });
    const intent = h.seed();
    expect(await h.execute(intent.id)).toEqual({ kind: "blocked", code: "PROVIDER_ACTIONS_DISABLED" });
    expect(h.posts).toHaveLength(0);
  });
});

describe("Step 7B-13C (F1) · Instagram replies go to TOP-LEVEL comments only, re-checked by the executor on the persisted target", () => {
  it.each<[string, Parameters<typeof replyTarget>[0]]>([
    ["a nested reply", { kind: "reply", parentProviderInteractionId: "17900000000000700" }],
    ["a reply whose parent is not known here", { kind: "reply", parentProviderInteractionId: null }],
    ["a 'comment' that names a parent (inconsistent data)", { kind: "comment", parentProviderInteractionId: "17900000000000700" }],
    ["an unknown kind", { kind: "unknown", parentProviderInteractionId: null }],
  ])("%s, queued without the request side (e.g. a hand-made request or an old deployment) → BLOCKED TARGET_NOT_REPLYABLE: no credential, zero POST — and a redelivery stays blocked", async (_label, target) => {
    const h = harness({ target });
    expect(await h.request()).toEqual({ kind: "refused", reason: "TARGET_NOT_REPLYABLE" });
    const intent = h.seed();
    expect(await h.execute(intent.id)).toEqual({ kind: "blocked", code: "TARGET_NOT_REPLYABLE" });
    expect(await h.execute(intent.id, "run_7b13c_redelivered")).toEqual({ kind: "noop", status: "BLOCKED" });
    expect(statusesOf(h.stores)).toEqual(["PENDING", "BLOCKED"]);
    expect(h.opened).toEqual([]);
    expect(h.posts).toHaveLength(0);
  });

  it("a top-level Instagram comment is eligible: with every other guard passing, ONE POST and CONFIRMED", async () => {
    const h = harness({ target: { kind: "comment", parentProviderInteractionId: null } });
    const intent = await requested(h);
    expect(await h.execute(intent.id)).toEqual({ kind: "confirmed", providerReplyId: CREATED });
    expect(h.posts).toHaveLength(1);
  });
});

describe("errors keep the conservative mapping through the composition", () => {
  it.each<[string, Answer, { readonly kind: string; readonly code?: string }]>([
    ["HTTP 400 + code 10 (permission) → FAILED PERMISSION_MISSING", { status: 400, body: { error: { message: "x", type: "OAuthException", code: 10, is_transient: false } } }, { kind: "failed", code: "PERMISSION_MISSING" }],
    ["HTTP 400 + code 190 (token) → FAILED CREDENTIAL_INVALID", { status: 400, body: { error: { message: "x", type: "OAuthException", code: 190, is_transient: false } } }, { kind: "failed", code: "CREDENTIAL_INVALID" }],
    ["HTTP 500 + code 1 → OUTCOME_UNKNOWN (never FAILED)", { status: 500, body: { error: { message: "x", type: "OAuthException", code: 1, is_transient: false } } }, { kind: "outcome_unknown" }],
    ["HTTP 400 + an unlisted code → OUTCOME_UNKNOWN", { status: 400, body: { error: { message: "x", type: "OAuthException", code: 9999, is_transient: false } } }, { kind: "outcome_unknown" }],
    ["HTTP 400 + is_transient true → OUTCOME_UNKNOWN", { status: 400, body: { error: { message: "x", type: "OAuthException", code: 10, is_transient: true } } }, { kind: "outcome_unknown" }],
    ["HTTP 200 without an id → OUTCOME_UNKNOWN", { status: 200, body: { success: true } }, { kind: "outcome_unknown" }],
  ])("%s; exactly one POST, never retried", async (_label, answer, expected) => {
    const h = harness({ answer });
    const intent = await requested(h);
    const result = await h.execute(intent.id);
    expect(result).toMatchObject(expected);
    expect(h.posts).toHaveLength(1);
    expect((await h.execute(intent.id, "run_7b13a_again")).kind).toBe("noop");
    expect(h.posts).toHaveLength(1);
    expectNoToken(h, result);
  });
});
