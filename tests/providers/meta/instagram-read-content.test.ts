/**
 * Meta Instagram professional-account read_content — listContent and getContent (Step 7G-H5.5-P11-B; design/phase-7g/
 * meta-provider/README.md › Instagram read_content — IMPLEMENTED_OFFLINE_NOT_LIVE_VALIDATED), offline. The sealed User
 * Access Token is used directly (no Page token is derived): ONE Graph GET per call — `{ig-user-id}/media` (one page,
 * fixed whitelist and limit, opaque `after` cursor in the `meta1.` envelope; the `next` URL is never fetched) or
 * `{ig-media-id}`. Every media object must be owned by the managed account (`owner.id`), its (`media_type`,
 * `media_product_type`) must be in the closed table, and the window [from, to) is applied client-side on `timestamp`.
 * `fetch` is an in-process double: no request leaves the process. Synthetic ids, texts and tokens only.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  CONTENT_SOURCES,
  ProviderError,
  providerCredential,
  providerObjectRef,
  type IsoInstant,
  type PageCursor,
  type ProviderErrorKind,
  type TimeWindow,
} from "@/integrations/providers/contract";
import {
  META_INSTAGRAM_MEDIA_FIELDS,
  META_INSTAGRAM_MEDIA_PAGE_LIMIT,
  META_POST_FIELDS,
  META_PUBLISHED_POSTS_PAGE_LIMIT,
  createMetaGraphTransport,
  type MetaGraphFetch,
} from "@/integrations/providers/meta/graph-transport";
import { META_INSTAGRAM_MEDIA_CONTENT_KINDS, META_STATUS_TYPE_CONTENT_KINDS, createMetaReadPort } from "@/integrations/providers/meta/read-port";
import { expectContent, expectResult } from "../contract/assertions";

const USER_TOKEN = "synthetic-meta-user-token-marker";
const BODY_MARKER = "synthetic-meta-graph-body-marker";
const CAPTION_MARKER = "Synthetic Instagram caption marker";
const HOSTILE_NEXT = "https://attacker.example.test/steal?access_token=x";
const CREDENTIAL = providerCredential("5eed0000-d1a9-4000-8000-00000000e013", USER_TOKEN);
const IG = "17840000000000001";
const OTHER_IG = "17840000000000002";
const MEDIA_A = "17900000000000001";
const MEDIA_B = "17900000000000002";
const WINDOW: TimeWindow = { from: "2026-09-22T00:00:00.000Z" as IsoInstant, to: "2026-10-22T00:00:00.000Z" as IsoInstant };
const ACCESS = { credential: CREDENTIAL, account: providerObjectRef("instagram", "asset", IG) };

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

/** An IG Media object in Meta's documented shape (timestamp in the Graph `+0000` form). */
const media = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  media_type: "IMAGE",
  media_product_type: "FEED",
  timestamp: "2026-10-01T12:00:00+0000",
  caption: `${CAPTION_MARKER} ${id}`,
  owner: { id: IG },
  ...patch,
});

interface Call {
  readonly url: URL;
  readonly init: RequestInit;
}
type Reply = (url: URL, call: Call) => Promise<Response>;

/** A Graph double: `/media` pages keyed by `after`, and media node reads. Anything else is a Graph error. */
function graphOf(world: { readonly pages?: Readonly<Record<string, unknown>>; readonly nodes?: Readonly<Record<string, unknown>> } = {}): Reply {
  return (url) => {
    const fields = url.searchParams.get("fields");
    const segments = url.pathname.split("/").slice(2).map(decodeURIComponent);
    if (segments.length === 2 && segments[1] === "media" && fields === META_INSTAGRAM_MEDIA_FIELDS) {
      const body = (world.pages ?? {})[url.searchParams.get("after") ?? ""];
      return body === undefined ? json(400, graphError({ code: 100 })) : json(200, body);
    }
    if (segments.length === 1 && fields === META_INSTAGRAM_MEDIA_FIELDS) {
      const body = (world.nodes ?? {})[segments[0] ?? ""];
      return body === undefined ? json(400, graphError({ code: 100, error_subcode: 33 })) : json(200, body);
    }
    return json(400, graphError({ code: 100 }));
  };
}

function portWith(reply: Reply) {
  const calls: Call[] = [];
  const fetch: MetaGraphFetch = (url, init) => {
    const call = { url: new URL(url), init };
    calls.push(call);
    return reply(call.url, call);
  };
  const port = createMetaReadPort({ transport: createMetaGraphTransport({ fetch }) });
  return {
    port,
    calls,
    list: (cursor: PageCursor | null = null, window: TimeWindow = WINDOW, access = ACCESS) => port.listContent(access, window, cursor),
    get: (id: string = MEDIA_A, access = ACCESS) => port.getContent(access, providerObjectRef("instagram", "content", id)),
    tokens: () => calls.map((call) => call.url.searchParams.get("access_token")),
    paths: () => calls.map((call) => `${call.url.pathname}?${call.url.searchParams.get("fields") ?? ""}`),
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

const envelope = (raw: string): PageCursor => `meta1.${Buffer.from(raw, "latin1").toString("base64url")}` as PageCursor;
const ONE_PAGE = { "": { data: [media(MEDIA_A), media(MEDIA_B, { media_type: "VIDEO", media_product_type: "REELS", caption: undefined })] } };

describe("transport · the User Access Token directly, ONE Graph GET per call — no Page token derivation", () => {
  it("listContent: exactly GET {ig-user-id}/media with the approved fields and the fixed page size, with the User token", async () => {
    const { list, calls, tokens, paths } = portWith(graphOf({ pages: ONE_PAGE }));
    await list();
    expect(paths()).toEqual([`/v25.0/${IG}/media?${META_INSTAGRAM_MEDIA_FIELDS}`]);
    expect(tokens()).toEqual([USER_TOKEN]);
    const url = calls[0]?.url;
    expect(META_INSTAGRAM_MEDIA_FIELDS).toBe("id,media_type,media_product_type,timestamp,caption,owner");
    expect(url?.searchParams.get("limit")).toBe(String(META_INSTAGRAM_MEDIA_PAGE_LIMIT));
    expect(META_INSTAGRAM_MEDIA_PAGE_LIMIT).toBe(10);
    // No cursor on the first page, no server-side window.
    expect([...(url?.searchParams.keys() ?? [])].sort()).toEqual(["access_token", "fields", "limit"]);
    for (const call of calls) {
      expect(call.url.origin).toBe("https://graph.facebook.com");
      expect(call.init.method).toBe("GET");
      expect(call.init.redirect).toBe("manual");
      expect(call.init.credentials).toBe("omit");
      expect(new Headers(call.init.headers).has("authorization")).toBe(false);
    }
  });

  it("getContent: exactly GET {ig-media-id} with the same approved fields, with the User token", async () => {
    const { get, paths, tokens } = portWith(graphOf({ nodes: { [MEDIA_A]: media(MEDIA_A) } }));
    await get();
    expect(paths()).toEqual([`/v25.0/${MEDIA_A}?${META_INSTAGRAM_MEDIA_FIELDS}`]);
    expect(tokens()).toEqual([USER_TOKEN]);
  });

  it("never requests a Page token, stories, live media, tags, mentions, children, media URLs, permalinks or metrics", async () => {
    const { list, get, calls } = portWith(graphOf({ pages: ONE_PAGE, nodes: { [MEDIA_A]: media(MEDIA_A) } }));
    await list();
    await get();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url.searchParams.get("fields")).not.toBe("access_token");
      expect(call.url.pathname).not.toMatch(/stories|live_media|tags|mentioned_media|children|published_posts/);
    }
    expect(META_INSTAGRAM_MEDIA_FIELDS).not.toMatch(/permalink|media_url|thumbnail_url|children|like_count|comments_count|insights|boost|username/);
  });

  it("the token never appears in a result, a DTO, a raw reference or an error", async () => {
    expectNoneOf(await portWith(graphOf({ pages: ONE_PAGE })).list(), [USER_TOKEN, "access_token"]);
    expectNoneOf(await portWith(graphOf({ nodes: { [MEDIA_A]: media(MEDIA_A) } })).get(), [USER_TOKEN, "access_token"]);
    const failed = await failure(portWith(graphOf({ pages: { "": { data: [media(MEDIA_A, { media_product_type: "STORY" })] } } })).list());
    expectNoneOf(failed, [USER_TOKEN, "access_token", BODY_MARKER, MEDIA_A, CAPTION_MARKER]);
  });
});

describe("listContent · normalization", () => {
  it("maps every media object to a ContentDto: identity, managed account, closed kind, unknown source, caption, times, raw reference", async () => {
    const result = await portWith(graphOf({ pages: ONE_PAGE })).list();
    const page = expectResult(result);
    expect(page.next).toEqual({ kind: "end" });
    for (const item of page.items) expectContent(item, "meta");
    expect(page.items).toEqual([
      {
        ref: providerObjectRef("instagram", "content", MEDIA_A),
        account: providerObjectRef("instagram", "asset", IG),
        contentKind: "post",
        reportedSource: "unknown",
        caption: `${CAPTION_MARKER} ${MEDIA_A}`,
        publishedAt: "2026-10-01T12:00:00.000Z",
        availability: "available",
        timestamps: { createdAt: "2026-10-01T12:00:00.000Z", updatedAt: null },
        rawReference: { provider: "meta", apiVersion: "v25.0", ref: `instagram:media:${MEDIA_A}` },
      },
      {
        ref: providerObjectRef("instagram", "content", MEDIA_B),
        account: providerObjectRef("instagram", "asset", IG),
        contentKind: "reel",
        reportedSource: "unknown",
        caption: null,
        publishedAt: "2026-10-01T12:00:00.000Z",
        availability: "available",
        timestamps: { createdAt: "2026-10-01T12:00:00.000Z", updatedAt: null },
        rawReference: { provider: "meta", apiVersion: "v25.0", ref: `instagram:media:${MEDIA_B}` },
      },
    ]);
    expect(Object.isFrozen(page) && Object.isFrozen(page.items) && page.items.every((item) => Object.isFrozen(item))).toBe(true);
  });

  it("an empty page is a successful empty result that ends", async () => {
    expect((await portWith(graphOf({ pages: { "": { data: [] } } })).list()).data).toEqual({ items: [], next: { kind: "end" } });
  });

  it.each([
    ["no id", { id: undefined }],
    ["a malformed id", { id: "has space" }],
    ["no timestamp", { timestamp: undefined }],
    ["a malformed timestamp", { timestamp: "yesterday" }],
    ["an impossible timestamp", { timestamp: "2026-02-30T12:00:00+0000" }],
    ["a non-string caption", { caption: 7 }],
    ["a lower-case media_type", { media_type: "image" }],
    ["a non-string media_product_type", { media_product_type: 1 }],
    ["an owner without id", { owner: {} }],
    ["a non-object owner", { owner: IG }],
  ])("a malformed item (%s) fails the WHOLE page closed", async (_label, patch) => {
    const { list } = portWith(graphOf({ pages: { "": { data: [media(MEDIA_A), media(MEDIA_B, patch)] } } }));
    expect((await failure(list())).toJSON()).toEqual({ kind: "permanent_rejected", operation: "listContent", retry: "never", details: { reasonCode: "unknown" } });
  });

  it.each([["a body without data", {}], ["a non-array data", { data: {} }], ["more items than the requested limit", { data: Array.from({ length: META_INSTAGRAM_MEDIA_PAGE_LIMIT + 1 }, (_, i) => media(`1790000000000${String(i).padStart(4, "0")}`)) }]])(
    "%s is unreadable",
    async (_label, body) => {
      expect((await failure(portWith(graphOf({ pages: { "": body } })).list())).kind).toBe("permanent_rejected");
    },
  );
});

describe("(media_type, media_product_type) → content kind: a CLOSED table, unknown fails closed", () => {
  it("the table is exactly IMAGE·FEED → post, VIDEO·FEED → video, VIDEO·REELS → reel, CAROUSEL_ALBUM·FEED → carousel", () => {
    expect(META_INSTAGRAM_MEDIA_CONTENT_KINDS).toEqual({ "IMAGE:FEED": "post", "VIDEO:FEED": "video", "VIDEO:REELS": "reel", "CAROUSEL_ALBUM:FEED": "carousel" });
    expect(Object.isFrozen(META_INSTAGRAM_MEDIA_CONTENT_KINDS)).toBe(true);
  });

  it.each([["IMAGE", "FEED", "post"], ["VIDEO", "FEED", "video"], ["VIDEO", "REELS", "reel"], ["CAROUSEL_ALBUM", "FEED", "carousel"]])("%s · %s → %s, on list and get alike", async (mediaType, productType, kind) => {
    const item = media(MEDIA_A, { media_type: mediaType, media_product_type: productType });
    const { list, get } = portWith(graphOf({ pages: { "": { data: [item] } }, nodes: { [MEDIA_A]: item } }));
    expect((await list()).data.items[0]?.contentKind).toBe(kind);
    expect((await get()).data.contentKind).toBe(kind);
  });

  it.each([
    ["a STORY image", { media_type: "IMAGE", media_product_type: "STORY" }],
    ["a STORY video", { media_type: "VIDEO", media_product_type: "STORY" }],
    ["AD media", { media_type: "IMAGE", media_product_type: "AD" }],
    ["an IMAGE as REELS", { media_type: "IMAGE", media_product_type: "REELS" }],
    ["a CAROUSEL_ALBUM as REELS", { media_type: "CAROUSEL_ALBUM", media_product_type: "REELS" }],
    ["an unknown media_type", { media_type: "HOLOGRAM", media_product_type: "FEED" }],
    ["an unknown media_product_type", { media_type: "IMAGE", media_product_type: "CLIPS" }],
    ["a missing media_type", { media_type: undefined }],
    ["a missing media_product_type", { media_product_type: undefined }],
    ["a prototype-named pair", { media_type: "CONSTRUCTOR", media_product_type: "FEED" }],
  ])("%s fails closed on list (the whole page) and on get — no fallback to post, other or unknown", async (_label, patch) => {
    const item = media(MEDIA_B, patch);
    const { list, get } = portWith(graphOf({ pages: { "": { data: [media(MEDIA_A), item] } }, nodes: { [MEDIA_B]: item } }));
    expect((await failure(list())).toJSON()).toEqual({ kind: "permanent_rejected", operation: "listContent", retry: "never", details: { reasonCode: "unknown" } });
    expect((await failure(get(MEDIA_B))).toJSON()).toEqual({ kind: "permanent_rejected", operation: "getContent", retry: "never", details: { reasonCode: "unknown" } });
  });

  it("the Facebook status_type table is unchanged by the Instagram branch", () => {
    expect(META_STATUS_TYPE_CONTENT_KINDS).toEqual({ added_video: "video", mobile_status_update: "post", added_photos: "post", shared_story: "post" });
  });
});

describe("identity: owner.id must be the managed account; refs must be Instagram", () => {
  it("media of another account fails the whole page closed (no partial page) and the single read alike", async () => {
    const foreign = media(MEDIA_B, { owner: { id: OTHER_IG } });
    const { list, get } = portWith(graphOf({ pages: { "": { data: [media(MEDIA_A), foreign] } }, nodes: { [MEDIA_B]: foreign } }));
    const listed = await failure(list());
    expect(listed.toJSON()).toEqual({ kind: "permanent_rejected", operation: "listContent", retry: "never", details: { reasonCode: "unknown" } });
    expectNoneOf(listed, [OTHER_IG, MEDIA_A, MEDIA_B]);
    expect((await failure(get(MEDIA_B))).toJSON().details).toEqual({ reasonCode: "unknown" });
  });

  it("media without an owner fails closed on list and get — never accepted on its id alone", async () => {
    const ownerless = media(MEDIA_A, { owner: undefined });
    const { list, get } = portWith(graphOf({ pages: { "": { data: [ownerless] } }, nodes: { [MEDIA_A]: ownerless } }));
    expect((await failure(list())).toJSON().details).toEqual({ reasonCode: "unknown" });
    expect((await failure(get())).toJSON().details).toEqual({ reasonCode: "unknown" });
  });

  it("a get answer echoing another media id is unreadable", async () => {
    const { get } = portWith(graphOf({ nodes: { [MEDIA_A]: media(MEDIA_B) } }));
    expect((await failure(get())).toJSON()).toEqual({ kind: "permanent_rejected", operation: "getContent", retry: "never", details: { reasonCode: "unknown" } });
  });

  it.each([
    ["a Facebook content ref", providerObjectRef("facebook", "content", MEDIA_A)],
    ["an interaction ref", providerObjectRef("instagram", "interaction", MEDIA_A)],
    ["a forged id", { platform: "instagram", kind: "content", id: "../me/accounts" }],
  ])("getContent refuses %s before any request", async (_label, ref) => {
    const { port, calls } = portWith(graphOf({ nodes: { [MEDIA_A]: media(MEDIA_A) } }));
    expect((await failure(port.getContent(ACCESS, ref as never))).toJSON()).toEqual({ kind: "permanent_rejected", operation: "getContent", retry: "never", details: { reasonCode: "invalid_request" } });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["a non-asset Instagram ref", providerObjectRef("instagram", "content", IG)],
    ["a forged account id", { platform: "instagram", kind: "asset", id: "../me" }],
  ])("%s as the account is refused (invalid_request) before any request", async (_label, account) => {
    const { port, calls } = portWith(graphOf({ pages: ONE_PAGE }));
    const access = { credential: CREDENTIAL, account } as unknown as typeof ACCESS;
    for (const [operation, run] of [["listContent", () => port.listContent(access, WINDOW, null)], ["getContent", () => port.getContent(access, providerObjectRef("instagram", "content", MEDIA_A))]] as const) {
      expect((await failure(run())).toJSON()).toEqual({ kind: "permanent_rejected", operation, retry: "never", details: { reasonCode: "invalid_request" } });
    }
    expect(calls).toHaveLength(0);
  });

  it("the account's platform selects the branch: an Instagram account never takes the Page path (no published_posts, no derivation)", async () => {
    const { list, calls } = portWith(graphOf({ pages: ONE_PAGE }));
    await list();
    expect(calls.map((call) => call.url.pathname)).toEqual([`/v25.0/${IG}/media`]);
    expect(calls.some((call) => call.url.searchParams.get("fields") === META_POST_FIELDS)).toBe(false);
  });
});

describe("time window [from, to): client-side on timestamp, never a server bound, never an early stop", () => {
  it("keeps exactly the media with from ≤ timestamp < to (Meta's +0000 form), and sends no since/until", async () => {
    const at = (time: string, id: string) => media(id, { timestamp: time });
    const { list, calls } = portWith(graphOf({
      pages: { "": { data: [at("2026-09-21T23:59:59+0000", "17900000000000011"), at("2026-09-22T00:00:00+0000", "17900000000000012"), at("2026-10-10T08:00:00+0000", "17900000000000013"), at("2026-10-22T00:00:00+0000", "17900000000000014"), at("2026-10-23T00:00:00+0000", "17900000000000015")] } },
    }));
    expect((await list()).data.items.map((item) => item.ref.id)).toEqual(["17900000000000012", "17900000000000013"]);
    expect(calls[0]?.url.searchParams.has("since") || calls[0]?.url.searchParams.has("until")).toBe(false);
  });

  it("does not depend on provider order: newest-first and oldest-first pages filter identically", async () => {
    const items = [media("17900000000000021", { timestamp: "2026-10-05T00:00:00+0000" }), media("17900000000000022", { timestamp: "2026-08-01T00:00:00+0000" }), media("17900000000000023", { timestamp: "2026-10-15T00:00:00+0000" })];
    const forward = (await portWith(graphOf({ pages: { "": { data: items } } })).list()).data.items.map((item) => item.ref.id).sort();
    const backward = (await portWith(graphOf({ pages: { "": { data: [...items].reverse() } } })).list()).data.items.map((item) => item.ref.id).sort();
    expect(forward).toEqual(["17900000000000021", "17900000000000023"]);
    expect(backward).toEqual(forward);
  });

  it("a page whose media all fall outside the window is empty yet still reports `more`", async () => {
    const { list } = portWith(graphOf({ pages: { "": { data: [media(MEDIA_A, { timestamp: "2020-01-01T00:00:00+0000" })], paging: { cursors: { after: "QVFIUmlnQ3Vyc29y" }, next: HOSTILE_NEXT } } } }));
    expect((await list()).data).toEqual({ items: [], next: { kind: "more", cursor: envelope("QVFIUmlnQ3Vyc29y") } });
  });

  it("an inverted window is refused before any request", async () => {
    const { list, calls } = portWith(graphOf({ pages: ONE_PAGE }));
    expect((await failure(list(null, { from: WINDOW.to, to: WINDOW.from }))).toJSON().details).toEqual({ reasonCode: "invalid_request" });
    expect(calls).toHaveLength(0);
  });
});

describe("source: always unknown — FEED and REELS are surfaces, never organic or paid", () => {
  it("every accepted kind reports unknown; no path emits organic, paid, mixed or any", async () => {
    const pairs = [["IMAGE", "FEED"], ["VIDEO", "FEED"], ["VIDEO", "REELS"], ["CAROUSEL_ALBUM", "FEED"]] as const;
    const data = pairs.map(([mediaType, productType], i) => media(`1790000000000003${String(i)}`, { media_type: mediaType, media_product_type: productType, is_shared_to_feed: true, boost_ads_list: [{ id: "1" }] }));
    const { items } = (await portWith(graphOf({ pages: { "": { data } } })).list()).data;
    expect(items.map((item) => item.reportedSource)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
    expect(CONTENT_SOURCES).not.toContain("any");
    expectNoneOf(items, ["organic", "paid", "mixed", "boost"]);
  });
});

describe("pagination: the same `meta1.` envelope and fixed-endpoint continuation as the Page path", () => {
  it("next + a valid after → more with the envelope; the next page sends the RAW after to /media; next absent → end", async () => {
    const RAW = "QVFIUmlnQWZ0ZXI";
    const { list, calls } = portWith(graphOf({ pages: { "": { data: [media(MEDIA_A)], paging: { cursors: { before: "QVFIUmJlZm9yZQ", after: RAW }, next: HOSTILE_NEXT } }, [RAW]: { data: [media(MEDIA_B)] } } }));
    const first = (await list()).data;
    expect(first.next).toEqual({ kind: "more", cursor: envelope(RAW) });
    const second = (await list(first.next.kind === "more" ? first.next.cursor : null)).data;
    expect(second.next).toEqual({ kind: "end" });
    expect(calls.map((call) => call.url.pathname)).toEqual([`/v25.0/${IG}/media`, `/v25.0/${IG}/media`]);
    expect(calls[1]?.url.searchParams.get("after")).toBe(RAW);
    for (const call of calls) {
      expect(call.url.href).not.toContain("meta1.");
      expect(call.url.href).not.toContain("attacker");
    }
  });

  it.each([["next without a cursor", { data: [], paging: { next: HOSTILE_NEXT } }], ["an empty next", { data: [], paging: { cursors: { after: "QVFI" }, next: "" } }], ["a cursor with whitespace", { data: [], paging: { cursors: { after: "a b" }, next: HOSTILE_NEXT } }]])(
    "%s from Graph fails closed as unreadable",
    async (_label, body) => {
      expect((await failure(portWith(graphOf({ pages: { "": body } })).list())).toJSON().details).toEqual({ reasonCode: "unknown" });
    },
  );

  it.each([["a raw Graph cursor (no envelope)", "QVFIUmlnQWZ0ZXI"], ["another version", "meta2.QUJD"], ["a padded payload", "meta1.QUJD=="], ["a non-canonical payload", "meta1.QUJ"]])(
    "an incoming PageCursor that is %s is refused (invalid_cursor) before any request",
    async (_label, cursor) => {
      const { list, calls } = portWith(graphOf({ pages: ONE_PAGE }));
      expect((await failure(list(cursor as PageCursor))).toJSON()).toEqual({ kind: "permanent_rejected", operation: "listContent", retry: "never", details: { reasonCode: "invalid_cursor" } });
      expect(calls).toHaveLength(0);
    },
  );

  it("a returned cursor equal to the one sent (a repeat) fails closed", async () => {
    const RAW = "QVFIUmlnQWZ0ZXI";
    const { list } = portWith(graphOf({ pages: { [RAW]: { data: [], paging: { cursors: { after: RAW }, next: HOSTILE_NEXT } } } }));
    expect((await failure(list(envelope(RAW)))).toJSON().details).toEqual({ reasonCode: "invalid_cursor" });
  });
});

describe("errors: the shared Graph read mapping, unchanged", () => {
  const cases: readonly (readonly [string, unknown, number, ProviderErrorKind, Record<string, unknown>])[] = [
    ["code 10 (permission)", graphError({ code: 10 }), 403, "permission_missing", { capability: "read_content" }],
    ["code 200 (permission)", graphError({ code: 200 }), 403, "permission_missing", { capability: "read_content" }],
    ["subcode 492 inside OAuthException", graphError({ code: 190, type: "OAuthException", error_subcode: 492 }), 400, "permission_missing", { capability: "read_content" }],
    ["code 190 / 463 (expired)", graphError({ code: 190, type: "OAuthException", error_subcode: 463 }), 400, "credential_invalid", { reason: "expired" }],
    ["code 4 (rate)", graphError({ code: 4 }), 400, "rate_limited", { retryAfterSeconds: null }],
    ["code 2 (temporary)", graphError({ code: 2 }), 500, "transient", { reason: "provider_unavailable" }],
    ["code 368 (policy)", graphError({ code: 368 }), 400, "permanent_rejected", { reasonCode: "content_policy" }],
  ];

  it.each(cases)("%s → %s on both operations, never unsupported or not-eligible, leaking nothing", async (_label, body, status, kind, details) => {
    const reply: Reply = () => json(status, body);
    for (const [operation, run] of [["listContent", portWith(reply).list], ["getContent", portWith(reply).get]] as const) {
      const error = await failure(run());
      expect(error.toJSON()).toEqual({ kind, operation, retry: error.retry, details });
      expect(error.kind).not.toBe("target_not_eligible");
      expectNoneOf(error, [USER_TOKEN, BODY_MARKER, "synthetic-trace", "access_token"]);
    }
  });

  it("code 100 / subcode 33 on the media read → TargetNotFound; on /media it stays a permanent rejection", async () => {
    expect((await failure(portWith(graphOf({ nodes: {} })).get())).toJSON()).toEqual({ kind: "target_not_found", operation: "getContent", retry: "never", details: {} });
    const listing = portWith(() => json(400, graphError({ code: 100, error_subcode: 33 })));
    expect((await failure(listing.list())).toJSON()).toEqual({ kind: "permanent_rejected", operation: "listContent", retry: "never", details: { reasonCode: "unknown" } });
  });

  it("a network failure is transient after exactly one request (no internal retry)", async () => {
    const { list, calls } = portWith(() => Promise.reject(new TypeError(`fetch failed ?access_token=${USER_TOKEN}`)));
    const error = await failure(list());
    expect(error.kind).toBe("transient");
    expect(calls).toHaveLength(1);
    expectNoneOf(error, [USER_TOKEN, "access_token"]);
  });

  it("the Page path keeps its own constants (Facebook regression pin)", () => {
    expect(META_POST_FIELDS).toBe("id,from,message,created_time,updated_time,status_type");
    expect(META_PUBLISHED_POSTS_PAGE_LIMIT).toBe(10);
  });
});
