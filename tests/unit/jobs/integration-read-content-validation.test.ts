/**
 * The INTEGRATION read_content validation diagnostic (Step 7G-H5.5-P5-B; jobs/integration-read-content-validation.ts),
 * offline. The guards run on synthetic environments; the provider path runs the REAL Meta read port and Graph
 * transport against an in-process `fetch` double (every Meta GET counted), with a synthetic credential lent by a
 * fake credential access and a fake read-only lookup — no database, AWS or network. Synthetic ids, texts and tokens
 * only; the output is checked for every one of them.
 *
 * Threat model: NOT_IN_NORMAL_PRODUCT_REGISTRY != NOT_TRIGGERABLE_BY_TRIGGER. Anyone with enough Integration project
 * privileges may trigger the task by id, so every precondition must fail before anything provider- or AWS-capable is
 * built, and the output must be safe to show an operator.
 */
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { ConnectedAccount, Connection, ProviderCredentialAccess } from "@/modules/connections";
import { CredentialUnreadableError } from "@/modules/connections";
import { CONTENT_KINDS, providerCredential, type ProviderReadPort } from "@/integrations/providers/contract";
import { META_POST_FIELDS, createMetaGraphTransport, type MetaGraphFetch } from "@/integrations/providers/meta/graph-transport";
import { createMetaReadPort } from "@/integrations/providers/meta/read-port";
import { CredentialCryptoError } from "@/platform/crypto/credentials/errors";
import { NonRetryableJobError, type JobRelease } from "@/platform/jobs";
import { readContentValidationLookup } from "@/server/persistence/connections";
import type { DatabaseTransaction } from "@/platform/db";
import {
  READ_CONTENT_VALIDATION_ACKNOWLEDGEMENT,
  READ_CONTENT_VALIDATION_AWS_ATTEMPTS,
  READ_CONTENT_VALIDATION_FAILURES,
  READ_CONTENT_VALIDATION_META_REQUESTS,
  READ_CONTENT_VALIDATION_TASK_ID,
  ReadContentValidationError,
  classifyTarget,
  runReadContentValidation,
  type ReadContentValidationDependencies,
  type ReadContentValidationFailure,
  type ReadContentValidationOutcome,
  type ReadContentValidationTarget,
} from "@/jobs/integration-read-content-validation";

// ── Trigger.dev SDK double: captures the task definition (no vendor runtime in unit tests) ───────────────────────
const sdk = vi.hoisted(() => {
  class AbortTaskRunError extends Error {
    override readonly name = "AbortTaskRunError";
  }
  const tasks: Record<string, unknown>[] = [];
  const queues: Record<string, unknown>[] = [];
  const scheduled: unknown[] = [];
  return {
    AbortTaskRunError,
    tasks,
    queues,
    scheduled,
    task: (options: Record<string, unknown>) => {
      tasks.push(options);
      return { id: options["id"] };
    },
    queue: (options: Record<string, unknown>) => {
      queues.push(options);
      return { type: "queue", ...options };
    },
    schedules: { task: (options: unknown) => scheduled.push(options) },
  };
});
vi.mock("@trigger.dev/sdk", () => sdk);

const WORKSPACE = "5eed0000-d1a9-4000-8000-00000000f001";
const ACCOUNT = "5eed0000-d1a9-4000-8000-00000000f002";
const CREDENTIAL_ID = "5eed0000-d1a9-4000-8000-00000000f003";
const CONNECTION_ID = "5eed0000-d1a9-4000-8000-00000000f004";
const PAGE = "880000000000001";
const OTHER_PAGE = "880000000000002";
const POST_A = `${PAGE}_990000000000001`;
const POST_B = `${PAGE}_990000000000002`;
const USER_TOKEN = "synthetic-diagnostic-user-token-marker";
const PAGE_TOKEN = "synthetic-diagnostic-page-token-marker";
const CAPTION = "Synthetic caption marker that must never be output";
const NAME = "Synthetic Page Name Marker";
const CURSOR = "QVFIUnN5bnRoZXRpY0N1cnNvck1hcmtlcg";
const BODY_MARKER = "synthetic-graph-body-marker";
const NOW = new Date("2026-10-22T12:00:00.000Z");
const KEY_A = "arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-0000000000aa";
const PINNED: JobRelease = { kind: "pinned", releaseId: "synthetic-release-0000000000000000000000" };
const RUN: { readonly environmentType: string | undefined; readonly release: JobRelease } = { environmentType: "PRODUCTION", release: PINNED };
const PAYLOAD = { acknowledge: READ_CONTENT_VALIDATION_ACKNOWLEDGEMENT, workspace_id: WORKSPACE, connected_account_id: ACCOUNT };
const FORBIDDEN_IN_OUTPUT = [PAGE, OTHER_PAGE, POST_A, POST_B, "990000000000001", USER_TOKEN, PAGE_TOKEN, CAPTION, NAME, CURSOR, BODY_MARKER, "graph.facebook.com", "access_token", "http", WORKSPACE, ACCOUNT, CREDENTIAL_ID, CONNECTION_ID, "facebook:post", "arn:aws"];

type Env = Record<string, string | undefined>;
/** The approved deployed Integration/prod configuration the guards accept (values synthetic). */
const DEPLOYED: Env = { NODE_ENV: "production", APP_DEPLOYMENT_ENV: "staging", CREDENTIAL_CONTEXT_ENV: "dev", CREDENTIAL_KMS_KEY_ARN: KEY_A, CREDENTIAL_KMS_ALLOWED_KEY_ARNS: KEY_A };

const json = (status: number, body: unknown): Promise<Response> => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const post = (id: string, patch: Record<string, unknown> = {}) => ({ id, from: { id: PAGE, name: NAME }, message: CAPTION, created_time: "2026-10-10T10:00:00+0000", updated_time: "2026-10-11T10:00:00+0000", status_type: "mobile_status_update", ...patch });

interface Graph {
  readonly list?: unknown;
  readonly listStatus?: number;
  readonly get?: unknown;
  readonly getStatus?: number;
}

/** The real Meta read port over a counting fetch double. */
function metaWorld(graph: Graph) {
  const calls: URL[] = [];
  const fetch: MetaGraphFetch = (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    if (parsed.searchParams.get("fields") === "access_token") return json(200, { id: PAGE, access_token: PAGE_TOKEN });
    if (parsed.pathname.endsWith("/published_posts")) return json(graph.listStatus ?? 200, graph.list ?? { data: [post(POST_A), post(POST_B, { status_type: "added_video" })], paging: { cursors: { after: CURSOR }, next: `https://graph.facebook.com/next?access_token=${PAGE_TOKEN}` } });
    if (parsed.searchParams.get("fields") === META_POST_FIELDS) return json(graph.getStatus ?? 200, graph.get ?? post(POST_A));
    return json(400, { error: { code: 100, message: BODY_MARKER } });
  };
  return { calls, read: createMetaReadPort({ transport: createMetaGraphTransport({ fetch }) }) };
}

const FOUND: ReadContentValidationTarget = { kind: "found", providerAssetId: PAGE, credentialId: CREDENTIAL_ID, envelope: new Uint8Array([1, 2, 3]) };

/** A fake credential access: lends a synthetic credential to exactly one use and records the opening. */
function lendingAccess() {
  const openings: { workspaceId: string; credentialId: string }[] = [];
  const access: ProviderCredentialAccess = {
    withCredential: (input, use) => {
      openings.push({ workspaceId: input.workspaceId, credentialId: input.credentialId });
      return use(providerCredential("synthetic-diagnostic-credential", USER_TOKEN));
    },
  };
  return { access, openings };
}

function harness(graph: Graph = {}, overrides: Partial<ReadContentValidationDependencies> = {}) {
  const world = metaWorld(graph);
  const lending = lendingAccess();
  const lookups: unknown[] = [];
  const composed: Env[] = [];
  const deps: Partial<ReadContentValidationDependencies> = {
    nodeVersion: "v22.16.0",
    clock: () => NOW,
    lookup: (input) => {
      lookups.push(input);
      return Promise.resolve(FOUND);
    },
    compose: (environment) => {
      composed.push({ ...environment });
      return { access: lending.access, read: world.read };
    },
    ...overrides,
  };
  return { world, lending, lookups, composed, run: (payload: unknown = PAYLOAD, env: Env = DEPLOYED, run = RUN) => runReadContentValidation(payload, run, env, deps) };
}

const rendered = (value: unknown): string => [JSON.stringify(value), inspect(value, { depth: 10, showHidden: true }), String(value)].join(" ");
const expectRedacted = (value: unknown): void => {
  const text = rendered(value);
  for (const forbidden of FORBIDDEN_IN_OUTPUT) expect(text, forbidden).not.toContain(forbidden);
};

async function refused(promise: Promise<unknown>): Promise<ReadContentValidationFailure> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ReadContentValidationError);
    const failure = (error as ReadContentValidationError).failure;
    expect(READ_CONTENT_VALIDATION_FAILURES).toContain(failure);
    expect((error as Error).message).toBe(`non-retryable job failure: ${failure}`);
    expectRedacted(error);
    return failure;
  }
  throw new Error("expected the diagnostic to refuse");
}

/** The ONLY keys an outcome may carry (output schema). */
const OUTCOME_KEYS = ["authorization", "expectedMetaRequests", "get", "graphVersion", "list", "maxListPages", "positiveEvidenceEligible", "result", "stages", "windowDays"];
const LIST_KEYS = ["allItemsFromManagedPage", "allSourcesUnknown", "contentKinds", "error", "inWindowItemCount", "itemCount", "pagination", "succeeded"];
const GET_KEYS = ["accountMatchesManagedPage", "attempted", "contentKindMatchesListed", "error", "refMatchesListed", "selectedContentKind", "succeeded"];
const CLOSED_STRINGS = new Set<string>([
  ...CONTENT_KINDS,
  "READ_CONTENT_LIST_AND_GET_SUCCEEDED", "READ_CONTENT_LIST_SUCCEEDED_NO_ITEMS", "READ_CONTENT_LIST_FAILED", "READ_CONTENT_GET_FAILED", "READ_CONTENT_GET_NOT_CORRELATED",
  "AUTHORIZED_READS_OBSERVED", "PERMISSION_MISSING_OBSERVED", "CREDENTIAL_INVALID_OBSERVED", "NOT_DETERMINED", "v25.0", "list_content", "get_content", "more", "end",
  "rate_limited", "transient", "permission_missing", "target_not_found", "target_not_eligible", "credential_invalid", "permanent_rejected", "outcome_unknown",
  "read_content", "network", "server_error", "provider_unavailable", "unknown", "expired", "revoked", "invalid_request", "invalid_cursor", "content_policy",
]);

/** Every string anywhere in the outcome is a closed vocabulary value; every key is in the schema. */
function expectOutcomeSchema(outcome: ReadContentValidationOutcome): void {
  expect(Object.keys(outcome).sort()).toEqual(OUTCOME_KEYS);
  expect(Object.keys(outcome.list).sort()).toEqual(LIST_KEYS);
  expect(Object.keys(outcome.get).sort()).toEqual(GET_KEYS);
  expect(Object.keys(outcome.list.contentKinds).sort()).toEqual([...CONTENT_KINDS].sort());
  const walk = (value: unknown, at: string): void => {
    if (typeof value === "string") expect(CLOSED_STRINGS.has(value), `${at}=${value}`).toBe(true);
    else if (Array.isArray(value)) value.forEach((item, i) => { walk(item, `${at}[${String(i)}]`); });
    else if (typeof value === "object" && value !== null) for (const [key, child] of Object.entries(value)) walk(child, `${at}.${key}`);
    else expect(["number", "boolean"].includes(typeof value) || value === null, at).toBe(true);
  };
  walk(outcome, "outcome");
  expectRedacted(outcome);
}

describe("the diagnostic's identity: operator-only INTEGRATION task", () => {
  it("is integration.read_content_validation: one attempt, its own queue of one, bounded, no schedule — and thin", async () => {
    await import("@/jobs/trigger/integration/read-content-validation");
    const definition = sdk.tasks.find((task) => task["id"] === READ_CONTENT_VALIDATION_TASK_ID);
    expect(definition).toBeDefined();
    expect(definition?.["retry"]).toEqual({ maxAttempts: 1 });
    expect(definition?.["maxDuration"]).toBe(120);
    expect(definition?.["queue"]).toMatchObject({ name: "integration-read-content-validation", concurrencyLimit: 1 });
    expect(Object.keys(definition ?? {}).sort()).toEqual(["id", "maxDuration", "queue", "retry", "run"]);
    expect(sdk.scheduled).toEqual([]);
    expect(READ_CONTENT_VALIDATION_AWS_ATTEMPTS).toEqual({ maxAttempts: 1 });
    expect(READ_CONTENT_VALIDATION_META_REQUESTS).toEqual({ withItem: 4, withoutItem: 2 });
  });

  it("the task aborts with the fixed code of a refusal (no retry), never a message of its own", async () => {
    await import("@/jobs/trigger/integration/read-content-validation");
    const definition = sdk.tasks.find((task) => task["id"] === READ_CONTENT_VALIDATION_TASK_ID);
    const run = definition?.["run"] as (payload: unknown, context: { ctx: unknown }) => Promise<unknown>;
    const ctx = { environment: { type: "DEVELOPMENT" }, deployment: undefined };
    await expect(run({ ...PAYLOAD, acknowledge: "nope" }, { ctx })).rejects.toThrow(new sdk.AbortTaskRunError("read_content_validation_input_refused"));
    await expect(run(PAYLOAD, { ctx })).rejects.toThrow(new sdk.AbortTaskRunError("read_content_validation_release_refused"));
  });
});

describe("guards: every refusal happens before any lookup, composition or provider request", () => {
  type Case = [name: string, failure: ReadContentValidationFailure, change: { payload?: unknown; env?: Env; run?: { environmentType: string | undefined; release: JobRelease }; node?: string }];
  const cases: Case[] = [
    ["no payload", "read_content_validation_input_refused", { payload: null }],
    ["an array payload", "read_content_validation_input_refused", { payload: [PAYLOAD] }],
    ["a wrong acknowledgement", "read_content_validation_input_refused", { payload: { ...PAYLOAD, acknowledge: "INTEGRATION_KMS_WORKER_AUTH_DIAGNOSTIC_V1" } }],
    ["a missing workspace", "read_content_validation_input_refused", { payload: { acknowledge: PAYLOAD.acknowledge, connected_account_id: ACCOUNT } }],
    ["an extra field (a provider id)", "read_content_validation_input_refused", { payload: { ...PAYLOAD, page_id: PAGE } }],
    ["an extra field (a token)", "read_content_validation_input_refused", { payload: { ...PAYLOAD, access_token: USER_TOKEN } }],
    ["a non-UUID account", "read_content_validation_input_refused", { payload: { ...PAYLOAD, connected_account_id: PAGE } }],
    ["a non-UUID workspace", "read_content_validation_input_refused", { payload: { ...PAYLOAD, workspace_id: "workspace" } }],
    ["a local development run", "read_content_validation_release_refused", { run: { environmentType: "DEVELOPMENT", release: { kind: "development" } } }],
    ["a deployed run without an external id", "read_content_validation_release_refused", { run: { environmentType: "PRODUCTION", release: { kind: "unidentified" } } }],
    ["a STAGING environment run", "read_content_validation_release_refused", { run: { environmentType: "STAGING", release: PINNED } }],
    ["the main plane's system database credential", "read_content_validation_plane_refused", { env: { DATABASE_SYSTEM_URL: "postgres://synthetic" } }],
    ["the integration task-operator key", "read_content_validation_plane_refused", { env: { TRIGGER_INTEGRATION_TASK_OPERATOR_KEY: "synthetic" } }],
    ["a standard AWS credential-chain variable", "read_content_validation_plane_refused", { env: { AWS_ACCESS_KEY_ID: "SYNTHETIC" } }],
    ["the Meta app secret", "read_content_validation_plane_refused", { env: { PROVIDER_META_CLIENT_SECRET: "synthetic" } }],
    ["APP_DEPLOYMENT_ENV unset", "read_content_validation_tier_refused", { env: { APP_DEPLOYMENT_ENV: undefined } }],
    ["APP_DEPLOYMENT_ENV=production", "read_content_validation_tier_refused", { env: { APP_DEPLOYMENT_ENV: "production" } }],
    ["APP_DEPLOYMENT_ENV=preview", "read_content_validation_tier_refused", { env: { APP_DEPLOYMENT_ENV: "preview" } }],
    ["Node 20", "read_content_validation_runtime_refused", { node: "v20.19.0" }],
    ["the staging stub provider mode", "read_content_validation_provider_mode_refused", { env: { CAPABILITY_PROVIDER_MODE: "staging_stub" } }],
    ["an unknown provider mode", "read_content_validation_provider_mode_refused", { env: { CAPABILITY_PROVIDER_MODE: "live" } }],
    ["the local keyring (no KMS)", "read_content_validation_keyring_refused", { env: { NODE_ENV: "test", CREDENTIAL_CONTEXT_ENV: undefined, CREDENTIAL_KMS_KEY_ARN: undefined, CREDENTIAL_KMS_ALLOWED_KEY_ARNS: undefined } }],
    ["a partial KMS configuration", "read_content_validation_keyring_refused", { env: { CREDENTIAL_KMS_ALLOWED_KEY_ARNS: undefined } }],
    ["a local key next to KMS", "read_content_validation_keyring_refused", { env: { LOCAL_KEYRING_KEY: "c3ludGhldGlj" } }],
  ];

  it.each(cases)("%s → %s", async (_name, failure, change) => {
    const h = harness({}, change.node === undefined ? {} : { nodeVersion: change.node });
    expect(await refused(h.run("payload" in change ? change.payload : PAYLOAD, { ...DEPLOYED, ...change.env }, change.run ?? RUN))).toBe(failure);
    expect(h.lookups).toEqual([]);
    expect(h.composed).toEqual([]);
    expect(h.world.calls).toEqual([]);
  });

  it.each([
    [{ kind: "not_found" }, "read_content_validation_target_not_found"],
    [{ kind: "inactive" }, "read_content_validation_target_inactive"],
    [{ kind: "not_facebook_page" }, "read_content_validation_target_not_facebook_page"],
    [{ kind: "credential_missing" }, "read_content_validation_credential_missing"],
  ] as const)("a lookup answering %o is refused (%s) before composition or any provider request", async (target, failure) => {
    const h = harness({}, { lookup: () => Promise.resolve(target) });
    expect(await refused(h.run())).toBe(failure);
    expect(h.composed).toEqual([]);
    expect(h.world.calls).toEqual([]);
  });

  it("a failing lookup is one fixed code (no database detail)", async () => {
    const h = harness({}, { lookup: () => Promise.reject(new Error(`connection refused postgres://${BODY_MARKER}`)) });
    expect(await refused(h.run())).toBe("read_content_validation_failed");
  });
});

describe("target classification (pure): only an ACTIVE content-bearing Facebook Page of a live Meta connection with its credential", () => {
  const account = (patch: Partial<ConnectedAccount> = {}) => ({ id: ACCOUNT, connectionId: CONNECTION_ID, platform: "facebook", providerAssetId: PAGE, assetClass: "content_bearing", status: "ACTIVE", ...patch }) as ConnectedAccount;
  const connection = (patch: Partial<Connection> = {}) => ({ id: CONNECTION_ID, provider: "meta", status: "ACTIVE", activeCredentialId: CREDENTIAL_ID, ...patch }) as unknown as Connection;
  const credential = { connectionId: CONNECTION_ID, envelope: new Uint8Array([9]) };

  it.each([
    ["the found Page", account(), connection(), credential, "found"],
    ["no account", undefined, connection(), credential, "not_found"],
    ["no connection", account(), undefined, credential, "not_found"],
    ["a removed connection", account(), connection({ status: "REMOVED" }), credential, "not_found"],
    ["an inactive account", account({ status: "INACTIVE" }), connection(), credential, "inactive"],
    ["an Instagram account", account({ platform: "instagram" }), connection(), credential, "not_facebook_page"],
    ["an ad account", account({ assetClass: "ad_account" }), connection(), credential, "not_facebook_page"],
    ["a TikTok connection", account(), connection({ provider: "tiktok" }), credential, "not_facebook_page"],
    ["no active credential", account(), connection({ activeCredentialId: null }), credential, "credential_missing"],
    ["a credential of another connection", account(), connection(), { ...credential, connectionId: "5eed0000-d1a9-4000-8000-00000000f099" }, "credential_missing"],
    ["no stored envelope", account(), connection(), undefined, "credential_missing"],
  ] as const)("%s → %s", (_name, a, c, k, kind) => {
    expect(classifyTarget(a, c, k).kind).toBe(kind);
  });

  it("the read-only lookup exposes exactly three reads, and its store's write dependencies refuse", () => {
    const lookup = readContentValidationLookup({} as DatabaseTransaction);
    expect(Object.keys(lookup).sort()).toEqual(["account", "connection", "credential"]);
    expect(Object.isFrozen(lookup)).toBe(true);
  });
});

describe("the provider sequence: listContent, then getContent of the FIRST listed ref — inside ONE credential opening", () => {
  it("with items: 4 Meta GETs (derive + published_posts, derive + post), one opening, and a positive, fully correlated outcome", async () => {
    const h = harness();
    const outcome = await h.run();
    expect(h.world.calls.map((url) => `${url.pathname.replace(/\d+/g, "N")}?${url.searchParams.get("fields") ?? ""}`)).toEqual([
      "/vN.N/N?access_token",
      `/vN.N/N/published_posts?${META_POST_FIELDS}`,
      "/vN.N/N?access_token",
      `/vN.N/N_N?${META_POST_FIELDS}`,
    ]);
    expect(h.world.calls[3]?.pathname).toBe(`/v25.0/${POST_A}`); // the first listed ref, never an arbitrary target
    expect(h.world.calls).toHaveLength(READ_CONTENT_VALIDATION_META_REQUESTS.withItem);
    expect(h.lending.openings).toEqual([{ workspaceId: WORKSPACE, credentialId: CREDENTIAL_ID }]);
    expect(h.lookups).toEqual([{ workspaceId: WORKSPACE, connectedAccountId: ACCOUNT }]);
    expect(outcome).toEqual({
      result: "READ_CONTENT_LIST_AND_GET_SUCCEEDED",
      positiveEvidenceEligible: true,
      authorization: "AUTHORIZED_READS_OBSERVED",
      graphVersion: "v25.0",
      windowDays: 30,
      maxListPages: 1,
      stages: ["list_content", "get_content"],
      expectedMetaRequests: 4,
      list: {
        succeeded: true,
        itemCount: 2,
        inWindowItemCount: 2,
        contentKinds: { post: 1, reel: 0, video: 1, carousel: 0, story: 0, ad_creative: 0, other: 0 },
        pagination: "more",
        allItemsFromManagedPage: true,
        allSourcesUnknown: true,
        error: null,
      },
      get: { attempted: true, succeeded: true, selectedContentKind: "post", refMatchesListed: true, accountMatchesManagedPage: true, contentKindMatchesListed: true, error: null },
    } satisfies ReadContentValidationOutcome);
    expectOutcomeSchema(outcome);
  });

  it("the listing window is [now − 30 days, now): items outside it are dropped client-side and never fetched by getContent", async () => {
    const h = harness({ list: { data: [post(`${PAGE}_1`, { created_time: "2026-09-01T00:00:00+0000" }), post(POST_B, { created_time: "2026-10-01T00:00:00+0000" })] } });
    const outcome = await h.run();
    expect(outcome.list).toMatchObject({ itemCount: 1, inWindowItemCount: 1, pagination: "end" });
    expect(h.world.calls[3]?.pathname).toBe(`/v25.0/${POST_B}`);
    expect(h.world.calls[1]?.searchParams.has("since")).toBe(false);
  });

  it("with zero in-window items: 2 Meta GETs, no getContent, and never positive evidence", async () => {
    const h = harness({ list: { data: [] } });
    const outcome = await h.run();
    expect(h.world.calls).toHaveLength(READ_CONTENT_VALIDATION_META_REQUESTS.withoutItem);
    expect(outcome).toMatchObject({
      result: "READ_CONTENT_LIST_SUCCEEDED_NO_ITEMS",
      positiveEvidenceEligible: false,
      stages: ["list_content"],
      expectedMetaRequests: 2,
      list: { succeeded: true, itemCount: 0, pagination: "end" },
      get: { attempted: false, succeeded: null, selectedContentKind: null, refMatchesListed: null, contentKindMatchesListed: null, error: null },
    });
    expectOutcomeSchema(outcome);
  });

  it("a list failure (permission) is reported as a closed class — NOT_AUTHORIZED evidence for P5-C, never unsupported — and getContent is not called", async () => {
    const h = harness({ list: { error: { code: 10, message: BODY_MARKER, type: "OAuthException" } }, listStatus: 403 });
    const outcome = await h.run();
    expect(h.world.calls).toHaveLength(2);
    expect(outcome).toMatchObject({
      result: "READ_CONTENT_LIST_FAILED",
      positiveEvidenceEligible: false,
      authorization: "PERMISSION_MISSING_OBSERVED",
      list: { succeeded: false, itemCount: 0, pagination: null, allItemsFromManagedPage: null, error: { kind: "permission_missing", detail: "read_content" } },
      get: { attempted: false },
    });
    expectOutcomeSchema(outcome);
  });

  it.each([
    ["an invalid credential", { error: { code: 190, type: "OAuthException", error_subcode: 463, message: BODY_MARKER } }, 400, { kind: "credential_invalid", detail: "expired" }, "CREDENTIAL_INVALID_OBSERVED"],
    ["a rate limit", { error: { code: 32, message: BODY_MARKER } }, 400, { kind: "rate_limited", detail: null }, "NOT_DETERMINED"],
    ["a transient provider failure", { error: { code: 2, message: BODY_MARKER } }, 500, { kind: "transient", detail: "provider_unavailable" }, "NOT_DETERMINED"],
    ["an unknown status_type", { data: [post(POST_A, { status_type: "created_event" })] }, 200, { kind: "permanent_rejected", detail: "unknown" }, "NOT_DETERMINED"],
    ["a post of another identity", { data: [post(POST_A, { from: { id: OTHER_PAGE, name: NAME } })] }, 200, { kind: "permanent_rejected", detail: "unknown" }, "NOT_DETERMINED"],
  ] as const)("a list failure (%s) → %o, redacted", async (_name, list, listStatus, error, authorization) => {
    const h = harness({ list, listStatus });
    const outcome = await h.run();
    expect(outcome).toMatchObject({ result: "READ_CONTENT_LIST_FAILED", authorization, positiveEvidenceEligible: false, list: { error } });
    expectOutcomeSchema(outcome);
  });

  it("a getContent failure (100/33 → TargetNotFound) is reported, never positive", async () => {
    const h = harness({ get: { error: { code: 100, error_subcode: 33, message: BODY_MARKER } }, getStatus: 400 });
    const outcome = await h.run();
    expect(h.world.calls).toHaveLength(4);
    expect(outcome).toMatchObject({
      result: "READ_CONTENT_GET_FAILED",
      positiveEvidenceEligible: false,
      authorization: "NOT_DETERMINED",
      get: { attempted: true, succeeded: false, refMatchesListed: null, error: { kind: "target_not_found", detail: null } },
    });
    expectOutcomeSchema(outcome);
  });

  it("a getContent permission failure is PERMISSION_MISSING_OBSERVED", async () => {
    const h = harness({ get: { error: { code: 200, message: BODY_MARKER } }, getStatus: 403 });
    expect(await h.run()).toMatchObject({ result: "READ_CONTENT_GET_FAILED", authorization: "PERMISSION_MISSING_OBSERVED", get: { error: { kind: "permission_missing", detail: "read_content" } } });
  });

  it("a getContent answer that does not correlate with the listed ref is never positive", async () => {
    // A synthetic read port whose getContent returns another (well-formed) ref: the diagnostic's own correlation check.
    const world = metaWorld({});
    const skewed: ProviderReadPort = { ...world.read, getContent: async (access, ref) => { const result = await world.read.getContent(access, ref); return { ...result, data: { ...result.data, ref: { ...result.data.ref, id: POST_B } } } as typeof result; } };
    const h = harness({}, { compose: () => ({ access: lendingAccess().access, read: skewed }) });
    const outcome = await h.run();
    expect(outcome).toMatchObject({ result: "READ_CONTENT_GET_NOT_CORRELATED", positiveEvidenceEligible: false, get: { succeeded: true, refMatchesListed: false } });
    expectOutcomeSchema(outcome);
  });
});

describe("credential-access failures before the provider call are fixed codes", () => {
  it.each([
    [new CredentialUnreadableError(), "read_content_validation_credential_unreadable"],
    [new NonRetryableJobError("credential_keyring_access_denied"), "read_content_validation_keyring_access_denied"],
    [new NonRetryableJobError("credential_keyring_misconfigured"), "read_content_validation_keyring_misconfigured"],
    [new CredentialCryptoError("KEYRING_UNAVAILABLE"), "read_content_validation_keyring_unavailable"],
    [new Error(`arn:aws:kms:sa-east-1:000000000000:key/leak ${BODY_MARKER}`), "read_content_validation_failed"],
  ] as const)("%s → %s, with no provider request", async (error, failure) => {
    const world = metaWorld({});
    const h = harness({}, { compose: () => ({ access: { withCredential: () => Promise.reject(error) }, read: world.read }) });
    expect(await refused(h.run())).toBe(failure);
    expect(world.calls).toEqual([]);
  });

  it("a non-provider error inside the provider stage (a bug) is the generic failure, never a partial outcome", async () => {
    const world = metaWorld({});
    const broken: ProviderReadPort = { ...world.read, listContent: () => Promise.reject(new TypeError(`${BODY_MARKER} ${PAGE}`)) };
    const h = harness({}, { compose: () => ({ access: lendingAccess().access, read: broken }) });
    expect(await refused(h.run())).toBe("read_content_validation_failed");
  });
});

describe("P5-C0: the output names the kind of the EXACT item getContent was validated on", () => {
  it("a selected post: selectedContentKind = post, read back from that same ref, kinds match", async () => {
    const h = harness({ list: { data: [post(POST_A), post(POST_B, { status_type: "added_video" })] }, get: post(POST_A) });
    const outcome = await h.run();
    expect(h.world.calls[3]?.pathname).toBe(`/v25.0/${POST_A}`);
    expect(outcome.get).toMatchObject({ attempted: true, succeeded: true, selectedContentKind: "post", contentKindMatchesListed: true, refMatchesListed: true });
    expectOutcomeSchema(outcome);
  });

  it("a selected video: selectedContentKind = video, even though the page also lists posts", async () => {
    const h = harness({ list: { data: [post(POST_B, { status_type: "added_video" }), post(POST_A)] }, get: post(POST_B, { status_type: "added_video" }) });
    const outcome = await h.run();
    expect(h.world.calls[3]?.pathname).toBe(`/v25.0/${POST_B}`);
    expect(outcome.list.contentKinds).toMatchObject({ post: 1, video: 1 });
    expect(outcome.get).toMatchObject({ attempted: true, succeeded: true, selectedContentKind: "video", contentKindMatchesListed: true });
    expect(outcome.result).toBe("READ_CONTENT_LIST_AND_GET_SUCCEEDED");
    expectOutcomeSchema(outcome);
  });

  it("zero eligible items: getContent not attempted and selectedContentKind null", async () => {
    const h = harness({ list: { data: [post(POST_A, { created_time: "2020-01-01T00:00:00+0000" })] } });
    const outcome = await h.run();
    expect(h.world.calls).toHaveLength(2);
    expect(outcome.get).toEqual({ attempted: false, succeeded: null, selectedContentKind: null, refMatchesListed: null, accountMatchesManagedPage: null, contentKindMatchesListed: null, error: null });
  });

  it("a re-read of a different kind: contentKindMatchesListed = false, selectedContentKind stays the LISTED kind", async () => {
    const h = harness({ list: { data: [post(POST_A)] }, get: post(POST_A, { status_type: "added_video" }) });
    const outcome = await h.run();
    expect(outcome.get).toMatchObject({ attempted: true, succeeded: true, selectedContentKind: "post", contentKindMatchesListed: false, refMatchesListed: true });
    expectOutcomeSchema(outcome);
  });

  it("a failed getContent still names the selected kind (it was attempted), with no match verdict", async () => {
    const h = harness({ list: { data: [post(POST_B, { status_type: "added_video" })] }, get: { error: { code: 100, error_subcode: 33, message: BODY_MARKER } }, getStatus: 400 });
    const outcome = await h.run();
    expect(outcome.get).toMatchObject({ attempted: true, succeeded: false, selectedContentKind: "video", contentKindMatchesListed: null, error: { kind: "target_not_found" } });
    expectOutcomeSchema(outcome);
  });

  it("the selected kind is a canonical ContentKind and is set iff getContent was attempted (every outcome above and below)", async () => {
    for (const graph of [{}, { list: { data: [] } }, { list: { error: { code: 10, message: BODY_MARKER } }, listStatus: 403 }] as Graph[]) {
      const outcome = await harness(graph).run();
      expect(outcome.get.selectedContentKind === null, JSON.stringify(outcome.get)).toBe(!outcome.get.attempted);
      if (outcome.get.selectedContentKind !== null) expect(CONTENT_KINDS).toContain(outcome.get.selectedContentKind);
    }
  });
});

describe("no writes, no persistence of the Page token", () => {
  it("the only stateful dependency is the read-only lookup; the outcome never carries the token, ids, captions or cursors", async () => {
    const h = harness();
    const outcome = await h.run();
    expectRedacted(outcome);
    // The Page token was used only on the content reads (as the documented query parameter), never elsewhere.
    expect(h.world.calls.filter((url) => url.searchParams.get("access_token") === PAGE_TOKEN).map((url) => url.pathname.endsWith("/published_posts") || url.pathname === `/v25.0/${POST_A}`)).toEqual([true, true]);
  });
});
