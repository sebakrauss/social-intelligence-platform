/**
 * The INTEGRATION Instagram reply preflight/observe diagnostic (Step 7B-14C1; jobs/integration-instagram-reply-
 * preflight.ts), offline. The guards run on synthetic environments; the provider path runs the REAL read-only preflight
 * reader and Graph read transport against an in-process `fetch` double (every request recorded), with a synthetic
 * credential lent by a fake credential access and a fake read-only lookup — no database, AWS or network. Synthetic ids,
 * texts, usernames and tokens only; outcomes and errors are checked for every one of them.
 */
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { CredentialUnreadableError, type ProviderCredentialAccess } from "@/modules/connections";
import { providerCredential, type ProviderObjectId } from "@/integrations/providers/contract";
import { META_INSTAGRAM_COMMENT_FIELDS, META_INSTAGRAM_MEDIA_FIELDS, META_INSTAGRAM_REPLY_FIELDS, createMetaGraphTransport, type MetaGraphFetch } from "@/integrations/providers/meta/graph-transport";
import { createInstagramReplyPreflight } from "@/integrations/providers/meta/instagram-reply-preflight";
import type { JobRelease } from "@/platform/jobs";
import {
  INSTAGRAM_REPLY_PREFLIGHT_ACKNOWLEDGEMENT,
  INSTAGRAM_REPLY_PREFLIGHT_AWS_ATTEMPTS,
  INSTAGRAM_REPLY_PREFLIGHT_FAILURES,
  INSTAGRAM_REPLY_PREFLIGHT_TASK_ID,
  InstagramReplyPreflightError,
  classifyPreflightTarget,
  runInstagramReplyPreflight,
  type InstagramReplyPreflightDependencies,
  type InstagramReplyPreflightFailure,
  type InstagramReplyPreflightInput,
  type InstagramReplyPreflightLookupResult,
} from "@/jobs/integration-instagram-reply-preflight";

// ── Trigger.dev SDK double: captures the task definition (no vendor runtime in unit tests) ───────────────────────
const sdk = vi.hoisted(() => {
  class AbortTaskRunError extends Error {
    override readonly name = "AbortTaskRunError";
  }
  const tasks: Record<string, unknown>[] = [];
  const scheduled: unknown[] = [];
  return {
    AbortTaskRunError,
    tasks,
    scheduled,
    task: (options: Record<string, unknown>) => {
      tasks.push(options);
      return { id: options["id"] };
    },
    queue: (options: Record<string, unknown>) => ({ type: "queue", ...options }),
    schedules: { task: (options: unknown) => scheduled.push(options) },
  };
});
vi.mock("@trigger.dev/sdk", () => sdk);

const WORKSPACE = "5eed0000-d1a9-4000-8000-00000000f201";
const OTHER_WORKSPACE = "5eed0000-d1a9-4000-8000-00000000f299";
const ACCOUNT = "5eed0000-d1a9-4000-8000-00000000f202";
const CONNECTION = "5eed0000-d1a9-4000-8000-00000000f203";
const CREDENTIAL_ID = "5eed0000-d1a9-4000-8000-00000000f204";
const TARGET_ID = "5eed0000-d1a9-4000-8000-00000000f205";
const IG = "17840000000000061";
const MEDIA = "17900000000000061";
const COMMENT = "17950000000000061";
const COMMENTER = "17960000000000061";
const PAGE = "880000000000061";
const MANAGED_HANDLE = "synthetic_managed_handle_marker";
const COMMENTER_HANDLE = "synthetic_commenter_handle_marker";
const TEXT = "Synthetic comment text that must never be output";
const USER_TOKEN = "synthetic-preflight-user-token-marker";
const BODY_MARKER = "synthetic-graph-body-marker";
const KEY_A = "arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-0000000000aa";
const PINNED: JobRelease = { kind: "pinned", releaseId: "synthetic-release-0000000000000000000000" };
const RUN = { environmentType: "PRODUCTION", release: PINNED } as const;
const PAYLOAD = { acknowledge: INSTAGRAM_REPLY_PREFLIGHT_ACKNOWLEDGEMENT, mode: "preflight", workspace_id: WORKSPACE, connected_account_id: ACCOUNT, target_interaction_id: TARGET_ID };
const FORBIDDEN_IN_OUTPUT = [IG, MEDIA, COMMENT, COMMENTER, PAGE, MANAGED_HANDLE, COMMENTER_HANDLE, TEXT, USER_TOKEN, BODY_MARKER, WORKSPACE, ACCOUNT, CONNECTION, CREDENTIAL_ID, TARGET_ID, "graph.facebook.com", "access_token", "arn:aws"];

type Env = Record<string, string | undefined>;
const DEPLOYED: Env = { NODE_ENV: "production", APP_DEPLOYMENT_ENV: "staging", CREDENTIAL_CONTEXT_ENV: "dev", CREDENTIAL_KMS_KEY_ARN: KEY_A, CREDENTIAL_KMS_ALLOWED_KEY_ARNS: KEY_A };

const FOUND: InstagramReplyPreflightLookupResult = {
  kind: "found",
  target: { instagramAccountId: IG as ProviderObjectId, commentId: COMMENT as ProviderObjectId, mediaId: MEDIA as ProviderObjectId },
  stored: { kind: "comment", topLevel: true, observed: true, visibility: "visible", removedAtSource: false, ownAuthor: false },
  credentialId: CREDENTIAL_ID,
  envelope: new Uint8Array([1, 2, 3]),
};

const json = (status: number, body: unknown): Promise<Response> => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const node = { id: COMMENT, from: { id: COMMENTER, username: COMMENTER_HANDLE }, text: TEXT, timestamp: "2026-10-27T23:19:52+0000", hidden: false, media: { id: MEDIA } };

/** An eligible Graph world over the REAL read transport; every request recorded with its method and body presence. */
function graphWorld() {
  const calls: { readonly method: string; readonly path: string; readonly body: boolean }[] = [];
  const fetch: MetaGraphFetch = (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname.split("/").slice(2).map(decodeURIComponent).join("/");
    const fields = parsed.searchParams.get("fields");
    calls.push({ method: init.method ?? "GET", path, body: init.body !== undefined && init.body !== null });
    if (path === "me/permissions") return json(200, { data: ["instagram_basic", "instagram_manage_comments", "pages_read_engagement", "pages_show_list"].map((permission) => ({ permission, status: "granted" })) });
    if (path === "me/accounts") return json(200, { data: [{ id: PAGE, name: "n" }] });
    if (path === PAGE) return json(200, { id: PAGE, instagram_business_account: { id: IG } });
    if (path === IG && fields === "id,username") return json(200, { id: IG, username: MANAGED_HANDLE });
    if (path === COMMENT && fields === META_INSTAGRAM_COMMENT_FIELDS) return json(200, node);
    if (path === MEDIA && fields === META_INSTAGRAM_MEDIA_FIELDS) return json(200, { id: MEDIA, media_type: "IMAGE", media_product_type: "FEED", timestamp: "2026-10-27T20:00:00+0000", owner: { id: IG } });
    if (path === `${MEDIA}/comments`) return json(200, { data: [node] });
    if (path === `${COMMENT}/replies` && fields === META_INSTAGRAM_REPLY_FIELDS) return json(200, { data: [] });
    return json(400, { error: { code: 100, message: BODY_MARKER } });
  };
  return { calls, preflight: createInstagramReplyPreflight({ transport: createMetaGraphTransport({ fetch }) }) };
}

function harness(options: { readonly lookup?: InstagramReplyPreflightLookupResult; readonly failOpen?: Error; readonly lookupThrows?: boolean; readonly deps?: Partial<InstagramReplyPreflightDependencies> } = {}) {
  const graph = graphWorld();
  const openings: string[] = [];
  const lookups: InstagramReplyPreflightInput[] = [];
  const composed: Env[] = [];
  const access: ProviderCredentialAccess = {
    withCredential: (input, use) => {
      if (options.failOpen !== undefined) return Promise.reject(options.failOpen);
      openings.push(input.credentialId);
      return use(providerCredential("synthetic-preflight-credential", USER_TOKEN));
    },
  };
  const deps: Partial<InstagramReplyPreflightDependencies> = {
    nodeVersion: "v22.16.0",
    lookup: (input) => {
      lookups.push(input);
      return options.lookupThrows === true ? Promise.reject(new Error(BODY_MARKER)) : Promise.resolve(options.lookup ?? FOUND);
    },
    compose: (environment) => {
      composed.push({ ...environment });
      return { access, preflight: graph.preflight };
    },
    ...options.deps,
  };
  return { graph, openings, lookups, composed, run: (payload: unknown = PAYLOAD, env: Env = DEPLOYED, run: { environmentType: string | undefined; release: JobRelease } = RUN) => runInstagramReplyPreflight(payload, run, env, deps) };
}

const rendered = (value: unknown): string => [JSON.stringify(value), inspect(value, { depth: 10, showHidden: true }), String(value)].join(" ");
const expectRedacted = (value: unknown): void => {
  const text = rendered(value);
  for (const forbidden of FORBIDDEN_IN_OUTPUT) expect(text, forbidden).not.toContain(forbidden);
};

async function refused(promise: Promise<unknown>): Promise<InstagramReplyPreflightFailure> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(InstagramReplyPreflightError);
    const failure = (error as InstagramReplyPreflightError).failure;
    expect(INSTAGRAM_REPLY_PREFLIGHT_FAILURES).toContain(failure);
    expectRedacted(error);
    return failure;
  }
  throw new Error("expected the diagnostic to refuse");
}

describe("the diagnostic's identity: a separate operator-only INTEGRATION task", () => {
  it("is integration.instagram_reply_preflight: one attempt, its own queue of one, bounded, no schedule — and thin", async () => {
    await import("@/jobs/trigger/integration/instagram-reply-preflight");
    const definition = sdk.tasks.find((task) => task["id"] === INSTAGRAM_REPLY_PREFLIGHT_TASK_ID);
    expect(definition).toBeDefined();
    expect(definition?.["retry"]).toEqual({ maxAttempts: 1 });
    expect(definition?.["maxDuration"]).toBe(120);
    expect(definition?.["queue"]).toMatchObject({ name: "integration-instagram-reply-preflight", concurrencyLimit: 1 });
    expect(Object.keys(definition ?? {}).sort()).toEqual(["id", "maxDuration", "queue", "retry", "run"]);
    expect(sdk.scheduled).toEqual([]);
    expect(INSTAGRAM_REPLY_PREFLIGHT_AWS_ATTEMPTS).toEqual({ maxAttempts: 1 });
  });

  it("the task aborts with the fixed code of a refusal (no retry), never a message of its own", async () => {
    await import("@/jobs/trigger/integration/instagram-reply-preflight");
    const definition = sdk.tasks.find((task) => task["id"] === INSTAGRAM_REPLY_PREFLIGHT_TASK_ID);
    const run = definition?.["run"] as (payload: unknown, context: { ctx: unknown }) => Promise<unknown>;
    const ctx = { environment: { type: "DEVELOPMENT" }, deployment: undefined };
    await expect(run({ ...PAYLOAD, acknowledge: "nope" }, { ctx })).rejects.toThrow(new sdk.AbortTaskRunError("instagram_reply_preflight_input_refused"));
    await expect(run(PAYLOAD, { ctx })).rejects.toThrow(new sdk.AbortTaskRunError("instagram_reply_preflight_release_refused"));
  });

  it("F4 (Step 7B-14C3): an UNEXPECTED error carrying sensitive data aborts with the fixed generic code only — its message never leaves", async () => {
    await import("@/jobs/trigger/integration/instagram-reply-preflight");
    const definition = sdk.tasks.find((task) => task["id"] === INSTAGRAM_REPLY_PREFLIGHT_TASK_ID);
    const run = definition?.["run"] as (payload: unknown, context: { ctx: unknown }) => Promise<unknown>;
    const sensitive = `https://graph.facebook.com/v25.0/${COMMENT}/replies?access_token=${USER_TOKEN} ${MANAGED_HANDLE} ${TEXT} ${KEY_A} ${BODY_MARKER}`;
    // The run context itself throws (not an InstagramReplyPreflightError): the task's own catch must not forward it.
    const ctx = {
      get environment(): never {
        throw new Error(sensitive, { cause: new Error(sensitive) });
      },
      deployment: undefined,
    };
    let thrown: unknown;
    try {
      await run(PAYLOAD, { ctx });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(sdk.AbortTaskRunError);
    expect((thrown as Error).message).toBe("instagram_reply_preflight_failed");
    expect((thrown as Error).cause).toBeUndefined();
    expectRedacted(thrown);
    expect(rendered(thrown)).not.toContain(USER_TOKEN);
  });
});

describe("P + guards: every refusal happens before any lookup, composition, credential or provider request", () => {
  type Case = [name: string, failure: InstagramReplyPreflightFailure, change: { payload?: unknown; env?: Env; run?: { environmentType: string | undefined; release: JobRelease }; node?: string }];
  const cases: Case[] = [
    ["no payload", "instagram_reply_preflight_input_refused", { payload: null }],
    ["an array", "instagram_reply_preflight_input_refused", { payload: [PAYLOAD] }],
    ["another diagnostic's acknowledgement", "instagram_reply_preflight_input_refused", { payload: { ...PAYLOAD, acknowledge: "INTEGRATION_READ_INTERACTIONS_VALIDATION_V1" } }],
    ["a missing mode", "instagram_reply_preflight_input_refused", { payload: { acknowledge: PAYLOAD.acknowledge, workspace_id: WORKSPACE, connected_account_id: ACCOUNT, target_interaction_id: TARGET_ID } }],
    ["a write mode", "instagram_reply_preflight_input_refused", { payload: { ...PAYLOAD, mode: "reply" } }],
    ["a missing target", "instagram_reply_preflight_input_refused", { payload: { acknowledge: PAYLOAD.acknowledge, mode: "preflight", workspace_id: WORKSPACE, connected_account_id: ACCOUNT } }],
    ["a Meta comment id as the target", "instagram_reply_preflight_input_refused", { payload: { ...PAYLOAD, target_interaction_id: COMMENT } }],
    ["a Meta account id as the account", "instagram_reply_preflight_input_refused", { payload: { ...PAYLOAD, connected_account_id: IG } }],
    ["an extra field (a Graph path)", "instagram_reply_preflight_input_refused", { payload: { ...PAYLOAD, graph_path: `${COMMENT}/replies` } }],
    ["an extra field (a URL)", "instagram_reply_preflight_input_refused", { payload: { ...PAYLOAD, url: "https://graph.facebook.com/v25.0/me" } }],
    ["an extra field (a provider comment id)", "instagram_reply_preflight_input_refused", { payload: { ...PAYLOAD, comment_id: COMMENT } }],
    ["an extra field (a token)", "instagram_reply_preflight_input_refused", { payload: { ...PAYLOAD, access_token: USER_TOKEN } }],
    ["an extra field (a message)", "instagram_reply_preflight_input_refused", { payload: { ...PAYLOAD, message: TEXT } }],
    ["a local development run", "instagram_reply_preflight_release_refused", { run: { environmentType: "DEVELOPMENT", release: { kind: "development" } } }],
    ["a deployed run without an external id", "instagram_reply_preflight_release_refused", { run: { environmentType: "PRODUCTION", release: { kind: "unidentified" } } }],
    ["the main plane's system database credential", "instagram_reply_preflight_plane_refused", { env: { DATABASE_SYSTEM_URL: "postgres://synthetic" } }],
    ["the Meta app secret", "instagram_reply_preflight_plane_refused", { env: { PROVIDER_META_CLIENT_SECRET: "synthetic" } }],
    ["APP_DEPLOYMENT_ENV=production", "instagram_reply_preflight_tier_refused", { env: { APP_DEPLOYMENT_ENV: "production" } }],
    ["Node 20", "instagram_reply_preflight_runtime_refused", { node: "v20.19.0" }],
    ["the staging stub provider mode", "instagram_reply_preflight_provider_mode_refused", { env: { CAPABILITY_PROVIDER_MODE: "staging_stub" } }],
    ["the local keyring (no KMS)", "instagram_reply_preflight_keyring_refused", { env: { NODE_ENV: "test", CREDENTIAL_CONTEXT_ENV: undefined, CREDENTIAL_KMS_KEY_ARN: undefined, CREDENTIAL_KMS_ALLOWED_KEY_ARNS: undefined } }],
  ];

  it.each(cases)("%s → %s", async (_name, failure, change) => {
    const h = harness(change.node === undefined ? {} : { deps: { nodeVersion: change.node } });
    expect(await refused(h.run("payload" in change ? change.payload : PAYLOAD, { ...DEPLOYED, ...change.env }, change.run ?? RUN))).toBe(failure);
    expect([h.lookups, h.composed, h.graph.calls, h.openings]).toEqual([[], [], [], []]);
  });

  it("a stored refusal or a failing lookup ends the run before composition, credential or provider", async () => {
    for (const failure of ["instagram_reply_preflight_target_not_found", "instagram_reply_preflight_connection_inactive"] as const) {
      const h = harness({ lookup: { kind: "refused", failure } });
      expect(await refused(h.run())).toBe(failure);
      expect([h.composed, h.graph.calls, h.openings]).toEqual([[], [], []]);
    }
    const broken = harness({ lookupThrows: true });
    expect(await refused(broken.run())).toBe("instagram_reply_preflight_failed");
    expect([broken.composed, broken.graph.calls, broken.openings]).toEqual([[], [], []]);
  });
});

describe("the stored target: exact workspace, account, connection, credential and comment — classified before any credential", () => {
  const input: InstagramReplyPreflightInput = { mode: "preflight", workspaceId: WORKSPACE as never, connectedAccountId: ACCOUNT, targetInteractionId: TARGET_ID };
  const account = { id: ACCOUNT, workspaceId: WORKSPACE, status: "ACTIVE", platform: "instagram", assetClass: "content_bearing", providerAssetId: IG, connectionId: CONNECTION } as never;
  const connection = { id: CONNECTION, status: "ACTIVE", provider: "meta", activeCredentialId: CREDENTIAL_ID } as never;
  const credential = { connectionId: CONNECTION, envelope: new Uint8Array([9]) };
  const interaction = {
    id: TARGET_ID, workspaceId: WORKSPACE, connectedAccountId: ACCOUNT, platform: "instagram", providerInteractionId: COMMENT, providerAssetId: IG, providerContentId: MEDIA,
    contentItemId: "5eed0000-d1a9-4000-8000-00000000f206", parentProviderInteractionId: null, kind: "comment" as const, observed: true, visibility: "visible", availability: "available", authorRole: "user",
  };
  const classify = (patch: { account?: object; connection?: object; credential?: object | undefined; interaction?: object | undefined } = {}) =>
    classifyPreflightTarget(
      input,
      "account" in patch ? ({ ...(account as object), ...patch.account } as never) : account,
      "connection" in patch ? ({ ...(connection as object), ...patch.connection } as never) : connection,
      "credential" in patch ? (patch.credential as never) : credential,
      "interaction" in patch ? (patch.interaction === undefined ? undefined : { ...interaction, ...patch.interaction }) : interaction,
    );

  it("the eligible stored comment is found with its stored ids and stored facts", () => {
    expect(classify()).toMatchObject({ kind: "found", target: { instagramAccountId: IG, commentId: COMMENT, mediaId: MEDIA }, stored: { kind: "comment", topLevel: true, observed: true, visibility: "visible", removedAtSource: false, ownAuthor: false }, credentialId: CREDENTIAL_ID });
    expect(classify({ interaction: { authorRole: "account_identity", visibility: "hidden" } })).toMatchObject({ kind: "found", stored: { ownAuthor: true, visibility: "hidden" } });
  });

  it.each([
    ["M. an account of another workspace", { account: { workspaceId: OTHER_WORKSPACE } }, "instagram_reply_preflight_account_not_found"],
    ["M. a target absent from this workspace (RLS / other workspace)", { interaction: undefined }, "instagram_reply_preflight_target_not_found"],
    ["M. a target row naming another workspace", { interaction: { workspaceId: OTHER_WORKSPACE } }, "instagram_reply_preflight_target_not_found"],
    ["an inactive account", { account: { status: "INACTIVE" } }, "instagram_reply_preflight_account_inactive"],
    ["a Facebook Page", { account: { platform: "facebook" } }, "instagram_reply_preflight_account_not_meta_instagram"],
    ["an ad account", { account: { assetClass: "ad_account" } }, "instagram_reply_preflight_account_not_meta_instagram"],
    ["another provider", { connection: { provider: "simulator" } }, "instagram_reply_preflight_account_not_meta_instagram"],
    ["N. a DEGRADED connection", { connection: { status: "DEGRADED" } }, "instagram_reply_preflight_connection_inactive"],
    ["N. a REMOVED connection", { connection: { status: "REMOVED" } }, "instagram_reply_preflight_account_not_found"],
    ["no active credential", { connection: { activeCredentialId: null } }, "instagram_reply_preflight_credential_missing"],
    ["a credential of another connection", { credential: { connectionId: "other", envelope: new Uint8Array([9]) } }, "instagram_reply_preflight_credential_missing"],
    ["D. a comment of another account", { interaction: { connectedAccountId: "5eed0000-d1a9-4000-8000-00000000f2ff" } }, "instagram_reply_preflight_target_account_mismatch"],
    ["D. a comment under another Instagram asset", { interaction: { providerAssetId: "17840000000000069" } }, "instagram_reply_preflight_target_account_mismatch"],
    ["a Facebook interaction", { interaction: { platform: "facebook" } }, "instagram_reply_preflight_target_account_mismatch"],
    ["G. a stored reply", { interaction: { kind: "reply", parentProviderInteractionId: "17950000000000069" } }, "instagram_reply_preflight_target_not_top_level_comment"],
    ["G. a comment with a stored parent", { interaction: { parentProviderInteractionId: "17950000000000069" } }, "instagram_reply_preflight_target_not_top_level_comment"],
    ["an unknown kind", { interaction: { kind: "unknown" } }, "instagram_reply_preflight_target_not_top_level_comment"],
    ["a target never observed", { interaction: { observed: false } }, "instagram_reply_preflight_target_not_observed"],
    ["a malformed stored provider id", { interaction: { providerInteractionId: "not a provider id/../x" } }, "instagram_reply_preflight_target_identity_invalid"],
  ] as const)("%s → %s", (_name, patch, failure) => {
    expect(classify(patch as never)).toEqual({ kind: "refused", failure });
  });
});

describe("the run: ONE credential opening, the reader's GETs inside it, stored and observed facts reported apart", () => {
  it("preflight: VERIFIED, 8 GETs, all GET without a body; the credential opened once for the stored credential id", async () => {
    const h = harness();
    const outcome = await h.run();
    expect(outcome.status).toBe("VERIFIED");
    expect(outcome.mode).toBe("preflight");
    expect(Object.keys(outcome).sort()).toEqual(["accountKind", "mode", "observed", "platform", "status", "stored"]);
    expect(outcome.stored).toEqual({ kind: "comment", topLevel: true, observed: true, visibility: "visible", removedAtSource: false, ownAuthor: false });
    expect(h.openings).toEqual([CREDENTIAL_ID]);
    expect(h.lookups).toEqual([{ mode: "preflight", workspaceId: WORKSPACE, connectedAccountId: ACCOUNT, targetInteractionId: TARGET_ID }]);
    expect(h.composed).toHaveLength(1);
    expect(h.graph.calls).toHaveLength(8);
    for (const call of h.graph.calls) expect([call.method, call.body]).toEqual(["GET", false]);
    expect(outcome.observed.tokenTypeForReplyPost).toBe("NOT_VERIFIED");
    expect(outcome.observed.limitations).toContain("TOKEN_TYPE_FOR_REPLY_POST_NOT_VERIFIED");
    expectRedacted(outcome);
  });

  it("R. observe: 3 GETs only (account, comment, replies), no write of any kind is reachable, the same single opening", async () => {
    const h = harness();
    const outcome = await h.run({ ...PAYLOAD, mode: "observe" });
    expect(outcome.mode).toBe("observe");
    expect(h.graph.calls.map((call) => call.path)).toEqual([IG, COMMENT, `${COMMENT}/replies`]);
    for (const call of h.graph.calls) expect([call.method, call.body]).toEqual(["GET", false]);
    expect(h.openings).toEqual([CREDENTIAL_ID]);
    // The only dependencies are a read-only lookup, the composition and the reader: nothing here can write.
    expect(outcome.observed.replies).toMatchObject({ listed: 0, complete: true, byManagedAccount: 0 });
    expectRedacted(outcome);
  });

  it.each([
    ["an unreadable envelope", new CredentialUnreadableError(), "instagram_reply_preflight_credential_unreadable"],
    ["an unexpected failure before opening", new Error(BODY_MARKER), "instagram_reply_preflight_failed"],
  ] as const)("%s → %s, and no provider request", async (_name, error, failure) => {
    const h = harness({ failOpen: error });
    expect(await refused(h.run())).toBe(failure);
    expect(h.graph.calls).toEqual([]);
  });
});
