/**
 * The INTEGRATION read_interactions validation diagnostic (Step 7G-H5.5-P12-B2; jobs/integration-read-interactions-
 * validation.ts), offline. The guards run on synthetic environments; the provider path runs the REAL Meta read port and
 * Graph transport against an in-process `fetch` double (every Meta GET counted), with a synthetic credential lent by a
 * fake credential access and a fake read-only lookup — no database, AWS or network. Correlation failures that the real
 * port can never produce are injected by wrapping its getInteraction answer. Synthetic ids, texts and tokens only; the
 * output is checked for every one of them.
 */
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { ProviderCredentialAccess } from "@/modules/connections";
import {
  AUTHOR_ROLES,
  CONTENT_KINDS,
  CONTENT_SOURCES,
  INTERACTION_KINDS,
  INTERACTION_VISIBILITY,
  TargetNotEligibleError,
  providerCredential,
  providerObjectRef,
  type InteractionDto,
  type ProviderReadPort,
} from "@/integrations/providers/contract";
import {
  META_FACEBOOK_COMMENT_FIELDS,
  META_FACEBOOK_COMMENT_NODE_FIELDS,
  META_INSTAGRAM_COMMENT_FIELDS,
  META_INSTAGRAM_MEDIA_FIELDS,
  createMetaGraphTransport,
  type MetaGraphFetch,
} from "@/integrations/providers/meta/graph-transport";
import { createMetaReadPort } from "@/integrations/providers/meta/read-port";
import type { JobRelease } from "@/platform/jobs";
import {
  READ_INTERACTIONS_VALIDATION_ACCOUNT_KINDS,
  READ_INTERACTIONS_VALIDATION_ACKNOWLEDGEMENT,
  READ_INTERACTIONS_VALIDATION_AWS_ATTEMPTS,
  READ_INTERACTIONS_VALIDATION_CANDIDATE_LIMIT,
  READ_INTERACTIONS_VALIDATION_FAILURES,
  READ_INTERACTIONS_VALIDATION_META_REQUESTS_PER_OPERATION,
  READ_INTERACTIONS_VALIDATION_PLATFORMS,
  READ_INTERACTIONS_VALIDATION_PROVABLE_KINDS,
  READ_INTERACTIONS_VALIDATION_RESULTS,
  READ_INTERACTIONS_VALIDATION_TASK_ID,
  ReadInteractionsValidationError,
  classifyTarget,
  runReadInteractionsValidation,
  type ReadInteractionsValidationDependencies,
  type ReadInteractionsValidationFailure,
  type ReadInteractionsValidationOutcome,
  type ReadInteractionsValidationTarget,
} from "@/jobs/integration-read-interactions-validation";

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

const WORKSPACE = "5eed0000-d1a9-4000-8000-00000000f101";
const ACCOUNT = "5eed0000-d1a9-4000-8000-00000000f102";
const CREDENTIAL_ID = "5eed0000-d1a9-4000-8000-00000000f103";
const PAGE = "880000000000011";
const POST = `${PAGE}_990000000000011`;
const COMMENT = "990000000000011_770000000000001";
const COMMENT_2 = "990000000000011_770000000000002";
const REPLY = "990000000000011_770000000000003";
const FB_USER = "660000000000001";
const IG = "17840000000000031";
const MEDIA = "17900000000000031";
const IG_COMMENT = "17950000000000031";
const IG_USER = "17960000000000031";
const USER_TOKEN = "synthetic-diagnostic-user-token-marker";
const PAGE_TOKEN = "synthetic-diagnostic-page-token-marker";
const TEXT = "Synthetic comment text that must never be output";
const NAME = "Synthetic Commenter Name Marker";
const HANDLE = "synthetic_commenter_handle_marker";
const CAPTION = "Synthetic caption marker";
const CURSOR = "QVFIUnN5bnRoZXRpY0N1cnNvck1hcmtlcg";
const BODY_MARKER = "synthetic-graph-body-marker";
const NOW = new Date("2026-10-26T12:00:00.000Z");
const KEY_A = "arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-0000000000aa";
const PINNED: JobRelease = { kind: "pinned", releaseId: "synthetic-release-0000000000000000000000" };
const RUN = { environmentType: "PRODUCTION", release: PINNED } as const;
const PAYLOAD = { acknowledge: READ_INTERACTIONS_VALIDATION_ACKNOWLEDGEMENT, workspace_id: WORKSPACE, connected_account_id: ACCOUNT };
const FORBIDDEN_IN_OUTPUT = [
  PAGE, POST, COMMENT, COMMENT_2, REPLY, FB_USER, IG, MEDIA, IG_COMMENT, IG_USER, "990000000000011", "770000000000001", USER_TOKEN, PAGE_TOKEN, TEXT, NAME, HANDLE, CAPTION, CURSOR, BODY_MARKER,
  "graph.facebook.com", "access_token", "http", "meta1.", WORKSPACE, ACCOUNT, CREDENTIAL_ID, "facebook:", "instagram:", "rawReference", "arn:aws",
];

type Env = Record<string, string | undefined>;
const DEPLOYED: Env = { NODE_ENV: "production", APP_DEPLOYMENT_ENV: "staging", CREDENTIAL_CONTEXT_ENV: "dev", CREDENTIAL_KMS_KEY_ARN: KEY_A, CREDENTIAL_KMS_ALLOWED_KEY_ARNS: KEY_A };

const json = (status: number, body: unknown): Promise<Response> => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const post = (id: string) => ({ id, from: { id: PAGE, name: NAME }, message: CAPTION, created_time: "2026-10-20T10:00:00+0000", status_type: "mobile_status_update" });
const fbComment = (id: string, patch: Record<string, unknown> = {}) => ({ id, from: { id: FB_USER, name: NAME }, message: TEXT, created_time: "2026-10-21T10:00:00+0000", is_hidden: false, ...patch });
const fbReply = (id: string, parent: string) => fbComment(id, { parent: { id: parent }, from: { id: PAGE, name: NAME } });
const media = (id: string) => ({ id, media_type: "IMAGE", media_product_type: "FEED", timestamp: "2026-10-20T10:00:00+0000", caption: CAPTION, owner: { id: IG } });
const igComment = (id: string, patch: Record<string, unknown> = {}) => ({ id, from: { id: IG_USER, username: HANDLE }, text: TEXT, timestamp: "2026-10-21T10:00:00+0000", hidden: false, media: { id: MEDIA }, ...patch });
const withNext = (data: unknown[]) => ({ data, paging: { cursors: { after: CURSOR }, next: `https://graph.facebook.com/next?access_token=${PAGE_TOKEN}` } });

interface Graph {
  readonly contents?: unknown;
  readonly comments?: unknown;
  readonly commentsStatus?: number;
  /** Per content item (post or media id): its comments page and status, overriding `comments`/`commentsStatus` (Step 7G-H5.5-P12-C4). */
  readonly commentsByContent?: Readonly<Record<string, { readonly body: unknown; readonly status?: number }>>;
  readonly nodes?: Readonly<Record<string, unknown>>;
}

/** The real Meta read port over a counting fetch double serving Facebook and Instagram paths. */
function metaWorld(graph: Graph) {
  const calls: URL[] = [];
  const fetch: MetaGraphFetch = (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    const fields = parsed.searchParams.get("fields");
    const segments = parsed.pathname.split("/").slice(2).map(decodeURIComponent);
    if (fields === "access_token") return json(200, { id: PAGE, access_token: PAGE_TOKEN });
    if (parsed.pathname.endsWith("/published_posts")) return json(200, graph.contents ?? withNext([post(POST)]));
    if (fields === META_INSTAGRAM_MEDIA_FIELDS) return json(200, graph.contents ?? { data: [media(MEDIA)] });
    if (segments[1] === "comments" && (fields === META_FACEBOOK_COMMENT_FIELDS || fields === META_INSTAGRAM_COMMENT_FIELDS)) {
      const own = (graph.commentsByContent ?? {})[segments[0] ?? ""];
      return own === undefined ? json(graph.commentsStatus ?? 200, graph.comments ?? { data: [] }) : json(own.status ?? 200, own.body);
    }
    if (fields === META_FACEBOOK_COMMENT_NODE_FIELDS || fields === META_INSTAGRAM_COMMENT_FIELDS) {
      const node = (graph.nodes ?? {})[segments[0] ?? ""];
      return node === undefined ? json(400, { error: { code: 100, error_subcode: 33, message: BODY_MARKER } }) : json(200, node);
    }
    return json(400, { error: { code: 100, message: BODY_MARKER } });
  };
  return { calls, read: createMetaReadPort({ transport: createMetaGraphTransport({ fetch }) }) };
}

const FB_FOUND: ReadInteractionsValidationTarget = { kind: "found", platform: "facebook", providerAssetId: PAGE, credentialId: CREDENTIAL_ID, envelope: new Uint8Array([1, 2, 3]) };
const IG_FOUND: ReadInteractionsValidationTarget = { kind: "found", platform: "instagram", providerAssetId: IG, credentialId: CREDENTIAL_ID, envelope: new Uint8Array([1, 2, 3]) };

/** Wraps the real port's getInteraction answer (a correlation failure the real port never produces). */
type Tamper = (dto: InteractionDto) => InteractionDto;
const tampered = (read: ProviderReadPort, tamper: Tamper | undefined, failGet?: Error): ProviderReadPort =>
  tamper === undefined && failGet === undefined ? read : {
    ...read,
    getInteraction: async (access, ref) => {
      if (failGet !== undefined) throw failGet;
      const result = await read.getInteraction(access, ref);
      return { ...result, data: tamper === undefined ? result.data : tamper(result.data) };
    },
  };

function harness(graph: Graph = {}, options: { readonly target?: ReadInteractionsValidationTarget; readonly tamper?: Tamper; readonly failGet?: Error; readonly failList?: Error; readonly deps?: Partial<ReadInteractionsValidationDependencies> } = {}) {
  const world = metaWorld(graph);
  const openings: string[] = [];
  const lookups: unknown[] = [];
  const composed: Env[] = [];
  const access: ProviderCredentialAccess = {
    withCredential: (input, use) => {
      openings.push(input.credentialId);
      return use(providerCredential("synthetic-diagnostic-credential", USER_TOKEN));
    },
  };
  let read = tampered(world.read, options.tamper, options.failGet);
  if (options.failList !== undefined) {
    const failure = options.failList;
    read = { ...read, listInteractions: () => Promise.reject(failure) };
  }
  const deps: Partial<ReadInteractionsValidationDependencies> = {
    nodeVersion: "v22.16.0",
    clock: () => NOW,
    lookup: (input) => {
      lookups.push(input);
      return Promise.resolve(options.target ?? FB_FOUND);
    },
    compose: (environment) => {
      composed.push({ ...environment });
      return { access, read };
    },
    ...options.deps,
  };
  return { world, openings, lookups, composed, run: (payload: unknown = PAYLOAD, env: Env = DEPLOYED, run: { environmentType: string | undefined; release: JobRelease } = RUN) => runReadInteractionsValidation(payload, run, env, deps) };
}

const rendered = (value: unknown): string => [JSON.stringify(value), inspect(value, { depth: 10, showHidden: true }), String(value)].join(" ");
const expectRedacted = (value: unknown): void => {
  const text = rendered(value);
  for (const forbidden of FORBIDDEN_IN_OUTPUT) expect(text, forbidden).not.toContain(forbidden);
};

async function refused(promise: Promise<unknown>): Promise<ReadInteractionsValidationFailure> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ReadInteractionsValidationError);
    const failure = (error as ReadInteractionsValidationError).failure;
    expect(READ_INTERACTIONS_VALIDATION_FAILURES).toContain(failure);
    expectRedacted(error);
    return failure;
  }
  throw new Error("expected the diagnostic to refuse");
}

const OUTCOME_KEYS = ["accountKind", "authorization", "candidateLimit", "candidatesInspected", "comment", "content", "evidenceInteractionKinds", "expectedMetaRequests", "graphVersion", "interactionKindsObserved", "interactionKindsValidated", "interactions", "maxListPages", "platform", "positiveEvidenceEligible", "reply", "result", "selectedCandidatePosition", "stages", "windowDays"];
const CONTENT_KEYS = ["allItemsFromManagedAccount", "error", "itemCount", "selectedContentKind", "selectedSource", "succeeded"];
const INTERACTIONS_KEYS = ["allOnSelectedContent", "attempted", "authorRoles", "commentCount", "error", "inWindowItemCount", "itemCount", "pagination", "parentShapeConsistent", "replyCount", "succeeded", "visibility"];
const PAIR_KEYS = ["attempted", "authorCorrelated", "contentCorrelated", "correlated", "error", "kindCorrelated", "observed", "parentCorrelated", "refCorrelated", "succeeded"];
const CLOSED_STRINGS = new Set<string>([
  ...CONTENT_KINDS, ...CONTENT_SOURCES, ...INTERACTION_KINDS, ...READ_INTERACTIONS_VALIDATION_PLATFORMS, ...READ_INTERACTIONS_VALIDATION_RESULTS, ...Object.values(READ_INTERACTIONS_VALIDATION_ACCOUNT_KINDS),
  "AUTHORIZED_READS_OBSERVED", "PERMISSION_MISSING_OBSERVED", "CREDENTIAL_INVALID_OBSERVED", "NOT_DETERMINED", "v25.0", "list_content", "list_interactions", "get_comment", "get_reply", "more", "end",
  "rate_limited", "transient", "permission_missing", "target_not_found", "target_not_eligible", "credential_invalid", "permanent_rejected", "outcome_unknown",
  "read_content", "read_interactions", "network", "server_error", "provider_unavailable", "unknown", "expired", "revoked", "invalid_request", "invalid_cursor", "content_policy", "unsupported_for_target",
]);

/** Every key is in the schema; every string anywhere is a closed vocabulary value; nothing identifying escapes. */
function expectOutcomeSchema(outcome: ReadInteractionsValidationOutcome): void {
  expect(Object.keys(outcome).sort()).toEqual(OUTCOME_KEYS);
  expect(Object.keys(outcome.content).sort()).toEqual(CONTENT_KEYS);
  expect(Object.keys(outcome.interactions).sort()).toEqual(INTERACTIONS_KEYS);
  expect(Object.keys(outcome.comment).sort()).toEqual(PAIR_KEYS);
  expect(Object.keys(outcome.reply).sort()).toEqual(PAIR_KEYS);
  expect(Object.keys(outcome.interactions.authorRoles).sort()).toEqual([...AUTHOR_ROLES].sort());
  expect(Object.keys(outcome.interactions.visibility).sort()).toEqual([...INTERACTION_VISIBILITY].sort());
  expect(outcome.positiveEvidenceEligible).toBe(outcome.evidenceInteractionKinds !== null);
  expect(outcome.expectedMetaRequests).toBe(READ_INTERACTIONS_VALIDATION_META_REQUESTS_PER_OPERATION[outcome.platform] * outcome.stages.length);
  // The scan is bounded and its counters agree with the stages it reached (Step 7G-H5.5-P12-C4).
  expect(outcome.candidateLimit).toBe(READ_INTERACTIONS_VALIDATION_CANDIDATE_LIMIT);
  expect(outcome.candidatesInspected).toBe(outcome.stages.filter((stage) => stage === "list_interactions").length);
  expect(outcome.candidatesInspected).toBeLessThanOrEqual(READ_INTERACTIONS_VALIDATION_CANDIDATE_LIMIT);
  expect(outcome.selectedCandidatePosition === null || (outcome.selectedCandidatePosition >= 1 && outcome.selectedCandidatePosition <= outcome.candidatesInspected)).toBe(true);
  const walk = (value: unknown, at: string): void => {
    if (typeof value === "string") expect(CLOSED_STRINGS.has(value), `${at}=${value}`).toBe(true);
    else if (Array.isArray(value)) value.forEach((item, i) => { walk(item, `${at}[${String(i)}]`); });
    else if (typeof value === "object" && value !== null) for (const [key, child] of Object.entries(value)) walk(child, `${at}.${key}`);
    else expect(["number", "boolean"].includes(typeof value) || value === null, at).toBe(true);
  };
  walk(outcome, "outcome");
  expectRedacted(outcome);
}

const FB_COMMENT_ONLY: Graph = { comments: withNext([fbComment(COMMENT), fbComment(COMMENT_2)]), nodes: { [COMMENT]: fbComment(COMMENT, { object: { id: POST } }) } };
const FB_COMMENT_AND_REPLY: Graph = {
  comments: { data: [fbComment(COMMENT), fbReply(REPLY, COMMENT)] },
  nodes: { [COMMENT]: fbComment(COMMENT, { object: { id: POST } }), [REPLY]: { ...fbReply(REPLY, COMMENT), object: { id: POST } } },
};
const IG_COMMENT_GRAPH: Graph = { comments: { data: [igComment(IG_COMMENT)] }, nodes: { [IG_COMMENT]: igComment(IG_COMMENT) } };

/** Identity fields a re-read must preserve; each tamper changes exactly one of them. */
type Mismatch = [label: string, field: keyof ReadInteractionsValidationOutcome["comment"], tamper: Tamper];
const mismatches: Mismatch[] = [
  ["ref", "refCorrelated", (dto) => ({ ...dto, ref: providerObjectRef(dto.ref.platform, "interaction", "990000000000011_770000000000099") })],
  ["content", "contentCorrelated", (dto) => ({ ...dto, content: providerObjectRef(dto.content.platform, "content", `${PAGE}_990000000000099`) })],
  ["kind", "kindCorrelated", (dto) => ({ ...dto, interactionKind: dto.interactionKind === "comment" ? "reply" : "comment" })],
  ["author", "authorCorrelated", (dto) => ({ ...dto, author: { ...dto.author, ref: providerObjectRef(dto.author.ref.platform, "author", "660000000000099") } })],
  ["parent", "parentCorrelated", (dto) => ({ ...dto, parent: dto.parent === null ? providerObjectRef(dto.ref.platform, "interaction", COMMENT_2) : null })],
];

// ── Identity, guards, target ────────────────────────────────────────────────────────────────────────────────

describe("the diagnostic's identity: a separate operator-only INTEGRATION task", () => {
  it("is integration.read_interactions_validation: one attempt, its own queue of one, bounded, no schedule — and thin", async () => {
    await import("@/jobs/trigger/integration/read-interactions-validation");
    const definition = sdk.tasks.find((task) => task["id"] === READ_INTERACTIONS_VALIDATION_TASK_ID);
    expect(definition).toBeDefined();
    expect(definition?.["retry"]).toEqual({ maxAttempts: 1 });
    expect(definition?.["maxDuration"]).toBe(120);
    expect(definition?.["queue"]).toMatchObject({ name: "integration-read-interactions-validation", concurrencyLimit: 1 });
    expect(Object.keys(definition ?? {}).sort()).toEqual(["id", "maxDuration", "queue", "retry", "run"]);
    expect(sdk.scheduled).toEqual([]);
    expect(READ_INTERACTIONS_VALIDATION_TASK_ID).not.toBe("integration.read_content_validation");
    expect(READ_INTERACTIONS_VALIDATION_AWS_ATTEMPTS).toEqual({ maxAttempts: 1 });
    expect(READ_INTERACTIONS_VALIDATION_PROVABLE_KINDS).toEqual({ facebook: ["comment", "reply"], instagram: ["comment"] });
    expect(READ_INTERACTIONS_VALIDATION_META_REQUESTS_PER_OPERATION).toEqual({ facebook: 2, instagram: 1 });
  });

  it("the task aborts with the fixed code of a refusal (no retry), never a message of its own", async () => {
    await import("@/jobs/trigger/integration/read-interactions-validation");
    const definition = sdk.tasks.find((task) => task["id"] === READ_INTERACTIONS_VALIDATION_TASK_ID);
    const run = definition?.["run"] as (payload: unknown, context: { ctx: unknown }) => Promise<unknown>;
    const ctx = { environment: { type: "DEVELOPMENT" }, deployment: undefined };
    await expect(run({ ...PAYLOAD, acknowledge: "nope" }, { ctx })).rejects.toThrow(new sdk.AbortTaskRunError("read_interactions_validation_input_refused"));
    await expect(run(PAYLOAD, { ctx })).rejects.toThrow(new sdk.AbortTaskRunError("read_interactions_validation_release_refused"));
  });
});

describe("guards: every refusal happens before any lookup, composition or provider request", () => {
  type Case = [name: string, failure: ReadInteractionsValidationFailure, change: { payload?: unknown; env?: Env; run?: { environmentType: string | undefined; release: JobRelease }; node?: string }];
  const cases: Case[] = [
    ["no payload", "read_interactions_validation_input_refused", { payload: null }],
    ["the read_content acknowledgement", "read_interactions_validation_input_refused", { payload: { ...PAYLOAD, acknowledge: "INTEGRATION_READ_CONTENT_VALIDATION_V1" } }],
    ["a missing account", "read_interactions_validation_input_refused", { payload: { acknowledge: PAYLOAD.acknowledge, workspace_id: WORKSPACE } }],
    ["an extra field (a post id)", "read_interactions_validation_input_refused", { payload: { ...PAYLOAD, post_id: POST } }],
    ["an extra field (a comment id)", "read_interactions_validation_input_refused", { payload: { ...PAYLOAD, comment_id: COMMENT } }],
    ["an extra field (a cursor)", "read_interactions_validation_input_refused", { payload: { ...PAYLOAD, cursor: CURSOR } }],
    ["an extra field (a token)", "read_interactions_validation_input_refused", { payload: { ...PAYLOAD, access_token: USER_TOKEN } }],
    ["a non-UUID account", "read_interactions_validation_input_refused", { payload: { ...PAYLOAD, connected_account_id: PAGE } }],
    ["a local development run", "read_interactions_validation_release_refused", { run: { environmentType: "DEVELOPMENT", release: { kind: "development" } } }],
    ["a deployed run without an external id", "read_interactions_validation_release_refused", { run: { environmentType: "PRODUCTION", release: { kind: "unidentified" } } }],
    ["the main plane's system database credential", "read_interactions_validation_plane_refused", { env: { DATABASE_SYSTEM_URL: "postgres://synthetic" } }],
    ["the Meta app secret", "read_interactions_validation_plane_refused", { env: { PROVIDER_META_CLIENT_SECRET: "synthetic" } }],
    ["APP_DEPLOYMENT_ENV=production", "read_interactions_validation_tier_refused", { env: { APP_DEPLOYMENT_ENV: "production" } }],
    ["Node 20", "read_interactions_validation_runtime_refused", { node: "v20.19.0" }],
    ["the staging stub provider mode", "read_interactions_validation_provider_mode_refused", { env: { CAPABILITY_PROVIDER_MODE: "staging_stub" } }],
    ["the local keyring (no KMS)", "read_interactions_validation_keyring_refused", { env: { NODE_ENV: "test", CREDENTIAL_CONTEXT_ENV: undefined, CREDENTIAL_KMS_KEY_ARN: undefined, CREDENTIAL_KMS_ALLOWED_KEY_ARNS: undefined } }],
  ];

  it.each(cases)("%s → %s", async (_name, failure, change) => {
    const h = harness({}, change.node === undefined ? {} : { deps: { nodeVersion: change.node } });
    expect(await refused(h.run("payload" in change ? change.payload : PAYLOAD, { ...DEPLOYED, ...change.env }, change.run ?? RUN))).toBe(failure);
    expect([h.lookups, h.composed, h.world.calls, h.openings]).toEqual([[], [], [], []]);
  });

  it.each([
    ["not_found", "read_interactions_validation_target_not_found"],
    ["inactive", "read_interactions_validation_target_inactive"],
    ["not_meta_content_account", "read_interactions_validation_target_not_meta_content_account"],
    ["credential_missing", "read_interactions_validation_credential_missing"],
  ] as const)("a %s target is refused before composition", async (kind, failure) => {
    const h = harness({}, { target: { kind } });
    expect(await refused(h.run())).toBe(failure);
    expect([h.composed, h.world.calls]).toEqual([[], []]);
  });

  it("only an ACTIVE content-bearing Facebook Page or Instagram account of a live Meta connection with its credential is a target", () => {
    const account = { id: ACCOUNT, status: "ACTIVE", platform: "facebook", assetClass: "content_bearing", providerAssetId: PAGE, connectionId: "c" } as never;
    const connection = { id: "c", status: "ACTIVE", provider: "meta", activeCredentialId: CREDENTIAL_ID } as never;
    const credential = { connectionId: "c", envelope: new Uint8Array([9]) };
    expect(classifyTarget(account, connection, credential)).toMatchObject({ kind: "found", platform: "facebook" });
    expect(classifyTarget({ ...(account as object), platform: "tiktok" } as never, connection, credential)).toEqual({ kind: "not_meta_content_account" });
    expect(classifyTarget({ ...(account as object), assetClass: "ad_account" } as never, connection, credential)).toEqual({ kind: "not_meta_content_account" });
    expect(classifyTarget(account, connection, { ...credential, connectionId: "other" })).toEqual({ kind: "credential_missing" });
  });
});

// ── Facebook ────────────────────────────────────────────────────────────────────────────────────────────────

describe("Facebook: listContent → listInteractions → getInteraction per observed kind, inside ONE credential opening", () => {
  it("empty content: 2 Meta GETs, no interaction read, INCONCLUSIVE_EMPTY_CONTENT, never evidence", async () => {
    const h = harness({ contents: { data: [] } });
    const outcome = await h.run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.stages, outcome.expectedMetaRequests, h.world.calls.length, outcome.positiveEvidenceEligible]).toEqual(["INCONCLUSIVE_EMPTY_CONTENT", ["list_content"], 2, 2, false]);
    expect(outcome.interactions.attempted).toBe(false);
  });

  it("content but no interactions: 4 Meta GETs, INCONCLUSIVE_EMPTY_INTERACTIONS, never evidence", async () => {
    const h = harness({ comments: { data: [] } });
    const outcome = await h.run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.stages, outcome.expectedMetaRequests, h.world.calls.length]).toEqual(["INCONCLUSIVE_EMPTY_INTERACTIONS", ["list_content", "list_interactions"], 4, 4]);
    expect([outcome.evidenceInteractionKinds, outcome.interactionKindsObserved, h.openings.length]).toEqual([null, [], 1]);
  });

  it("comment-only: 6 Meta GETs; comments proven, replies not — INCONCLUSIVE_COMMENT_ONLY with limited evidence [comment]", async () => {
    const h = harness(FB_COMMENT_ONLY);
    const outcome = await h.run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.stages, outcome.expectedMetaRequests, h.world.calls.length]).toEqual(["INCONCLUSIVE_COMMENT_ONLY", ["list_content", "list_interactions", "get_comment"], 6, 6]);
    expect([outcome.interactionKindsObserved, outcome.interactionKindsValidated, outcome.evidenceInteractionKinds, outcome.positiveEvidenceEligible]).toEqual([["comment"], ["comment"], ["comment"], true]);
    expect(outcome.comment).toEqual({ observed: true, attempted: true, succeeded: true, refCorrelated: true, contentCorrelated: true, kindCorrelated: true, authorCorrelated: true, parentCorrelated: true, correlated: true, error: null });
    expect(outcome.reply).toMatchObject({ observed: false, attempted: false });
    expect(outcome.interactions).toMatchObject({ itemCount: 2, commentCount: 2, replyCount: 0, pagination: "more", allOnSelectedContent: true, parentShapeConsistent: true });
    expect([outcome.content.selectedContentKind, outcome.content.selectedSource, outcome.accountKind, outcome.authorization]).toEqual(["post", "unknown", "facebook_page", "AUTHORIZED_READS_OBSERVED"]);
    // The Page token is derived before EACH operation; the comment node is the FIRST listed comment.
    expect(h.world.calls.filter((url) => url.searchParams.get("fields") === "access_token")).toHaveLength(3);
    expect(decodeURIComponent(h.world.calls.at(-1)?.pathname ?? "")).toBe(`/v25.0/${COMMENT}`);
  });

  it("comment + reply: 8 Meta GETs; both re-read and correlated — evidence [comment, reply]", async () => {
    const h = harness(FB_COMMENT_AND_REPLY);
    const outcome = await h.run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.stages, outcome.expectedMetaRequests, h.world.calls.length]).toEqual(["READ_INTERACTIONS_LIST_AND_GET_SUCCEEDED", ["list_content", "list_interactions", "get_comment", "get_reply"], 8, 8]);
    expect([outcome.interactionKindsObserved, outcome.interactionKindsValidated, outcome.evidenceInteractionKinds]).toEqual([["comment", "reply"], ["comment", "reply"], ["comment", "reply"]]);
    expect([outcome.comment.correlated, outcome.reply.correlated, outcome.reply.parentCorrelated]).toEqual([true, true, true]);
    expect(outcome.interactions.authorRoles).toEqual({ account_identity: 1, user: 1, unknown: 0 });
  });

  it("a reply without a comment is re-read but never evidence: INCONCLUSIVE_REPLY_WITHOUT_COMMENT", async () => {
    const h = harness({ comments: { data: [fbReply(REPLY, COMMENT)] }, nodes: { [REPLY]: { ...fbReply(REPLY, COMMENT), object: { id: POST } } } });
    const outcome = await h.run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.evidenceInteractionKinds, outcome.positiveEvidenceEligible, outcome.interactionKindsValidated]).toEqual(["INCONCLUSIVE_REPLY_WITHOUT_COMMENT", null, false, ["reply"]]);
    expect([outcome.expectedMetaRequests, h.world.calls.length]).toEqual([6, 6]);
  });


  it.each(mismatches)("a comment re-read with another %s → CORRELATION_FAILURE, never evidence", async (_label, field, tamper) => {
    const outcome = await harness(FB_COMMENT_ONLY, { tamper }).run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.comment[field], outcome.comment.correlated, outcome.evidenceInteractionKinds, outcome.positiveEvidenceEligible]).toEqual(["CORRELATION_FAILURE", false, false, null, false]);
  });

  it.each(mismatches)("a reply re-read with another %s → CORRELATION_FAILURE; the comment alone is not offered as evidence either", async (_label, field, tamper) => {
    const onlyReply: Tamper = (dto) => (dto.interactionKind === "reply" || dto.parent !== null ? tamper(dto) : dto);
    const outcome = await harness(FB_COMMENT_AND_REPLY, { tamper: onlyReply }).run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.comment.correlated, outcome.reply[field], outcome.reply.correlated, outcome.evidenceInteractionKinds]).toEqual(["CORRELATION_FAILURE", true, false, false, null]);
  });

  it("a listed interaction on another content item is a CORRELATION_FAILURE", async () => {
    const offContent: ProviderReadPort = metaWorld(FB_COMMENT_ONLY).read;
    const h = harness(FB_COMMENT_ONLY, {
      deps: {
        compose: () => ({
          access: { withCredential: (_input, use) => use(providerCredential("synthetic-diagnostic-credential", USER_TOKEN)) },
          read: { ...offContent, listInteractions: async (access, scope, window, cursor) => {
            const page = await offContent.listInteractions(access, scope, window, cursor);
            return { ...page, data: { ...page.data, items: page.data.items.map((item) => ({ ...item, content: providerObjectRef("facebook", "content", `${PAGE}_990000000000098`) })) } };
          } },
        }),
      },
    });
    const outcome = await h.run();
    expect([outcome.result, outcome.interactions.allOnSelectedContent, outcome.evidenceInteractionKinds]).toEqual(["CORRELATION_FAILURE", false, null]);
  });

  it("permission missing on the comments edge → PERMISSION_MISSING (read_interactions), no re-read", async () => {
    const h = harness({ comments: { error: { code: 10, message: BODY_MARKER } }, commentsStatus: 403 });
    const outcome = await h.run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.authorization, outcome.interactions.error, outcome.expectedMetaRequests]).toEqual(["PERMISSION_MISSING", "PERMISSION_MISSING_OBSERVED", { kind: "permission_missing", detail: "read_interactions" }, 4]);
  });

  it("a target-not-eligible provider answer → TARGET_NOT_ELIGIBLE", async () => {
    const outcome = await harness(FB_COMMENT_ONLY, { failList: new TargetNotEligibleError("listInteractions", "unsupported_for_target") }).run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.interactions.error]).toEqual(["TARGET_NOT_ELIGIBLE", { kind: "target_not_eligible", detail: "unsupported_for_target" }]);
  });

  it("a malformed provider page (an author missing) → MALFORMED_RESPONSE, the whole page refused", async () => {
    const outcome = await harness({ comments: { data: [fbComment(COMMENT), fbComment(COMMENT_2, { from: undefined })] } }).run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.interactions.succeeded, outcome.interactions.itemCount, outcome.evidenceInteractionKinds]).toEqual(["MALFORMED_RESPONSE", false, 0, null]);
  });

  it("a failed comment re-read (100/33) → PROVIDER_FAILURE, never evidence", async () => {
    const outcome = await harness({ comments: { data: [fbComment(COMMENT)] }, nodes: {} }).run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.comment.succeeded, outcome.comment.error, outcome.evidenceInteractionKinds]).toEqual(["PROVIDER_FAILURE", false, { kind: "target_not_found", detail: null }, null]);
  });
});

// ── Instagram ───────────────────────────────────────────────────────────────────────────────────────────────

describe("Instagram: /media → /comments → the comment node, with the User token directly", () => {
  const ig = (graph: Graph, options: Parameters<typeof harness>[1] = {}) => harness(graph, { target: IG_FOUND, ...options });

  it("empty content: 1 Meta GET, INCONCLUSIVE_EMPTY_CONTENT", async () => {
    const h = ig({ contents: { data: [] } });
    const outcome = await h.run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.expectedMetaRequests, h.world.calls.length, outcome.accountKind]).toEqual(["INCONCLUSIVE_EMPTY_CONTENT", 1, 1, "instagram_professional_account"]);
  });

  it("media but no comments: 2 Meta GETs, INCONCLUSIVE_EMPTY_INTERACTIONS", async () => {
    const h = ig({ comments: { data: [] } });
    const outcome = await h.run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.expectedMetaRequests, h.world.calls.length]).toEqual(["INCONCLUSIVE_EMPTY_INTERACTIONS", 2, 2]);
  });

  it("a comment: 3 Meta GETs, no Page token, LIST_AND_GET_SUCCEEDED with evidence [comment] only", async () => {
    const h = ig(IG_COMMENT_GRAPH);
    const outcome = await h.run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.stages, outcome.expectedMetaRequests, h.world.calls.length]).toEqual(["READ_INTERACTIONS_LIST_AND_GET_SUCCEEDED", ["list_content", "list_interactions", "get_comment"], 3, 3]);
    expect([outcome.evidenceInteractionKinds, outcome.interactionKindsObserved, outcome.reply.observed]).toEqual([["comment"], ["comment"], false]);
    expect(h.world.calls.some((url) => url.searchParams.get("fields") === "access_token")).toBe(false);
    expect(h.world.calls.every((url) => url.searchParams.get("access_token") === USER_TOKEN)).toBe(true);
  });

  it.each(mismatches)("a comment re-read with another %s → CORRELATION_FAILURE", async (_label, field, tamper) => {
    const outcome = await ig(IG_COMMENT_GRAPH, { tamper }).run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.comment[field], outcome.evidenceInteractionKinds]).toEqual(["CORRELATION_FAILURE", false, null]);
  });

  it("a reply on Instagram can never be evidence: a listed reply is a CORRELATION_FAILURE of the slice", async () => {
    const real = metaWorld(IG_COMMENT_GRAPH).read;
    const h = ig(IG_COMMENT_GRAPH, {
      deps: {
        compose: () => ({
          access: { withCredential: (_input, use) => use(providerCredential("synthetic-diagnostic-credential", USER_TOKEN)) },
          read: { ...real, listInteractions: async (...args) => {
            const page = await real.listInteractions(...args);
            const [first] = page.data.items;
            const reply = first === undefined ? [] : [{ ...first, ref: providerObjectRef("instagram", "interaction", "17950000000000039"), interactionKind: "reply" as const, parent: first.ref }];
            return { ...page, data: { ...page.data, items: [...page.data.items, ...reply] } };
          } },
        }),
      },
    });
    const outcome = await h.run();
    expect([outcome.result, outcome.evidenceInteractionKinds]).toEqual(["CORRELATION_FAILURE", null]);
    // Observed, never re-read: no GET is spent on a kind this slice cannot prove.
    expect([outcome.reply.observed, outcome.reply.attempted, outcome.stages, outcome.expectedMetaRequests]).toEqual([true, false, ["list_content", "list_interactions", "get_comment"], 3]);
  });

  it("a provider reply (parent_id) fails the page closed → MALFORMED_RESPONSE", async () => {
    const outcome = await ig({ comments: { data: [igComment(IG_COMMENT, { parent_id: "17950000000000032" })] } }).run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.evidenceInteractionKinds]).toEqual(["MALFORMED_RESPONSE", null]);
  });

  it("permission missing → PERMISSION_MISSING", async () => {
    const outcome = await ig({ comments: { error: { code: 200, message: BODY_MARKER } }, commentsStatus: 403 }).run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.authorization, outcome.expectedMetaRequests]).toEqual(["PERMISSION_MISSING", "PERMISSION_MISSING_OBSERVED", 2]);
  });
});

// ── Bounded candidate scan (Step 7G-H5.5-P12-C4) ─────────────────────────────────────────────────────────────

describe("the bounded candidate scan: the first in-window content item WITH an interaction, at most CANDIDATE_LIMIT", () => {
  const P1 = `${PAGE}_990000000000101`;
  const P2 = `${PAGE}_990000000000102`;
  const P3 = `${PAGE}_990000000000103`;
  const P4 = `${PAGE}_990000000000104`;
  const C2 = "990000000000102_770000000000201";
  const R2 = "990000000000102_770000000000202";
  const C3 = "990000000000103_770000000000301";
  const R3 = "990000000000103_770000000000302";
  const M1 = "17900000000000101";
  const M2 = "17900000000000102";
  const IGC2 = "17950000000000201";
  const posts = (...ids: string[]) => ({ data: ids.map(post) });
  const empty = { body: { data: [] } };
  const commentsOf = (graph: Graph): string[] => graph.commentsByContent === undefined ? [] : Object.keys(graph.commentsByContent);
  const commentListCalls = (h: ReturnType<typeof harness>) => h.world.calls.filter((url) => url.pathname.endsWith("/comments")).map((url) => decodeURIComponent(url.pathname.split("/")[2] ?? ""));
  const fbOn = (postId: string, commentId: string, replyId?: string): NonNullable<Graph["nodes"]> => ({
    [commentId]: fbComment(commentId, { object: { id: postId } }),
    ...(replyId === undefined ? {} : { [replyId]: { ...fbReply(replyId, commentId), object: { id: postId } } }),
  });

  it("is a fixed limit of 3 content candidates", () => {
    expect(READ_INTERACTIONS_VALIDATION_CANDIDATE_LIMIT).toBe(3);
  });

  it("position 1 has no interactions, position 2 has comment + reply → position 2 is selected; full evidence; 10 GETs", async () => {
    const graph: Graph = { contents: posts(P1, P2, P3), commentsByContent: { [P1]: empty, [P2]: { body: { data: [fbComment(C2), fbReply(R2, C2)] } } }, nodes: fbOn(P2, C2, R2) };
    const h = harness(graph);
    const outcome = await h.run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.selectedCandidatePosition, outcome.candidatesInspected, outcome.evidenceInteractionKinds]).toEqual(["READ_INTERACTIONS_LIST_AND_GET_SUCCEEDED", 2, 2, ["comment", "reply"]]);
    expect([outcome.stages, outcome.expectedMetaRequests, h.world.calls.length]).toEqual([["list_content", "list_interactions", "list_interactions", "get_comment", "get_reply"], 10, 10]);
    // The scan stops at the selected candidate: position 3 is never listed.
    expect(commentListCalls(h)).toEqual([P1, P2]);
    expect(outcome.interactions).toMatchObject({ itemCount: 2, commentCount: 1, replyCount: 1, allOnSelectedContent: true });
  });

  it("Facebook worst case: positions 1 and 2 empty, position 3 has comment + reply → 12 GETs (2·(1 + N + 2)), never more", async () => {
    const graph: Graph = { contents: posts(P1, P2, P3, P4), commentsByContent: { [P1]: empty, [P2]: empty, [P3]: { body: { data: [fbComment(C3), fbReply(R3, C3)] } } }, nodes: fbOn(P3, C3, R3) };
    const h = harness(graph);
    const outcome = await h.run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.selectedCandidatePosition, outcome.expectedMetaRequests, h.world.calls.length]).toEqual(["READ_INTERACTIONS_LIST_AND_GET_SUCCEEDED", 3, 12, 12]);
    expect(commentListCalls(h)).toEqual([P1, P2, P3]);
  });

  it("all N candidates empty → INCONCLUSIVE_EMPTY_INTERACTIONS; the (N+1)th item is never listed", async () => {
    const graph: Graph = { contents: posts(P1, P2, P3, P4), commentsByContent: { [P1]: empty, [P2]: empty, [P3]: empty, [P4]: { body: { data: [fbComment(C2)] } } } };
    const h = harness(graph);
    const outcome = await h.run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.selectedCandidatePosition, outcome.candidatesInspected, outcome.evidenceInteractionKinds]).toEqual(["INCONCLUSIVE_EMPTY_INTERACTIONS", null, 3, null]);
    expect([outcome.expectedMetaRequests, h.world.calls.length]).toEqual([8, 8]);
    expect(commentListCalls(h)).toEqual([P1, P2, P3]);
    expect(commentsOf(graph)).toContain(P4); // present in the world, deliberately never reached
  });

  it("the bound holds however many items the content page carries (10 empty posts → exactly 3 comment lists)", async () => {
    const ids = Array.from({ length: 10 }, (_v, i) => `${PAGE}_9900000000002${String(i).padStart(2, "0")}`);
    const h = harness({ contents: posts(...ids), comments: { data: [] } });
    const outcome = await h.run();
    expectOutcomeSchema(outcome);
    expect([outcome.content.itemCount, outcome.candidatesInspected, commentListCalls(h).length, outcome.expectedMetaRequests]).toEqual([10, 3, 3, 8]);
  });

  it("a comment without a reply on the selected Facebook candidate → INCONCLUSIVE_COMMENT_ONLY (limited evidence [comment])", async () => {
    const graph: Graph = { contents: posts(P1, P2), commentsByContent: { [P1]: empty, [P2]: { body: { data: [fbComment(C2)] } } }, nodes: fbOn(P2, C2) };
    const outcome = await harness(graph).run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.selectedCandidatePosition, outcome.evidenceInteractionKinds, outcome.expectedMetaRequests]).toEqual(["INCONCLUSIVE_COMMENT_ONLY", 2, ["comment"], 8]);
  });

  it("Instagram: media 1 has no comments, media 2 has one → media 2 selected; 4 GETs; worst case 5 (1 + N + 1)", async () => {
    const two: Graph = { contents: { data: [media(M1), media(M2)] }, commentsByContent: { [M1]: empty, [M2]: { body: { data: [igComment(IGC2, { media: { id: M2 } })] } } }, nodes: { [IGC2]: igComment(IGC2, { media: { id: M2 } }) } };
    const h = harness(two, { target: IG_FOUND });
    const outcome = await h.run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.selectedCandidatePosition, outcome.evidenceInteractionKinds, outcome.expectedMetaRequests, h.world.calls.length]).toEqual(["READ_INTERACTIONS_LIST_AND_GET_SUCCEEDED", 2, ["comment"], 4, 4]);
    const M3 = "17900000000000103";
    const IGC3 = "17950000000000301";
    const worst: Graph = { contents: { data: [media(M1), media(M2), media(M3)] }, commentsByContent: { [M1]: empty, [M2]: empty, [M3]: { body: { data: [igComment(IGC3, { media: { id: M3 } })] } } }, nodes: { [IGC3]: igComment(IGC3, { media: { id: M3 } }) } };
    const w = harness(worst, { target: IG_FOUND });
    const worstOutcome = await w.run();
    expectOutcomeSchema(worstOutcome);
    expect([worstOutcome.selectedCandidatePosition, worstOutcome.expectedMetaRequests, w.world.calls.length]).toEqual([3, 5, 5]);
  });

  it("a provider error during the scan fails closed: PROVIDER_FAILURE, no later candidate, never evidence", async () => {
    const graph: Graph = { contents: posts(P1, P2, P3), commentsByContent: { [P1]: empty, [P2]: { body: `<html>${BODY_MARKER}</html>`, status: 502 }, [P3]: { body: { data: [fbComment(C3)] } } }, nodes: fbOn(P3, C3) };
    const h = harness(graph);
    const outcome = await h.run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.selectedCandidatePosition, outcome.candidatesInspected, outcome.evidenceInteractionKinds, outcome.interactions.succeeded]).toEqual(["PROVIDER_FAILURE", null, 2, null, false]);
    expect(commentListCalls(h)).toEqual([P1, P2]);
  });

  it("a permission error during the scan → PERMISSION_MISSING (read_interactions), no later candidate", async () => {
    const graph: Graph = { contents: posts(P1, P2, P3), commentsByContent: { [P1]: empty, [P2]: { body: { error: { code: 10, message: BODY_MARKER } }, status: 403 } } };
    const h = harness(graph);
    const outcome = await h.run();
    expectOutcomeSchema(outcome);
    expect([outcome.result, outcome.authorization, outcome.interactions.error, outcome.candidatesInspected]).toEqual(["PERMISSION_MISSING", "PERMISSION_MISSING_OBSERVED", { kind: "permission_missing", detail: "read_interactions" }, 2]);
    expect(commentListCalls(h)).toEqual([P1, P2]);
  });

  it("no pagination is followed anywhere in the scan: no cursor is sent, no next URL is fetched", async () => {
    const graph: Graph = { contents: withNext([post(P1), post(P2), post(P3)]), commentsByContent: { [P1]: { body: withNext([]) }, [P2]: { body: withNext([]) }, [P3]: { body: withNext([]) } } };
    const h = harness(graph);
    const outcome = await h.run();
    expectOutcomeSchema(outcome);
    expect(h.world.calls.some((url) => url.searchParams.has("after"))).toBe(false);
    expect(h.world.calls.some((url) => url.href.includes("/next"))).toBe(false);
    expect([outcome.result, outcome.interactions.pagination, outcome.candidatesInspected]).toEqual(["INCONCLUSIVE_EMPTY_INTERACTIONS", "more", 3]);
  });
});

// ── Budgets, writes, redaction ──────────────────────────────────────────────────────────────────────────────

describe("the request budget and the absence of writes", () => {
  it("Meta GETs per path: Facebook 2/4/6/8, Instagram 1/2/3 — the outcome's expectation equals the GETs actually made", async () => {
    const runs = [
      [harness({ contents: { data: [] } }), 2],
      [harness({ comments: { data: [] } }), 4],
      [harness(FB_COMMENT_ONLY), 6],
      [harness(FB_COMMENT_AND_REPLY), 8],
      [harness({ contents: { data: [] } }, { target: IG_FOUND }), 1],
      [harness({ comments: { data: [] } }, { target: IG_FOUND }), 2],
      [harness(IG_COMMENT_GRAPH, { target: IG_FOUND }), 3],
    ] as const;
    for (const [h, gets] of runs) {
      const outcome = await h.run();
      expect([outcome.expectedMetaRequests, h.world.calls.length]).toEqual([gets, gets]);
      expect(h.openings).toHaveLength(1);
    }
  });

  it("no paging.next is followed and no cursor is sent: one provider page of each list", async () => {
    const h = harness(FB_COMMENT_ONLY);
    await h.run();
    expect(h.world.calls.some((url) => url.searchParams.has("after"))).toBe(false);
    expect(h.world.calls.some((url) => url.href.includes("/next"))).toBe(false);
  });

  it("the outcome carries no text, name, handle, provider id, ref, cursor, raw reference or token on any path", async () => {
    for (const h of [harness(FB_COMMENT_AND_REPLY), harness(FB_COMMENT_ONLY, { tamper: (dto) => ({ ...dto, text: `${TEXT} changed` }) }), harness(IG_COMMENT_GRAPH, { target: IG_FOUND })]) {
      const outcome = await h.run();
      expectOutcomeSchema(outcome);
      // Text, name, handle and visibility are never identity: a changed text alone still correlates.
      expect(outcome.comment.correlated).toBe(true);
    }
  });
});
