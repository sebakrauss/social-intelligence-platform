/**
 * The Meta read-only Instagram reply preflight/observe reader (Step 7B-14C1; integrations/providers/meta/instagram-reply-
 * preflight.ts), offline: the REAL Graph read transport over an in-process `fetch` double serving each allowlisted
 * path — every request recorded (method, path, body), no network. Synthetic ids, usernames, texts and tokens only; the
 * report is checked for every one of them.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { providerCredential, type ProviderObjectId } from "@/integrations/providers/contract";
import {
  META_INSTAGRAM_COMMENT_FIELDS,
  META_INSTAGRAM_MEDIA_FIELDS,
  META_INSTAGRAM_REPLY_FIELDS,
  createMetaGraphTransport,
  type MetaGraphFetch,
  type MetaGraphTransport,
} from "@/integrations/providers/meta/graph-transport";
import {
  INSTAGRAM_REPLY_CHECK_REASONS,
  INSTAGRAM_REPLY_LIMITATIONS,
  INSTAGRAM_REPLY_PREFLIGHT_OPERATIONS,
  META_INSTAGRAM_REPLY_OBSERVE_MAX_REQUESTS,
  META_INSTAGRAM_REPLY_PREFLIGHT_MAX_REQUESTS,
  createInstagramReplyPreflight,
  readFailureOf,
  type InstagramReplyPreflightFacts,
  type InstagramReplyPreflightMode,
  type InstagramReplyPreflightTransport,
} from "@/integrations/providers/meta/instagram-reply-preflight";
import { graphErrorFields, metaGraphReadError } from "@/integrations/providers/meta/errors";

const PAGE = "880000000000041";
const OTHER_PAGE = "880000000000042";
const IG = "17840000000000041";
const OTHER_IG = "17840000000000042";
const MEDIA = "17900000000000041";
const OTHER_MEDIA = "17900000000000042";
const COMMENT = "17950000000000041";
const REPLY_MANAGED = "17950000000000042";
const REPLY_OTHER = "17950000000000043";
const COMMENTER = "17960000000000041";
const MANAGED_HANDLE = "synthetic_managed_handle_marker";
const COMMENTER_HANDLE = "synthetic_commenter_handle_marker";
const PAGE_NAME = "Synthetic Page Name Marker";
const TEXT = "Synthetic comment text that must never be output";
const CAPTION = "Synthetic caption marker";
const USER_TOKEN = "synthetic-preflight-user-token-marker";
const PAGE_TOKEN = "synthetic-preflight-page-token-marker";
const CURSOR = "QVFIUnN5bnRoZXRpY0N1cnNvck1hcmtlcg";
const BODY_MARKER = "synthetic-graph-body-marker";
const FORBIDDEN_IN_OUTPUT = [PAGE, OTHER_PAGE, IG, OTHER_IG, MEDIA, OTHER_MEDIA, COMMENT, REPLY_MANAGED, REPLY_OTHER, COMMENTER, MANAGED_HANDLE, COMMENTER_HANDLE, PAGE_NAME, TEXT, CAPTION, USER_TOKEN, PAGE_TOKEN, CURSOR, BODY_MARKER, "graph.facebook.com", "access_token", "http"];

const TARGET = { instagramAccountId: IG as ProviderObjectId, commentId: COMMENT as ProviderObjectId, mediaId: MEDIA as ProviderObjectId };
const CREDENTIAL = providerCredential("synthetic-preflight-credential", USER_TOKEN);

type Answer = { readonly status?: number; readonly body: unknown } | "network" | "timeout";
type Route = "permissions" | "pages" | "pageInstagram" | "account" | "comment" | "media" | "mediaComments" | "replies";

const ok = (body: unknown): Answer => ({ body });
const graphError = (code: number, subcode?: number, type = "GraphMethodException"): Answer => ({ status: 400, body: { error: { code, ...(subcode === undefined ? {} : { error_subcode: subcode }), type, message: BODY_MARKER } } });
const granted = (...names: string[]) => ok({ data: names.map((permission) => ({ permission, status: "granted" })) });
const ALL_GRANTED = ["instagram_basic", "instagram_manage_comments", "pages_read_engagement", "pages_show_list", "business_management", "public_profile"];
const node = (patch: Record<string, unknown> = {}) => ({ id: COMMENT, from: { id: COMMENTER, username: COMMENTER_HANDLE }, text: TEXT, timestamp: "2026-10-27T23:19:52+0000", hidden: false, media: { id: MEDIA }, ...patch });
const media = (patch: Record<string, unknown> = {}) => ({ id: MEDIA, media_type: "IMAGE", media_product_type: "FEED", timestamp: "2026-10-27T20:00:00+0000", caption: CAPTION, owner: { id: IG }, ...patch });
const reply = (id: string, from: Record<string, unknown>, timestamp: string, parent: string | null = COMMENT) => ({ id, from, timestamp, ...(parent === null ? {} : { parent_id: parent }) });

const ELIGIBLE: Readonly<Record<Route, Answer>> = {
  permissions: granted(...ALL_GRANTED),
  pages: ok({ data: [{ id: PAGE, name: PAGE_NAME }] }),
  pageInstagram: ok({ id: PAGE, instagram_business_account: { id: IG } }),
  account: ok({ id: IG, username: MANAGED_HANDLE }),
  comment: ok(node()),
  media: ok(media()),
  mediaComments: ok({ data: [node()] }),
  replies: ok({ data: [] }),
};

interface Call {
  readonly method: string;
  readonly route: Route | "unknown";
  readonly path: string;
  readonly hasBody: boolean;
  readonly query: readonly string[];
}

/** The real read transport over a recording fetch double; `pageInstagram` may be keyed per Page id. */
function world(overrides: Partial<Record<Route, Answer>> = {}, perPage: Readonly<Record<string, Answer>> = {}) {
  const answers = { ...ELIGIBLE, ...overrides };
  const calls: Call[] = [];
  const fetch: MetaGraphFetch = (url, init) => {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").slice(2).map(decodeURIComponent);
    const fields = parsed.searchParams.get("fields");
    let route: Route | "unknown" = "unknown";
    if (segments.join("/") === "me/permissions") route = "permissions";
    else if (segments.join("/") === "me/accounts") route = "pages";
    else if (segments.length === 1 && fields === "instagram_business_account") route = "pageInstagram";
    else if (segments.length === 1 && fields === "id,username") route = "account";
    else if (segments.length === 1 && fields === META_INSTAGRAM_COMMENT_FIELDS) route = "comment";
    else if (segments.length === 1 && fields === META_INSTAGRAM_MEDIA_FIELDS) route = "media";
    else if (segments[1] === "comments" && fields === META_INSTAGRAM_COMMENT_FIELDS) route = "mediaComments";
    else if (segments[1] === "replies" && fields === META_INSTAGRAM_REPLY_FIELDS) route = "replies";
    calls.push({ method: init.method ?? "GET", route, path: segments.join("/"), hasBody: init.body !== undefined && init.body !== null, query: [...parsed.searchParams.keys()].sort() });
    const answer = route === "pageInstagram" && segments[0] !== undefined && perPage[segments[0]] !== undefined ? perPage[segments[0]] : route === "unknown" ? graphError(100) : answers[route];
    if (answer === "network") return Promise.reject(new TypeError("fetch failed"));
    if (answer === "timeout") return Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    return Promise.resolve(new Response(JSON.stringify(answer?.body), { status: answer?.status ?? 200, headers: { "content-type": "application/json" } }));
  };
  const preflight = createInstagramReplyPreflight({ transport: createMetaGraphTransport({ fetch }) });
  return { calls, inspect: (mode: InstagramReplyPreflightMode = "preflight") => preflight.inspect(CREDENTIAL, TARGET, mode) };
}

const rendered = (value: unknown): string => [JSON.stringify(value), inspect(value, { depth: 10, showHidden: true })].join(" ");
function expectRedacted(facts: InstagramReplyPreflightFacts): void {
  const text = rendered(facts);
  for (const forbidden of FORBIDDEN_IN_OUTPUT) expect(text, forbidden).not.toContain(forbidden);
  for (const check of Object.values(facts.checks)) if (check.reason !== null) expect(INSTAGRAM_REPLY_CHECK_REASONS).toContain(check.reason);
  expect(facts.tokenTypeForReplyPost).toBe("NOT_VERIFIED");
  expect(facts.limitations).toEqual(INSTAGRAM_REPLY_LIMITATIONS);
  expect(facts.requests).toBeLessThanOrEqual(facts.maxRequests);
}

const state = (facts: InstagramReplyPreflightFacts) => Object.fromEntries(Object.entries(facts.checks).map(([name, check]) => [name, check.reason === null ? check.state : `${check.state}:${check.reason}`]));

describe("A. preflight on an eligible comment: every check VERIFIED, 8 GETs, all of them GET without a body", () => {
  it("permissions, account, Page link, comment, media, top-level edge, replies baseline", async () => {
    const w = world();
    const facts = await w.inspect();
    expect(state(facts)).toEqual({
      permissions: "VERIFIED", account: "VERIFIED", pageLink: "VERIFIED", commentExists: "VERIFIED", commentOnStoredMedia: "VERIFIED", commentTopLevel: "VERIFIED",
      commentVisible: "VERIFIED", commentAuthorExternal: "VERIFIED", mediaOwnedByAccount: "VERIFIED", repliesListing: "VERIFIED",
    });
    expect(facts.status).toBe("VERIFIED");
    expect(facts.permissions).toEqual({ instagram_basic: "granted", instagram_manage_comments: "granted", pages_read_engagement: "granted", pages_show_list: "granted", ads_management: "not_granted", ads_read: "not_granted" });
    expect(facts.media).toEqual({ mediaType: "IMAGE", productType: "FEED" });
    expect(facts.replies).toEqual({ listed: 0, complete: true, byManagedAccount: 0, byOthers: 0, unattributed: 0, allNameTargetAsParent: true, managedAccountReplyTimestamps: [] });
    expect(w.calls.map((call) => call.route)).toEqual(["permissions", "account", "pages", "pageInstagram", "comment", "media", "mediaComments", "replies"]);
    expect(facts.requests).toBe(8);
    expect(facts.maxRequests).toBe(META_INSTAGRAM_REPLY_PREFLIGHT_MAX_REQUESTS);
    expect(facts.errors).toEqual([]);
    expect(facts.stoppedEarly).toBe(false);
    expectRedacted(facts);
  });
});

describe("B. permissions", () => {
  it("instagram_manage_comments missing (declined/expired read granted-only) → BLOCKED not_granted", async () => {
    const facts = await world({ permissions: granted("instagram_basic", "pages_read_engagement", "pages_show_list") }).inspect();
    expect(facts.checks.permissions).toEqual({ state: "BLOCKED", reason: "not_granted" });
    expect(facts.permissions?.instagram_manage_comments).toBe("not_granted");
    expect(facts.status).toBe("BLOCKED");
    expectRedacted(facts);
  });

  it("the conditional Business Manager permissions are reported, never decisive", async () => {
    const facts = await world({ permissions: granted(...ALL_GRANTED, "ads_read") }).inspect();
    expect(facts.permissions?.ads_read).toBe("granted");
    expect(facts.permissions?.ads_management).toBe("not_granted");
    expect(facts.status).toBe("VERIFIED");
  });

  it("a Graph permission refusal (code 10) on the comment node → BLOCKED permission_missing", async () => {
    const facts = await world({ comment: graphError(10) }).inspect();
    expect(facts.checks.commentExists).toEqual({ state: "BLOCKED", reason: "permission_missing" });
    expect(facts.status).toBe("BLOCKED");
    expectRedacted(facts);
  });
});

describe("C. an invalid or expired token stops the sequence at the first answer", () => {
  it.each([
    ["invalid (190)", graphError(190, undefined, "OAuthException")],
    ["expired (190/463)", graphError(190, 463, "OAuthException")],
    ["revoked (190/460)", graphError(190, 460, "OAuthException")],
  ])("%s → BLOCKED credential_invalid, ONE request, nothing else read", async (_name, answer) => {
    const w = world({ permissions: answer });
    const facts = await w.inspect();
    expect(facts.checks.permissions).toEqual({ state: "BLOCKED", reason: "credential_invalid" });
    expect(facts.stoppedEarly).toBe(true);
    expect(w.calls).toHaveLength(1);
    expect(facts.requests).toBe(1);
    expect(facts.checks.account).toEqual({ state: "NOT_VERIFIED", reason: "not_attempted" });
    expect(facts.status).toBe("BLOCKED");
    expectRedacted(facts);
  });

  it("a rate limit (80002) also stops the sequence → NOT_VERIFIED, never more requests", async () => {
    const w = world({ account: graphError(80002) });
    const facts = await w.inspect();
    expect(facts.checks.account).toEqual({ state: "NOT_VERIFIED", reason: "rate_limited" });
    expect(facts.stoppedEarly).toBe(true);
    expect(w.calls).toHaveLength(2);
    expect(facts.status).toBe("NOT_VERIFIED");
  });
});

describe("D. the Instagram account", () => {
  it("a node answering with ANOTHER id (echo mismatch) → NOT_VERIFIED unreadable, never matched by inference", async () => {
    const facts = await world({ account: ok({ id: OTHER_IG, username: MANAGED_HANDLE }) }).inspect();
    expect(facts.checks.account).toEqual({ state: "NOT_VERIFIED", reason: "unreadable" });
    expect(facts.status).toBe("NOT_VERIFIED");
    expectRedacted(facts);
  });

  it("an account Graph cannot reach (100/33) → BLOCKED not_found", async () => {
    const facts = await world({ account: graphError(100, 33) }).inspect();
    expect(facts.checks.account).toEqual({ state: "BLOCKED", reason: "not_found" });
    expect(facts.status).toBe("BLOCKED");
  });
});

describe("E. the Page link", () => {
  it("the only Page links ANOTHER Instagram account → BLOCKED not_linked", async () => {
    const facts = await world({ pageInstagram: ok({ id: PAGE, instagram_business_account: { id: OTHER_IG } }) }).inspect();
    expect(facts.checks.pageLink).toEqual({ state: "BLOCKED", reason: "not_linked" });
    expect(facts.status).toBe("BLOCKED");
    expectRedacted(facts);
  });

  it("a Page without any linked account → BLOCKED not_linked; two Pages, the second links it → VERIFIED", async () => {
    expect((await world({ pageInstagram: ok({ id: PAGE }) }).inspect()).checks.pageLink).toEqual({ state: "BLOCKED", reason: "not_linked" });
    const two = world({ pages: ok({ data: [{ id: OTHER_PAGE, name: PAGE_NAME }, { id: PAGE, name: PAGE_NAME }] }) }, { [OTHER_PAGE]: ok({ id: OTHER_PAGE }) });
    const facts = await two.inspect();
    expect(facts.checks.pageLink.state).toBe("VERIFIED");
    expect(two.calls.filter((call) => call.route === "pageInstagram")).toHaveLength(2);
  });

  it("more Pages than the bound, or a next page, without a match → NOT_VERIFIED incomplete_listing; never a cursor", async () => {
    const many = { data: ["880000000000051", "880000000000052", "880000000000053", "880000000000054"].map((id) => ({ id, name: PAGE_NAME })) };
    const w = world({ pages: ok(many), pageInstagram: ok({ id: "x" }) }, Object.fromEntries(many.data.map((page) => [page.id, ok({ id: page.id })])));
    const facts = await w.inspect();
    expect(facts.checks.pageLink).toEqual({ state: "NOT_VERIFIED", reason: "incomplete_listing" });
    expect(w.calls.filter((call) => call.route === "pageInstagram")).toHaveLength(3);
    const next = await world({ pages: ok({ data: [{ id: OTHER_PAGE, name: PAGE_NAME }], paging: { cursors: { after: CURSOR }, next: `https://graph.facebook.com/next?access_token=${PAGE_TOKEN}` } }) }, { [OTHER_PAGE]: ok({ id: OTHER_PAGE }) }).inspect();
    expect(next.checks.pageLink).toEqual({ state: "NOT_VERIFIED", reason: "incomplete_listing" });
    expectRedacted(next);
  });
});

describe("F–I. the comment node", () => {
  it("F. a comment Graph says does not exist (100/33) → BLOCKED not_found; its other checks are not verified", async () => {
    const w = world({ comment: graphError(100, 33) });
    const facts = await w.inspect();
    expect(facts.checks.commentExists).toEqual({ state: "BLOCKED", reason: "not_found" });
    expect(facts.checks.commentTopLevel.state).toBe("NOT_VERIFIED");
    expect(w.calls.some((call) => call.route === "mediaComments")).toBe(false);
    expect(facts.status).toBe("BLOCKED");
  });

  it("G. a nested comment (parent_id present) → BLOCKED nested; the top-level edge is never read", async () => {
    const w = world({ comment: ok(node({ parent_id: "17950000000000049" })) });
    const facts = await w.inspect();
    expect(facts.checks.commentTopLevel).toEqual({ state: "BLOCKED", reason: "nested" });
    expect(w.calls.some((call) => call.route === "mediaComments")).toBe(false);
    expect(facts.status).toBe("BLOCKED");
  });

  it("G'. parent_id absent but the media's top-level edge does not list the comment → NOT_VERIFIED (ambiguous / incomplete)", async () => {
    expect((await world({ mediaComments: ok({ data: [] }) }).inspect()).checks.commentTopLevel).toEqual({ state: "NOT_VERIFIED", reason: "ambiguous" });
    const incomplete = await world({ mediaComments: ok({ data: [], paging: { cursors: { after: CURSOR }, next: "https://graph.facebook.com/next" } }) }).inspect();
    expect(incomplete.checks.commentTopLevel).toEqual({ state: "NOT_VERIFIED", reason: "incomplete_listing" });
    expect(incomplete.status).toBe("NOT_VERIFIED");
  });

  it("H. hidden → BLOCKED hidden; `hidden` absent → NOT_VERIFIED field_absent", async () => {
    expect((await world({ comment: ok(node({ hidden: true })) }).inspect()).checks.commentVisible).toEqual({ state: "BLOCKED", reason: "hidden" });
    const absent = node();
    delete (absent as Record<string, unknown>)["hidden"];
    const facts = await world({ comment: ok(absent) }).inspect();
    expect(facts.checks.commentVisible).toEqual({ state: "NOT_VERIFIED", reason: "field_absent" });
    expect(facts.status).toBe("NOT_VERIFIED");
  });

  it("I. an own comment — by id, or by username (any case) — → BLOCKED own_author", async () => {
    expect((await world({ comment: ok(node({ from: { id: IG, username: MANAGED_HANDLE } })) }).inspect()).checks.commentAuthorExternal).toEqual({ state: "BLOCKED", reason: "own_author" });
    expect((await world({ comment: ok(node({ from: { id: COMMENTER, username: MANAGED_HANDLE.toUpperCase() } })) }).inspect()).checks.commentAuthorExternal).toEqual({ state: "BLOCKED", reason: "own_author" });
  });

  it("I'. author username absent (or the account's unknown) → NOT_VERIFIED field_absent, never external by inference", async () => {
    expect((await world({ comment: ok(node({ from: { id: COMMENTER } })) }).inspect()).checks.commentAuthorExternal).toEqual({ state: "NOT_VERIFIED", reason: "field_absent" });
    expect((await world({ account: ok({ id: IG }) }).inspect()).checks.commentAuthorExternal).toEqual({ state: "NOT_VERIFIED", reason: "field_absent" });
  });
});

describe("J. the media", () => {
  it("media owned by ANOTHER account → BLOCKED other_owner", async () => {
    const facts = await world({ media: ok(media({ owner: { id: OTHER_IG } })) }).inspect();
    expect(facts.checks.mediaOwnedByAccount).toEqual({ state: "BLOCKED", reason: "other_owner" });
    expect(facts.status).toBe("BLOCKED");
    expectRedacted(facts);
  });

  it("the comment on ANOTHER media than stored → BLOCKED mismatch; without media → NOT_VERIFIED field_absent", async () => {
    expect((await world({ comment: ok(node({ media: { id: OTHER_MEDIA } })) }).inspect()).checks.commentOnStoredMedia).toEqual({ state: "BLOCKED", reason: "mismatch" });
    const without = node();
    delete (without as Record<string, unknown>)["media"];
    const facts = await world({ comment: ok(without) }).inspect();
    expect(facts.checks.commentOnStoredMedia).toEqual({ state: "NOT_VERIFIED", reason: "field_absent" });
    expect(facts.checks.commentTopLevel.state).toBe("NOT_VERIFIED");
  });
});

describe("K. partial or ambiguous answers are never VERIFIED", () => {
  it.each([
    ["a comment without from.id (not the documented shape)", { comment: ok(node({ from: {} })) }, "commentExists", "unreadable"],
    ["a malformed permission entry", { permissions: ok({ data: [{ permission: "instagram_basic", status: "maybe" }] }) }, "permissions", "unreadable"],
    ["a permissions page reporting a next page", { permissions: ok({ data: [], paging: { next: "https://graph.facebook.com/next" } }) }, "permissions", "unreadable"],
    ["a 5xx without a Graph error", { media: { status: 503, body: "busy" } }, "mediaOwnedByAccount", "transient"],
    ["an unknown Graph error code", { media: graphError(9999) }, "mediaOwnedByAccount", "provider_error"],
  ] as const)("%s → NOT_VERIFIED", async (_name, overrides, check, reason) => {
    const facts = await world(overrides).inspect();
    expect(facts.checks[check]).toEqual({ state: "NOT_VERIFIED", reason });
    expect(facts.status).toBe("NOT_VERIFIED");
    expectRedacted(facts);
  });

  it("a replies page reporting a next page → incomplete; a reply under another parent → mismatch", async () => {
    const more = await world({ replies: ok({ data: [], paging: { cursors: { after: CURSOR }, next: "https://graph.facebook.com/next" } }) }).inspect();
    expect(more.checks.repliesListing).toEqual({ state: "NOT_VERIFIED", reason: "incomplete_listing" });
    expect(more.replies.complete).toBe(false);
    const foreign = await world({ replies: ok({ data: [reply(REPLY_OTHER, { id: COMMENTER }, "2026-11-11T10:00:00+0000", "17950000000000049")] }) }).inspect();
    expect(foreign.checks.repliesListing).toEqual({ state: "NOT_VERIFIED", reason: "mismatch" });
    expect(foreign.replies.allNameTargetAsParent).toBe(false);
  });
});

describe("L. network failures and timeouts", () => {
  it.each(["network", "timeout"] as const)("%s on the comment node → NOT_VERIFIED transient; the run continues (reads have no effect)", async (failure) => {
    const facts = await world({ comment: failure }).inspect();
    expect(facts.checks.commentExists).toEqual({ state: "NOT_VERIFIED", reason: "transient" });
    expect(facts.stoppedEarly).toBe(false);
    expect(facts.status).toBe("NOT_VERIFIED");
    expectRedacted(facts);
  });
});

describe("O. the HTTP boundary: Graph GETs on the allowlist only", () => {
  it("every request of every path is a GET without a body, on an allowlisted route, with no cursor", async () => {
    const scenarios: Partial<Record<Route, Answer>>[] = [{}, { comment: graphError(100, 33) }, { permissions: graphError(190) }, { replies: ok({ data: [reply(REPLY_MANAGED, { id: IG }, "2026-11-11T10:00:00+0000")] }) }];
    for (const scenario of scenarios) {
      for (const mode of ["preflight", "observe"] as const) {
        const w = world(scenario);
        await w.inspect(mode);
        for (const call of w.calls) {
          expect(call.method).toBe("GET");
          expect(call.hasBody).toBe(false);
          expect(call.route).not.toBe("unknown");
          expect(call.query).not.toContain("after");
        }
      }
    }
  });

  it("the reader reaches ONLY the allowlisted transport operations (a transport exposing nothing else is enough)", async () => {
    const touched: string[] = [];
    const base: MetaGraphTransport = createMetaGraphTransport({ fetch: () => Promise.resolve(new Response("{}", { status: 500 })) });
    const narrowed = new Proxy({} as InstagramReplyPreflightTransport, {
      get(_target, property: string) {
        touched.push(property);
        if (!(INSTAGRAM_REPLY_PREFLIGHT_OPERATIONS as readonly string[]).includes(property)) throw new Error(`not allowlisted: ${property}`);
        return (base as unknown as Record<string, unknown>)[property];
      },
    });
    const preflight = createInstagramReplyPreflight({ transport: narrowed });
    await preflight.inspect(CREDENTIAL, TARGET, "preflight");
    await preflight.inspect(CREDENTIAL, TARGET, "observe");
    expect(new Set(touched).size).toBeGreaterThan(0);
    for (const property of touched) expect(INSTAGRAM_REPLY_PREFLIGHT_OPERATIONS).toContain(property);
    expect(INSTAGRAM_REPLY_PREFLIGHT_OPERATIONS).not.toContain("createInstagramCommentReply");
    expect(INSTAGRAM_REPLY_PREFLIGHT_OPERATIONS).not.toContain("getPageAccessToken");
    expect(Object.keys(preflight)).toEqual(["inspect"]);
  });
});

describe("OBSERVE: the replies under the same comment, 3 GETs", () => {
  it("counts the managed account's replies (by id or username) with their instants; others counted apart", async () => {
    const w = world({
      replies: ok({
        data: [
          reply(REPLY_OTHER, { id: COMMENTER, username: COMMENTER_HANDLE }, "2026-11-11T09:00:00+0000"),
          reply(REPLY_MANAGED, { id: IG, username: MANAGED_HANDLE }, "2026-11-11T10:00:00+0000"),
          reply("17950000000000044", { id: "17960000000000049", username: MANAGED_HANDLE }, "2026-11-11T08:00:00+0000"),
        ],
      }),
    });
    const facts = await w.inspect("observe");
    expect(w.calls.map((call) => call.route)).toEqual(["account", "comment", "replies"]);
    expect(facts.requests).toBe(3);
    expect(facts.maxRequests).toBe(META_INSTAGRAM_REPLY_OBSERVE_MAX_REQUESTS);
    expect(facts.permissions).toBeNull();
    expect(facts.replies).toEqual({ listed: 3, complete: true, byManagedAccount: 2, byOthers: 1, unattributed: 0, allNameTargetAsParent: true, managedAccountReplyTimestamps: ["2026-11-11T08:00:00.000Z", "2026-11-11T10:00:00.000Z"] });
    expect(facts.status).toBe("VERIFIED");
    expect(facts.checks.permissions).toEqual({ state: "NOT_VERIFIED", reason: "not_attempted" });
    expect(facts.checks.pageLink).toEqual({ state: "NOT_VERIFIED", reason: "not_attempted" });
    expect(facts.checks.commentTopLevel).toEqual({ state: "NOT_VERIFIED", reason: "not_attempted" });
    expectRedacted(facts);
  });

  it("an incomplete replies page can never claim `no reply`: NOT_VERIFIED", async () => {
    const facts = await world({ replies: ok({ data: [], paging: { cursors: { after: CURSOR }, next: "https://graph.facebook.com/next" } }) }).inspect("observe");
    expect(facts.status).toBe("NOT_VERIFIED");
    expect(facts.replies.complete).toBe(false);
  });

  it("the comment gone (100/33) → BLOCKED; a reply without parent_id leaves the parent relation unverified (null)", async () => {
    expect((await world({ comment: graphError(100, 33) }).inspect("observe")).status).toBe("BLOCKED");
    const facts = await world({ replies: ok({ data: [reply(REPLY_MANAGED, { id: IG }, "2026-11-11T10:00:00+0000", null)] }) }).inspect("observe");
    expect(facts.replies.allNameTargetAsParent).toBeNull();
    expect(facts.replies.byManagedAccount).toBe(1);
  });
});

describe("F1 (Step 7B-14C3): Graph errors typed OAuthException keep the read port's precedence — never an invalid credential by type alone", () => {
  const oauth = (code: number, subcode?: number) => graphError(code, subcode, "OAuthException");
  const fieldsOf = (code: number, subcode?: number) => {
    const fields = graphErrorFields({ error: { code, ...(subcode === undefined ? {} : { error_subcode: subcode }), type: "OAuthException" } });
    if (fields === null) throw new Error("not a Graph error");
    return fields;
  };

  it.each([
    ["10 (permission)", 10, undefined, "BLOCKED", "permission_missing", false],
    ["200 (permission)", 200, undefined, "BLOCKED", "permission_missing", false],
    ["230 (permission, 201–299)", 230, undefined, "BLOCKED", "permission_missing", false],
    ["299 (permission, upper bound)", 299, undefined, "BLOCKED", "permission_missing", false],
    ["100/492 (no role on the Page)", 100, 492, "BLOCKED", "permission_missing", false],
    ["1 (temporary)", 1, undefined, "NOT_VERIFIED", "transient", false],
    ["2 (temporary)", 2, undefined, "NOT_VERIFIED", "transient", false],
    ["100/33 (object missing)", 100, 33, "BLOCKED", "not_found", false],
    ["102 (credential)", 102, undefined, "BLOCKED", "credential_invalid", true],
    ["190 (credential)", 190, undefined, "BLOCKED", "credential_invalid", true],
    ["190/463 (expired)", 190, 463, "BLOCKED", "credential_invalid", true],
    ["4 (rate limit)", 4, undefined, "NOT_VERIFIED", "rate_limited", true],
    ["17 (rate limit)", 17, undefined, "NOT_VERIFIED", "rate_limited", true],
    ["613 (rate limit)", 613, undefined, "NOT_VERIFIED", "rate_limited", true],
    ["80002 (rate limit)", 80002, undefined, "NOT_VERIFIED", "rate_limited", true],
    // Only AFTER every listed code: an OAuthException with an unlisted code is the shared normalizer's credential class.
    ["100 without subcode 33 (unlisted, OAuthException)", 100, undefined, "BLOCKED", "credential_invalid", true],
    ["an unlisted code (OAuthException)", 1234, undefined, "BLOCKED", "credential_invalid", true],
  ] as const)("%s on the comment node: the exact category, the precedence and whether it stops the sequence", async (_name, code, subcode, checkState, reason, stops) => {
    const w = world({ comment: oauth(code, subcode) });
    const facts = await w.inspect();
    expect(facts.checks.commentExists).toEqual({ state: checkState, reason });
    expect(facts.errors).toEqual([{ operation: "getInstagramComment", failure: reason }]);
    expect(facts.stoppedEarly).toBe(stops);
    // A stop ends the sequence after the comment (5 GETs); otherwise media and replies are still read (the top-level edge
    // is skipped because the comment was not read).
    expect(facts.requests).toBe(stops ? 5 : 7);
    expect(facts.status).not.toBe("VERIFIED");
    expectRedacted(facts);
  });

  it("(#200) on me/permissions and 492 on the Page link are missing permissions, and the sequence continues", async () => {
    const permissions = await world({ permissions: oauth(200) }).inspect();
    expect(permissions.checks.permissions).toEqual({ state: "BLOCKED", reason: "permission_missing" });
    expect(permissions.stoppedEarly).toBe(false);
    expect(permissions.checks.account.state).toBe("VERIFIED");
    const link = await world({ pageInstagram: oauth(100, 492) }).inspect();
    expect(link.checks.pageLink).toEqual({ state: "NOT_VERIFIED", reason: "permission_missing" });
    expect(link.stoppedEarly).toBe(false);
    expect(link.checks.commentExists.state).toBe("VERIFIED");
  });

  it("the classification is the read port's normalizer itself: parity over every listed code, typed or not as OAuthException", () => {
    const kinds: Record<string, string> = { rate_limited: "rate_limited", permission_missing: "permission_missing", transient: "transient", credential_invalid: "credential_invalid", permanent_rejected: "provider_error" };
    const codes = [1, 2, 4, 10, 17, 32, 100, 102, 190, 200, 201, 250, 299, 300, 341, 368, 613, 80000, 80001, 80002, 80004, 80008, 1234];
    for (const code of codes) {
      for (const subcode of [undefined, 33, 458, 460, 463, 492]) {
        for (const type of ["OAuthException", "GraphMethodException"]) {
          const fields = graphErrorFields({ error: { code, ...(subcode === undefined ? {} : { error_subcode: subcode }), type } });
          if (fields === null) throw new Error("not a Graph error");
          const expected = code === 100 && subcode === 33 ? "not_found" : kinds[metaGraphReadError("getInteraction", fields, "read_interactions").kind];
          expect(readFailureOf({ kind: "graph_error", error: fields }), `${String(code)}/${String(subcode)}/${type}`).toBe(expected);
        }
      }
    }
    expect(readFailureOf({ kind: "graph_error", error: fieldsOf(10) })).toBe("permission_missing");
  });
});

describe("F2 (Step 7B-14C3): reply authorship is attributed only on proof; ambiguity is NOT_VERIFIED, never a confirmed absence", () => {
  const managedReply = (from: Record<string, unknown>) => reply(REPLY_MANAGED, from, "2026-11-11T10:00:00+0000");

  it("A. from.id equal to the managed account → managed", async () => {
    const facts = await world({ replies: ok({ data: [managedReply({ id: IG })] }) }).inspect("observe");
    expect(facts.replies).toMatchObject({ byManagedAccount: 1, byOthers: 0, unattributed: 0, managedAccountReplyTimestamps: ["2026-11-11T10:00:00.000Z"] });
    expect(facts.checks.repliesListing).toEqual({ state: "VERIFIED", reason: null });
  });

  it("B. a different (Instagram-scoped) from.id but the same username, in any case → managed", async () => {
    const facts = await world({ replies: ok({ data: [managedReply({ id: "17960000000000077", username: MANAGED_HANDLE.toUpperCase() })] }) }).inspect("observe");
    expect(facts.replies).toMatchObject({ byManagedAccount: 1, byOthers: 0, unattributed: 0 });
    expect(facts.status).toBe("VERIFIED");
  });

  it("C. the managed username unknown and a different from.id → NOT_VERIFIED author_ambiguous, counts withheld", async () => {
    for (const account of [ok({ id: IG }), ok({ id: IG, username: "" })]) {
      const facts = await world({ account, replies: ok({ data: [managedReply({ id: "17960000000000077", username: MANAGED_HANDLE })] }) }).inspect("observe");
      expect(facts.checks.account.state).toBe("VERIFIED");
      expect(facts.checks.repliesListing).toEqual({ state: "NOT_VERIFIED", reason: "author_ambiguous" });
      expect(facts.replies).toMatchObject({ listed: 1, complete: true, byManagedAccount: null, byOthers: null, unattributed: 1, managedAccountReplyTimestamps: [] });
      expect(facts.status).toBe("NOT_VERIFIED");
      expectRedacted(facts);
    }
  });

  it("D. partial identities: the reply's username absent (or empty) with a different id → ambiguous; proven ones are kept apart", async () => {
    const facts = await world({
      replies: ok({
        data: [
          managedReply({ id: IG }),
          reply(REPLY_OTHER, { id: COMMENTER }, "2026-11-11T09:00:00+0000"),
          reply("17950000000000045", { id: "17960000000000078", username: "" }, "2026-11-11T09:30:00+0000"),
        ],
      }),
    }).inspect("observe");
    expect(facts.replies).toMatchObject({ listed: 3, byManagedAccount: null, byOthers: null, unattributed: 2, managedAccountReplyTimestamps: ["2026-11-11T10:00:00.000Z"] });
    expect(facts.checks.repliesListing).toEqual({ state: "NOT_VERIFIED", reason: "author_ambiguous" });
    expect(facts.status).toBe("NOT_VERIFIED");
  });

  it("E. third-party replies with a different id AND a different known username → others, VERIFIED with byManagedAccount 0", async () => {
    const facts = await world({ replies: ok({ data: [reply(REPLY_OTHER, { id: COMMENTER, username: COMMENTER_HANDLE }, "2026-11-11T09:00:00+0000")] }) }).inspect("observe");
    expect(facts.replies).toMatchObject({ listed: 1, complete: true, byManagedAccount: 0, byOthers: 1, unattributed: 0, managedAccountReplyTimestamps: [] });
    expect(facts.status).toBe("VERIFIED");
  });

  it("F. an incomplete listing with an ambiguous author → NOT_VERIFIED incomplete_listing (both reported), never VERIFIED", async () => {
    const facts = await world({
      replies: ok({ data: [managedReply({ id: "17960000000000077" })], paging: { cursors: { after: CURSOR }, next: "https://graph.facebook.com/next" } }),
    }).inspect("observe");
    expect(facts.checks.repliesListing).toEqual({ state: "NOT_VERIFIED", reason: "incomplete_listing" });
    expect(facts.replies).toMatchObject({ complete: false, byManagedAccount: null, byOthers: null, unattributed: 1 });
    expect(facts.status).toBe("NOT_VERIFIED");
  });

  it("the preflight baseline applies the same rule: an ambiguous existing reply keeps the preflight NOT_VERIFIED", async () => {
    const facts = await world({ replies: ok({ data: [managedReply({ id: "17960000000000077" })] }) }).inspect();
    expect(facts.checks.repliesListing).toEqual({ state: "NOT_VERIFIED", reason: "author_ambiguous" });
    expect(facts.status).toBe("NOT_VERIFIED");
  });

  it("G. a found own reply never confirms a specific POST: no reply id, no selection, pre-existing own replies counted alike", async () => {
    const facts = await world({
      replies: ok({
        data: [
          reply(REPLY_MANAGED, { id: IG, username: MANAGED_HANDLE }, "2026-10-30T10:00:00+0000"),
          reply(REPLY_OTHER, { id: IG, username: MANAGED_HANDLE }, "2026-11-11T10:00:00+0000"),
        ],
      }),
    }).inspect("observe");
    expect(facts.status).toBe("VERIFIED");
    expect(facts.replies).toEqual({
      listed: 2, complete: true, byManagedAccount: 2, byOthers: 0, unattributed: 0, allNameTargetAsParent: true,
      managedAccountReplyTimestamps: ["2026-10-30T10:00:00.000Z", "2026-11-11T10:00:00.000Z"],
    });
    expect(Object.keys(facts).sort()).toEqual(["checks", "errors", "graphVersion", "limitations", "maxRequests", "media", "mode", "permissions", "replies", "requests", "status", "stoppedEarly", "tokenTypeForReplyPost"]);
    expect(facts.limitations).toContain("OBSERVE_DOES_NOT_IDENTIFY_A_SPECIFIC_REPLY");
    expect(JSON.stringify(facts)).not.toMatch(/confirm|publish|replyId|provider_reply|intent/i);
    expectRedacted(facts);
  });
});

describe("F4 (Step 7B-14C3): the Page link is never VERIFIED from an ambiguous answer", () => {
  it("two checked Pages both linking the account → NOT_VERIFIED ambiguous (also with a further page reported)", async () => {
    const linked = ok({ id: PAGE, instagram_business_account: { id: IG } });
    const linkedOther = ok({ id: OTHER_PAGE, instagram_business_account: { id: IG } });
    const pages = { data: [{ id: PAGE, name: PAGE_NAME }, { id: OTHER_PAGE, name: PAGE_NAME }] };
    for (const listing of [pages, { ...pages, paging: { cursors: { after: CURSOR }, next: "https://graph.facebook.com/next" } }]) {
      const w = world({ pages: ok(listing) }, { [PAGE]: linked, [OTHER_PAGE]: linkedOther });
      const facts = await w.inspect();
      expect(facts.checks.pageLink).toEqual({ state: "NOT_VERIFIED", reason: "ambiguous" });
      expect(facts.status).toBe("NOT_VERIFIED");
      expect(w.calls.filter((call) => call.route === "pages")).toHaveLength(1);
      expect(w.calls.every((call) => !call.query.includes("after"))).toBe(true);
    }
  });
});

describe("Q. the report never carries tokens, ids, usernames, Page names or texts on any path", () => {
  it("across eligible, blocked and failing answers in both modes", async () => {
    const scenarios: Partial<Record<Route, Answer>>[] = [
      {},
      { comment: ok(node({ hidden: true, parent_id: "17950000000000049" })) },
      { pages: ok({ data: [{ id: OTHER_PAGE, name: PAGE_NAME }], paging: { cursors: { after: CURSOR }, next: `https://graph.facebook.com/next?access_token=${PAGE_TOKEN}` } }) },
      { replies: ok({ data: [reply(REPLY_MANAGED, { id: IG, username: MANAGED_HANDLE }, "2026-11-11T10:00:00+0000")] }) },
      { media: graphError(10), account: "timeout" },
    ];
    for (const scenario of scenarios) for (const mode of ["preflight", "observe"] as const) expectRedacted(await world(scenario).inspect(mode));
  });
});
