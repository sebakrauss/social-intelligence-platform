/**
 * Meta read_interactions — listInteractions and getInteraction (Step 7G-H5.5-P12-B1; design/phase-7g/meta-provider/
 * README.md › read_interactions — IMPLEMENTED_OFFLINE_NOT_REGISTERED), offline.
 *
 *   Facebook   comments AND replies of ONE managed Page post: a Page token derived per call, then ONE page of
 *              `{post-id}/comments?filter=stream`, or the `{comment-id}` node (whose `object.id` is its only content
 *              authority). A reply is exactly a comment with `parent.id`.
 *   Instagram  top-level comments ONLY of ONE managed media, with the sealed User token directly: ONE page of
 *              `{ig-media-id}/comments`, or the `{ig-comment-id}` node. A `parent_id` fails closed.
 *
 * Both: `from.id` required (a missing author fails the WHOLE page), the same `meta1.` envelope, a client-side window,
 * no account-wide feed. `fetch` is an in-process double: no request leaves the process. Synthetic ids, texts, names and
 * tokens only.
 */
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderError,
  providerCredential,
  providerObjectRef,
  type InteractionDto,
  type InteractionScope,
  type IsoInstant,
  type PageCursor,
  type ProviderErrorKind,
  type ProviderObjectRef,
  type TimeWindow,
} from "@/integrations/providers/contract";
import {
  META_FACEBOOK_COMMENTS_PAGE_LIMIT,
  META_FACEBOOK_COMMENT_FIELDS,
  META_FACEBOOK_COMMENT_NODE_FIELDS,
  META_INSTAGRAM_COMMENTS_PAGE_LIMIT,
  META_INSTAGRAM_COMMENT_FIELDS,
  META_INSTAGRAM_MEDIA_FIELDS,
  META_POST_FIELDS,
  createMetaGraphTransport,
  type MetaGraphFetch,
} from "@/integrations/providers/meta/graph-transport";
import { createMetaReadPort } from "@/integrations/providers/meta/read-port";
import { expectInteraction, expectResult } from "../contract/assertions";

const USER_TOKEN = "synthetic-meta-user-token-marker";
const PAGE_TOKEN = "synthetic-meta-page-token-marker";
const BODY_MARKER = "synthetic-meta-graph-body-marker";
const TEXT_MARKER = "Synthetic comment text marker";
const NAME_MARKER = "Synthetic Commenter Name Marker";
const HANDLE_MARKER = "synthetic_commenter_handle";
const HOSTILE_NEXT = "https://attacker.example.test/steal?access_token=x";
const RAW_AFTER = "QVFIUmlnQWZ0ZXI";
const CREDENTIAL = providerCredential("5eed0000-d1a9-4000-8000-00000000e021", USER_TOKEN);
const WINDOW: TimeWindow = { from: "2026-09-22T00:00:00.000Z" as IsoInstant, to: "2026-10-22T00:00:00.000Z" as IsoInstant };

// Facebook: the managed Page, one of its posts, comments on it and the people who wrote them.
const PAGE = "1001";
const POST = `${PAGE}_2001`;
const OTHER_POST = `${PAGE}_2002`;
const FB_COMMENT = "2001_3001";
const FB_REPLY = "2001_3002";
const FB_USER = "5001";
const FB_ACCESS = { credential: CREDENTIAL, account: providerObjectRef("facebook", "asset", PAGE) };
const FB_POST_REF = providerObjectRef("facebook", "content", POST);

// Instagram: the managed professional account, one of its media, top-level comments and their authors.
const IG = "17840000000000001";
const MEDIA = "17900000000000001";
const OTHER_MEDIA = "17900000000000002";
const IG_COMMENT = "17950000000000001";
const IG_COMMENT_B = "17950000000000002";
const IG_USER = "17960000000000001";
const IG_ACCESS = { credential: CREDENTIAL, account: providerObjectRef("instagram", "asset", IG) };
const IG_MEDIA_REF = providerObjectRef("instagram", "content", MEDIA);

const renderings = (value: unknown): string => {
  const error = value instanceof Error ? `${value.message} ${value.stack ?? ""} ${String(value.cause)}` : "";
  return [JSON.stringify(value), String(value), inspect(value, { depth: 10, showHidden: true }), error].join(" ");
};
const expectNoneOf = (value: unknown, secrets: readonly string[]): void => {
  const rendered = renderings(value);
  for (const secret of secrets) expect(rendered, secret).not.toContain(secret);
};

const json = (status: number, body: unknown): Promise<Response> => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const graphError = (fields: Record<string, unknown>) => ({ error: { message: BODY_MARKER, error_user_msg: BODY_MARKER, fbtrace_id: "synthetic-trace", ...fields } });

/** A Facebook comment in Meta's documented shape (created_time in the Graph `+0000` form). */
const fbComment = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  from: { id: FB_USER, name: `${NAME_MARKER} ${id}` },
  message: `${TEXT_MARKER} ${id}`,
  created_time: "2026-10-01T12:00:00+0000",
  ...patch,
});
const fbReply = (id: string, parent: string, patch: Record<string, unknown> = {}) => fbComment(id, { parent: { id: parent }, ...patch });
/** The node read of a comment: the same fields plus `object`. */
const fbNode = (id: string, patch: Record<string, unknown> = {}) => fbComment(id, { object: { id: POST }, ...patch });

/** An IG Comment in Meta's documented shape. */
const igComment = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  from: { id: IG_USER, username: `${HANDLE_MARKER}_${id}` },
  text: `${TEXT_MARKER} ${id}`,
  timestamp: "2026-10-01T12:00:00+0000",
  media: { id: MEDIA },
  ...patch,
});

interface Call {
  readonly url: URL;
  readonly init: RequestInit;
}
type Reply = (url: URL, call: Call) => Promise<Response>;

/** The token derivation answer (the Page node with its access_token, as Meta returns it). */
const TOKEN_REPLY = (): Promise<Response> => json(200, { access_token: PAGE_TOKEN, id: PAGE });

type World = { readonly pages?: Readonly<Record<string, unknown>>; readonly nodes?: Readonly<Record<string, unknown>>; readonly token?: Reply };

/** A Facebook Graph double: Page token derivation, `{post-id}/comments` pages keyed by `after`, comment nodes. */
function facebookGraph(world: World = {}): Reply {
  return (url, call) => {
    const fields = url.searchParams.get("fields");
    const segments = url.pathname.split("/").slice(2).map(decodeURIComponent);
    if (segments.length === 1 && fields === "access_token") return (world.token ?? TOKEN_REPLY)(url, call);
    if (segments.length === 2 && segments[1] === "comments" && fields === META_FACEBOOK_COMMENT_FIELDS) {
      const body = (world.pages ?? {})[url.searchParams.get("after") ?? ""];
      return body === undefined ? json(400, graphError({ code: 100 })) : json(200, body);
    }
    if (segments.length === 1 && fields === META_FACEBOOK_COMMENT_NODE_FIELDS) {
      const body = (world.nodes ?? {})[segments[0] ?? ""];
      return body === undefined ? json(400, graphError({ code: 100, error_subcode: 33 })) : json(200, body);
    }
    return json(400, graphError({ code: 100 }));
  };
}

/** An Instagram Graph double: `{ig-media-id}/comments` pages keyed by `after`, comment nodes. No token derivation. */
function instagramGraph(world: World = {}): Reply {
  return (url) => {
    const fields = url.searchParams.get("fields");
    const segments = url.pathname.split("/").slice(2).map(decodeURIComponent);
    if (segments.length === 2 && segments[1] === "comments" && fields === META_INSTAGRAM_COMMENT_FIELDS) {
      const body = (world.pages ?? {})[url.searchParams.get("after") ?? ""];
      return body === undefined ? json(400, graphError({ code: 100 })) : json(200, body);
    }
    if (segments.length === 1 && fields === META_INSTAGRAM_COMMENT_FIELDS) {
      const body = (world.nodes ?? {})[segments[0] ?? ""];
      return body === undefined ? json(400, graphError({ code: 100, error_subcode: 33 })) : json(200, body);
    }
    return json(400, graphError({ code: 100 }));
  };
}

function harness(reply: Reply) {
  const calls: Call[] = [];
  /** While set, a comments-edge request is answered with this page (the prelisting of a re-read, Step 7G-H5.5-P12-C9). */
  let edge: unknown;
  const fetch: MetaGraphFetch = (url, init) => {
    const call = { url: new URL(url), init };
    calls.push(call);
    const segments = call.url.pathname.split("/").slice(2);
    if (edge !== undefined && segments.length === 2 && segments[1] === "comments") return json(200, edge);
    return reply(call.url, call);
  };
  const port = createMetaReadPort({ transport: createMetaGraphTransport({ fetch }) });
  /**
   * A re-read the only way the contract allows: list on THIS port (one edge page carrying `item`), then pass the exact
   * listed DTO back. The prelisting's requests are cleared so a test sees only the re-read's own requests.
   */
  const reread = async (access: typeof FB_ACCESS, scope: ProviderObjectRef<"content">, item: Record<string, unknown>, id: string) => {
    edge = { data: [item] };
    const page = (await port.listInteractions(access, { kind: "content", content: scope }, WINDOW, null)).data;
    edge = undefined;
    const listed = page.items.find((candidate) => candidate.ref.id === id);
    if (listed === undefined) throw new Error("prelisting did not list the interaction");
    calls.length = 0;
    return port.getInteraction(access, { kind: "listed", listed });
  };
  return {
    port,
    calls,
    reread,
    tokens: () => calls.map((call) => call.url.searchParams.get("access_token")),
    paths: () => calls.map((call) => `${call.url.pathname}?${call.url.searchParams.get("fields") ?? ""}`),
  };
}

function facebook(reply: Reply) {
  const h = harness(reply);
  return {
    ...h,
    list: (cursor: PageCursor | null = null, window: TimeWindow = WINDOW, content = FB_POST_REF) => h.port.listInteractions(FB_ACCESS, { kind: "content", content }, window, cursor),
    /** Re-reads `id` after listing it as `listedAs` (default: a top-level comment, or a reply to `parent`). */
    get: (id: string = FB_COMMENT, listedAs?: Record<string, unknown>, parent?: string) =>
      h.reread(FB_ACCESS, FB_POST_REF, listedAs ?? (parent === undefined ? fbComment(id) : fbComment(id, { parent: { id: parent } })), id),
  };
}

function instagram(reply: Reply) {
  const h = harness(reply);
  return {
    ...h,
    list: (cursor: PageCursor | null = null, window: TimeWindow = WINDOW, content = IG_MEDIA_REF) => h.port.listInteractions(IG_ACCESS, { kind: "content", content }, window, cursor),
    /** Re-reads `id` after listing it as `listedAs` (default: a top-level comment on the scoped media). */
    get: (id: string = IG_COMMENT, listedAs?: Record<string, unknown>) => h.reread(IG_ACCESS, IG_MEDIA_REF, listedAs ?? igComment(id), id),
  };
}

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  let settled: unknown;
  try {
    settled = await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
  throw new Error(`expected a provider failure, it resolved (${typeof settled})`);
}

const rejected = (operation: string, reasonCode: string) => ({ kind: "permanent_rejected", operation, retry: "never", details: { reasonCode } });
/** A refusal that names its closed diagnostic (Step 7G-H5.5-P12-C6): same kind, code and retry, never an id. */
const rejectedAs = (operation: string, reasonCode: string, diagnostic: string) => ({ kind: "permanent_rejected", operation, retry: "never", details: { reasonCode, diagnostic } });
const envelope = (raw: string): PageCursor => `meta1.${Buffer.from(raw, "latin1").toString("base64url")}` as PageCursor;
const ids = (items: readonly InteractionDto[]) => items.map((item) => item.ref.id);

const FB_STREAM = { "": { data: [fbComment(FB_COMMENT), fbReply(FB_REPLY, FB_COMMENT)] } };
const IG_PAGE = { "": { data: [igComment(IG_COMMENT)] } };

// ── Facebook ────────────────────────────────────────────────────────────────────────────────────────────────

describe("Facebook · transport: a Page token derived per operation, then ONE comment read", () => {
  it("listInteractions: derivation with the User token, then GET {post-id}/comments?filter=stream with the approved fields and fixed limit", async () => {
    const { list, calls, tokens, paths } = facebook(facebookGraph({ pages: FB_STREAM }));
    await list();
    expect(paths()).toEqual([`/v25.0/${PAGE}?access_token`, `/v25.0/${POST}/comments?${META_FACEBOOK_COMMENT_FIELDS}`]);
    expect(tokens()).toEqual([USER_TOKEN, PAGE_TOKEN]);
    const url = calls[1]?.url;
    expect(META_FACEBOOK_COMMENT_FIELDS).toBe("id,from,message,created_time,parent,is_hidden");
    expect(url?.searchParams.get("filter")).toBe("stream");
    expect(url?.searchParams.get("limit")).toBe(String(META_FACEBOOK_COMMENTS_PAGE_LIMIT));
    expect(META_FACEBOOK_COMMENTS_PAGE_LIMIT).toBe(10);
    // No cursor on the first page, no server-side window, no ordering parameter.
    expect([...(url?.searchParams.keys() ?? [])].sort()).toEqual(["access_token", "fields", "filter", "limit"]);
    for (const call of calls) {
      expect(call.url.origin).toBe("https://graph.facebook.com");
      expect(call.init.method).toBe("GET");
      expect(call.init.redirect).toBe("manual");
      expect(call.init.credentials).toBe("omit");
      expect(new Headers(call.init.headers).has("authorization")).toBe(false);
    }
  });

  it("getInteraction: derivation, then GET {comment-id} with the node fields (the edge fields plus object)", async () => {
    const { get, paths, tokens } = facebook(facebookGraph({ nodes: { [FB_COMMENT]: fbNode(FB_COMMENT) } }));
    await get();
    expect(paths()).toEqual([`/v25.0/${PAGE}?access_token`, `/v25.0/${FB_COMMENT}?${META_FACEBOOK_COMMENT_NODE_FIELDS}`]);
    expect(tokens()).toEqual([USER_TOKEN, PAGE_TOKEN]);
    expect(META_FACEBOOK_COMMENT_NODE_FIELDS).toBe("id,from,message,created_time,parent,is_hidden,object");
  });

  it("the Page token is derived again for EVERY operation: nothing is cached between calls", async () => {
    const { list, get, paths } = facebook(facebookGraph({ pages: FB_STREAM, nodes: { [FB_COMMENT]: fbNode(FB_COMMENT) } }));
    await list();
    await list();
    expect(paths().filter((path) => path.endsWith("?access_token"))).toHaveLength(2);
    expect(paths()).toHaveLength(4);
    // The re-read (its prelisting cleared by the helper) derives its own token again.
    await get();
    expect(paths().filter((path) => path.endsWith("?access_token"))).toHaveLength(1);
    expect(paths()).toHaveLength(2);
  });

  it("never reads replies edges, reactions, likes, attachments, private replies or the post itself", async () => {
    const { list, get, calls } = facebook(facebookGraph({ pages: FB_STREAM, nodes: { [FB_COMMENT]: fbNode(FB_COMMENT) } }));
    await list();
    await get();
    for (const call of calls) {
      expect(call.url.pathname).not.toMatch(/reactions|likes|replies|private_replies|published_posts|feed/);
      expect(call.url.searchParams.get("fields")).not.toBe(META_POST_FIELDS);
    }
    for (const fields of [META_FACEBOOK_COMMENT_FIELDS, META_FACEBOOK_COMMENT_NODE_FIELDS]) expect(fields).not.toMatch(/attachment|like|reaction|message_tags|permalink|private|can_|comment_count|\{/);
  });

  it("the Page and User tokens never appear in a result, a DTO, a raw reference or an error", async () => {
    expectNoneOf(await facebook(facebookGraph({ pages: FB_STREAM })).list(), [USER_TOKEN, PAGE_TOKEN, "access_token"]);
    expectNoneOf(await facebook(facebookGraph({ nodes: { [FB_COMMENT]: fbNode(FB_COMMENT) } })).get(), [USER_TOKEN, PAGE_TOKEN, "access_token"]);
    const failed = await failure(facebook(facebookGraph({ pages: { "": { data: [fbComment(FB_COMMENT, { from: undefined })] } } })).list());
    expectNoneOf(failed, [USER_TOKEN, PAGE_TOKEN, "access_token", BODY_MARKER]);
  });

  it("a failed derivation stops before the comment read and names read_interactions", async () => {
    const { list, calls } = facebook(facebookGraph({ pages: FB_STREAM, token: () => json(403, graphError({ code: 10 })) }));
    expect((await failure(list())).toJSON()).toMatchObject({ kind: "permission_missing", operation: "listInteractions", details: { capability: "read_interactions" } });
    expect(calls).toHaveLength(1);
  });
});

describe("Facebook · normalization: comment and reply from one stream", () => {
  it("a top-level comment and its reply, in one page, as exact InteractionDtos", async () => {
    const page = expectResult(await facebook(facebookGraph({ pages: FB_STREAM })).list());
    expect(page.next).toEqual({ kind: "end" });
    for (const item of page.items) expectInteraction(item, "meta");
    expect(page.items).toEqual([
      {
        ref: providerObjectRef("facebook", "interaction", FB_COMMENT),
        content: providerObjectRef("facebook", "content", POST),
        parent: null,
        interactionKind: "comment",
        author: { ref: providerObjectRef("facebook", "author", FB_USER), role: "user", displayName: `${NAME_MARKER} ${FB_COMMENT}`, handle: null },
        text: `${TEXT_MARKER} ${FB_COMMENT}`,
        textRevision: null,
        editedAt: null,
        visibility: "unknown",
        availability: "available",
        timestamps: { createdAt: "2026-10-01T12:00:00.000Z", updatedAt: null },
        rawReference: { provider: "meta", apiVersion: "v25.0", ref: `facebook:comment:${FB_COMMENT}` },
      },
      {
        ref: providerObjectRef("facebook", "interaction", FB_REPLY),
        content: providerObjectRef("facebook", "content", POST),
        parent: providerObjectRef("facebook", "interaction", FB_COMMENT),
        interactionKind: "reply",
        author: { ref: providerObjectRef("facebook", "author", FB_USER), role: "user", displayName: `${NAME_MARKER} ${FB_REPLY}`, handle: null },
        text: `${TEXT_MARKER} ${FB_REPLY}`,
        textRevision: null,
        editedAt: null,
        visibility: "unknown",
        availability: "available",
        timestamps: { createdAt: "2026-10-01T12:00:00.000Z", updatedAt: null },
        rawReference: { provider: "meta", apiVersion: "v25.0", ref: `facebook:comment:${FB_REPLY}` },
      },
    ]);
    expect(Object.isFrozen(page) && Object.isFrozen(page.items) && page.items.every((item) => Object.isFrozen(item) && Object.isFrozen(item.author))).toBe(true);
  });

  it("a mixed stream keeps provider order and classifies each item ONLY by parent.id", async () => {
    const data = [fbComment("2001_3011"), fbReply("2001_3012", "2001_3011"), fbComment("2001_3013"), fbReply("2001_3014", "2001_3013"), fbReply("2001_3015", "2001_3011")];
    const { items } = (await facebook(facebookGraph({ pages: { "": { data } } })).list()).data;
    expect(items.map((item) => [item.ref.id, item.interactionKind, item.parent?.id ?? null])).toEqual([
      ["2001_3011", "comment", null],
      ["2001_3012", "reply", "2001_3011"],
      ["2001_3013", "comment", null],
      ["2001_3014", "reply", "2001_3013"],
      ["2001_3015", "reply", "2001_3011"],
    ]);
  });

  it("a stray kind-like field never classifies: only parent.id makes a reply", async () => {
    const data = [fbComment("2001_3021", { type: "reply", kind: "reply" }), fbReply("2001_3022", "2001_3021", { type: "comment" })];
    const { items } = (await facebook(facebookGraph({ pages: { "": { data } } })).list()).data;
    expect(items.map((item) => item.interactionKind)).toEqual(["comment", "reply"]);
  });

  it("author role: the managed Page itself is account_identity, anyone else is user; a missing name is null", async () => {
    const data = [fbComment("2001_3031", { from: { id: PAGE, name: "The Page" } }), fbComment("2001_3032", { from: { id: "5099" } })];
    const { items } = (await facebook(facebookGraph({ pages: { "": { data } } })).list()).data;
    expect(items.map((item) => item.author)).toEqual([
      { ref: providerObjectRef("facebook", "author", PAGE), role: "account_identity", displayName: "The Page", handle: null },
      { ref: providerObjectRef("facebook", "author", "5099"), role: "user", displayName: null, handle: null },
    ]);
  });

  it("visibility only from the reported is_hidden: true → hidden, false → visible, absent → unknown", async () => {
    const data = [fbComment("2001_3041", { is_hidden: true }), fbComment("2001_3042", { is_hidden: false }), fbComment("2001_3043")];
    const { items } = (await facebook(facebookGraph({ pages: { "": { data } } })).list()).data;
    expect(items.map((item) => item.visibility)).toEqual(["hidden", "visible", "unknown"]);
  });

  it("an explicitly empty message stays empty: text is never invented and never null", async () => {
    const { items } = (await facebook(facebookGraph({ pages: { "": { data: [fbComment(FB_COMMENT, { message: "" })] } } })).list()).data;
    expect(items[0]?.text).toBe("");
  });

  it("created_time in Graph's forms becomes one UTC instant", async () => {
    const data = [fbComment("2001_3051", { created_time: "2026-10-01T12:00:00+0000" }), fbComment("2001_3052", { created_time: "2026-10-01T14:00:00+02:00" }), fbComment("2001_3053", { created_time: "2026-10-01T12:00:00Z" })];
    const { items } = (await facebook(facebookGraph({ pages: { "": { data } } })).list()).data;
    expect(items.map((item) => item.timestamps.createdAt)).toEqual(["2026-10-01T12:00:00.000Z", "2026-10-01T12:00:00.000Z", "2026-10-01T12:00:00.000Z"]);
  });

  it("an empty page is a successful empty result that ends", async () => {
    expect((await facebook(facebookGraph({ pages: { "": { data: [] } } })).list()).data).toEqual({ items: [], next: { kind: "end" } });
  });

  it.each([
    ["no from", { from: undefined }],
    ["a from without id", { from: { name: NAME_MARKER } }],
    ["a from with a malformed id", { from: { id: "has space" } }],
    ["a non-object from", { from: FB_USER }],
    ["a non-string from.name", { from: { id: FB_USER, name: 7 } }],
    ["no id", { id: undefined }],
    ["no message", { message: undefined }],
    ["a non-string message", { message: 7 }],
    ["no created_time", { created_time: undefined }],
    ["a malformed created_time", { created_time: "yesterday" }],
    ["an impossible created_time", { created_time: "2026-02-30T12:00:00+0000" }],
    ["a non-boolean is_hidden", { is_hidden: "false" }],
    ["a parent without id", { parent: {} }],
    ["a parent as a bare string", { parent: FB_COMMENT }],
    ["a parent with a malformed id", { parent: { id: "../me" } }],
    ["a null parent", { parent: null }],
    ["a comment that names itself as its parent", { parent: { id: "2001_3099" } }],
  ])("%s fails the WHOLE page closed — never a dropped row, never an invented author", async (_label, patch) => {
    const { list } = facebook(facebookGraph({ pages: { "": { data: [fbComment(FB_COMMENT), fbComment("2001_3099", patch)] } } }));
    const error = await failure(list());
    expect(error.toJSON()).toEqual(rejected("listInteractions", "unknown"));
    expectNoneOf(error, [FB_COMMENT, "2001_3099", TEXT_MARKER, NAME_MARKER, FB_USER]);
  });

  it.each([["a body without data", {}], ["a non-array data", { data: {} }], ["more items than the requested limit", { data: Array.from({ length: META_FACEBOOK_COMMENTS_PAGE_LIMIT + 1 }, (_, i) => fbComment(`2001_40${String(i).padStart(2, "0")}`)) }]])(
    "%s is unreadable",
    async (_label, body) => {
      expect((await failure(facebook(facebookGraph({ pages: { "": body } })).list())).toJSON()).toEqual(rejected("listInteractions", "unknown"));
    },
  );
});

describe("Facebook · getInteraction: the listing edge is the content authority, object only corroborates (Step 7G-H5.5-P12-C9)", () => {
  it("a comment node becomes the same DTO a list would give, on the post it was listed under", async () => {
    const { data } = await facebook(facebookGraph({ nodes: { [FB_COMMENT]: fbNode(FB_COMMENT, { is_hidden: false }) } })).get();
    expectInteraction(data, "meta");
    expect(data).toMatchObject({ ref: providerObjectRef("facebook", "interaction", FB_COMMENT), content: FB_POST_REF, parent: null, interactionKind: "comment", visibility: "visible" });
  });

  it("a listed comment whose node carries NO object is accepted on the listed post (the LIVE shape, P12-C7)", async () => {
    const { data } = await facebook(facebookGraph({ nodes: { [FB_COMMENT]: fbComment(FB_COMMENT) } })).get();
    expect(data).toMatchObject({ ref: providerObjectRef("facebook", "interaction", FB_COMMENT), content: FB_POST_REF, parent: null, interactionKind: "comment" });
  });

  it("a listed reply whose node carries NO object, with the listed parent, is accepted — direct edge authority, never inherited", async () => {
    const { data } = await facebook(facebookGraph({ nodes: { [FB_REPLY]: fbReply(FB_REPLY, FB_COMMENT) } })).get(FB_REPLY, undefined, FB_COMMENT);
    expect(data).toMatchObject({ content: FB_POST_REF, parent: providerObjectRef("facebook", "interaction", FB_COMMENT), interactionKind: "reply" });
  });

  it("a reply node with object present and matching keeps its parent and its post", async () => {
    const { data } = await facebook(facebookGraph({ nodes: { [FB_REPLY]: fbNode(FB_REPLY, { parent: { id: FB_COMMENT } }) } })).get(FB_REPLY, undefined, FB_COMMENT);
    expect(data).toMatchObject({ content: FB_POST_REF, parent: providerObjectRef("facebook", "interaction", FB_COMMENT), interactionKind: "reply" });
  });

  it("an object naming ANOTHER post conflicts with the listing: refused, never reported as that post", async () => {
    const error = await failure(facebook(facebookGraph({ nodes: { [FB_COMMENT]: fbNode(FB_COMMENT, { object: { id: OTHER_POST } }) } })).get());
    expect(error.toJSON()).toEqual(rejectedAs("getInteraction", "unknown", "interaction_content_conflicts"));
    expect(JSON.stringify(error.toJSON())).not.toMatch(new RegExp(`${FB_COMMENT}|${POST}|${OTHER_POST}`));
  });

  it.each([
    ["a reply node under a different parent", fbReply(FB_REPLY, "2001_3098"), FB_COMMENT],
    ["a listed reply whose node is top-level (kind differs)", fbComment(FB_REPLY), FB_COMMENT],
    ["a listed comment whose node is a reply (kind differs)", fbReply(FB_REPLY, FB_COMMENT), undefined],
  ])("%s → interaction_parent_mismatch, never re-parented", async (_label, node, listedParent) => {
    const error = await failure(facebook(facebookGraph({ nodes: { [FB_REPLY]: node } })).get(FB_REPLY, undefined, listedParent));
    expect(error.toJSON()).toEqual(rejectedAs("getInteraction", "unknown", "interaction_parent_mismatch"));
    expect(JSON.stringify(error.toJSON())).not.toMatch(new RegExp(`${FB_COMMENT}|${FB_REPLY}|2001_3098`));
  });

  it.each([
    ["an object without id", { object: {} }, "interaction_content_id_missing"],
    ["an object with a malformed id", { object: { id: "a b" } }, "interaction_content_malformed"],
    ["an object that is not an object", { object: "a-string" }, "interaction_content_malformed"],
    ["an object that is the parent comment", { parent: { id: FB_COMMENT }, object: { id: FB_COMMENT } }, "interaction_content_equals_parent"],
    ["an object that is the comment itself", { parent: { id: FB_COMMENT }, object: { id: FB_REPLY } }, "interaction_content_equals_interaction"],
    ["no from", { parent: { id: FB_COMMENT }, from: undefined }, "interaction_node_unreadable"],
  ])("%s fails closed: the content cannot be corroborated — the same refusal, naming %s", async (_label, patch, diagnostic) => {
    const { get } = facebook(facebookGraph({ nodes: { [FB_REPLY]: fbNode(FB_REPLY, patch) } }));
    const error = await failure(get(FB_REPLY, undefined, FB_COMMENT));
    // Same kind, code and retry as before (Step 7G-H5.5-P12-C6); only the closed diagnostic is added.
    expect(error.toJSON()).toEqual(rejectedAs("getInteraction", "unknown", diagnostic));
    expect(JSON.stringify(error.toJSON())).not.toMatch(new RegExp(`${FB_COMMENT}|${FB_REPLY}|${POST}|a b|a-string`));
  });

  it("an answer echoing another comment id is unreadable", async () => {
    const { get } = facebook(facebookGraph({ nodes: { [FB_COMMENT]: fbNode(FB_REPLY) } }));
    expect((await failure(get())).toJSON()).toEqual(rejectedAs("getInteraction", "unknown", "interaction_node_unreadable"));
  });

  it("code 100 / subcode 33 on the node read → TargetNotFound (ambiguous, never deletion or non-support); on the edge it stays a permanent rejection", async () => {
    expect((await failure(facebook(facebookGraph({ nodes: {} })).get())).toJSON()).toEqual({ kind: "target_not_found", operation: "getInteraction", retry: "never", details: { authority: "unconfirmed" } });
    const edge = facebook((url) => (url.searchParams.get("fields") === "access_token" ? TOKEN_REPLY() : json(400, graphError({ code: 100, error_subcode: 33 }))));
    expect((await failure(edge.list())).toJSON()).toEqual(rejected("listInteractions", "unknown"));
  });
});

describe("Facebook · window [from, to): client-side on created_time, never a server bound, never an early stop", () => {
  it("keeps exactly the interactions with from ≤ created_time < to and sends no since/until", async () => {
    const at = (time: string, id: string) => fbComment(id, { created_time: time });
    const { list, calls } = facebook(facebookGraph({
      pages: { "": { data: [at("2026-09-21T23:59:59+0000", "2001_5011"), at("2026-09-22T00:00:00+0000", "2001_5012"), at("2026-10-10T08:00:00+0000", "2001_5013"), at("2026-10-22T00:00:00+0000", "2001_5014")] } },
    }));
    expect(ids((await list()).data.items)).toEqual(["2001_5012", "2001_5013"]);
    expect(calls[1]?.url.searchParams.has("since") || calls[1]?.url.searchParams.has("until")).toBe(false);
  });

  it("does not depend on provider order", async () => {
    const items = [fbComment("2001_5021", { created_time: "2026-10-05T00:00:00+0000" }), fbComment("2001_5022", { created_time: "2026-08-01T00:00:00+0000" }), fbComment("2001_5023", { created_time: "2026-10-15T00:00:00+0000" })];
    const forward = ids((await facebook(facebookGraph({ pages: { "": { data: items } } })).list()).data.items).sort();
    const backward = ids((await facebook(facebookGraph({ pages: { "": { data: [...items].reverse() } } })).list()).data.items).sort();
    expect(forward).toEqual(["2001_5021", "2001_5023"]);
    expect(backward).toEqual(forward);
  });

  it("a malformed item outside the window still fails the page (mapping precedes filtering)", async () => {
    const { list } = facebook(facebookGraph({ pages: { "": { data: [fbComment(FB_COMMENT), fbComment("2001_5031", { created_time: "2020-01-01T00:00:00+0000", from: undefined })] } } }));
    expect((await failure(list())).toJSON()).toEqual(rejected("listInteractions", "unknown"));
  });

  it("an inverted window is refused before any request", async () => {
    const { list, calls } = facebook(facebookGraph({ pages: FB_STREAM }));
    expect((await failure(list(null, { from: WINDOW.to, to: WINDOW.from }))).toJSON()).toEqual(rejected("listInteractions", "invalid_request"));
    expect(calls).toHaveLength(0);
  });
});

describe("Facebook · pagination: the meta1. envelope, one provider page per call, paging.next never fetched", () => {
  it("next + a valid after → more; the next call sends the RAW after to the fixed edge; next absent → end", async () => {
    const { list, calls } = facebook(facebookGraph({ pages: { "": { data: [fbComment(FB_COMMENT)], paging: { cursors: { before: "QVFIUmJlZm9yZQ", after: RAW_AFTER }, next: HOSTILE_NEXT } }, [RAW_AFTER]: { data: [fbReply(FB_REPLY, FB_COMMENT)] } } }));
    const first = (await list()).data;
    expect(first.next).toEqual({ kind: "more", cursor: envelope(RAW_AFTER) });
    // ONE provider page per call: the derivation and one comments read, nothing followed.
    expect(calls).toHaveLength(2);
    const second = (await list(first.next.kind === "more" ? first.next.cursor : null)).data;
    expect(second.next).toEqual({ kind: "end" });
    expect(ids(second.items)).toEqual([FB_REPLY]);
    expect(calls.filter((call) => call.url.pathname.endsWith("/comments")).map((call) => call.url.searchParams.get("after"))).toEqual([null, RAW_AFTER]);
    for (const call of calls) {
      expect(call.url.href).not.toContain("meta1.");
      expect(call.url.href).not.toContain("attacker");
    }
  });

  it.each([["next without a cursor", { data: [], paging: { next: HOSTILE_NEXT } }], ["an empty next", { data: [], paging: { cursors: { after: "QVFI" }, next: "" } }], ["a cursor with whitespace", { data: [], paging: { cursors: { after: "a b" }, next: HOSTILE_NEXT } }], ["a non-object paging", { data: [], paging: "next" }]])(
    "%s from Graph fails closed as unreadable",
    async (_label, body) => {
      expect((await failure(facebook(facebookGraph({ pages: { "": body } })).list())).toJSON()).toEqual(rejected("listInteractions", "unknown"));
    },
  );

  it.each([["a raw Graph cursor (no envelope)", RAW_AFTER], ["another version", "meta2.QUJD"], ["a padded payload", "meta1.QUJD=="], ["a non-canonical payload", "meta1.QUJ"], ["an empty payload", "meta1."]])(
    "an incoming PageCursor that is %s is refused (invalid_cursor) before any request",
    async (_label, cursor) => {
      const { list, calls } = facebook(facebookGraph({ pages: FB_STREAM }));
      expect((await failure(list(cursor as PageCursor))).toJSON()).toEqual(rejected("listInteractions", "invalid_cursor"));
      expect(calls).toHaveLength(0);
    },
  );

  it("a returned cursor equal to the one sent (a repeat) fails closed", async () => {
    const { list } = facebook(facebookGraph({ pages: { [RAW_AFTER]: { data: [], paging: { cursors: { after: RAW_AFTER }, next: HOSTILE_NEXT } } } }));
    expect((await failure(list(envelope(RAW_AFTER)))).toJSON()).toEqual(rejected("listInteractions", "invalid_cursor"));
  });
});

describe("Facebook · scope and refs", () => {
  it("the account scope (an account-wide comment feed) is TargetNotEligible before any request", async () => {
    const { port, calls } = facebook(facebookGraph({ pages: FB_STREAM }));
    expect((await failure(port.listInteractions(FB_ACCESS, { kind: "account" }, WINDOW, null))).toJSON()).toEqual({ kind: "target_not_eligible", operation: "listInteractions", retry: "never", details: { reason: "unsupported_for_target" } });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["an Instagram content ref", providerObjectRef("instagram", "content", MEDIA)],
    ["an interaction ref as content", providerObjectRef("facebook", "interaction", POST)],
    ["a forged content id", { platform: "facebook", kind: "content", id: "../me/accounts" }],
  ])("listInteractions refuses %s as the scope before any request", async (_label, content) => {
    const { port, calls } = facebook(facebookGraph({ pages: FB_STREAM }));
    expect((await failure(port.listInteractions(FB_ACCESS, { kind: "content", content } as InteractionScope, WINDOW, null))).toJSON()).toEqual(rejected("listInteractions", "invalid_request"));
    expect(calls).toHaveLength(0);
  });

  it("an unknown scope kind is refused (invalid_request) before any request", async () => {
    const { port, calls } = facebook(facebookGraph({ pages: FB_STREAM }));
    expect((await failure(port.listInteractions(FB_ACCESS, { kind: "thread" } as unknown as InteractionScope, WINDOW, null))).toJSON()).toEqual(rejected("listInteractions", "invalid_request"));
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["a bare Facebook interaction ref", providerObjectRef("facebook", "interaction", FB_COMMENT)],
    ["an Instagram interaction ref", providerObjectRef("instagram", "interaction", FB_COMMENT)],
    ["a content ref", providerObjectRef("facebook", "content", FB_COMMENT)],
    ["a forged id", { platform: "facebook", kind: "interaction", id: "../me" }],
    ["a listed target wrapping a bare ref", { kind: "listed", listed: providerObjectRef("facebook", "interaction", FB_COMMENT) }],
    ["an unknown target kind", { kind: "webhook", listed: providerObjectRef("facebook", "interaction", FB_COMMENT) }],
    ["null", null],
  ])("getInteraction refuses %s before any request", async (_label, target) => {
    const { port, calls } = facebook(facebookGraph({ nodes: { [FB_COMMENT]: fbNode(FB_COMMENT) } }));
    expect((await failure(port.getInteraction(FB_ACCESS, target as never))).toJSON()).toEqual(rejected("getInteraction", "invalid_request"));
    expect(calls).toHaveLength(0);
  });
});

describe("listed provenance: only the exact DTO this port listed, for this account, is a re-read target (Step 7G-H5.5-P12-C9)", () => {
  /** Lists FB_STREAM on a fresh port; returns the port, its calls (cleared) and the listed comment DTO. */
  const listedOn = async (graph: Reply = facebookGraph({ pages: FB_STREAM, nodes: { [FB_COMMENT]: fbNode(FB_COMMENT) } })) => {
    const h = harness(graph);
    const page = (await h.port.listInteractions(FB_ACCESS, { kind: "content", content: FB_POST_REF }, WINDOW, null)).data;
    const listed = page.items.find((item) => item.ref.id === FB_COMMENT);
    if (listed === undefined) throw new Error("not listed");
    h.calls.length = 0;
    return { ...h, listed };
  };
  const refusedWithoutRequest = async (h: { readonly calls: readonly Call[] }, promise: Promise<unknown>) => {
    const error = await failure(promise);
    expect(error.toJSON()).toEqual(rejected("getInteraction", "invalid_request"));
    expect(h.calls).toHaveLength(0);
    expectNoneOf(error, [FB_COMMENT, POST, PAGE, USER_TOKEN, PAGE_TOKEN, TEXT_MARKER, NAME_MARKER]);
  };

  it("the listed instance itself is accepted", async () => {
    const h = await listedOn();
    expect((await h.port.getInteraction(FB_ACCESS, { kind: "listed", listed: h.listed })).data.ref).toEqual(h.listed.ref);
  });

  it("a fabricated DTO (equal data, never listed) is refused with zero requests", async () => {
    const h = await listedOn();
    const fabricated: InteractionDto = { ...h.listed, ref: providerObjectRef("facebook", "interaction", FB_COMMENT) };
    await refusedWithoutRequest(h, h.port.getInteraction(FB_ACCESS, { kind: "listed", listed: fabricated }));
  });

  it.each([
    ["a shallow copy", (dto: InteractionDto) => ({ ...dto })],
    ["a deserialized value", (dto: InteractionDto) => JSON.parse(JSON.stringify(dto)) as InteractionDto],
    ["a structured clone", (dto: InteractionDto) => structuredClone(dto)],
  ])("%s of a listed DTO is a reconstruction, not the listed instance: refused with zero requests", async (_label, copy) => {
    const h = await listedOn();
    await refusedWithoutRequest(h, h.port.getInteraction(FB_ACCESS, { kind: "listed", listed: copy(h.listed) }));
  });

  it("a DTO listed by ANOTHER port instance is unknown to this one: refused with zero requests", async () => {
    const other = await listedOn();
    const h = await listedOn();
    await refusedWithoutRequest(h, h.port.getInteraction(FB_ACCESS, { kind: "listed", listed: other.listed }));
  });

  it("another account (another managed Page) cannot re-read what this account listed: refused with zero requests", async () => {
    const h = await listedOn();
    const otherPage = { credential: CREDENTIAL, account: providerObjectRef("facebook", "asset", "1999") };
    await refusedWithoutRequest(h, h.port.getInteraction(otherPage, { kind: "listed", listed: h.listed }));
  });

  it("another provider (an Instagram account) cannot re-read a Facebook listing: refused with zero requests", async () => {
    const h = await listedOn();
    await refusedWithoutRequest(h, h.port.getInteraction(IG_ACCESS, { kind: "listed", listed: h.listed }));
    await refusedWithoutRequest(h, h.port.getInteraction({ credential: CREDENTIAL, account: providerObjectRef("instagram", "asset", PAGE) }, { kind: "listed", listed: h.listed }));
  });

  it("the provenance is recorded at listing time: mutating the caller-held DTO cannot redirect the re-read", async () => {
    const h = await listedOn();
    // Whether or not the DTO is frozen, a write to it (if it lands) must not change what is re-read or reported.
    Reflect.set(h.listed, "content", providerObjectRef("facebook", "content", OTHER_POST));
    Reflect.set(h.listed, "ref", providerObjectRef("facebook", "interaction", FB_REPLY));
    const { data } = await h.port.getInteraction(FB_ACCESS, { kind: "listed", listed: h.listed });
    expect(data.content).toEqual(FB_POST_REF);
    expect(h.calls.map((call) => call.url.pathname)).toEqual([`/v25.0/${PAGE}`, `/v25.0/${FB_COMMENT}`]);
  });

  it("an Instagram port refuses an unregistered Instagram target with zero requests", async () => {
    const ig = instagram(instagramGraph({ pages: IG_PAGE, nodes: { [IG_COMMENT]: igComment(IG_COMMENT) } }));
    const page = (await ig.port.listInteractions(IG_ACCESS, { kind: "content", content: IG_MEDIA_REF }, WINDOW, null)).data;
    const listed = page.items[0];
    if (listed === undefined) throw new Error("not listed");
    ig.calls.length = 0;
    for (const target of [{ kind: "listed", listed: { ...listed } }, { kind: "listed", listed: JSON.parse(JSON.stringify(listed)) as InteractionDto }, providerObjectRef("instagram", "interaction", IG_COMMENT)]) {
      expect((await failure(ig.port.getInteraction(IG_ACCESS, target as never))).toJSON()).toEqual(rejected("getInteraction", "invalid_request"));
    }
    expect(ig.calls).toHaveLength(0);
    expect((await ig.port.getInteraction(IG_ACCESS, { kind: "listed", listed })).data.ref).toEqual(listed.ref);
    expect(ig.calls).toHaveLength(1);
  });
});

// ── Instagram ───────────────────────────────────────────────────────────────────────────────────────────────

describe("Instagram · transport: the User token directly, ONE Graph GET per call — no Page token derivation", () => {
  it("listInteractions: exactly GET {ig-media-id}/comments with the approved fields and fixed limit, with the User token", async () => {
    const { list, calls, tokens, paths } = instagram(instagramGraph({ pages: IG_PAGE }));
    await list();
    expect(paths()).toEqual([`/v25.0/${MEDIA}/comments?${META_INSTAGRAM_COMMENT_FIELDS}`]);
    expect(tokens()).toEqual([USER_TOKEN]);
    const url = calls[0]?.url;
    expect(META_INSTAGRAM_COMMENT_FIELDS).toBe("id,from,text,timestamp,parent_id,hidden,media");
    expect(url?.searchParams.get("limit")).toBe(String(META_INSTAGRAM_COMMENTS_PAGE_LIMIT));
    expect(META_INSTAGRAM_COMMENTS_PAGE_LIMIT).toBe(10);
    expect([...(url?.searchParams.keys() ?? [])].sort()).toEqual(["access_token", "fields", "limit"]);
  });

  it("getInteraction: exactly GET {ig-comment-id} with the same fields, with the User token", async () => {
    const { get, paths, tokens } = instagram(instagramGraph({ nodes: { [IG_COMMENT]: igComment(IG_COMMENT) } }));
    await get();
    expect(paths()).toEqual([`/v25.0/${IG_COMMENT}?${META_INSTAGRAM_COMMENT_FIELDS}`]);
    expect(tokens()).toEqual([USER_TOKEN]);
  });

  it("never derives a Page token, never reads replies (edge or expansion), likes or the media itself", async () => {
    const { list, get, calls } = instagram(instagramGraph({ pages: IG_PAGE, nodes: { [IG_COMMENT]: igComment(IG_COMMENT) } }));
    await list();
    const seen = [...calls];
    expect(seen).toHaveLength(1);
    await get();
    expect(calls).toHaveLength(1);
    seen.push(...calls);
    for (const call of seen) {
      expect(call.url.searchParams.get("fields")).not.toBe("access_token");
      expect(call.url.searchParams.get("fields")).not.toBe(META_INSTAGRAM_MEDIA_FIELDS);
      expect(call.url.pathname).not.toMatch(/replies|likes|\/media$|ordered_comments/);
    }
    expect(META_INSTAGRAM_COMMENT_FIELDS).not.toMatch(/replies|like_count|user\b|legacy|\{/);
  });

  it("the User token never appears in a result, a DTO or an error", async () => {
    expectNoneOf(await instagram(instagramGraph({ pages: IG_PAGE })).list(), [USER_TOKEN, "access_token"]);
    expectNoneOf(await instagram(instagramGraph({ nodes: { [IG_COMMENT]: igComment(IG_COMMENT) } })).get(), [USER_TOKEN, "access_token"]);
    expectNoneOf(await failure(instagram(instagramGraph({ pages: { "": { data: [igComment(IG_COMMENT, { from: undefined })] } } })).list()), [USER_TOKEN, "access_token", BODY_MARKER]);
  });
});

describe("Instagram · normalization: top-level comments only", () => {
  it("a top-level comment as an exact InteractionDto: handle from username, no display name", async () => {
    const page = expectResult(await instagram(instagramGraph({ pages: IG_PAGE })).list());
    expect(page.next).toEqual({ kind: "end" });
    for (const item of page.items) expectInteraction(item, "meta");
    expect(page.items).toEqual([
      {
        ref: providerObjectRef("instagram", "interaction", IG_COMMENT),
        content: IG_MEDIA_REF,
        parent: null,
        interactionKind: "comment",
        author: { ref: providerObjectRef("instagram", "author", IG_USER), role: "user", displayName: null, handle: `${HANDLE_MARKER}_${IG_COMMENT}` },
        text: `${TEXT_MARKER} ${IG_COMMENT}`,
        textRevision: null,
        editedAt: null,
        visibility: "unknown",
        availability: "available",
        timestamps: { createdAt: "2026-10-01T12:00:00.000Z", updatedAt: null },
        rawReference: { provider: "meta", apiVersion: "v25.0", ref: `instagram:comment:${IG_COMMENT}` },
      },
    ]);
    expect(Object.isFrozen(page) && Object.isFrozen(page.items) && page.items.every((item) => Object.isFrozen(item) && Object.isFrozen(item.author))).toBe(true);
  });

  it("author role: the managed account is account_identity, anyone else is user; a missing username is a null handle", async () => {
    const data = [igComment(IG_COMMENT, { from: { id: IG, username: "the_brand" } }), igComment(IG_COMMENT_B, { from: { id: "17960000000000009" } })];
    const { items } = (await instagram(instagramGraph({ pages: { "": { data } } })).list()).data;
    expect(items.map((item) => item.author)).toEqual([
      { ref: providerObjectRef("instagram", "author", IG), role: "account_identity", displayName: null, handle: "the_brand" },
      { ref: providerObjectRef("instagram", "author", "17960000000000009"), role: "user", displayName: null, handle: null },
    ]);
  });

  it("visibility only from the reported hidden: true → hidden, false → visible, absent → unknown", async () => {
    const data = [igComment("17950000000000011", { hidden: true }), igComment("17950000000000012", { hidden: false }), igComment("17950000000000013")];
    const { items } = (await instagram(instagramGraph({ pages: { "": { data } } })).list()).data;
    expect(items.map((item) => item.visibility)).toEqual(["hidden", "visible", "unknown"]);
  });

  it("a comment without media on the edge is placed on the scope's media (the scope is the list's authority)", async () => {
    const { items } = (await instagram(instagramGraph({ pages: { "": { data: [igComment(IG_COMMENT, { media: undefined })] } } })).list()).data;
    expect(items[0]?.content).toEqual(IG_MEDIA_REF);
  });

  it.each([
    ["a parent_id (a reply: not read in this slice)", { parent_id: "17950000000000099" }],
    ["a media.id of another media", { media: { id: OTHER_MEDIA } }],
    ["no from", { from: undefined }],
    ["a from without id", { from: { username: HANDLE_MARKER } }],
    ["a non-object from", { from: IG_USER }],
    ["a non-string username", { from: { id: IG_USER, username: 7 } }],
    ["no text", { text: undefined }],
    ["no timestamp", { timestamp: undefined }],
    ["an impossible timestamp", { timestamp: "2026-02-30T12:00:00+0000" }],
    ["a non-boolean hidden", { hidden: 0 }],
    ["a malformed parent_id", { parent_id: { id: "17950000000000099" } }],
    ["a media without id", { media: {} }],
  ])("%s fails the WHOLE page closed", async (_label, patch) => {
    const { list } = instagram(instagramGraph({ pages: { "": { data: [igComment(IG_COMMENT), igComment(IG_COMMENT_B, patch)] } } }));
    const error = await failure(list());
    expect(error.toJSON()).toEqual(rejected("listInteractions", "unknown"));
    expectNoneOf(error, [IG_COMMENT, IG_COMMENT_B, TEXT_MARKER, HANDLE_MARKER, IG_USER, OTHER_MEDIA]);
  });

  it.each([["a body without data", {}], ["more items than the requested limit", { data: Array.from({ length: META_INSTAGRAM_COMMENTS_PAGE_LIMIT + 1 }, (_, i) => igComment(`179500000000001${String(i).padStart(2, "0")}`)) }]])(
    "%s is unreadable",
    async (_label, body) => {
      expect((await failure(instagram(instagramGraph({ pages: { "": body } })).list())).toJSON()).toEqual(rejected("listInteractions", "unknown"));
    },
  );
});

describe("Instagram · getInteraction: media.id is the only content authority", () => {
  it("a comment node on the managed media", async () => {
    const { data } = await instagram(instagramGraph({ nodes: { [IG_COMMENT]: igComment(IG_COMMENT, { hidden: true }) } })).get();
    expectInteraction(data, "meta");
    expect(data).toMatchObject({ ref: providerObjectRef("instagram", "interaction", IG_COMMENT), content: IG_MEDIA_REF, parent: null, interactionKind: "comment", visibility: "hidden" });
  });

  it.each([
    // Step 7G-H5.5-P12-C6: a node without media.id names its case; the other refusals are unchanged (unnamed).
    ["no media", { media: undefined }, rejectedAs("getInteraction", "unknown", "interaction_content_missing")],
    ["a reply (parent_id)", { parent_id: IG_COMMENT_B }, rejected("getInteraction", "unknown")],
    ["no from", { from: undefined }, rejected("getInteraction", "unknown")],
  ])("%s fails closed", async (_label, patch, expected) => {
    const { get } = instagram(instagramGraph({ nodes: { [IG_COMMENT]: igComment(IG_COMMENT, patch) } }));
    expect((await failure(get())).toJSON()).toEqual(expected);
  });

  it("an answer echoing another comment id is unreadable; 100/33 is TargetNotFound", async () => {
    expect((await failure(instagram(instagramGraph({ nodes: { [IG_COMMENT]: igComment(IG_COMMENT_B) } })).get())).toJSON()).toEqual(rejected("getInteraction", "unknown"));
    expect((await failure(instagram(instagramGraph({ nodes: {} })).get())).toJSON()).toEqual({ kind: "target_not_found", operation: "getInteraction", retry: "never", details: { authority: "unconfirmed" } });
  });
});

describe("Instagram · window and pagination", () => {
  it("keeps exactly from ≤ timestamp < to, client-side", async () => {
    const at = (time: string, id: string) => igComment(id, { timestamp: time });
    const data = [at("2026-09-21T23:59:59+0000", "17950000000000021"), at("2026-09-22T00:00:00+0000", "17950000000000022"), at("2026-10-22T00:00:00+0000", "17950000000000023")];
    const { list, calls } = instagram(instagramGraph({ pages: { "": { data } } }));
    expect(ids((await list()).data.items)).toEqual(["17950000000000022"]);
    expect(calls[0]?.url.searchParams.has("since") || calls[0]?.url.searchParams.has("until")).toBe(false);
  });

  it("the envelope round-trips through the fixed edge; ONE page per call; next never fetched", async () => {
    const { list, calls } = instagram(instagramGraph({ pages: { "": { data: [igComment(IG_COMMENT)], paging: { cursors: { after: RAW_AFTER }, next: HOSTILE_NEXT } }, [RAW_AFTER]: { data: [igComment(IG_COMMENT_B)] } } }));
    const first = (await list()).data;
    expect(first.next).toEqual({ kind: "more", cursor: envelope(RAW_AFTER) });
    expect(calls).toHaveLength(1);
    const second = (await list(first.next.kind === "more" ? first.next.cursor : null)).data;
    expect([ids(second.items), second.next]).toEqual([[IG_COMMENT_B], { kind: "end" }]);
    expect(calls.map((call) => call.url.searchParams.get("after"))).toEqual([null, RAW_AFTER]);
    for (const call of calls) expect(call.url.href).not.toMatch(/meta1\.|attacker/);
  });

  it("a malformed incoming cursor is refused before any request; a repeated one fails closed", async () => {
    const fresh = instagram(instagramGraph({ pages: IG_PAGE }));
    expect((await failure(fresh.list("meta1.QUJ" as PageCursor))).toJSON()).toEqual(rejected("listInteractions", "invalid_cursor"));
    expect(fresh.calls).toHaveLength(0);
    const repeating = instagram(instagramGraph({ pages: { [RAW_AFTER]: { data: [], paging: { cursors: { after: RAW_AFTER }, next: HOSTILE_NEXT } } } }));
    expect((await failure(repeating.list(envelope(RAW_AFTER)))).toJSON()).toEqual(rejected("listInteractions", "invalid_cursor"));
  });
});

describe("Instagram · scope and refs", () => {
  it("the account scope is TargetNotEligible before any request", async () => {
    const { port, calls } = instagram(instagramGraph({ pages: IG_PAGE }));
    expect((await failure(port.listInteractions(IG_ACCESS, { kind: "account" }, WINDOW, null))).toJSON()).toEqual({ kind: "target_not_eligible", operation: "listInteractions", retry: "never", details: { reason: "unsupported_for_target" } });
    expect(calls).toHaveLength(0);
  });

  it("a Facebook content scope or a Facebook interaction ref is refused before any request", async () => {
    const { port, calls } = instagram(instagramGraph({ pages: IG_PAGE }));
    expect((await failure(port.listInteractions(IG_ACCESS, { kind: "content", content: FB_POST_REF }, WINDOW, null))).toJSON()).toEqual(rejected("listInteractions", "invalid_request"));
    expect((await failure(port.getInteraction(IG_ACCESS, providerObjectRef("facebook", "interaction", FB_COMMENT) as never))).toJSON()).toEqual(rejected("getInteraction", "invalid_request"));
    expect(calls).toHaveLength(0);
  });
});

// ── Errors: the shared Graph read mapping, with capability read_interactions ───────────────────────────────

describe("errors: the shared Graph read mapping, never non-support, leaking nothing", () => {
  const cases: readonly (readonly [string, unknown, number, ProviderErrorKind, Record<string, unknown>])[] = [
    ["code 10 (permission)", graphError({ code: 10 }), 403, "permission_missing", { capability: "read_interactions" }],
    ["code 200 (permission)", graphError({ code: 200 }), 403, "permission_missing", { capability: "read_interactions" }],
    ["subcode 492 inside OAuthException", graphError({ code: 190, type: "OAuthException", error_subcode: 492 }), 400, "permission_missing", { capability: "read_interactions" }],
    ["code 190 / 463 (expired)", graphError({ code: 190, type: "OAuthException", error_subcode: 463 }), 400, "credential_invalid", { reason: "expired" }],
    ["code 4 (rate)", graphError({ code: 4 }), 400, "rate_limited", { retryAfterSeconds: null }],
    ["code 2 (temporary)", graphError({ code: 2 }), 500, "transient", { reason: "provider_unavailable" }],
  ];

  it.each(cases)("%s → %s on every operation of both platforms", async (_label, body, status, kind, details) => {
    const instagramReply: Reply = () => json(status, body);
    // Facebook: the derivation succeeds, the comment read fails.
    const facebookReply: Reply = (url) => (url.searchParams.get("fields") === "access_token" ? TOKEN_REPLY() : json(status, body));
    const runs = [
      ["listInteractions", () => facebook(facebookReply).list()],
      ["getInteraction", () => facebook(facebookReply).get()],
      ["listInteractions", () => instagram(instagramReply).list()],
      ["getInteraction", () => instagram(instagramReply).get()],
    ] as const;
    for (const [operation, run] of runs) {
      const error = await failure(run());
      expect(error.toJSON()).toEqual({ kind, operation, retry: error.retry, details });
      expect(error.kind).not.toBe("target_not_eligible");
      expectNoneOf(error, [USER_TOKEN, PAGE_TOKEN, BODY_MARKER, "synthetic-trace", "access_token"]);
    }
  });

  it("a network failure is transient after exactly one request (no internal retry)", async () => {
    const { list, calls } = instagram(() => Promise.reject(new TypeError(`fetch failed ?access_token=${USER_TOKEN}`)));
    const error = await failure(list());
    expect(error.kind).toBe("transient");
    expect(calls).toHaveLength(1);
    expectNoneOf(error, [USER_TOKEN, "access_token"]);
  });
});

// ── Cross-platform: no fixture, kind or branch leaks between Facebook and Instagram ─────────────────────────

describe("cross-platform: each platform reads only its own shape", () => {
  /** Serves `body` for any comments edge or node, whatever the fields, and the Page token for derivation. */
  const anyShape = (body: unknown): Reply => (url) => (url.searchParams.get("fields") === "access_token" ? TOKEN_REPLY() : json(200, body));

  it("a Facebook comment cannot be read as an Instagram comment (no text, no timestamp)", async () => {
    expect((await failure(instagram(anyShape({ data: [fbComment(FB_COMMENT)] })).list())).toJSON()).toEqual(rejected("listInteractions", "unknown"));
    expect((await failure(instagram(anyShape(fbNode(IG_COMMENT))).get())).toJSON()).toEqual(rejected("getInteraction", "unknown"));
  });

  it("an Instagram comment cannot be read as a Facebook comment (no message, no created_time)", async () => {
    expect((await failure(facebook(anyShape({ data: [igComment(IG_COMMENT)] })).list())).toJSON()).toEqual(rejected("listInteractions", "unknown"));
    expect((await failure(facebook(anyShape(igComment(FB_COMMENT))).get())).toJSON()).toEqual(rejectedAs("getInteraction", "unknown", "interaction_node_unreadable"));
  });

  it("Facebook reply semantics never leak into Instagram: a Facebook-style parent is not read; only parent_id marks a reply, and fails", async () => {
    const withFacebookParent = (await instagram(instagramGraph({ pages: { "": { data: [igComment(IG_COMMENT, { parent: { id: IG_COMMENT_B } })] } } })).list()).data.items;
    expect(withFacebookParent.map((item) => [item.interactionKind, item.parent])).toEqual([["comment", null]]);
    expect((await failure(instagram(instagramGraph({ pages: { "": { data: [igComment(IG_COMMENT, { parent_id: IG_COMMENT_B })] } } })).list())).toJSON()).toEqual(rejected("listInteractions", "unknown"));
  });

  it("dispatch is by the account's platform only: Instagram never derives a Page token, Facebook never reads an IG edge", async () => {
    const ig = instagram(instagramGraph({ pages: IG_PAGE }));
    await ig.list();
    expect(ig.calls.map((call) => call.url.pathname)).toEqual([`/v25.0/${MEDIA}/comments`]);
    const fb = facebook(facebookGraph({ pages: FB_STREAM }));
    await fb.list();
    expect(fb.calls.map((call) => call.url.searchParams.get("fields"))).toEqual(["access_token", META_FACEBOOK_COMMENT_FIELDS]);
  });

  it("any other platform takes the Facebook path, which refuses it before any request", async () => {
    const { port, calls } = harness(facebookGraph({ pages: FB_STREAM }));
    const tiktok = { credential: CREDENTIAL, account: providerObjectRef("tiktok", "asset", "9001") };
    expect((await failure(port.listInteractions(tiktok, { kind: "content", content: providerObjectRef("tiktok", "content", "9002") }, WINDOW, null))).toJSON()).toEqual(rejected("listInteractions", "invalid_request"));
    expect((await failure(port.getInteraction(tiktok, providerObjectRef("tiktok", "interaction", "9003") as never))).toJSON()).toEqual(rejected("getInteraction", "invalid_request"));
    expect(calls).toHaveLength(0);
  });

  it("no source and no fallback kind exist on an interaction: only comment or reply, from the parent alone", async () => {
    const [fbItems, igItems] = [(await facebook(facebookGraph({ pages: FB_STREAM })).list()).data.items, (await instagram(instagramGraph({ pages: IG_PAGE })).list()).data.items];
    for (const item of [...fbItems, ...igItems]) {
      expect(Object.keys(item)).not.toContain("source");
      expect(Object.keys(item)).not.toContain("reportedSource");
      expect(["comment", "reply"]).toContain(item.interactionKind);
    }
    expect(igItems.every((item) => item.interactionKind === "comment")).toBe(true);
  });
});

// ── Privacy: nothing of a comment reaches the console or an error ───────────────────────────────────────────

describe("privacy: the adapter logs nothing and its errors carry no comment data", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no console output on any success or failure path of either platform", async () => {
    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    await facebook(facebookGraph({ pages: FB_STREAM })).list();
    await facebook(facebookGraph({ nodes: { [FB_COMMENT]: fbNode(FB_COMMENT) } })).get();
    await instagram(instagramGraph({ pages: IG_PAGE })).list();
    await instagram(instagramGraph({ nodes: { [IG_COMMENT]: igComment(IG_COMMENT) } })).get();
    await failure(facebook(facebookGraph({ pages: { "": { data: [fbComment(FB_COMMENT, { from: undefined })] } } })).list());
    await failure(instagram(instagramGraph({ pages: { "": { data: [igComment(IG_COMMENT, { parent_id: IG_COMMENT_B })] } } })).list());
    await failure(facebook(facebookGraph({ pages: { "": { data: [], paging: { cursors: { after: RAW_AFTER }, next: HOSTILE_NEXT } }, [RAW_AFTER]: graphError({ code: 10 }) } })).list(envelope(RAW_AFTER)));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("every failure is a closed error: no text, name, handle, provider id, token, payload or cursor in any rendering", async () => {
    const secrets = [TEXT_MARKER, NAME_MARKER, HANDLE_MARKER, FB_COMMENT, FB_REPLY, POST, PAGE, FB_USER, IG_COMMENT, IG_COMMENT_B, MEDIA, IG, IG_USER, USER_TOKEN, PAGE_TOKEN, BODY_MARKER, RAW_AFTER, envelope(RAW_AFTER), "access_token"];
    const failures = [
      await failure(facebook(facebookGraph({ pages: { "": { data: [fbComment(FB_COMMENT), fbReply(FB_REPLY, FB_REPLY)] } } })).list()),
      await failure(facebook(facebookGraph({ nodes: { [FB_REPLY]: fbNode(FB_REPLY, { object: { id: FB_COMMENT }, parent: { id: FB_COMMENT } }) } })).get(FB_REPLY)),
      await failure(instagram(instagramGraph({ pages: { "": { data: [igComment(IG_COMMENT, { media: { id: OTHER_MEDIA } })] } } })).list()),
      await failure(instagram(instagramGraph({ pages: { [RAW_AFTER]: { data: [], paging: { cursors: { after: RAW_AFTER }, next: HOSTILE_NEXT } } } })).list(envelope(RAW_AFTER))),
    ];
    for (const error of failures) {
      expectNoneOf(error, secrets);
      expect(Object.keys(error.toJSON()).sort()).toEqual(["details", "kind", "operation", "retry"]);
    }
  });
});

describe("H6-E: stored targets (persisted provenance) — the same checks, never removal authority on Meta", () => {
  const storedFb = (id: string, parent: string | null = null) => ({
    kind: "stored" as const,
    stored: { account: FB_ACCESS.account, content: FB_POST_REF, ref: providerObjectRef("facebook", "interaction", id), parent: parent === null ? null : providerObjectRef("facebook", "interaction", parent), interactionKind: parent === null ? ("comment" as const) : ("reply" as const) },
  });
  const storedIg = (id: string, kind: "comment" | "reply" = "comment") => ({
    kind: "stored" as const,
    stored: { account: IG_ACCESS.account, content: IG_MEDIA_REF, ref: providerObjectRef("instagram", "interaction", id), parent: kind === "reply" ? providerObjectRef("instagram", "interaction", "17950000000000009") : null, interactionKind: kind },
  });

  it("a stored Facebook comment is re-read against its stored content and parent, like a listed one", async () => {
    const h = facebook(facebookGraph({ nodes: { [FB_COMMENT]: fbNode(FB_COMMENT) } }));
    const result = await h.port.getInteraction(FB_ACCESS, storedFb(FB_COMMENT));
    expect([result.data.ref.id, result.data.content.id, result.data.parent, result.data.interactionKind]).toEqual([FB_COMMENT, POST, null, "comment"]);
  });

  it("Meta's 100/33 on a stored re-read is an UNCONFIRMED not-found: never removal authority", async () => {
    const h = facebook(facebookGraph({ nodes: {} }));
    const error = await failure(h.port.getInteraction(FB_ACCESS, storedFb(FB_COMMENT)));
    expect(error.toJSON()).toEqual({ kind: "target_not_found", operation: "getInteraction", retry: "never", details: { authority: "unconfirmed" } });
    const ig = instagram(instagramGraph({ nodes: {} }));
    expect((await failure(ig.port.getInteraction(IG_ACCESS, storedIg(IG_COMMENT)))).toJSON()).toEqual({ kind: "target_not_found", operation: "getInteraction", retry: "never", details: { authority: "unconfirmed" } });
  });

  it("a stored Instagram REPLY is refused before any request (REPLIES_NOT_READ: no direct reply re-read is invented)", async () => {
    const h = instagram(instagramGraph({ nodes: {} }));
    const error = await failure(h.port.getInteraction(IG_ACCESS, storedIg(IG_COMMENT, "reply")));
    expect(error.toJSON()).toMatchObject({ kind: "target_not_eligible", operation: "getInteraction" });
    expect(h.calls).toEqual([]);
  });

  it("a stored Instagram comment whose node sits on another media is a conflict, never applied", async () => {
    const h = instagram(instagramGraph({ nodes: { [IG_COMMENT]: igComment(IG_COMMENT, { media: { id: "17900000000000099" } }) } }));
    expect((await failure(h.port.getInteraction(IG_ACCESS, storedIg(IG_COMMENT)))).toJSON()).toEqual(rejectedAs("getInteraction", "unknown", "interaction_content_conflicts"));
  });

  it("a stored provenance for another account, mixing platforms or contradicting its kind is invalid_request, before any request", async () => {
    const h = facebook(facebookGraph({ nodes: { [FB_COMMENT]: fbNode(FB_COMMENT) } }));
    const base = storedFb(FB_COMMENT).stored;
    for (const stored of [
      { ...base, account: providerObjectRef("facebook", "asset", "1009") },
      { ...base, content: providerObjectRef("instagram", "content", MEDIA) },
      { ...base, interactionKind: "reply" as const },
      { ...base, parent: providerObjectRef("facebook", "interaction", "2001_3009") },
    ]) {
      expect((await failure(h.port.getInteraction(FB_ACCESS, { kind: "stored", stored }))).toJSON()).toMatchObject({ kind: "permanent_rejected", operation: "getInteraction", details: { reasonCode: "invalid_request" } });
    }
    expect(h.calls).toEqual([]);
  });
});
