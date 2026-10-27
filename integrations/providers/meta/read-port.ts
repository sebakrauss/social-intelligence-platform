/**
 * Meta implementation of the provider READ port — `discoverAssets`, `describeAccount` and Facebook Page and Instagram
 * professional-account `listContent` / `getContent` (Step 7G-E; design/phase-7g/meta-provider/README.md, E1 — the implementation authority). Composed only by the integration worker (jobs/connections.ts), with
 * the credential the worker opened for this one call: no Meta app configuration, no App Secret, no KMS, no state.
 *
 * Discovery, sequential and deterministic, only documented requests (./graph-transport):
 *   1. /me/accounts?fields=id,name, page by page — continued only while the provider reports a next page with a valid
 *      `after` cursor, rebuilt against the fixed endpoint (the returned `next` URL is never fetched); a repeated
 *      cursor, or a next page without a valid cursor, fails closed; at most DISCOVER_ASSETS_MAX_PAGES pages, and a
 *      last page that still reports a next page fails closed (no silent truncation);
 *   2. each distinct Page, in id order: its instagram_business_account (none is not an error);
 *   3. each distinct Instagram account, in id order: id + username.
 * Pages are deduplicated by id, Instagram accounts by id (one account seen through several Pages is ONE asset that
 * relates to all of them). Assets are Facebook Pages and Instagram professional accounts, both content-bearing,
 * ordered by platform then id; display names are the reported name/username (empty → the application's fallback).
 *
 * Complete or nothing: any failure — a provider error, an unreadable or malformed response, the page bound — fails
 * the whole call; no partial asset list is ever returned.
 *
 * describeAccount (Step 7G-H5.5; README contract H55) — the FACTS capability evaluation needs about ONE discovered
 * asset, never a statement of what the product may do (that is the capability catalog's):
 *   1. the asset itself, its echoed id checked: a Facebook Page `{page-id}?fields=id,name`, an Instagram professional
 *      account `{ig-user-id}?fields=id,username` (E1's documented read);
 *   2. `me/permissions?fields=permission,status`: the names the user GRANTED (declined and expired are not grants).
 * Facts: content-bearing; the identity the account posts as is the asset itself; no linked ad accounts (no ads
 * permission is requested, so none is claimed). Any other platform is refused (invalid_request) before any request;
 * any failure fails the whole description — the evaluator then records "facts unavailable" (UNKNOWN, never SUPPORTED).
 *
 * read_content, Facebook Pages (Step 7G-H5.5-P5-B; README › read_content — IMPLEMENTED_OFFLINE_NOT_LIVE_VALIDATED):
 * READ_CONTENT_REQUIRED_OPERATIONS = listContent + getContent (modules/capability/domain/catalog-contract.ts), both here. Each call derives a Page Access Token from
 * the sealed User Access Token it was handed (`{page-id}?fields=access_token`) and uses it for exactly ONE content
 * read in the same call; the derived token is a SecretValue local to that call — never persisted, cached, returned,
 * logged or placed in a DTO, error or raw reference. Two Graph GETs per call:
 *   listContent  token derivation, then ONE page of `{page-id}/published_posts` (never `/feed`). The caller iterates:
 *                `more` carries the Graph `after` cursor wrapped in the versioned envelope `meta1.<base64url>` (Step
 *                7G-H5.5-P5-C7: the raw Graph cursor never crosses the port; it is decoded back and sent as `after`
 *                against the fixed endpoint; the `next` URL is never fetched), `end` means `paging.next` was absent.
 *                A cursor returned equal to the one sent, a next page without a valid cursor, or a malformed,
 *                non-canonical or foreign envelope fails closed (invalid_cursor) before any request. The window [from, to) is applied CLIENT-SIDE to
 *                `created_time` (no server bounding is claimed, and no ordering is assumed: pagination never stops
 *                early on a date), so a page may be empty and still report `more`.
 *   getContent   token derivation, then `{post-id}` (echoed id checked).
 * Every returned post must have `from.id` = the managed Page, else the WHOLE page (or the single read) fails closed —
 * never a partial page; `from.name` is never read. `status_type` is classified by a CLOSED table (added_video →
 * video; mobile_status_update, added_photos, shared_story → post); anything else, or none, fails closed (no
 * fallback). `reportedSource` is always "unknown": `/published_posts` says who published, not organic vs paid.
 * Errors: the shared Graph read mapping (permission → PermissionMissing(read_content), never non-support), plus ONE
 * getContent-only case: code 100 / subcode 33 on the post read is TargetNotFound — ambiguous (missing, inaccessible
 * or unsupported), so it is never an eligibility or support observation.
 *
 * read_content, Instagram professional accounts (Step 7G-H5.5-P11-B; README › Instagram read_content —
 * IMPLEMENTED_OFFLINE_NOT_LIVE_VALIDATED): the same two operations, selected by the account's platform (no fallback).
 * The sealed Facebook User Access Token is used DIRECTLY — no Page token is derived — so each call is ONE Graph GET:
 *   listContent  ONE page of `{ig-user-id}/media` (never stories, live media, tags, mentions or album children), with
 *                the same `meta1.` cursor envelope, the same fixed-endpoint continuation and the same client-side
 *                window, here on `timestamp`.
 *   getContent   `{ig-media-id}` (echoed id checked).
 * Every media object must have `owner.id` = the managed account, else the WHOLE page (or the single read) fails closed.
 * The kind is classified by a CLOSED table on (`media_type`, `media_product_type`) — IMAGE·FEED → post, VIDEO·FEED →
 * video, VIDEO·REELS → reel, CAROUSEL_ALBUM·FEED → carousel; anything else (STORY, AD, IMAGE·REELS, a new or missing
 * value) fails closed, with no fallback. `reportedSource` is always "unknown": the surface (FEED, REELS) says where
 * the media appears, not whether it is organic or paid. Errors: the same shared mapping and the same getContent-only
 * 100/33 → TargetNotFound.
 *
 * read_interactions (Step 7G-H5.5-P12-B1; README › read_interactions — IMPLEMENTED_OFFLINE_NOT_REGISTERED):
 * `listInteractions` of ONE known content item (an account-wide comment feed is not offered: the `account` scope is
 * TargetNotEligible for every platform, before any request) and `getInteraction`. Platform-selected like read_content:
 *   Facebook   comments AND replies. listInteractions derives a Page token, then ONE page of `{post-id}/comments`
 *              with `filter=stream` (top-level comments and their replies in one edge, each reply carrying
 *              `parent.id`); getInteraction derives a Page token, then `{comment-id}`, whose `object.id` is its ONLY
 *              content authority (absent, or equal to its own parent, fails closed: never a guessed post).
 *   Instagram  top-level comments ONLY, with the sealed User token directly: ONE page of `{ig-media-id}/comments`, or
 *              `{ig-comment-id}`. A `parent_id` fails closed (replies are not read in this slice; never normalized as
 *              a reply); a `media.id` other than the scope's fails closed; getInteraction requires `media.id`.
 * Both: `from.id` is required (a missing author fails the WHOLE page — never a dropped row, never an invented id);
 * the author is the account itself exactly when `from.id` is the managed asset's id; visibility comes only from the
 * reported boolean (absent → unknown); the same `meta1.` cursor envelope, fixed-endpoint continuation and client-side
 * window [from, to) on the creation time, with no ordering assumed. Errors: the shared Graph read mapping with
 * capability read_interactions, plus getInteraction's 100/33 → TargetNotFound.
 * Every other read operation is refused (permanent).
 */
import type { ProviderCredential } from "../contract/credential";
import { PermanentRejectedError, TargetNotEligibleError, TargetNotFoundError, TransientError, type PermanentRejectionDiagnostic, type PermissionCapability, type ReadOperation } from "../contract/errors";
import type { AccountDescriptionDto, ContentDto, ContentKind, InteractionDto, ProviderAccess, SocialAssetDto } from "../contract/dto";
import { isoInstant, parseIsoInstant, parseProviderObjectId, providerObjectRef, rawReference, type ProviderObjectId, type ProviderObjectRef } from "../contract/identity";
import { BUDGET_NOT_REPORTED, parsePageCursor, type Page, type PageCursor, type TimeWindow } from "../contract/pagination";
import type { InteractionScope, ProviderReadPort } from "../contract/read-port";
import { WebhookRejectedError } from "../contract/webhooks";
import { META_GRAPH_VERSION } from "./endpoints";
import { metaGraphReadError } from "./errors";
import {
  createMetaGraphTransport,
  parseMetaGraphCursor,
  type MetaGraphCursor,
  type MetaGraphOutcome,
  type MetaComment,
  type MetaGraphTransport,
  type MetaInstagramComment,
  type MetaInstagramMedia,
  type MetaPageList,
  type MetaPost,
} from "./graph-transport";

/** The most /me/accounts pages one discovery reads. Fixed (never configuration); revised only with evidence. */
export const DISCOVER_ASSETS_MAX_PAGES = 20;

export interface MetaReadPortOptions {
  readonly transport?: MetaGraphTransport;
  /** describeAccount's `describedAt` (the local clock by default). */
  readonly clock?: () => Date;
}

const OPERATION = "discoverAssets";
const DESCRIBE = "describeAccount";

/**
 * The CLOSED `status_type` → content-kind table (P5-B). Only Graph Page-post types that unambiguously denote an
 * ordinary post or a video; everything else (created_event, created_note, wall_post, app_created_story,
 * published_story, tagged_in_photo, approved_friend, created_group, any new value) and a missing status_type are
 * unreadable. Reels, stories and carousels are out of scope.
 */
export const META_STATUS_TYPE_CONTENT_KINDS: Readonly<Record<string, ContentKind>> = Object.freeze({
  added_video: "video",
  mobile_status_update: "post",
  added_photos: "post",
  shared_story: "post",
});

/**
 * The CLOSED (`media_type`, `media_product_type`) → content-kind table (P11-B), keyed `MEDIA_TYPE:MEDIA_PRODUCT_TYPE`.
 * Only the documented pairs that unambiguously denote one product kind; STORY and AD media, IMAGE or CAROUSEL_ALBUM as
 * REELS, any new value and a missing value are unreadable. Album children are never read.
 */
export const META_INSTAGRAM_MEDIA_CONTENT_KINDS: Readonly<Record<string, ContentKind>> = Object.freeze({
  "IMAGE:FEED": "post",
  "VIDEO:FEED": "video",
  "VIDEO:REELS": "reel",
  "CAROUSEL_ALBUM:FEED": "carousel",
});

/**
 * The Meta continuation envelope (Step 7G-H5.5-P5-C7): `meta1.` + the raw Graph cursor as unpadded base64url. Private
 * to this adapter; deterministic (same raw cursor → same PageCursor), carries no id, time or randomness, never stored.
 */
export const META_PAGE_CURSOR_PREFIX = "meta1.";
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The paginated reads: each names its own failures. */
type ListOperation = "listContent" | "listInteractions";

/** A validated raw Graph cursor as the opaque PageCursor handed to callers. */
function encodeMetaPageCursor(raw: MetaGraphCursor, operation: ListOperation = "listContent"): PageCursor {
  const cursor = parsePageCursor(META_PAGE_CURSOR_PREFIX + Buffer.from(raw, "latin1").toString("base64url"));
  if (cursor === undefined) throw new PermanentRejectedError(operation, "invalid_cursor");
  return cursor;
}

/**
 * A caller's PageCursor back to the raw Graph cursor, fail closed: exact prefix, non-empty STRICT base64url payload,
 * canonical (re-encoding the bytes reproduces the payload — Node's decoder is permissive), and the decoded value must
 * again be a valid raw Graph cursor. The value never appears in the error.
 */
function decodeMetaPageCursor(cursor: PageCursor, operation: ListOperation = "listContent"): MetaGraphCursor {
  const value: string = cursor;
  const payload = value.startsWith(META_PAGE_CURSOR_PREFIX) ? value.slice(META_PAGE_CURSOR_PREFIX.length) : "";
  if (!BASE64URL.test(payload)) throw new PermanentRejectedError(operation, "invalid_cursor");
  const bytes = Buffer.from(payload, "base64url");
  const raw = bytes.toString("base64url") === payload ? parseMetaGraphCursor(bytes.toString("latin1")) : undefined;
  if (raw === undefined) throw new PermanentRejectedError(operation, "invalid_cursor");
  return raw;
}

/** Graph code 100 / subcode 33: "object does not exist, cannot be loaded due to missing permissions, or does not support this operation". */
const AMBIGUOUS_OBJECT_CODE = 100;
const AMBIGUOUS_OBJECT_SUBCODE = 33;

/** Code-unit order: deterministic, locale-independent. */
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The value of a successful outcome; every failure becomes one normalized provider error of `operation`. */
function outcomeValue<T>(outcome: MetaGraphOutcome<T>, operation: ReadOperation, capability: PermissionCapability): T {
  switch (outcome.kind) {
    case "ok":
      return outcome.value;
    case "graph_error":
      throw metaGraphReadError(operation, outcome.error, capability);
    case "transient":
      throw new TransientError(operation, outcome.reason);
    case "unreadable":
      throw new PermanentRejectedError(operation, "unknown");
  }
}

const valueOf = <T>(outcome: MetaGraphOutcome<T>): T => outcomeValue(outcome, OPERATION, "discover_assets");
const describedValue = <T>(outcome: MetaGraphOutcome<T>): T => outcomeValue(outcome, DESCRIBE, "read_account");

/** Facts about one discovered Facebook Page or Instagram professional account (README, H55). */
async function describe(transport: MetaGraphTransport, access: ProviderAccess, now: Date): Promise<AccountDescriptionDto> {
  const token = access.credential.secret;
  const { platform, id } = access.account;
  let displayName: string;
  if (platform === "facebook") displayName = describedValue(await transport.getPage(token, id)).name;
  else if (platform === "instagram") displayName = describedValue(await transport.getInstagramAccount(token, id)).username;
  else throw new PermanentRejectedError(DESCRIBE, "invalid_request");
  const grantedPermissions = describedValue(await transport.listPermissions(token));
  return Object.freeze({
    asset: providerObjectRef(platform, "asset", id),
    assetClass: "content_bearing",
    displayName,
    accountIdentity: providerObjectRef(platform, "author", id),
    grantedPermissions,
    linkedAdAccounts: Object.freeze([]),
    describedAt: isoInstant(now),
    rawReference: rawReference("meta", META_GRAPH_VERSION, platform === "facebook" ? `facebook:page:${id}` : `instagram:account:${id}`),
  });
}

type ContentOperation = "listContent" | "getContent";
type InteractionOperation = "listInteractions" | "getInteraction";

/** The managed Facebook Page of `access`, or a refusal before any request (Instagram has its own branch; TikTok: not here). */
function managedPage(access: ProviderAccess, operation: ContentOperation | InteractionOperation): ProviderObjectId {
  const { platform, kind, id } = access.account;
  const page = parseProviderObjectId(id);
  // The kind is re-checked at runtime: a caller's ref is data, whatever its static type says.
  if (platform !== "facebook" || (kind as string) !== "asset" || page === undefined) throw new PermanentRejectedError(operation, "invalid_request");
  return page;
}

/** A post as a ContentDto: correlated to the managed Page, classified by the closed table, else unreadable. */
function contentOf(post: MetaPost, page: ProviderObjectId, operation: ContentOperation): ContentDto {
  if (post.fromId !== page) throw new PermanentRejectedError(operation, "unknown");
  // Own keys only: an inherited name that passes the grammar (e.g. `constructor`) is unreadable, never a kind.
  const contentKind = post.statusType !== null && Object.hasOwn(META_STATUS_TYPE_CONTENT_KINDS, post.statusType) ? META_STATUS_TYPE_CONTENT_KINDS[post.statusType] : undefined;
  if (contentKind === undefined) throw new PermanentRejectedError(operation, "unknown");
  return Object.freeze({
    ref: providerObjectRef("facebook", "content", post.id),
    account: providerObjectRef("facebook", "asset", page),
    contentKind,
    reportedSource: "unknown",
    caption: post.message,
    publishedAt: post.createdTime,
    availability: "available",
    timestamps: Object.freeze({ createdAt: post.createdTime, updatedAt: post.updatedTime }),
    rawReference: rawReference("meta", META_GRAPH_VERSION, `facebook:post:${post.id}`),
  });
}

/** [from, to) as epoch milliseconds, refused (before any request) unless both ends are instants and from < to. */
function windowBounds(window: TimeWindow, operation: ListOperation = "listContent"): { readonly from: number; readonly to: number } {
  const from = parseIsoInstant(window.from);
  const to = parseIsoInstant(window.to);
  if (from === undefined || to === undefined || Date.parse(from) >= Date.parse(to)) throw new PermanentRejectedError(operation, "invalid_request");
  return { from: Date.parse(from), to: Date.parse(to) };
}

/** The Page Access Token for one content or interaction read, derived from the sealed User Access Token. Never kept. */
async function pageToken(transport: MetaGraphTransport, access: ProviderAccess, page: ProviderObjectId, operation: ContentOperation | InteractionOperation) {
  const capability: PermissionCapability = operation === "listContent" || operation === "getContent" ? "read_content" : "read_interactions";
  return outcomeValue(await transport.getPageAccessToken(access.credential.secret, page), operation, capability);
}

async function listPublished(transport: MetaGraphTransport, access: ProviderAccess, window: TimeWindow, cursor: PageCursor | null): Promise<Page<ContentDto>> {
  const page = managedPage(access, "listContent");
  const bounds = windowBounds(window);
  // The caller's cursor is the envelope a previous page returned: re-validated and decoded to the raw `after`, never a URL.
  if (cursor !== null && parsePageCursor(cursor) === undefined) throw new PermanentRejectedError("listContent", "invalid_cursor");
  const after: MetaGraphCursor | null = cursor === null ? null : decodeMetaPageCursor(cursor);
  const token = await pageToken(transport, access, page, "listContent");
  const list = outcomeValue(await transport.listPublishedPosts(token, page, after), "listContent", "read_content");
  // Map EVERY post first (one mismatch fails the whole page), then filter the window client-side.
  const items = list.posts.map((post) => contentOf(post, page, "listContent")).filter((item) => {
    const at = Date.parse(item.publishedAt ?? "");
    return at >= bounds.from && at < bounds.to;
  });
  if (list.after === null) return Object.freeze({ items: Object.freeze(items), next: Object.freeze({ kind: "end" as const }) });
  // Deterministic envelope: the same raw cursor yields the same PageCursor, so a repeat is detected here.
  const next = encodeMetaPageCursor(list.after);
  if (next === cursor) throw new PermanentRejectedError("listContent", "invalid_cursor");
  return Object.freeze({ items: Object.freeze(items), next: Object.freeze({ kind: "more" as const, cursor: next }) });
}

async function getPublished(transport: MetaGraphTransport, access: ProviderAccess, ref: ProviderObjectRef<"content">): Promise<ContentDto> {
  const page = managedPage(access, "getContent");
  const postId = parseProviderObjectId(ref.id);
  if (ref.platform !== "facebook" || (ref.kind as string) !== "content" || postId === undefined) throw new PermanentRejectedError("getContent", "invalid_request");
  const token = await pageToken(transport, access, page, "getContent");
  const outcome = await transport.getPost(token, postId);
  if (outcome.kind === "graph_error" && outcome.error.code === AMBIGUOUS_OBJECT_CODE && outcome.error.subcode === AMBIGUOUS_OBJECT_SUBCODE) throw new TargetNotFoundError("getContent");
  return contentOf(outcomeValue(outcome, "getContent", "read_content"), page, "getContent");
}

/** The managed Instagram professional account of `access`, or a refusal before any request. */
function managedInstagramAccount(access: ProviderAccess, operation: ContentOperation | InteractionOperation): ProviderObjectId {
  const { platform, kind, id } = access.account;
  const account = parseProviderObjectId(id);
  // The kind is re-checked at runtime: a caller's ref is data, whatever its static type says.
  if (platform !== "instagram" || (kind as string) !== "asset" || account === undefined) throw new PermanentRejectedError(operation, "invalid_request");
  return account;
}

/** An IG Media object as a ContentDto: created by the managed account, classified by the closed table, else unreadable. */
function contentOfMedia(media: MetaInstagramMedia, account: ProviderObjectId, operation: ContentOperation): ContentDto {
  if (media.ownerId !== account) throw new PermanentRejectedError(operation, "unknown");
  const key = media.mediaType === null || media.mediaProductType === null ? undefined : `${media.mediaType}:${media.mediaProductType}`;
  const contentKind = key !== undefined && Object.hasOwn(META_INSTAGRAM_MEDIA_CONTENT_KINDS, key) ? META_INSTAGRAM_MEDIA_CONTENT_KINDS[key] : undefined;
  if (contentKind === undefined) throw new PermanentRejectedError(operation, "unknown");
  return Object.freeze({
    ref: providerObjectRef("instagram", "content", media.id),
    account: providerObjectRef("instagram", "asset", account),
    contentKind,
    reportedSource: "unknown",
    caption: media.caption,
    publishedAt: media.timestamp,
    availability: "available",
    timestamps: Object.freeze({ createdAt: media.timestamp, updatedAt: null }),
    rawReference: rawReference("meta", META_GRAPH_VERSION, `instagram:media:${media.id}`),
  });
}

async function listMedia(transport: MetaGraphTransport, access: ProviderAccess, window: TimeWindow, cursor: PageCursor | null): Promise<Page<ContentDto>> {
  const account = managedInstagramAccount(access, "listContent");
  const bounds = windowBounds(window);
  // The caller's cursor is the envelope a previous page returned: re-validated and decoded to the raw `after`, never a URL.
  if (cursor !== null && parsePageCursor(cursor) === undefined) throw new PermanentRejectedError("listContent", "invalid_cursor");
  const after: MetaGraphCursor | null = cursor === null ? null : decodeMetaPageCursor(cursor);
  // The sealed User Access Token, used directly: Instagram reads derive no Page token.
  const list = outcomeValue(await transport.listInstagramMedia(access.credential.secret, account, after), "listContent", "read_content");
  // Map EVERY media object first (one mismatch fails the whole page), then filter the window client-side.
  const items = list.media.map((media) => contentOfMedia(media, account, "listContent")).filter((item) => {
    const at = Date.parse(item.publishedAt ?? "");
    return at >= bounds.from && at < bounds.to;
  });
  if (list.after === null) return Object.freeze({ items: Object.freeze(items), next: Object.freeze({ kind: "end" as const }) });
  // Deterministic envelope: the same raw cursor yields the same PageCursor, so a repeat is detected here.
  const next = encodeMetaPageCursor(list.after);
  if (next === cursor) throw new PermanentRejectedError("listContent", "invalid_cursor");
  return Object.freeze({ items: Object.freeze(items), next: Object.freeze({ kind: "more" as const, cursor: next }) });
}

async function getMedia(transport: MetaGraphTransport, access: ProviderAccess, ref: ProviderObjectRef<"content">): Promise<ContentDto> {
  const account = managedInstagramAccount(access, "getContent");
  const mediaId = parseProviderObjectId(ref.id);
  if (ref.platform !== "instagram" || (ref.kind as string) !== "content" || mediaId === undefined) throw new PermanentRejectedError("getContent", "invalid_request");
  const outcome = await transport.getInstagramMedia(access.credential.secret, mediaId);
  if (outcome.kind === "graph_error" && outcome.error.code === AMBIGUOUS_OBJECT_CODE && outcome.error.subcode === AMBIGUOUS_OBJECT_SUBCODE) throw new TargetNotFoundError("getContent");
  return contentOfMedia(outcomeValue(outcome, "getContent", "read_content"), account, "getContent");
}

async function discover(transport: MetaGraphTransport, credential: ProviderCredential): Promise<readonly SocialAssetDto[]> {
  const token = credential.secret;

  // 1. Pages, paginated by validated cursor, bounded.
  const pageNames = new Map<ProviderObjectId, string>();
  const seenCursors = new Set<MetaGraphCursor>();
  let after: MetaGraphCursor | null = null;
  for (let page = 1; ; page += 1) {
    const list: MetaPageList = valueOf(await transport.listPages(token, after));
    for (const { id, name } of list.pages) if (!pageNames.has(id)) pageNames.set(id, name);
    if (list.after === null) break;
    if (page >= DISCOVER_ASSETS_MAX_PAGES) throw new PermanentRejectedError(OPERATION, "limit_exceeded");
    if (seenCursors.has(list.after)) throw new PermanentRejectedError(OPERATION, "invalid_cursor");
    seenCursors.add(list.after);
    after = list.after;
  }
  const pageIds = [...pageNames.keys()].sort(byId);

  // 2. Each Page's linked Instagram professional account.
  const pagesOfInstagram = new Map<ProviderObjectId, ProviderObjectId[]>();
  const instagramOfPage = new Map<ProviderObjectId, ProviderObjectId>();
  for (const pageId of pageIds) {
    const instagramId = valueOf(await transport.getPageInstagram(token, pageId));
    if (instagramId === null) continue;
    instagramOfPage.set(pageId, instagramId);
    pagesOfInstagram.set(instagramId, [...(pagesOfInstagram.get(instagramId) ?? []), pageId]);
  }
  const instagramIds = [...pagesOfInstagram.keys()].sort(byId);

  // 3. Each distinct Instagram account's username.
  const usernames = new Map<ProviderObjectId, string>();
  for (const instagramId of instagramIds) usernames.set(instagramId, valueOf(await transport.getInstagramAccount(token, instagramId)).username);

  // Only now, with every call succeeded, build the result.
  const pageRef = (id: ProviderObjectId): ProviderObjectRef<"asset"> => providerObjectRef("facebook", "asset", id);
  const instagramRef = (id: ProviderObjectId): ProviderObjectRef<"asset"> => providerObjectRef("instagram", "asset", id);
  const pages = pageIds.map((id): SocialAssetDto => {
    const linked = instagramOfPage.get(id);
    return Object.freeze({
      ref: pageRef(id),
      assetClass: "content_bearing",
      displayName: pageNames.get(id) ?? "",
      relatedAssets: Object.freeze(linked === undefined ? [] : [instagramRef(linked)]),
      rawReference: rawReference("meta", META_GRAPH_VERSION, `facebook:page:${id}`),
    });
  });
  const accounts = instagramIds.map((id): SocialAssetDto =>
    Object.freeze({
      ref: instagramRef(id),
      assetClass: "content_bearing",
      displayName: usernames.get(id) ?? "",
      relatedAssets: Object.freeze([...new Set(pagesOfInstagram.get(id))].sort(byId).map(pageRef)),
      rawReference: rawReference("meta", META_GRAPH_VERSION, `instagram:account:${id}`),
    }),
  );
  // Platform order ("facebook" < "instagram"), then id: both lists are already id-sorted.
  return Object.freeze([...pages, ...accounts]);
}

// ── read_interactions (Step 7G-H5.5-P12-B1) ─────────────────────────────────────────────────────────────────

/** The content item a listInteractions scope names, on the managed account's platform; anything else is refused before any request. */
function scopedContent(content: ProviderObjectRef<"content">, platform: "facebook" | "instagram"): ProviderObjectId {
  const id = parseProviderObjectId(content.id);
  // The kind is re-checked at runtime: a caller's ref is data, whatever its static type says.
  if (content.platform !== platform || (content.kind as string) !== "content" || id === undefined) throw new PermanentRejectedError("listInteractions", "invalid_request");
  return id;
}

/** The interaction a getInteraction ref names, on the managed account's platform; anything else is refused before any request. */
function requestedInteraction(ref: ProviderObjectRef<"interaction">, platform: "facebook" | "instagram"): ProviderObjectId {
  const id = parseProviderObjectId(ref.id);
  if (ref.platform !== platform || (ref.kind as string) !== "interaction" || id === undefined) throw new PermanentRejectedError("getInteraction", "invalid_request");
  return id;
}

/** Visibility only from the reported boolean: absent is unknown, never assumed visible. */
const visibilityOf = (hidden: boolean | null): InteractionDto["visibility"] => (hidden === null ? "unknown" : hidden ? "hidden" : "visible");

/** Keeps the interactions created in [from, to): client-side, no ordering assumed, every item already mapped. */
const createdWithin = (items: readonly InteractionDto[], bounds: { readonly from: number; readonly to: number }): readonly InteractionDto[] =>
  items.filter((item) => {
    const at = Date.parse(item.timestamps.createdAt ?? "");
    return at >= bounds.from && at < bounds.to;
  });

/** One provider page as the port's Page: `end` when Graph reports no next page, else the `meta1.` envelope (a repeat fails closed). */
function interactionPage(items: readonly InteractionDto[], after: MetaGraphCursor | null, cursor: PageCursor | null): Page<InteractionDto> {
  if (after === null) return Object.freeze({ items: Object.freeze([...items]), next: Object.freeze({ kind: "end" as const }) });
  const next = encodeMetaPageCursor(after, "listInteractions");
  if (next === cursor) throw new PermanentRejectedError("listInteractions", "invalid_cursor");
  return Object.freeze({ items: Object.freeze([...items]), next: Object.freeze({ kind: "more" as const, cursor: next }) });
}

/**
 * A Facebook comment as an InteractionDto on `post`: a reply exactly when Graph reports `parent.id` (a comment that
 * names itself as its parent is unreadable); the author is the Page itself exactly when `from.id` is the managed Page.
 */
function interactionOfComment(comment: MetaComment, post: ProviderObjectId, page: ProviderObjectId, operation: InteractionOperation): InteractionDto {
  if (comment.parentId === comment.id) throw new PermanentRejectedError(operation, "unknown");
  return Object.freeze({
    ref: providerObjectRef("facebook", "interaction", comment.id),
    content: providerObjectRef("facebook", "content", post),
    parent: comment.parentId === null ? null : providerObjectRef("facebook", "interaction", comment.parentId),
    interactionKind: comment.parentId === null ? "comment" : "reply",
    author: Object.freeze({
      ref: providerObjectRef("facebook", "author", comment.fromId),
      role: comment.fromId === page ? "account_identity" : "user",
      displayName: comment.fromName,
      handle: null,
    }),
    text: comment.message,
    textRevision: null,
    editedAt: null,
    visibility: visibilityOf(comment.isHidden),
    availability: "available",
    timestamps: Object.freeze({ createdAt: comment.createdTime, updatedAt: null }),
    rawReference: rawReference("meta", META_GRAPH_VERSION, `facebook:comment:${comment.id}`),
  });
}

async function listPageComments(transport: MetaGraphTransport, access: ProviderAccess, content: ProviderObjectRef<"content">, window: TimeWindow, cursor: PageCursor | null): Promise<Page<InteractionDto>> {
  const page = managedPage(access, "listInteractions");
  const post = scopedContent(content, "facebook");
  const bounds = windowBounds(window, "listInteractions");
  if (cursor !== null && parsePageCursor(cursor) === undefined) throw new PermanentRejectedError("listInteractions", "invalid_cursor");
  const after: MetaGraphCursor | null = cursor === null ? null : decodeMetaPageCursor(cursor, "listInteractions");
  const token = await pageToken(transport, access, page, "listInteractions");
  const list = outcomeValue(await transport.listPostComments(token, post, after), "listInteractions", "read_interactions");
  // Map EVERY comment first (one malformed comment fails the whole page), then filter the window client-side.
  const items = list.comments.map((comment) => interactionOfComment(comment, post, page, "listInteractions"));
  return interactionPage(createdWithin(items, bounds), list.after, cursor);
}

/** Why a Facebook comment node has no content authority, as a closed diagnostic; null when `object.id` is usable. */
function contentAuthorityProblem(comment: MetaComment): PermanentRejectionDiagnostic | null {
  if (comment.objectState === "malformed") return "interaction_content_malformed";
  if (comment.objectState === "id_missing") return "interaction_content_id_missing";
  if (comment.objectId === null) return "interaction_content_missing";
  if (comment.objectId === comment.id) return "interaction_content_equals_interaction";
  if (comment.objectId === comment.parentId) return "interaction_content_equals_parent";
  return null;
}

async function getPageComment(transport: MetaGraphTransport, access: ProviderAccess, ref: ProviderObjectRef<"interaction">): Promise<InteractionDto> {
  const page = managedPage(access, "getInteraction");
  const commentId = requestedInteraction(ref, "facebook");
  const token = await pageToken(transport, access, page, "getInteraction");
  const outcome = await transport.getComment(token, commentId);
  if (outcome.kind === "graph_error" && outcome.error.code === AMBIGUOUS_OBJECT_CODE && outcome.error.subcode === AMBIGUOUS_OBJECT_SUBCODE) throw new TargetNotFoundError("getInteraction");
  // An unreadable node (any field other than `object`) is the same refusal as before, now named (Step 7G-H5.5-P12-C6).
  if (outcome.kind === "unreadable") throw new PermanentRejectedError("getInteraction", "unknown", "interaction_node_unreadable");
  const comment = outcomeValue(outcome, "getInteraction", "read_interactions");
  // `object.id` is the node's only content authority: without it, or when it names the parent comment or the comment
  // itself, the content cannot be established — fail closed rather than guess a post. The refusal names which case it
  // was (a closed diagnostic, never the id); the code, kind and handling are unchanged.
  const authority = contentAuthorityProblem(comment);
  if (authority !== null || comment.objectId === null) throw new PermanentRejectedError("getInteraction", "unknown", authority ?? "interaction_content_missing");
  return interactionOfComment(comment, comment.objectId, page, "getInteraction");
}

/**
 * An IG Comment as an InteractionDto on `media`: top-level only in this slice (a `parent_id` is unreadable, never a
 * reply), and a reported `media.id` must be that media; the author is the account itself exactly when `from.id` is the
 * managed account.
 */
function interactionOfInstagramComment(comment: MetaInstagramComment, media: ProviderObjectId, account: ProviderObjectId, operation: InteractionOperation): InteractionDto {
  if (comment.parentId !== null) throw new PermanentRejectedError(operation, "unknown");
  if (comment.mediaId !== null && comment.mediaId !== media) throw new PermanentRejectedError(operation, "unknown");
  return Object.freeze({
    ref: providerObjectRef("instagram", "interaction", comment.id),
    content: providerObjectRef("instagram", "content", media),
    parent: null,
    interactionKind: "comment",
    author: Object.freeze({
      ref: providerObjectRef("instagram", "author", comment.fromId),
      role: comment.fromId === account ? "account_identity" : "user",
      displayName: null,
      handle: comment.fromUsername,
    }),
    text: comment.text,
    textRevision: null,
    editedAt: null,
    visibility: visibilityOf(comment.hidden),
    availability: "available",
    timestamps: Object.freeze({ createdAt: comment.timestamp, updatedAt: null }),
    rawReference: rawReference("meta", META_GRAPH_VERSION, `instagram:comment:${comment.id}`),
  });
}

async function listMediaComments(transport: MetaGraphTransport, access: ProviderAccess, content: ProviderObjectRef<"content">, window: TimeWindow, cursor: PageCursor | null): Promise<Page<InteractionDto>> {
  const account = managedInstagramAccount(access, "listInteractions");
  const media = scopedContent(content, "instagram");
  const bounds = windowBounds(window, "listInteractions");
  if (cursor !== null && parsePageCursor(cursor) === undefined) throw new PermanentRejectedError("listInteractions", "invalid_cursor");
  const after: MetaGraphCursor | null = cursor === null ? null : decodeMetaPageCursor(cursor, "listInteractions");
  // The sealed User Access Token, used directly: Instagram reads derive no Page token.
  const list = outcomeValue(await transport.listInstagramComments(access.credential.secret, media, after), "listInteractions", "read_interactions");
  const items = list.comments.map((comment) => interactionOfInstagramComment(comment, media, account, "listInteractions"));
  return interactionPage(createdWithin(items, bounds), list.after, cursor);
}

async function getMediaComment(transport: MetaGraphTransport, access: ProviderAccess, ref: ProviderObjectRef<"interaction">): Promise<InteractionDto> {
  const account = managedInstagramAccount(access, "getInteraction");
  const commentId = requestedInteraction(ref, "instagram");
  const outcome = await transport.getInstagramComment(access.credential.secret, commentId);
  if (outcome.kind === "graph_error" && outcome.error.code === AMBIGUOUS_OBJECT_CODE && outcome.error.subcode === AMBIGUOUS_OBJECT_SUBCODE) throw new TargetNotFoundError("getInteraction");
  const comment = outcomeValue(outcome, "getInteraction", "read_interactions");
  // `media.id` is the node's only content authority: without it the comment cannot be placed.
  if (comment.mediaId === null) throw new PermanentRejectedError("getInteraction", "unknown", "interaction_content_missing");
  return interactionOfInstagramComment(comment, comment.mediaId, account, "getInteraction");
}

/** Only one known content item at a time: an account-wide comment feed is not offered on any platform. */
function contentOfScope(scope: InteractionScope): ProviderObjectRef<"content"> {
  if (scope.kind === "account") throw new TargetNotEligibleError("listInteractions", "unsupported_for_target");
  if ((scope.kind as string) !== "content") throw new PermanentRejectedError("listInteractions", "invalid_request");
  return scope.content;
}

export function createMetaReadPort(options: MetaReadPortOptions = {}): ProviderReadPort {
  const transport = options.transport ?? createMetaGraphTransport();
  const clock = options.clock ?? (() => new Date());
  const refuse = (operation: Exclude<ReadOperation, "discoverAssets" | "describeAccount" | "listContent" | "getContent" | "listInteractions" | "getInteraction" | "parseWebhook">): Promise<never> =>
    Promise.reject(new PermanentRejectedError(operation, "invalid_request"));

  return Object.freeze({
    provider: "meta",

    async discoverAssets(credential) {
      return Object.freeze({ data: await discover(transport, credential), budget: BUDGET_NOT_REPORTED });
    },

    async describeAccount(access) {
      return Object.freeze({ data: await describe(transport, access, clock()), budget: BUDGET_NOT_REPORTED });
    },
    // The account's platform selects the branch; every platform but Instagram takes the Facebook Page path, which
    // refuses anything that is not a Facebook Page before any request.
    async listContent(access, window, cursor) {
      const page = access.account.platform === "instagram" ? await listMedia(transport, access, window, cursor) : await listPublished(transport, access, window, cursor);
      return Object.freeze({ data: page, budget: BUDGET_NOT_REPORTED });
    },

    async getContent(access, ref) {
      const content = access.account.platform === "instagram" ? await getMedia(transport, access, ref) : await getPublished(transport, access, ref);
      return Object.freeze({ data: content, budget: BUDGET_NOT_REPORTED });
    },
    // The same platform selection: Instagram reads top-level media comments; every other platform takes the Facebook
    // Page path (comments and replies), which refuses anything that is not a Facebook Page before any request.
    async listInteractions(access, scope, window, cursor) {
      const content = contentOfScope(scope);
      const page = access.account.platform === "instagram" ? await listMediaComments(transport, access, content, window, cursor) : await listPageComments(transport, access, content, window, cursor);
      return Object.freeze({ data: page, budget: BUDGET_NOT_REPORTED });
    },

    async getInteraction(access, ref) {
      const interaction = access.account.platform === "instagram" ? await getMediaComment(transport, access, ref) : await getPageComment(transport, access, ref);
      return Object.freeze({ data: interaction, budget: BUDGET_NOT_REPORTED });
    },
    getCurrentState: () => refuse("getCurrentState"),
    retrievePaidContext: () => refuse("retrievePaidContext"),
    parseWebhook: () => Promise.reject(new WebhookRejectedError("invalid_signature")),
    subscribe: () => refuse("subscribe"),
    unsubscribe: () => refuse("unsubscribe"),
    refreshCredential: () => refuse("refreshCredential"),
  } satisfies ProviderReadPort);
}
