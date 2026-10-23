/**
 * Meta Facebook Page read_content — listContent and getContent (Step 7G-H5.5-P5-B; design/phase-7g/meta-provider/
 * README.md › read_content — IMPLEMENTED_OFFLINE_NOT_LIVE_VALIDATED), offline. Each call derives a Page Access Token
 * from the User Access Token (`{page-id}?fields=access_token`) and makes ONE content read with it: `{page-id}/
 * published_posts` (one page, fixed whitelist and limit, opaque `after` cursor; the `next` URL is never fetched) or
 * `{post-id}`. Every post must be published by the managed Page (`from.id`), its status_type must be in the closed
 * table, and the window [from, to) is applied client-side. `fetch` is an in-process double: no request leaves the
 * process. Synthetic ids, texts and tokens only — the Page token is a marker, never real secret material.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  PAGE_CURSOR_MAX_LENGTH,
  ProviderError,
  parsePageCursor,
  providerCredential,
  providerObjectRef,
  type IsoInstant,
  type PageCursor,
  type ProviderErrorKind,
  type TimeWindow,
} from "@/integrations/providers/contract";
import { META_GRAPH_CURSOR_MAX_LENGTH, META_POST_FIELDS, META_PUBLISHED_POSTS_PAGE_LIMIT, createMetaGraphTransport, parseGraphDatetime, type MetaGraphFetch } from "@/integrations/providers/meta/graph-transport";
import { META_PAGE_CURSOR_PREFIX, META_STATUS_TYPE_CONTENT_KINDS, createMetaReadPort } from "@/integrations/providers/meta/read-port";
import { expectContent, expectResult } from "../contract/assertions";

const USER_TOKEN = "synthetic-meta-user-token-marker";
const PAGE_TOKEN = "synthetic-meta-page-token-marker";
const BODY_MARKER = "synthetic-meta-graph-body-marker";
const NAME_MARKER = "Synthetic Page Display Name Marker";
const HOSTILE_NEXT = "https://attacker.example.test/steal?access_token=x";
const CREDENTIAL = providerCredential("5eed0000-d1a9-4000-8000-00000000e003", USER_TOKEN);
const PAGE = "1001";
const OTHER_PAGE = "1002";
const POST_A = `${PAGE}_2001`;
const POST_B = `${PAGE}_2002`;
const WINDOW: TimeWindow = { from: "2026-09-22T00:00:00.000Z" as IsoInstant, to: "2026-10-22T00:00:00.000Z" as IsoInstant };
const ACCESS = { credential: CREDENTIAL, account: providerObjectRef("facebook", "asset", PAGE) };

const renderings = (value: unknown): string => {
  const error = value instanceof Error ? `${value.message} ${value.stack ?? ""} ${String(value.cause)}` : "";
  return [JSON.stringify(value), String(value), inspect(value, { depth: 10, showHidden: true }), error].join(" ");
};
const expectNoneOf = (value: unknown, secrets: readonly string[]): void => {
  const rendered = renderings(value);
  for (const secret of secrets) expect(rendered, secret).not.toContain(secret);
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }));
const graphError = (fields: Record<string, unknown>) => ({ error: { message: BODY_MARKER, error_user_msg: BODY_MARKER, fbtrace_id: "synthetic-trace", ...fields } });

const post = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  from: { id: PAGE, name: NAME_MARKER },
  message: `caption of ${id}`,
  created_time: "2026-10-01T12:00:00+0000",
  updated_time: "2026-10-02T08:30:00+0000",
  status_type: "mobile_status_update",
  ...patch,
});

interface Call {
  readonly url: URL;
  readonly init: RequestInit;
}
type Reply = (url: URL, call: Call) => Promise<Response>;

/** The token derivation answer (the Page node with its access_token, as Meta returns it). */
const TOKEN_REPLY = (): Promise<Response> => json(200, { access_token: PAGE_TOKEN, id: PAGE });

/** A Graph double: token derivation, published_posts pages keyed by `after`, and post reads. */
function graphOf(world: { readonly pages?: Readonly<Record<string, unknown>>; readonly posts?: Readonly<Record<string, unknown>>; readonly token?: Reply } = {}): Reply {
  return (url, call) => {
    const fields = url.searchParams.get("fields");
    const segments = url.pathname.split("/").slice(2).map(decodeURIComponent);
    if (segments.length === 1 && fields === "access_token") return (world.token ?? TOKEN_REPLY)(url, call);
    if (segments.length === 2 && segments[1] === "published_posts") {
      const body = (world.pages ?? {})[url.searchParams.get("after") ?? ""];
      return body === undefined ? json(400, graphError({ code: 100 })) : json(200, body);
    }
    if (segments.length === 1 && fields === META_POST_FIELDS) {
      const body = (world.posts ?? {})[segments[0] ?? ""];
      return body === undefined ? json(400, graphError({ code: 100, error_subcode: 33 })) : json(200, body);
    }
    return json(400, graphError({ code: 100 }));
  };
}

function portWith(reply: Reply, options: { readonly timeoutMs?: number; readonly maxResponseBytes?: number } = {}) {
  const calls: Call[] = [];
  const fetch: MetaGraphFetch = (url, init) => {
    const call = { url: new URL(url), init };
    calls.push(call);
    return reply(call.url, call);
  };
  const port = createMetaReadPort({ transport: createMetaGraphTransport({ fetch, ...options }) });
  return {
    port,
    calls,
    list: (cursor: PageCursor | null = null, window: TimeWindow = WINDOW, access = ACCESS) => port.listContent(access, window, cursor),
    get: (id: string = POST_A, access = ACCESS) => port.getContent(access, providerObjectRef("facebook", "content", id)),
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

/** The expected Meta envelope of a raw Graph cursor (computed independently of the adapter's helper). */
const envelope = (raw: string): PageCursor => `meta1.${Buffer.from(raw, "latin1").toString("base64url")}` as PageCursor;

const ONE_PAGE = { "": { data: [post(POST_A), post(POST_B, { status_type: "added_video", message: undefined, updated_time: undefined })] } };

describe("Page Access Token derivation", () => {
  it("derives the Page token with the USER token at {page-id}?fields=access_token, then reads content with the PAGE token only", async () => {
    const { list, calls, tokens, paths } = portWith(graphOf({ pages: ONE_PAGE }));
    await list();
    expect(paths()).toEqual([`/v25.0/${PAGE}?access_token`, `/v25.0/${PAGE}/published_posts?${META_POST_FIELDS}`]);
    expect(tokens()).toEqual([USER_TOKEN, PAGE_TOKEN]);
    for (const call of calls) {
      expect(call.url.origin).toBe("https://graph.facebook.com");
      expect(call.init.method).toBe("GET");
      expect(call.init.redirect).toBe("manual");
      expect(call.init.credentials).toBe("omit");
      expect(new Headers(call.init.headers).has("authorization")).toBe(false);
    }
  });

  it("is derived afresh for every call (never cached): two listContent calls → two derivations", async () => {
    const { list, paths } = portWith(graphOf({ pages: ONE_PAGE }));
    await list();
    await list();
    expect(paths().filter((p) => p.endsWith("?access_token"))).toHaveLength(2);
  });

  it("the token never appears in the result, a DTO, a raw reference, or an error", async () => {
    const ok = portWith(graphOf({ pages: ONE_PAGE }));
    const result = await ok.list();
    expectNoneOf(result, [PAGE_TOKEN, USER_TOKEN, "access_token", NAME_MARKER]);
    const single = await portWith(graphOf({ posts: { [POST_A]: post(POST_A) } })).get();
    expectNoneOf(single, [PAGE_TOKEN, USER_TOKEN, "access_token", NAME_MARKER]);
    const failed = await failure(portWith(graphOf({ pages: { "": { data: [post(POST_A, { status_type: "created_event" })] } } })).list());
    expectNoneOf(failed, [PAGE_TOKEN, USER_TOKEN, "access_token", BODY_MARKER, POST_A]);
  });

  it.each([
    ["no access_token", { id: PAGE }],
    ["an empty access_token", { id: PAGE, access_token: "" }],
    ["a non-string access_token", { id: PAGE, access_token: 42 }],
    ["an access_token with whitespace", { id: PAGE, access_token: "abc def" }],
    ["an echoed id of another Page", { id: OTHER_PAGE, access_token: PAGE_TOKEN }],
    ["an array body", [PAGE_TOKEN]],
  ])("a malformed derivation (%s) fails closed as unreadable before any content read", async (_label, body) => {
    const { list, get, calls } = portWith(graphOf({ pages: ONE_PAGE, token: () => json(200, body) }));
    for (const [operation, run] of [["listContent", list], ["getContent", get]] as const) {
      const error = await failure(run());
      expect(error.toJSON()).toEqual({ kind: "permanent_rejected", operation, retry: "never", details: { reasonCode: "unknown" } });
      expectNoneOf(error, [PAGE_TOKEN, USER_TOKEN]);
    }
    expect(calls.every((call) => call.url.searchParams.get("fields") === "access_token")).toBe(true);
  });

  it("a derivation with no echoed id is accepted (the id is checked only when present)", async () => {
    const { list } = portWith(graphOf({ pages: ONE_PAGE, token: () => json(200, { access_token: PAGE_TOKEN }) }));
    expect((await list()).data.items).toHaveLength(2);
  });
});

describe("listContent · GET {page-id}/published_posts", () => {
  it("requests exactly the field whitelist and the fixed page size — never /feed, attachments, story or insights", async () => {
    const { list, calls } = portWith(graphOf({ pages: ONE_PAGE }));
    await list();
    const content = calls[1]?.url;
    expect(content?.pathname).toBe(`/v25.0/${PAGE}/published_posts`);
    expect(content?.searchParams.get("fields")).toBe("id,from,message,created_time,updated_time,status_type");
    expect(content?.searchParams.get("limit")).toBe(String(META_PUBLISHED_POSTS_PAGE_LIMIT));
    expect(META_PUBLISHED_POSTS_PAGE_LIMIT).toBe(10);
    expect([...(content?.searchParams.keys() ?? [])].sort()).toEqual(["access_token", "fields", "limit"]);
    expect(calls.map((call) => call.url.pathname).join(" ")).not.toMatch(/feed/);
    expect(META_POST_FIELDS).not.toMatch(/attachments|full_picture|permalink_url|story|insights|name/);
  });

  it("maps every post to a ContentDto: identity, managed account, closed kind, unknown source, caption, times, raw reference", async () => {
    const { list } = portWith(graphOf({ pages: ONE_PAGE }));
    const result = await list();
    const page = expectResult(result);
    expect(page.next).toEqual({ kind: "end" });
    for (const item of page.items) expectContent(item, "meta");
    expect(page.items).toEqual([
      {
        ref: providerObjectRef("facebook", "content", POST_A),
        account: providerObjectRef("facebook", "asset", PAGE),
        contentKind: "post",
        reportedSource: "unknown",
        caption: `caption of ${POST_A}`,
        publishedAt: "2026-10-01T12:00:00.000Z",
        availability: "available",
        timestamps: { createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-02T08:30:00.000Z" },
        rawReference: { provider: "meta", apiVersion: "v25.0", ref: `facebook:post:${POST_A}` },
      },
      {
        ref: providerObjectRef("facebook", "content", POST_B),
        account: providerObjectRef("facebook", "asset", PAGE),
        contentKind: "video",
        reportedSource: "unknown",
        caption: null,
        publishedAt: "2026-10-01T12:00:00.000Z",
        availability: "available",
        timestamps: { createdAt: "2026-10-01T12:00:00.000Z", updatedAt: null },
        rawReference: { provider: "meta", apiVersion: "v25.0", ref: `facebook:post:${POST_B}` },
      },
    ]);
    expect(Object.isFrozen(page) && Object.isFrozen(page.items) && page.items.every((item) => Object.isFrozen(item))).toBe(true);
    // from.name and every non-whitelisted field never reach the DTO.
    expectNoneOf(result, [NAME_MARKER, PAGE_TOKEN]);
  });

  it("reportedSource is always unknown — /published_posts never manufactures organic", async () => {
    const { list } = portWith(graphOf({ pages: { "": { data: [post(POST_A, { is_published: true, promotion_status: "ineligible" })] } } }));
    expect((await list()).data.items.map((item) => item.reportedSource)).toEqual(["unknown"]);
  });

  it("an empty page is a successful empty result that ends", async () => {
    const { list } = portWith(graphOf({ pages: { "": { data: [] } } }));
    expect((await list()).data).toEqual({ items: [], next: { kind: "end" } });
  });

  it("a post published by another identity fails the WHOLE page closed (no partial page)", async () => {
    const { list } = portWith(graphOf({ pages: { "": { data: [post(POST_A), post(POST_B, { from: { id: OTHER_PAGE, name: NAME_MARKER } })] } } }));
    const error = await failure(list());
    expect(error.toJSON()).toEqual({ kind: "permanent_rejected", operation: "listContent", retry: "never", details: { reasonCode: "unknown" } });
    expectNoneOf(error, [NAME_MARKER, OTHER_PAGE, POST_A]);
  });

  it.each([
    ["no id", { id: undefined }],
    ["a malformed id", { id: "has space" }],
    ["no from", { from: undefined }],
    ["from without id", { from: { name: NAME_MARKER } }],
    ["a non-string message", { message: 7 }],
    ["no created_time", { created_time: undefined }],
    ["a malformed created_time", { created_time: "yesterday" }],
    ["an impossible created_time", { created_time: "2026-02-30T12:00:00+0000" }],
    ["a malformed updated_time", { updated_time: "2026-10-02" }],
    ["a malformed status_type", { status_type: "Added Video" }],
  ])("a malformed item (%s) fails the page closed", async (_label, patch) => {
    const { list } = portWith(graphOf({ pages: { "": { data: [post(POST_A), post(POST_B, patch)] } } }));
    expect((await failure(list())).toJSON().details).toEqual({ reasonCode: "unknown" });
  });

  it.each([["a body without data", {}], ["a non-array data", { data: {} }], ["more items than the requested limit", { data: Array.from({ length: META_PUBLISHED_POSTS_PAGE_LIMIT + 1 }, (_, i) => post(`${PAGE}_3${String(i).padStart(3, "0")}`)) }]])(
    "%s is unreadable",
    async (_label, body) => {
      const { list } = portWith(graphOf({ pages: { "": body } }));
      expect((await failure(list())).kind).toBe("permanent_rejected");
    },
  );
});

describe("status_type → content kind: a CLOSED table, unknown fails closed", () => {
  it("the table is exactly added_video → video and three ordinary post types → post", () => {
    expect(META_STATUS_TYPE_CONTENT_KINDS).toEqual({ added_video: "video", mobile_status_update: "post", added_photos: "post", shared_story: "post" });
    expect(Object.isFrozen(META_STATUS_TYPE_CONTENT_KINDS)).toBe(true);
  });

  it.each(Object.entries({ added_video: "video", mobile_status_update: "post", added_photos: "post", shared_story: "post" }))("%s → %s", async (statusType, kind) => {
    const { list } = portWith(graphOf({ pages: { "": { data: [post(POST_A, { status_type: statusType })] } } }));
    expect((await list()).data.items[0]?.contentKind).toBe(kind);
  });

  it.each(["created_event", "created_note", "wall_post", "app_created_story", "published_story", "tagged_in_photo", "approved_friend", "created_group", "added_reel", "some_future_type", undefined])(
    "%s (unknown or missing) fails the page closed — no silent fallback to post",
    async (statusType) => {
      const { list } = portWith(graphOf({ pages: { "": { data: [post(POST_A), post(POST_B, { status_type: statusType })] } } }));
      expect((await failure(list())).toJSON()).toEqual({ kind: "permanent_rejected", operation: "listContent", retry: "never", details: { reasonCode: "unknown" } });
    },
  );
});

describe("status_type lookup is own-property only (Step 7G-H5.5-P11-B-H1): inherited names never yield a kind", () => {
  // `constructor` passes the lexical grammar and is inherited by every plain object; the others are rejected earlier by
  // the grammar. Whichever stage refuses them, none may produce a ContentKind, on list or get.
  it.each(["constructor", "toString", "__proto__", "valueOf", "hasownproperty", "future_status"])("%s fails closed on listContent (the whole page) and on getContent", async (statusType) => {
    const hostile = post(POST_B, { status_type: statusType });
    const { list, get } = portWith(graphOf({ pages: { "": { data: [post(POST_A), hostile] } }, posts: { [POST_B]: hostile } }));
    expect((await failure(list())).toJSON()).toEqual({ kind: "permanent_rejected", operation: "listContent", retry: "never", details: { reasonCode: "unknown" } });
    expect((await failure(get(POST_B))).toJSON()).toEqual({ kind: "permanent_rejected", operation: "getContent", retry: "never", details: { reasonCode: "unknown" } });
  });

  it("the four supported status types still map exactly as before, with the same DTO facts", async () => {
    const statuses = Object.keys(META_STATUS_TYPE_CONTENT_KINDS);
    expect(statuses).toEqual(["added_video", "mobile_status_update", "added_photos", "shared_story"]);
    for (const statusType of statuses) {
      const { list, get } = portWith(graphOf({ pages: { "": { data: [post(POST_A, { status_type: statusType })] } }, posts: { [POST_A]: post(POST_A, { status_type: statusType }) } }));
      const expected = { ref: providerObjectRef("facebook", "content", POST_A), account: providerObjectRef("facebook", "asset", PAGE), contentKind: META_STATUS_TYPE_CONTENT_KINDS[statusType], reportedSource: "unknown", caption: `caption of ${POST_A}`, publishedAt: "2026-10-01T12:00:00.000Z" };
      const page = (await list()).data;
      expect(page.next).toEqual({ kind: "end" });
      expect(page.items[0]).toMatchObject(expected);
      expect((await get()).data).toMatchObject(expected);
    }
  });
});

describe("time window [from, to): client-side on created_time, never a server bound, never an early stop", () => {
  it("keeps exactly the items with from ≤ created_time < to, and sends no since/until", async () => {
    const at = (time: string, id: string) => post(id, { created_time: time });
    const { list, calls } = portWith(graphOf({
      pages: { "": { data: [at("2026-09-21T23:59:59+0000", `${PAGE}_1`), at("2026-09-22T00:00:00+0000", `${PAGE}_2`), at("2026-10-21T23:59:59+0000", `${PAGE}_3`), at("2026-10-22T00:00:00+0000", `${PAGE}_4`), at("2026-10-21T20:00:00-0500", `${PAGE}_5`)] } },
    }));
    const { items } = (await list()).data;
    expect(items.map((item) => item.ref.id)).toEqual([`${PAGE}_2`, `${PAGE}_3`]);
    expect(calls[1]?.url.searchParams.has("since") || calls[1]?.url.searchParams.has("until")).toBe(false);
  });

  it("a page whose items all fall outside the window is empty yet still reports `more` (no stop on ordering)", async () => {
    const { list } = portWith(graphOf({ pages: { "": { data: [post(POST_A, { created_time: "2020-01-01T00:00:00+0000" })], paging: { cursors: { after: "QVFIUmN1cnNvcg" }, next: HOSTILE_NEXT } } } }));
    expect((await list()).data).toEqual({ items: [], next: { kind: "more", cursor: envelope("QVFIUmN1cnNvcg") } });
  });

  it.each([
    ["an inverted window", { from: WINDOW.to, to: WINDOW.from }],
    ["an empty window", { from: WINDOW.from, to: WINDOW.from }],
    ["a non-instant bound", { from: "2026-09-22" as IsoInstant, to: WINDOW.to }],
  ])("%s is refused before any request", async (_label, window) => {
    const { list, calls } = portWith(graphOf({ pages: ONE_PAGE }));
    expect((await failure(list(null, window))).toJSON()).toEqual({ kind: "permanent_rejected", operation: "listContent", retry: "never", details: { reasonCode: "invalid_request" } });
    expect(calls).toHaveLength(0);
  });

  it("Graph datetimes: the default +0000 form, a colon offset and Z are UTC instants; anything else is undefined", () => {
    expect(parseGraphDatetime("2026-10-01T12:00:00+0000")).toBe("2026-10-01T12:00:00.000Z");
    expect(parseGraphDatetime("2026-10-01T07:00:00-05:00")).toBe("2026-10-01T12:00:00.000Z");
    expect(parseGraphDatetime("2026-10-01T12:00:00Z")).toBe("2026-10-01T12:00:00.000Z");
    for (const bad of ["2026-10-01", "2026-13-01T00:00:00+0000", "2026-10-01T24:00:00+0000", "2026-10-01T12:00:00", "1696161600", 1696161600, null]) expect(parseGraphDatetime(bad), String(bad)).toBeUndefined();
  });
});

describe("pagination: ONE provider page per call; the Graph `after` cursor in a `meta1.` envelope; `next` is never fetched", () => {
  const cursorPage = (after: unknown, next: unknown = HOSTILE_NEXT) => ({ data: [post(POST_A)], paging: { cursors: { before: "QVFIUmJlZm9yZQ", after }, next } });
  /** What a page with continuation `raw` must hand back, and what a second page must request (Graph sees `raw`). */
  async function roundTrip(raw: string) {
    const { list, calls } = portWith(graphOf({ pages: { "": cursorPage(raw), [raw]: { data: [post(POST_B)] } } }));
    const first = (await list()).data;
    const cursor = first.next.kind === "more" ? first.next.cursor : null;
    const second = (await list(cursor)).data;
    return { first, second, cursor, sentAfter: calls[3]?.url.searchParams.get("after"), calls };
  }

  it("next + a valid after → more with the deterministic `meta1.` envelope; the next page sends the RAW after; next absent → end", async () => {
    const { first, second, sentAfter, calls } = await roundTrip("QVFIUmFmdGVy");
    expect(first.next).toEqual({ kind: "more", cursor: envelope("QVFIUmFmdGVy") });
    expect(META_PAGE_CURSOR_PREFIX).toBe("meta1.");
    expect(second.next).toEqual({ kind: "end" });
    // Exactly one content page per call; the follow-up went to the fixed endpoint with the decoded cursor, never to `next`.
    expect(calls.map((call) => call.url.pathname)).toEqual([`/v25.0/${PAGE}`, `/v25.0/${PAGE}/published_posts`, `/v25.0/${PAGE}`, `/v25.0/${PAGE}/published_posts`]);
    expect(sentAfter).toBe("QVFIUmFmdGVy");
    for (const call of calls) {
      expect(call.url.origin).toBe("https://graph.facebook.com");
      expect(call.url.href).not.toContain("meta1.");
      expect(call.url.href).not.toContain("attacker");
    }
  });

  it.each([
    ["a `+`", "QVFI+UmFmdGVy"],
    ["a `/`", "QVFI/UmFmdGVy"],
    ["`=` padding", "QVFIUmFmdGVy=="],
    ["every printable ASCII symbol", "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"],
    ["1023 characters", "Q".repeat(1023)],
    ["exactly the 1024-character raw maximum", "/".repeat(META_GRAPH_CURSOR_MAX_LENGTH)],
  ])("a raw cursor with %s is accepted, enveloped within capacity, and sent back to Graph byte-for-byte", async (_label, raw) => {
    const { first, cursor, sentAfter } = await roundTrip(raw);
    expect(first.next).toEqual({ kind: "more", cursor: envelope(raw) });
    expect(cursor?.length).toBeLessThanOrEqual(PAGE_CURSOR_MAX_LENGTH);
    expect(parsePageCursor(cursor)).toBe(cursor);
    expect(sentAfter).toBe(raw);
  });

  it("the envelope is deterministic: the same raw cursor always yields the same PageCursor", async () => {
    const a = await roundTrip("QVFI+UmFmdGVy/x");
    const b = await roundTrip("QVFI+UmFmdGVy/x");
    expect(a.cursor).not.toBeNull();
    expect(a.cursor).toBe(b.cursor);
  });

  it("a page without paging, or with paging but no next, ends", async () => {
    for (const body of [{ data: [post(POST_A)] }, { data: [post(POST_A)], paging: { cursors: { after: "QVFIUmFmdGVy" } } }]) {
      const { list } = portWith(graphOf({ pages: { "": body } }));
      expect((await list()).data.next).toEqual({ kind: "end" });
    }
  });

  it.each([
    ["next without a cursor", { data: [], paging: { next: HOSTILE_NEXT } }],
    ["a non-string cursor", cursorPage(42)],
    ["an empty cursor", cursorPage("")],
    ["a cursor with whitespace", cursorPage("abc def")],
    ["a cursor with a control character", cursorPage("abc\ndef")],
    ["an oversized (1025-character) cursor", cursorPage("Q".repeat(META_GRAPH_CURSOR_MAX_LENGTH + 1))],
    ["an empty next", cursorPage("QVFIUmFmdGVy", "")],
    ["a non-object paging", { data: [], paging: "next" }],
  ])("%s from Graph fails closed as an unreadable response (never invalid_cursor, never a page)", async (_label, body) => {
    const { list } = portWith(graphOf({ pages: { "": body } }));
    expect((await failure(list())).toJSON().details).toEqual({ reasonCode: "unknown" });
  });

  it("a returned cursor equal to the one sent (a repeat) fails closed", async () => {
    const { list } = portWith(graphOf({ pages: { QVFIUmFmdGVy: cursorPage("QVFIUmFmdGVy") } }));
    expect((await failure(list(envelope("QVFIUmFmdGVy")))).toJSON()).toEqual({ kind: "permanent_rejected", operation: "listContent", retry: "never", details: { reasonCode: "invalid_cursor" } });
  });

  const b64 = (bytes: number[] | string): string => (typeof bytes === "string" ? Buffer.from(bytes, "latin1") : Buffer.from(bytes)).toString("base64url");
  it.each([
    ["a raw Graph cursor (no envelope)", "QVFIUmFmdGVy"],
    ["an empty envelope", "meta1."],
    ["the simulator's prefix", `sim1.${b64("QVFIUmFmdGVy")}`],
    ["another version", `meta2.${b64("QVFIUmFmdGVy")}`],
    ["an uppercase prefix", `META1.${b64("QVFIUmFmdGVy")}`],
    ["a padded payload", "meta1.QUJD=="],
    ["a payload with `+`", "meta1.QU+JD"],
    ["a payload with `/`", "meta1.QU/JD"],
    ["a payload with a space", "meta1.QU JD"],
    ["a payload with `.`", "meta1.QU.JD"],
    ["a payload with `:`", "meta1.QU:JD"],
    ["a non-canonical payload (non-zero trailing bits)", "meta1.QUJ"],
    ["a non-canonical payload (impossible length)", "meta1.QUJDR"],
    ["a payload decoding to a control character", `meta1.${b64([0x0a, 0x41])}`],
    ["a payload decoding to a space", `meta1.${b64("A B")}`],
    ["a payload decoding to a non-ASCII byte", `meta1.${b64([0x41, 0xc3, 0xa9])}`],
    ["a payload decoding to an over-long raw cursor", `meta1.${b64("Q".repeat(META_GRAPH_CURSOR_MAX_LENGTH + 1))}`],
    ["a cursor over the PageCursor capacity", `meta1.${"Q".repeat(PAGE_CURSOR_MAX_LENGTH)}`],
  ])("an incoming PageCursor that is %s is refused (invalid_cursor) before any request, without echoing it", async (_label, cursor) => {
    const { list, calls } = portWith(graphOf({ pages: ONE_PAGE }));
    const error = await failure(list(cursor as PageCursor));
    expect(error.toJSON()).toEqual({ kind: "permanent_rejected", operation: "listContent", retry: "never", details: { reasonCode: "invalid_cursor" } });
    expect(calls).toHaveLength(0);
    if (cursor.length > 6) expectNoneOf(error, [cursor, cursor.slice(6)]);
  });

  it("neither the raw nor the enveloped cursor appears in any error or rendering", async () => {
    const RAW = "QVFIcmF3Q3Vyc29yTWFya2Vy";
    // A repeat (the error path that has both in hand) and a page that fails after the cursor was parsed.
    const repeat = await failure(portWith(graphOf({ pages: { [RAW]: cursorPage(RAW) } })).list(envelope(RAW)));
    const later = await failure(portWith(graphOf({ pages: { "": { data: [post(POST_A, { status_type: "created_event" })], paging: { cursors: { after: RAW }, next: HOSTILE_NEXT } } } })).list());
    for (const error of [repeat, later]) expectNoneOf(error, [RAW, envelope(RAW), envelope(RAW).slice(6), "meta1.", "attacker"]);
  });
});

describe("listContent / getContent · refusal before any request", () => {
  // Instagram accounts take their own branch (Step 7G-H5.5-P11-B; tests/providers/meta/instagram-read-content.test.ts).
  it.each([
    ["a TikTok account", providerObjectRef("tiktok", "asset", "7001")],
    ["a non-asset ref", providerObjectRef("facebook", "content", PAGE)],
  ])("%s is refused (invalid_request) — the Facebook Page path accepts only a Facebook Page", async (_label, account) => {
    const { port, calls } = portWith(graphOf({ pages: ONE_PAGE }));
    const access = { credential: CREDENTIAL, account } as unknown as typeof ACCESS;
    for (const [operation, run] of [["listContent", () => port.listContent(access, WINDOW, null)], ["getContent", () => port.getContent(access, providerObjectRef("facebook", "content", POST_A))]] as const) {
      expect((await failure(run())).toJSON()).toEqual({ kind: "permanent_rejected", operation, retry: "never", details: { reasonCode: "invalid_request" } });
    }
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["an Instagram content ref", providerObjectRef("instagram", "content", POST_A)],
    ["an interaction ref", providerObjectRef("facebook", "interaction", POST_A)],
    ["a forged id", { platform: "facebook", kind: "content", id: "../me/accounts" }],
  ])("getContent refuses %s before any request", async (_label, ref) => {
    const { port, calls } = portWith(graphOf({ posts: { [POST_A]: post(POST_A) } }));
    expect((await failure(port.getContent(ACCESS, ref as never))).toJSON().details).toEqual({ reasonCode: "invalid_request" });
    expect(calls).toHaveLength(0);
  });
});

describe("getContent · GET {post-id}", () => {
  it("derives the Page token, then reads the post with the same whitelist; maps through the same strict mapper", async () => {
    const { get, paths, tokens } = portWith(graphOf({ posts: { [POST_A]: post(POST_A, { status_type: "added_photos" }) } }));
    const result = await get();
    expect(paths()).toEqual([`/v25.0/${PAGE}?access_token`, `/v25.0/${POST_A}?${META_POST_FIELDS}`]);
    expect(tokens()).toEqual([USER_TOKEN, PAGE_TOKEN]);
    const dto = expectResult(result);
    expectContent(dto, "meta");
    expect(dto).toMatchObject({ ref: providerObjectRef("facebook", "content", POST_A), account: providerObjectRef("facebook", "asset", PAGE), contentKind: "post", reportedSource: "unknown" });
    expectNoneOf(result, [NAME_MARKER, PAGE_TOKEN]);
  });

  it("a post published by another identity is refused (account correlation: from.id must be the managed Page)", async () => {
    const { get } = portWith(graphOf({ posts: { [POST_A]: post(POST_A, { from: { id: OTHER_PAGE } }) } }));
    expect((await failure(get())).toJSON()).toEqual({ kind: "permanent_rejected", operation: "getContent", retry: "never", details: { reasonCode: "unknown" } });
  });

  it.each([["an echoed id of another post", post(POST_B)], ["an unknown status_type", post(POST_A, { status_type: "created_event" })], ["no created_time", post(POST_A, { created_time: undefined })], ["a non-object body", [post(POST_A)]]])(
    "%s is unreadable",
    async (_label, body) => {
      const { get } = portWith(graphOf({ posts: { [POST_A]: body } }));
      expect((await failure(get())).toJSON().details).toEqual({ reasonCode: "unknown" });
    },
  );

  it("code 100 / subcode 33 on the post read → TargetNotFound — never not-eligible, never an unsupported observation", async () => {
    const { get } = portWith(graphOf({ posts: {} }));
    const error = await failure(get());
    expect(error.toJSON()).toEqual({ kind: "target_not_found", operation: "getContent", retry: "never", details: {} });
    expect(error.kind).not.toBe("target_not_eligible");
  });

  it("100/33 is getContent-only: on listContent (or a plain 100 on getContent) it stays a permanent rejection", async () => {
    const listing = portWith((url) => (url.pathname.endsWith("/published_posts") ? json(400, graphError({ code: 100, error_subcode: 33 })) : TOKEN_REPLY()));
    expect((await failure(listing.list())).toJSON()).toEqual({ kind: "permanent_rejected", operation: "listContent", retry: "never", details: { reasonCode: "unknown" } });
    const plain = portWith((url) => (url.searchParams.get("fields") === META_POST_FIELDS ? json(400, graphError({ code: 100 })) : TOKEN_REPLY()));
    expect((await failure(plain.get())).toJSON()).toEqual({ kind: "permanent_rejected", operation: "getContent", retry: "never", details: { reasonCode: "unknown" } });
    // The same subcode on the token derivation is not the post: it never becomes TargetNotFound.
    const derivation = portWith(() => json(400, graphError({ code: 100, error_subcode: 33 })));
    expect((await failure(derivation.get())).kind).toBe("permanent_rejected");
  });
});

describe("error mapping (P4-C semantics preserved) — at the derivation and at the content read", () => {
  const cases: readonly (readonly [string, unknown, number, ProviderErrorKind, Record<string, unknown>])[] = [
    ["code 10 (permission)", graphError({ code: 10 }), 403, "permission_missing", { capability: "read_content" }],
    ["code 200 (permission)", graphError({ code: 200 }), 403, "permission_missing", { capability: "read_content" }],
    ["code 299 (permission)", graphError({ code: 299 }), 403, "permission_missing", { capability: "read_content" }],
    ["subcode 492 inside OAuthException (no Page role)", graphError({ code: 190, type: "OAuthException", error_subcode: 492 }), 400, "permission_missing", { capability: "read_content" }],
    ["code 190 / 463 (expired)", graphError({ code: 190, type: "OAuthException", error_subcode: 463 }), 400, "credential_invalid", { reason: "expired" }],
    ["code 190 / 460 (revoked)", graphError({ code: 190, type: "OAuthException", error_subcode: 460 }), 400, "credential_invalid", { reason: "revoked" }],
    ["code 102", graphError({ code: 102 }), 400, "credential_invalid", { reason: "unknown" }],
    ["code 4 (rate)", graphError({ code: 4 }), 400, "rate_limited", { retryAfterSeconds: null }],
    ["code 32 (page rate)", graphError({ code: 32 }), 400, "rate_limited", { retryAfterSeconds: null }],
    ["code 80001 (page rate)", graphError({ code: 80001 }), 400, "rate_limited", { retryAfterSeconds: null }],
    ["code 2 (temporary)", graphError({ code: 2 }), 500, "transient", { reason: "provider_unavailable" }],
  ];

  it.each(cases)("%s → %s on both operations and both requests, never unsupported or not-eligible", async (_label, body, status, kind, details) => {
    for (const at of ["derivation", "content"] as const) {
      const reply: Reply = (url) => {
        const derivation = url.searchParams.get("fields") === "access_token";
        return (at === "derivation") === derivation ? json(status, body) : derivation ? TOKEN_REPLY() : json(200, url.pathname.endsWith("/published_posts") ? { data: [] } : post(POST_A));
      };
      for (const [operation, run] of [["listContent", portWith(reply).list], ["getContent", portWith(reply).get]] as const) {
        const error = await failure(run());
        expect(error.toJSON(), `${at} ${operation}`).toEqual({ kind, operation, retry: error.retry, details });
        expect(error.kind).not.toBe("target_not_eligible");
        expectNoneOf(error, [USER_TOKEN, PAGE_TOKEN, BODY_MARKER, "synthetic-trace", "access_token"]);
      }
    }
  });

  const transport: readonly (readonly [string, Reply, ProviderErrorKind, { readonly maxResponseBytes?: number; readonly timeoutMs?: number }])[] = [
    ["a network error", () => Promise.reject(new TypeError(`fetch failed ?access_token=${USER_TOKEN}`)), "transient", {}],
    ["a 5xx without a Graph error", () => Promise.resolve(new Response(`<html>${BODY_MARKER}</html>`, { status: 503 })), "transient", {}],
    ["a redirect", () => Promise.resolve(new Response(null, { status: 302, headers: { location: HOSTILE_NEXT } })), "permanent_rejected", {}],
    ["an oversized body", () => json(200, { data: [post(POST_A, { message: "x".repeat(200) })] }), "permanent_rejected", { maxResponseBytes: 64 }],
    ["a timeout", (_url, call) => new Promise((_resolve, reject) => { call.init.signal?.addEventListener("abort", () => { reject(new Error(BODY_MARKER)); }); }), "transient", { timeoutMs: 20 }],
  ];

  it.each(transport)("%s on the content read → %s after exactly one content request (no internal retry), leaking nothing", async (_label, failing, kind, options) => {
    const reply: Reply = (url, call) => (url.searchParams.get("fields") === "access_token" ? TOKEN_REPLY() : failing(url, call));
    const { list, calls } = portWith(reply, options);
    const error = await failure(list());
    expect(error.kind).toBe(kind);
    expect(calls).toHaveLength(2);
    expectNoneOf(error, [USER_TOKEN, PAGE_TOKEN, BODY_MARKER, "graph.facebook.com", "access_token", "attacker"]);
  });
});
