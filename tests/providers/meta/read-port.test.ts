/**
 * The Meta read port — discoverAssets (Step 7G-E) — and its Graph transport, offline (describeAccount, Step 7G-H5.5, is
 * covered in describe-account.test.ts). Behavior follows the frozen
 * contract in design/phase-7g/meta-provider/README.md (E1): three documented reads, cursor pagination rebuilt against
 * the fixed endpoint, a 20-page bound, whitelist parsing, the contained query-token transport, SocialAssetDto mapping,
 * deduplication, deterministic order, and complete-or-nothing results. `fetch` is an in-process double: no request
 * leaves the process. Synthetic ids, names and tokens only; Graph error codes are the documented ones.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ProviderError, READ_OPERATIONS, SecretValue, providerCredential, providerObjectKey, type ProviderErrorKind, type ProviderObjectId, type SocialAssetDto } from "@/integrations/providers/contract";
import { metaGraphError, metaGraphReadError } from "@/integrations/providers/meta/errors";
import { META_GRAPH_RESPONSE_MAX_BYTES, META_GRAPH_TIMEOUT_MS, createMetaGraphTransport, type MetaGraphFetch } from "@/integrations/providers/meta/graph-transport";
import { DISCOVER_ASSETS_MAX_PAGES, createMetaReadPort } from "@/integrations/providers/meta/read-port";
import { expectRaw, expectRef, expectResult } from "../contract/assertions";

const TOKEN_MARKER = "synthetic-meta-user-token-marker";
const PAGE_TOKEN_MARKER = "synthetic-meta-page-token-marker";
const BODY_MARKER = "synthetic-meta-graph-body-marker";
const CREDENTIAL = providerCredential("5eed0000-d1a9-4000-8000-00000000e001", TOKEN_MARKER);
const HOSTILE_NEXT = "https://attacker.example.test/steal?access_token=x";

const renderings = (value: unknown): string => {
  const error = value instanceof Error ? `${value.message} ${value.stack ?? ""} ${String(value.cause)}` : "";
  return [JSON.stringify(value), String(value), inspect(value, { depth: 10, showHidden: true }), error].join(" ");
};
const expectNoneOf = (value: unknown, secrets: readonly string[]): void => {
  const rendered = renderings(value);
  for (const secret of secrets) expect(rendered).not.toContain(secret);
};

// ── Graph double ─────────────────────────────────────────────────────────────────────────────────────────────────
interface Call {
  readonly url: string;
  readonly init: RequestInit;
}
type Reply = (url: URL, call: Call) => Promise<Response>;
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }));
const graphError = (fields: Record<string, unknown>) => ({ error: { message: BODY_MARKER, error_user_msg: BODY_MARKER, fbtrace_id: "synthetic-trace", ...fields } });

interface World {
  /** Each /me/accounts page: its items and its `paging` object (undefined → no paging at all). */
  readonly lists: readonly { readonly data: readonly unknown[]; readonly paging?: unknown }[];
  /** Page id → the `instagram_business_account` value (absent key → field absent). */
  readonly pageIg: Readonly<Record<string, unknown>>;
  /** IG id → the detail body. */
  readonly ig: Readonly<Record<string, unknown>>;
}

/** The happy world: two list pages (a duplicate Page, a Page token that must be ignored), one IG shared by two Pages. */
const WORLD: World = {
  lists: [
    {
      data: [
        { id: "1002", name: "Synthetic Page Two", access_token: PAGE_TOKEN_MARKER, category: "Brand", tasks: ["MODERATE"] },
        { id: "1001", name: "Synthetic Page One", access_token: PAGE_TOKEN_MARKER },
      ],
      paging: { cursors: { before: "b1", after: "c1" }, next: HOSTILE_NEXT },
    },
    { data: [{ id: "1003", name: "Synthetic Page Three" }, { id: "1001", name: "Synthetic Page One" }], paging: { cursors: { before: "b2", after: "c2" } } },
  ],
  pageIg: { "1001": { id: "17840001" }, "1002": { id: "17840001" } },
  ig: { "17840001": { id: "17840001", username: "synthetic_brand" } },
};

function graphOf(world: World): Reply {
  return (url) => {
    const fields = url.searchParams.get("fields");
    if (url.pathname === "/v25.0/me/accounts") {
      const after = url.searchParams.get("after");
      const index = after === null ? 0 : Number(after.replace(/^c/, ""));
      const page = world.lists[index];
      return page === undefined ? json(400, graphError({ code: 100 })) : json(200, { data: page.data, ...(page.paging === undefined ? {} : { paging: page.paging }) });
    }
    const id = decodeURIComponent(url.pathname.split("/")[2] ?? "");
    if (fields === "instagram_business_account") return json(200, { id, ...(id in world.pageIg ? { instagram_business_account: world.pageIg[id] } : {}) });
    if (fields === "id,username") return json(200, world.ig[id] ?? { id });
    return json(400, graphError({ code: 100 }));
  };
}

function portWith(reply: Reply, options: { readonly timeoutMs?: number; readonly maxResponseBytes?: number } = {}) {
  const calls: Call[] = [];
  const fetch: MetaGraphFetch = (url, init) => {
    const call = { url, init };
    calls.push(call);
    return reply(new URL(url), call);
  };
  const port = createMetaReadPort({ transport: createMetaGraphTransport({ fetch, ...options }) });
  return { port, calls, discover: () => port.discoverAssets(CREDENTIAL) };
}

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  let settled: unknown;
  try {
    settled = await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
  // No partial result: a discovery that should fail never resolves with assets.
  throw new Error(`expected discoverAssets to fail, it resolved with ${String(Array.isArray((settled as { data?: unknown } | undefined)?.data))}`);
}

const keys = (assets: readonly SocialAssetDto[]) => assets.map((asset) => providerObjectKey(asset.ref));
const callPaths = (calls: readonly Call[]) => calls.map((call) => { const url = new URL(call.url); return `${url.pathname}?${url.searchParams.get("fields") ?? ""}${url.searchParams.has("after") ? `&after=${url.searchParams.get("after") ?? ""}` : ""}`; });

describe("Meta read port · shape (shared contract assertions that apply)", () => {
  it("is the meta provider and implements every read operation as a function", () => {
    const port = createMetaReadPort({ transport: createMetaGraphTransport({ fetch: () => Promise.reject(new Error("unused")) }) });
    expect(port.provider).toBe("meta");
    for (const operation of READ_OPERATIONS) expect(typeof port[operation], operation).toBe("function");
    expect(DISCOVER_ASSETS_MAX_PAGES).toBe(20);
  });

  // listContent / getContent (Step 7G-H5.5-P5-B) are covered in read-content.test.ts.
  it.each(READ_OPERATIONS.filter((operation) => !["discoverAssets", "describeAccount", "listContent", "getContent", "parseWebhook"].includes(operation)))("%s is refused (permanent), never synthetic data", async (operation) => {
    const { port, calls } = portWith(graphOf(WORLD));
    const method = port[operation].bind(port) as (...args: unknown[]) => Promise<unknown>;
    const error = await failure(method({}, {}, {}, null));
    expect(error.toJSON()).toEqual({ kind: "permanent_rejected", operation, retry: "never", details: { reasonCode: "invalid_request" } });
    expect(calls).toHaveLength(0);
  });

  it("parseWebhook fails closed", async () => {
    const { port } = portWith(graphOf(WORLD));
    await expect(port.parseWebhook({} as never)).rejects.toMatchObject({ name: "WebhookRejectedError" });
  });

  it("discovered assets carry valid, stable provider identities and raw references (shared contract §2)", async () => {
    const { port } = portWith(graphOf(WORLD));
    const first = expectResult(await port.discoverAssets(CREDENTIAL));
    const second = expectResult(await port.discoverAssets(CREDENTIAL));
    expect(first.length).toBeGreaterThan(0);
    for (const asset of first) {
      expectRef(asset.ref, "asset");
      expect(["content_bearing", "ad_account"]).toContain(asset.assetClass);
      for (const related of asset.relatedAssets) expectRef(related, "asset");
      expectRaw(asset.rawReference, "meta");
    }
    expect(keys(second)).toEqual(keys(first));
  });
});

describe("Meta read port · discovery (happy path, mapping, relationships, order)", () => {
  it("three documented stages, in deterministic order, and nothing else", async () => {
    const { calls, discover } = portWith(graphOf(WORLD));
    await discover();
    expect(callPaths(calls)).toEqual([
      "/v25.0/me/accounts?id,name",
      "/v25.0/me/accounts?id,name&after=c1",
      "/v25.0/1001?instagram_business_account",
      "/v25.0/1002?instagram_business_account",
      "/v25.0/1003?instagram_business_account",
      "/v25.0/17840001?id,username",
    ]);
    for (const call of calls) expect(new URL(call.url).origin).toBe("https://graph.facebook.com");
  });

  it("maps Pages and the linked Instagram account exactly, deduplicated, related both ways, ordered by platform then id", async () => {
    const result = expectResult(await portWith(graphOf(WORLD)).discover());
    expect(result).toEqual([
      { ref: { platform: "facebook", kind: "asset", id: "1001" }, assetClass: "content_bearing", displayName: "Synthetic Page One", relatedAssets: [{ platform: "instagram", kind: "asset", id: "17840001" }], rawReference: { provider: "meta", apiVersion: "v25.0", ref: "facebook:page:1001" } },
      { ref: { platform: "facebook", kind: "asset", id: "1002" }, assetClass: "content_bearing", displayName: "Synthetic Page Two", relatedAssets: [{ platform: "instagram", kind: "asset", id: "17840001" }], rawReference: { provider: "meta", apiVersion: "v25.0", ref: "facebook:page:1002" } },
      { ref: { platform: "facebook", kind: "asset", id: "1003" }, assetClass: "content_bearing", displayName: "Synthetic Page Three", relatedAssets: [], rawReference: { provider: "meta", apiVersion: "v25.0", ref: "facebook:page:1003" } },
      {
        ref: { platform: "instagram", kind: "asset", id: "17840001" },
        assetClass: "content_bearing",
        displayName: "synthetic_brand",
        relatedAssets: [{ platform: "facebook", kind: "asset", id: "1001" }, { platform: "facebook", kind: "asset", id: "1002" }],
        rawReference: { provider: "meta", apiVersion: "v25.0", ref: "instagram:account:17840001" },
      },
    ]);
  });

  it("an empty Page list is a successful, empty discovery", async () => {
    const { calls, discover } = portWith(graphOf({ lists: [{ data: [] }], pageIg: {}, ig: {} }));
    expect(expectResult(await discover())).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("the unexpected Page access_token (and every other extra field) is structurally ignored: never in output, references or errors", async () => {
    const result = await portWith(graphOf(WORLD)).discover();
    expectNoneOf(result, [PAGE_TOKEN_MARKER, TOKEN_MARKER, "MODERATE", "Brand"]);
    for (const asset of result.data) expect(Object.keys(asset).sort()).toEqual(["assetClass", "displayName", "rawReference", "ref", "relatedAssets"]);
    const failing = graphOf({ ...WORLD, ig: { "17840001": { id: "17840002" } } });
    expectNoneOf(await failure(portWith(failing).discover()), [PAGE_TOKEN_MARKER, TOKEN_MARKER]);
  });

  it("missing name/username → empty display name (the application's id fallback applies; nothing is invented)", async () => {
    const result = expectResult(await portWith(graphOf({ lists: [{ data: [{ id: "1001" }] }], pageIg: { "1001": { id: "17840001" } }, ig: { "17840001": { id: "17840001" } } })).discover());
    expect(result.map((asset) => asset.displayName)).toEqual(["", ""]);
  });

  it("the same response set always yields the same ordered result, whatever the provider's order", async () => {
    const shuffled: World = { ...WORLD, lists: [{ data: [{ id: "1003", name: "Synthetic Page Three" }, { id: "1001", name: "Synthetic Page One" }, { id: "1002", name: "Synthetic Page Two" }] }] };
    expect(keys(expectResult(await portWith(graphOf(shuffled)).discover()))).toEqual(keys(expectResult(await portWith(graphOf(WORLD)).discover())));
  });
});

describe("Meta read port · pagination and the hard bound", () => {
  const list = (n: number, last: { readonly next: boolean }) =>
    Array.from({ length: n }, (_, index) => ({
      data: [{ id: String(2000 + index), name: `Synthetic Page ${String(index)}` }],
      ...(index < n - 1 || last.next ? { paging: { cursors: { after: `c${String(index + 1)}` }, next: HOSTILE_NEXT } } : { paging: { cursors: { after: `c${String(index + 1)}` } } }),
    }));

  it("continues only through a validated after cursor rebuilt on the fixed endpoint; the returned next URL is never fetched", async () => {
    const { calls, discover } = portWith(graphOf(WORLD));
    await discover();
    expect(calls.some((call) => call.url.includes("attacker.example.test") || call.url.includes("steal"))).toBe(false);
    const second = new URL(calls[1]?.url ?? "");
    expect(`${second.origin}${second.pathname}`).toBe("https://graph.facebook.com/v25.0/me/accounts");
    expect([...second.searchParams.keys()]).toEqual(["fields", "after", "access_token"]);
    expect(second.searchParams.get("after")).toBe("c1");
    expect(second.searchParams.has("limit")).toBe(false);
  });

  it("a cursor is an opaque query value, never a URL or a path", async () => {
    const hostile = "https://attacker.example.test/x?y=1#z";
    const { calls, discover } = portWith(graphOf({ ...WORLD, lists: [{ data: [], paging: { cursors: { after: hostile }, next: HOSTILE_NEXT } }] }));
    await failure(discover());
    const second = calls[1];
    if (second !== undefined) {
      const url = new URL(second.url);
      expect(url.origin).toBe("https://graph.facebook.com");
      expect(url.pathname).toBe("/v25.0/me/accounts");
      expect(url.searchParams.get("after")).toBe(hostile);
    }
  });

  it("no next stops, whatever the page size; a short page WITH next continues", async () => {
    const short = portWith(graphOf({ lists: [{ data: [{ id: "1001" }], paging: { cursors: { after: "c1" } } }], pageIg: {}, ig: {} }));
    expect(keys((await short.discover()).data)).toEqual(["facebook:asset:1001"]);
    expect(short.calls.filter((call) => call.url.includes("/me/accounts"))).toHaveLength(1);
    // WORLD's first page holds two items and reports next: it continues.
    const run = portWith(graphOf(WORLD));
    await run.discover();
    expect(run.calls.filter((call) => call.url.includes("/me/accounts"))).toHaveLength(2);
  });

  it.each([
    ["next without cursors", { next: HOSTILE_NEXT }],
    ["next with an empty after", { cursors: { after: "" }, next: HOSTILE_NEXT }],
    ["next with a non-string after", { cursors: { after: 7 }, next: HOSTILE_NEXT }],
    ["next with a whitespace after", { cursors: { after: "c 1" }, next: HOSTILE_NEXT }],
    ["a non-string next", { cursors: { after: "c1" }, next: true }],
    ["a non-object paging", "paging"],
  ])("%s → fails closed after one request, no partial result", async (_label, paging) => {
    const { calls, discover } = portWith(graphOf({ lists: [{ data: [{ id: "1001" }], paging }], pageIg: {}, ig: {} }));
    const error = await failure(discover());
    expect(error.kind).toBe("permanent_rejected");
    expect(calls).toHaveLength(1);
  });

  it("a repeated cursor fails closed (invalid_cursor)", async () => {
    const looping: World = { lists: [{ data: [{ id: "1001" }], paging: { cursors: { after: "c1" }, next: HOSTILE_NEXT } }, { data: [{ id: "1002" }], paging: { cursors: { after: "c1" }, next: HOSTILE_NEXT } }], pageIg: {}, ig: {} };
    const { calls, discover } = portWith(graphOf(looping));
    expect((await failure(discover())).toJSON().details).toEqual({ reasonCode: "invalid_cursor" });
    expect(calls).toHaveLength(2);
  });

  it("twenty pages may complete; a twentieth page that still has next fails closed and page 21 is never requested", async () => {
    const complete = portWith(graphOf({ lists: list(20, { next: false }), pageIg: {}, ig: {} }));
    expect(expectResult(await complete.discover())).toHaveLength(20);
    const bounded = portWith(graphOf({ lists: list(21, { next: true }), pageIg: {}, ig: {} }));
    expect((await failure(bounded.discover())).toJSON().details).toEqual({ reasonCode: "limit_exceeded" });
    expect(bounded.calls.filter((call) => call.url.includes("/me/accounts"))).toHaveLength(20);
    expect(bounded.calls.some((call) => new URL(call.url).searchParams.get("after") === "c20")).toBe(false);
    expect(bounded.calls).toHaveLength(20);
  });
});

describe("Meta read port · Page → Instagram and Instagram detail", () => {
  it("a forged or hostile id stays one encoded path segment on the fixed origin", async () => {
    const calls: Call[] = [];
    const transport = createMetaGraphTransport({ fetch: (url, init) => { calls.push({ url, init }); return json(200, { id: "x" }); } });
    for (const forged of ["../../me", "https://attacker.example.test", "1001/feed?x=1#y"]) await transport.getPageInstagram(new SecretValue(TOKEN_MARKER), forged as ProviderObjectId);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      const url = new URL(call.url);
      expect(url.origin).toBe("https://graph.facebook.com");
      expect(url.pathname.split("/")).toHaveLength(3);
      expect(url.pathname.startsWith("/v25.0/")).toBe(true);
      expect(url.hash).toBe("");
      expect([...url.searchParams.keys()]).toEqual(["fields", "access_token"]);
    }
  });

  it.each([
    ["a Page id that breaks the provider-id rule", graphOf({ lists: [{ data: [{ id: "10/01", name: "x" }] }], pageIg: {}, ig: {} }), 1],
    ["a Page without an id", graphOf({ lists: [{ data: [{ name: "x" }] }], pageIg: {}, ig: {} }), 1],
    ["a non-string Page name", graphOf({ lists: [{ data: [{ id: "1001", name: 7 }] }], pageIg: {}, ig: {} }), 1],
    ["data that is not an array", () => json(200, { data: {} }), 1],
    ["a malformed linked IG object", graphOf({ ...WORLD, pageIg: { "1001": "17840001" } }), 3],
    ["a null linked IG", graphOf({ ...WORLD, pageIg: { "1001": null } }), 3],
    ["a linked IG id that breaks the provider-id rule (no detail request follows)", graphOf({ ...WORLD, pageIg: { "1001": { id: "1784/0001" } } }), 3],
    ["a Page lookup echoing another id", (url: URL, call: Call) => (url.pathname.endsWith("/1001") ? json(200, { id: "9999" }) : graphOf(WORLD)(url, call)), 3],
    ["an IG detail echoing another id", graphOf({ ...WORLD, ig: { "17840001": { id: "17840002", username: "x" } } }), 6],
    ["an IG detail without an id", graphOf({ ...WORLD, ig: { "17840001": { username: "x" } } }), 6],
    ["a non-string username", graphOf({ ...WORLD, ig: { "17840001": { id: "17840001", username: 5 } } }), 6],
  ])("%s → fails closed (whole discovery), no partial result", async (_label, reply, expectedCalls) => {
    const { calls, discover } = portWith(reply);
    const error = await failure(discover());
    expect(error.toJSON()).toEqual({ kind: "permanent_rejected", operation: "discoverAssets", retry: "never", details: { reasonCode: "unknown" } });
    expect(calls).toHaveLength(expectedCalls);
    expect(calls.some((call) => call.url.includes("1784%2F0001") || call.url.includes("10%2F01"))).toBe(false);
  });

  it("duplicate IG ids are looked up once; a Page with no IG is a valid Page asset", async () => {
    const { calls, discover } = portWith(graphOf(WORLD));
    const result = expectResult(await discover());
    expect(calls.filter((call) => call.url.includes("fields=id%2Cusername"))).toHaveLength(1);
    expect(result.find((asset) => asset.ref.id === "1003")?.relatedAssets).toEqual([]);
  });
});

describe("Meta read port · Graph transport security (the contained query-token exception)", () => {
  it("fixed origin and version, exact fields, the token only as the access_token query parameter, no header token, no app secrets", async () => {
    const { calls, discover } = portWith(graphOf(WORLD));
    await discover();
    for (const call of calls) {
      const url = new URL(call.url);
      expect(url.origin).toBe("https://graph.facebook.com");
      expect(url.pathname.startsWith("/v25.0/")).toBe(true);
      expect(url.searchParams.getAll("access_token")).toEqual([TOKEN_MARKER]);
      for (const name of ["client_secret", "appsecret_proof", "client_token", "client_id", "config_id", "limit"]) expect(url.searchParams.has(name), name).toBe(false);
      expect(call.init.method).toBe("GET");
      expect(call.init.redirect).toBe("manual");
      expect(call.init.credentials).toBe("omit");
      expect(call.init.body).toBeUndefined();
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      expect(Object.keys(call.init.headers ?? {})).toEqual(["accept"]);
      expect(JSON.stringify(call.init.headers)).not.toContain(TOKEN_MARKER);
    }
    expect(META_GRAPH_TIMEOUT_MS).toBe(10_000);
    expect(META_GRAPH_RESPONSE_MAX_BYTES).toBe(65_536);
  });

  it("the transport exposes exactly eight typed operations (P5-B adds three): no URL, path or next-link input", () => {
    const transport = createMetaGraphTransport({ fetch: () => Promise.reject(new Error("unused")) });
    expect(Object.keys(transport).sort()).toEqual(["getInstagramAccount", "getPage", "getPageAccessToken", "getPageInstagram", "getPost", "listPages", "listPermissions", "listPublishedPosts"]);
  });

  const outcomes: readonly (readonly [string, Reply, ProviderErrorKind, Record<string, unknown>, { readonly timeoutMs?: number; readonly maxResponseBytes?: number }])[] = [
    ["a network error", () => Promise.reject(new TypeError(`fetch failed https://graph.facebook.com/v25.0/me/accounts?access_token=${TOKEN_MARKER}`)), "transient", { reason: "network" }, {}],
    ["a timeout", (_url, call) => new Promise((_resolve, reject) => { call.init.signal?.addEventListener("abort", () => { reject(new Error(`${BODY_MARKER} ${call.url}`)); }); }), "transient", { reason: "network" }, { timeoutMs: 20 }],
    ["a 5xx without a Graph error", () => Promise.resolve(new Response(`<html>${BODY_MARKER}</html>`, { status: 503 })), "transient", { reason: "server_error" }, {}],
    ["a redirect", () => Promise.resolve(new Response(null, { status: 302, headers: { location: HOSTILE_NEXT } })), "permanent_rejected", { reasonCode: "unknown" }, {}],
    ["an oversized body (declared)", () => json(200, { data: [] }, { "content-length": "999999" }), "permanent_rejected", { reasonCode: "unknown" }, { maxResponseBytes: 64 }],
    ["an oversized body (streamed)", () => Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ data: [{ id: "1001", name: "x".repeat(200) }] }))); controller.close(); } }), { status: 200 })), "permanent_rejected", { reasonCode: "unknown" }, { maxResponseBytes: 64 }],
    ["malformed JSON", () => Promise.resolve(new Response(`{"data": [${BODY_MARKER}`, { status: 200 })), "permanent_rejected", { reasonCode: "unknown" }, {}],
    ["invalid UTF-8", () => Promise.resolve(new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200 })), "permanent_rejected", { reasonCode: "unknown" }, {}],
    ["a 4xx that is not a Graph error", () => json(400, { message: BODY_MARKER }), "permanent_rejected", { reasonCode: "unknown" }, {}],
  ];

  it.each(outcomes)("%s → %s after exactly one request (no internal retry), leaking nothing", async (_label, reply, kind, details, options) => {
    const { calls, discover } = portWith(reply, options);
    const error = await failure(discover());
    expect(error.kind).toBe(kind);
    expect(error.operation).toBe("discoverAssets");
    expect(error.toJSON().details).toEqual(details);
    expect(calls).toHaveLength(1);
    expectNoneOf(error, [TOKEN_MARKER, BODY_MARKER, calls[0]?.url ?? "-", "graph.facebook.com", "access_token", "attacker"]);
  });

  it("response.url is never read or propagated", async () => {
    const reply: Reply = () => {
      const response = new Response(JSON.stringify({ data: [{ id: "1001" }] }), { status: 200 });
      Object.defineProperty(response, "url", { get: () => { throw new Error("response.url must never be read"); } });
      return Promise.resolve(response);
    };
    const run = portWith((url, call) => (url.pathname === "/v25.0/me/accounts" ? reply(url, call) : graphOf(WORLD)(url, call)));
    expect(keys(expectResult(await run.discover()))).toEqual(["facebook:asset:1001", "instagram:asset:17840001"]);
  });
});

describe("Meta read port · Graph error normalization (documented codes; whole discovery fails)", () => {
  const cases: readonly (readonly [string, Record<string, unknown>, ProviderErrorKind, Record<string, unknown>])[] = [
    ["492 inside an OAuthException (no role on the Page)", { type: "OAuthException", code: 190, error_subcode: 492 }, "permission_missing", { capability: "discover_assets" }],
    ["10 permission", { type: "OAuthException", code: 10 }, "permission_missing", { capability: "discover_assets" }],
    ["200 permission", { code: 200 }, "permission_missing", { capability: "discover_assets" }],
    ["4 rate limit", { code: 4 }, "rate_limited", { retryAfterSeconds: null }],
    ["80001 Pages business use case", { code: 80001 }, "rate_limited", { retryAfterSeconds: null }],
    ["2 temporary", { code: 2 }, "transient", { reason: "provider_unavailable" }],
    ["190 / 463 expired", { type: "OAuthException", code: 190, error_subcode: 463 }, "credential_invalid", { reason: "expired" }],
    ["190 / 460 revoked", { type: "OAuthException", code: 190, error_subcode: 460 }, "credential_invalid", { reason: "revoked" }],
    ["an unmapped Graph error (default branch)", { type: "GraphMethodException", code: 987654 }, "permanent_rejected", { reasonCode: "unknown" }],
  ];

  for (const stage of ["list", "page", "instagram"] as const) {
    it.each(cases)(`${stage} stage · %s → %s, no provider text`, async (_label, fields, kind, details) => {
      const reply: Reply = (url, call) => {
        const isList = url.pathname === "/v25.0/me/accounts";
        const fail = (stage === "list" && isList) || (stage === "page" && url.searchParams.get("fields") === "instagram_business_account") || (stage === "instagram" && url.searchParams.get("fields") === "id,username");
        return fail ? json(400, graphError(fields)) : graphOf(WORLD)(url, call);
      };
      const error = await failure(portWith(reply).discover());
      expect(error.kind).toBe(kind);
      expect(error.toJSON().details).toEqual(details);
      expectNoneOf(error, [BODY_MARKER, "synthetic-trace", TOKEN_MARKER]);
    });
  }

  it("492 is a read-only extension: the authorization exchange's mapping is unchanged", () => {
    const fields = { code: 190, subcode: 492, oauthException: true };
    expect(metaGraphReadError("discoverAssets", fields, "discover_assets").kind).toBe("permission_missing");
    expect(metaGraphError("exchangeCode", fields, "discover_assets").toJSON()).toEqual({ kind: "credential_invalid", operation: "exchangeCode", retry: "after_recovery", details: { reason: "unknown" } });
  });
});

describe("Meta read port · complete or nothing (PARTIAL_DISCOVERY_RESULT = NOT_SUPPORTED)", () => {
  it.each([
    ["a pagination failure after a successful first page", graphOf({ ...WORLD, lists: [WORLD.lists[0] as World["lists"][number]] })],
    ["a Page lookup failure after other Pages succeeded", (url: URL, call: Call) => (url.pathname.endsWith("/1003") ? json(500, graphError({ code: 2 })) : graphOf(WORLD)(url, call))],
    ["an IG detail failure after every Page succeeded", (url: URL, call: Call) => (url.searchParams.get("fields") === "id,username" ? json(500, graphError({ code: 1 })) : graphOf(WORLD)(url, call))],
    ["malformed data in the last list page", graphOf({ ...WORLD, lists: [WORLD.lists[0] as World["lists"][number], { data: [{ id: "1003" }, { id: "bad id" }] }] })],
    ["the hard bound", graphOf({ lists: Array.from({ length: 25 }, (_, index) => ({ data: [{ id: String(3000 + index) }], paging: { cursors: { after: `c${String(index + 1)}` }, next: HOSTILE_NEXT } })), pageIg: {}, ig: {} })],
  ])("%s → rejects; no SocialAssetDto[] is ever returned", async (_label, reply) => {
    const { discover } = portWith(reply);
    await failure(discover());
  });
});
