/**
 * The Meta Graph READ transport for discoverAssets (Step 7G-E; design/phase-7g/meta-provider/README.md, E1 — the
 * implementation authority), describeAccount (Step 7G-H5.5, contract H55), Facebook Page read_content (Step
 * 7G-H5.5-P5-B, README › read_content), Instagram professional-account read_content (Step 7G-H5.5-P11-B, README ›
 * Instagram read_content) and Meta read_interactions (Step 7G-H5.5-P12-B1, README › read_interactions). Fourteen typed
 * operations, nothing else:
 *
 *   listPages            GET https://graph.facebook.com/v25.0/me/accounts?fields=id,name[&after={cursor}]
 *   getPageInstagram     GET https://graph.facebook.com/v25.0/{page-id}?fields=instagram_business_account
 *   getInstagramAccount  GET https://graph.facebook.com/v25.0/{ig-user-id}?fields=id,username
 *   getPage              GET https://graph.facebook.com/v25.0/{page-id}?fields=id,name
 *   listPermissions      GET https://graph.facebook.com/v25.0/me/permissions?fields=permission,status
 *   getPageAccessToken   GET https://graph.facebook.com/v25.0/{page-id}?fields=access_token            (User token)
 *   listPublishedPosts   GET https://graph.facebook.com/v25.0/{page-id}/published_posts?fields=META_POST_FIELDS
 *                            &limit=META_PUBLISHED_POSTS_PAGE_LIMIT[&after={cursor}]                  (Page token)
 *   getPost              GET https://graph.facebook.com/v25.0/{post-id}?fields=META_POST_FIELDS        (Page token)
 *   listInstagramMedia   GET https://graph.facebook.com/v25.0/{ig-user-id}/media?fields=META_INSTAGRAM_MEDIA_FIELDS
 *                            &limit=META_INSTAGRAM_MEDIA_PAGE_LIMIT[&after={cursor}]                  (User token)
 *   getInstagramMedia    GET https://graph.facebook.com/v25.0/{ig-media-id}?fields=META_INSTAGRAM_MEDIA_FIELDS (User token)
 *   listPostComments     GET https://graph.facebook.com/v25.0/{post-id}/comments?fields=META_FACEBOOK_COMMENT_FIELDS
 *                            &filter=stream&limit=META_FACEBOOK_COMMENTS_PAGE_LIMIT[&after={cursor}] (Page token)
 *   getComment           GET https://graph.facebook.com/v25.0/{comment-id}?fields=META_FACEBOOK_COMMENT_NODE_FIELDS
 *                                                                                                   (Page token)
 *   listInstagramComments GET https://graph.facebook.com/v25.0/{ig-media-id}/comments?fields=META_INSTAGRAM_COMMENT_FIELDS
 *                            &limit=META_INSTAGRAM_COMMENTS_PAGE_LIMIT[&after={cursor}]               (User token)
 *   getInstagramComment  GET https://graph.facebook.com/v25.0/{ig-comment-id}?fields=META_INSTAGRAM_COMMENT_FIELDS
 *                                                                                                   (User token)
 *
 * Callers name an operation and pass a SecretValue token plus validated provider ids or a validated cursor — never a
 * URL. Meta documents the access token as the `access_token` query parameter for these exact endpoints, so the
 * request URL is sensitive: this is the approved, documented provider exception (QUERY_PARAMETER, Meta Graph reads
 * only). The URL is built here, handed to `fetch`, and never logged, thrown, returned or serialized; `response.url`,
 * raw fetch errors and raw bodies never leave this module. Each operation makes exactly ONE request: no retry, no
 * redirect (`manual`, any 3xx refused), no cookies, no Authorization header, a finite timeout over the whole exchange
 * and a bounded body. Never the App Secret, the Client Token or appsecret_proof.
 *
 * Bodies are parsed here by whitelist into closed results; only the fields the contract maps are read. The ONE
 * exception is getPageAccessToken: its `access_token` is read into a SecretValue (never a plain string field of any
 * result) and handed to the caller for the immediately following content read inside the same credential use; every
 * other operation ignores a stray `access_token`. A provider id is used in a later path only after the provider-id rule,
 * as one encoded path segment. Results: the parsed value, the closed fields of a Graph error, `transient` (no
 * response, timeout, or a 5xx without a Graph error — reads have no effect, so these are retryable by the task) or
 * `unreadable` (redirect, oversized, not UTF-8 JSON, or a body that is not the documented shape).
 */
import { SecretValue } from "../contract/credential";
import { isoInstant, parseProviderObjectId, type IsoInstant, type ProviderObjectId } from "../contract/identity";
import { META_GRAPH_ORIGIN, META_GRAPH_VERSION } from "./endpoints";
import { graphErrorFields, type MetaGraphErrorFields } from "./errors";

/** The same reviewed bounds as the token exchange: the whole request within 10 s, at most 64 KiB of body. */
export const META_GRAPH_TIMEOUT_MS = 10_000;
export const META_GRAPH_RESPONSE_MAX_BYTES = 64 * 1024;

declare const cursorBrand: unique symbol;
/** An opaque Graph pagination cursor: printable ASCII without whitespace, bounded. Never a URL, never stored. */
export type MetaGraphCursor = string & { readonly [cursorBrand]: true };
/** The longest raw Graph cursor accepted (printable ASCII, no whitespace). */
export const META_GRAPH_CURSOR_MAX_LENGTH = 1024;
const CURSOR = new RegExp(`^[\\x21-\\x7E]{1,${String(META_GRAPH_CURSOR_MAX_LENGTH)}}$`);

export function parseMetaGraphCursor(value: unknown): MetaGraphCursor | undefined {
  return typeof value === "string" && CURSOR.test(value) ? (value as MetaGraphCursor) : undefined;
}

export interface MetaPage {
  readonly id: ProviderObjectId;
  /** As reported; "" when absent (the application's display-name fallback applies). */
  readonly name: string;
}

export type MetaGraphOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "graph_error"; readonly error: MetaGraphErrorFields }
  | { readonly kind: "transient"; readonly reason: "network" | "server_error" }
  | { readonly kind: "unreadable" };

export interface MetaPageList {
  readonly pages: readonly MetaPage[];
  /** The next page's cursor, or null when the provider reports no next page. */
  readonly after: MetaGraphCursor | null;
}

/**
 * The minimum Page-post fields Facebook read_content maps (P5-A/P5-B; README › read_content): never `attachments`,
 * `full_picture`, `permalink_url`, `story`, insights or metrics. `from` is read for its `id` only (its `name` is never
 * kept).
 */
export const META_POST_FIELDS = "id,from,message,created_time,updated_time,status_type";
/** One provider page of `published_posts`: fixed, small enough that ordinary posts fit the 64 KiB body bound. */
export const META_PUBLISHED_POSTS_PAGE_LIMIT = 10;

/** One Page post exactly as the whitelist reads it: closed fields, nothing else from the body. */
export interface MetaPost {
  readonly id: ProviderObjectId;
  /** `from.id`: the publishing identity (the read port requires it to be the managed Page). */
  readonly fromId: ProviderObjectId;
  /** `message` as reported; null when absent. Untrusted text. */
  readonly message: string | null;
  readonly createdTime: IsoInstant;
  /** null when absent. */
  readonly updatedTime: IsoInstant | null;
  /** `status_type` as reported (a bounded lower-case token), null when absent; classified by the read port only. */
  readonly statusType: string | null;
}

export interface MetaPostList {
  readonly posts: readonly MetaPost[];
  /** The next page's cursor, or null when the provider reports no next page (`paging.next` absent). */
  readonly after: MetaGraphCursor | null;
}

/**
 * The minimum IG Media fields Instagram read_content maps (P11-A/P11-B; README › Instagram read_content), shared by the
 * `/media` edge and the media node read: never a media URL, thumbnail, permalink, children, counts, metrics or boost
 * data. `owner` is read for its `id` only.
 */
export const META_INSTAGRAM_MEDIA_FIELDS = "id,media_type,media_product_type,timestamp,caption,owner";
/** One provider page of `{ig-user-id}/media`: fixed, the same size as the Page-post page. */
export const META_INSTAGRAM_MEDIA_PAGE_LIMIT = 10;

/** One IG Media object exactly as the whitelist reads it: closed fields, nothing else from the body. */
export interface MetaInstagramMedia {
  readonly id: ProviderObjectId;
  /** `owner.id`: the account that created the media (the read port requires it to be the managed account). */
  readonly ownerId: ProviderObjectId;
  /** `caption` as reported; null when absent. Untrusted text. */
  readonly caption: string | null;
  /** `timestamp` (ISO 8601 in UTC): the creation instant. */
  readonly timestamp: IsoInstant;
  /** `media_type` as reported (a bounded upper-case token), null when absent; classified by the read port only. */
  readonly mediaType: string | null;
  /** `media_product_type` as reported (a bounded upper-case token), null when absent; classified by the read port only. */
  readonly mediaProductType: string | null;
}

export interface MetaInstagramMediaList {
  readonly media: readonly MetaInstagramMedia[];
  /** The next page's cursor, or null when the provider reports no next page (`paging.next` absent). */
  readonly after: MetaGraphCursor | null;
}

/**
 * The minimum comment fields Facebook read_interactions maps on the `{post-id}/comments` edge (P12-A/P12-B1; README ›
 * read_interactions): never attachments, likes, reactions, mentions, permalinks, counts or private-reply data. `from`
 * is read for its `id` and `name`, `parent` for its `id` only. `is_hidden` is a LIVE-verify field: when Graph omits it
 * the visibility is unknown, never assumed.
 */
export const META_FACEBOOK_COMMENT_FIELDS = "id,from,message,created_time,parent,is_hidden";
/** The comment node read adds `object` (the commented object, read for its `id` only; LIVE-verify): the node's only content authority. */
export const META_FACEBOOK_COMMENT_NODE_FIELDS = "id,from,message,created_time,parent,is_hidden,object";
/** One provider page of `{post-id}/comments`: fixed, the same size as the content pages. */
export const META_FACEBOOK_COMMENTS_PAGE_LIMIT = 10;

/** One Facebook comment exactly as the whitelist reads it: closed fields, nothing else from the body. */
export interface MetaComment {
  readonly id: ProviderObjectId;
  /** `from.id`: the author (required; a comment without one is not the documented shape). */
  readonly fromId: ProviderObjectId;
  /** `from.name` as reported; null when absent. Untrusted text. */
  readonly fromName: string | null;
  /** `message` as reported (required; "" only when Graph says ""). Untrusted text. */
  readonly message: string;
  readonly createdTime: IsoInstant;
  /** `parent.id`: the comment this one replies to; null when absent (a top-level comment). */
  readonly parentId: ProviderObjectId | null;
  /** `is_hidden` as reported; null when absent. */
  readonly isHidden: boolean | null;
  /** `object.id` on the node read only (the edge never requests it); null when absent. */
  readonly objectId: ProviderObjectId | null;
}

export interface MetaCommentList {
  readonly comments: readonly MetaComment[];
  /** The next page's cursor, or null when the provider reports no next page (`paging.next` absent). */
  readonly after: MetaGraphCursor | null;
}

/**
 * The minimum IG Comment fields Instagram read_interactions maps (P12-A/P12-B1; README › read_interactions), shared by
 * the `{ig-media-id}/comments` edge and the comment node read: never `replies`, `like_count`, `user` or
 * `legacy_instagram_comment_id`, never a field expansion. `from` is read for its `id` and `username`, `media` for its
 * `id` only. `parent_id` is read only to refuse replies in this first slice.
 */
export const META_INSTAGRAM_COMMENT_FIELDS = "id,from,text,timestamp,parent_id,hidden,media";
/** One provider page of `{ig-media-id}/comments`: fixed, the same size as the content pages. */
export const META_INSTAGRAM_COMMENTS_PAGE_LIMIT = 10;

/** One IG Comment exactly as the whitelist reads it: closed fields, nothing else from the body. */
export interface MetaInstagramComment {
  readonly id: ProviderObjectId;
  /** `from.id`: the author (required). */
  readonly fromId: ProviderObjectId;
  /** `from.username` as reported; null when absent. Untrusted text. */
  readonly fromUsername: string | null;
  /** `text` as reported (required). Untrusted text. */
  readonly text: string;
  readonly timestamp: IsoInstant;
  /** `parent_id` as reported; null when absent. */
  readonly parentId: ProviderObjectId | null;
  /** `hidden` as reported; null when absent. */
  readonly hidden: boolean | null;
  /** `media.id`: the commented media; null when absent. */
  readonly mediaId: ProviderObjectId | null;
}

export interface MetaInstagramCommentList {
  readonly comments: readonly MetaInstagramComment[];
  /** The next page's cursor, or null when the provider reports no next page (`paging.next` absent). */
  readonly after: MetaGraphCursor | null;
}

export interface MetaGraphTransport {
  listPages(token: SecretValue, after: MetaGraphCursor | null): Promise<MetaGraphOutcome<MetaPageList>>;
  /** The linked Instagram professional account id, or null when the Page has none. */
  getPageInstagram(token: SecretValue, pageId: ProviderObjectId): Promise<MetaGraphOutcome<ProviderObjectId | null>>;
  /** The account's username as reported ("" when absent). */
  getInstagramAccount(token: SecretValue, instagramId: ProviderObjectId): Promise<MetaGraphOutcome<{ readonly username: string }>>;
  /** The Page node itself, its echoed id checked; the name as reported ("" when absent). */
  getPage(token: SecretValue, pageId: ProviderObjectId): Promise<MetaGraphOutcome<{ readonly name: string }>>;
  /** The permissions the user granted to the app: only `status = "granted"` entries, sorted and distinct. */
  listPermissions(token: SecretValue): Promise<MetaGraphOutcome<readonly string[]>>;
  /**
   * The Page Access Token derived from the User Access Token (P5-B): a NEW SecretValue, never persisted, cached,
   * logged or serialized; an echoed `id`, when present, must be the requested Page.
   */
  getPageAccessToken(userToken: SecretValue, pageId: ProviderObjectId): Promise<MetaGraphOutcome<SecretValue>>;
  /** ONE page of the Page's published posts (Page token); the `next` URL is never fetched. */
  listPublishedPosts(pageToken: SecretValue, pageId: ProviderObjectId, after: MetaGraphCursor | null): Promise<MetaGraphOutcome<MetaPostList>>;
  /** One post node (Page token), its echoed id checked. */
  getPost(pageToken: SecretValue, postId: ProviderObjectId): Promise<MetaGraphOutcome<MetaPost>>;
  /** ONE page of the Instagram account's `/media` edge (User token, no derivation); the `next` URL is never fetched. */
  listInstagramMedia(userToken: SecretValue, instagramId: ProviderObjectId, after: MetaGraphCursor | null): Promise<MetaGraphOutcome<MetaInstagramMediaList>>;
  /** One IG Media node (User token), its echoed id checked. */
  getInstagramMedia(userToken: SecretValue, mediaId: ProviderObjectId): Promise<MetaGraphOutcome<MetaInstagramMedia>>;
  /** ONE page of a Page post's comments and replies (`filter=stream`, Page token); the `next` URL is never fetched. */
  listPostComments(pageToken: SecretValue, postId: ProviderObjectId, after: MetaGraphCursor | null): Promise<MetaGraphOutcome<MetaCommentList>>;
  /** One Facebook comment node (Page token), its echoed id checked. */
  getComment(pageToken: SecretValue, commentId: ProviderObjectId): Promise<MetaGraphOutcome<MetaComment>>;
  /** ONE page of an IG Media's top-level comments (User token, no derivation); the `next` URL is never fetched. */
  listInstagramComments(userToken: SecretValue, mediaId: ProviderObjectId, after: MetaGraphCursor | null): Promise<MetaGraphOutcome<MetaInstagramCommentList>>;
  /** One IG Comment node (User token), its echoed id checked. */
  getInstagramComment(userToken: SecretValue, commentId: ProviderObjectId): Promise<MetaGraphOutcome<MetaInstagramComment>>;
}

/** A Meta permission name: lower-case identifier, bounded. Anything else is an unreadable response, never kept. */
const PERMISSION_NAME = /^[a-z][a-z0-9_]{0,99}$/;
const PERMISSION_STATUSES = ["granted", "declined", "expired"] as const;
/** More entries than any real grant set: a larger list is not the documented shape. */
export const META_PERMISSIONS_MAX_ENTRIES = 256;

export type MetaGraphFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface MetaGraphTransportOptions {
  readonly fetch?: MetaGraphFetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

const UNREADABLE = Object.freeze({ kind: "unreadable" as const });
const ok = <T>(value: T): MetaGraphOutcome<T> => Object.freeze({ kind: "ok", value });

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** A display string as reported: absent → "", a string → itself, anything else → undefined (malformed). */
const displayString = (value: unknown): string | undefined => (value === undefined ? "" : typeof value === "string" ? value : undefined);

/** The response body as UTF-8 text, or undefined when it exceeds the bound or isn't valid UTF-8. */
async function boundedText(response: Response, maxBytes: number): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return undefined;
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** `/me/accounts` page: only `data[].id`, `data[].name`, `paging.next` (presence) and `paging.cursors.after`. */
function pageListOf(body: unknown): MetaPageList | undefined {
  const root = record(body);
  if (root === undefined || !Array.isArray(root["data"])) return undefined;
  const pages: MetaPage[] = [];
  for (const item of root["data"] as readonly unknown[]) {
    const page = record(item);
    const id = parseProviderObjectId(page?.["id"]);
    const name = displayString(page?.["name"]);
    if (page === undefined || id === undefined || name === undefined) return undefined;
    pages.push(Object.freeze({ id, name }));
  }
  const paging = root["paging"];
  if (paging === undefined) return Object.freeze({ pages: Object.freeze(pages), after: null });
  const pagingRecord = record(paging);
  if (pagingRecord === undefined) return undefined;
  const next = pagingRecord["next"];
  if (next === undefined) return Object.freeze({ pages: Object.freeze(pages), after: null });
  // `next` only signals that another page exists; it is never read as a URL or fetched.
  if (typeof next !== "string" || next === "") return undefined;
  const after = parseMetaGraphCursor(record(pagingRecord["cursors"])?.["after"]);
  return after === undefined ? undefined : Object.freeze({ pages: Object.freeze(pages), after });
}

/** `{page-id}?fields=instagram_business_account`: the echoed id must be the requested one. */
function pageInstagramOf(body: unknown, pageId: ProviderObjectId): { readonly id: ProviderObjectId | null } | undefined {
  const root = record(body);
  if (root === undefined || root["id"] !== pageId) return undefined;
  const linked = root["instagram_business_account"];
  if (linked === undefined) return { id: null };
  const id = parseProviderObjectId(record(linked)?.["id"]);
  return id === undefined ? undefined : { id };
}

/** `{ig-user-id}?fields=id,username`: the echoed id must be the requested one. */
function instagramAccountOf(body: unknown, instagramId: ProviderObjectId): { readonly username: string } | undefined {
  const root = record(body);
  if (root === undefined || root["id"] !== instagramId) return undefined;
  const username = displayString(root["username"]);
  return username === undefined ? undefined : Object.freeze({ username });
}

/** `{page-id}?fields=id,name`: the echoed id must be the requested one. */
function pageOf(body: unknown, pageId: ProviderObjectId): { readonly name: string } | undefined {
  const root = record(body);
  if (root === undefined || root["id"] !== pageId) return undefined;
  const name = displayString(root["name"]);
  return name === undefined ? undefined : Object.freeze({ name });
}

/**
 * `me/permissions?fields=permission,status`: `data[]` of `{permission, status ∈ granted|declined|expired}` (R12). One
 * page only: the permissions of one app grant fit it, so a response that reports a next page is not trusted as complete
 * (unreadable, never a silently truncated grant set). Only granted names are returned.
 */
function permissionsOf(body: unknown): readonly string[] | undefined {
  const root = record(body);
  if (root === undefined || !Array.isArray(root["data"])) return undefined;
  const data = root["data"] as readonly unknown[];
  if (data.length > META_PERMISSIONS_MAX_ENTRIES) return undefined;
  const paging = root["paging"];
  if (paging !== undefined && (record(paging) === undefined || record(paging)?.["next"] !== undefined)) return undefined;
  const granted = new Set<string>();
  for (const item of data) {
    const entry = record(item);
    const permission = entry?.["permission"];
    const status = entry?.["status"];
    if (typeof permission !== "string" || !PERMISSION_NAME.test(permission)) return undefined;
    if (typeof status !== "string" || !(PERMISSION_STATUSES as readonly string[]).includes(status)) return undefined;
    if (status === "granted") granted.add(permission);
  }
  return Object.freeze([...granted].sort());
}

/** A Page Access Token as reported: printable ASCII, no whitespace, bounded. Anything else is unreadable. */
const PAGE_ACCESS_TOKEN = /^[\x21-\x7E]{1,4096}$/;

/** `{page-id}?fields=access_token`: a non-empty token; an echoed id, when present, must be the requested Page. */
function pageAccessTokenOf(body: unknown, pageId: ProviderObjectId): SecretValue | undefined {
  const root = record(body);
  if (root === undefined) return undefined;
  if (root["id"] !== undefined && root["id"] !== pageId) return undefined;
  const token = root["access_token"];
  return typeof token === "string" && PAGE_ACCESS_TOKEN.test(token) ? new SecretValue(token) : undefined;
}

/** A Graph `status_type`: a bounded lower-case token (classification is the read port's, against a closed table). */
const STATUS_TYPE = /^[a-z][a-z_]{0,63}$/;
/** Graph's default datetime form (`2026-10-01T12:00:00+0000`); a colon offset or `Z` is accepted, nothing else. */
const GRAPH_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:Z|([+-])(\d{2}):?(\d{2}))$/;

/** A Graph datetime as a UTC instant, or undefined when it is not a real calendar instant of that form. */
export function parseGraphDatetime(value: unknown): IsoInstant | undefined {
  if (typeof value !== "string") return undefined;
  const match = GRAPH_DATETIME.exec(value);
  if (match === null) return undefined;
  // An unmatched optional group (the `Z` form has no offset) is undefined at runtime.
  const [, y, mo, d, h, mi, s, sign, oh, om] = Array.from(match, (part: string | undefined) => part ?? "");
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number) as [number, number, number, number, number, number];
  const offsetMinutes = sign === "" ? 0 : (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om));
  if (hour > 23 || minute > 59 || second > 59 || Number(oh) > 23 || Number(om) > 59) return undefined;
  const local = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(local);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined;
  return isoInstant(new Date(local - offsetMinutes * 60_000));
}

/** One post node by whitelist: id, from.id, message, created_time, updated_time, status_type. */
function postOf(value: unknown): MetaPost | undefined {
  const post = record(value);
  if (post === undefined) return undefined;
  const id = parseProviderObjectId(post["id"]);
  const fromId = parseProviderObjectId(record(post["from"])?.["id"]);
  const message = post["message"] === undefined ? null : typeof post["message"] === "string" ? post["message"] : undefined;
  const createdTime = parseGraphDatetime(post["created_time"]);
  const updatedTime = post["updated_time"] === undefined ? null : parseGraphDatetime(post["updated_time"]);
  const statusType = post["status_type"] === undefined ? null : typeof post["status_type"] === "string" && STATUS_TYPE.test(post["status_type"]) ? post["status_type"] : undefined;
  if (id === undefined || fromId === undefined || message === undefined || createdTime === undefined || updatedTime === undefined || statusType === undefined) return undefined;
  return Object.freeze({ id, fromId, message, createdTime, updatedTime, statusType });
}

/**
 * `{page-id}/published_posts`: `data[]` of posts (whitelist), `paging.next` (presence only) and `paging.cursors.after`.
 * More entries than the requested limit is not the documented shape. `next` present without a valid `after` fails.
 */
function postListOf(body: unknown): MetaPostList | undefined {
  const root = record(body);
  if (root === undefined || !Array.isArray(root["data"])) return undefined;
  const data = root["data"] as readonly unknown[];
  if (data.length > META_PUBLISHED_POSTS_PAGE_LIMIT) return undefined;
  const posts: MetaPost[] = [];
  for (const item of data) {
    const post = postOf(item);
    if (post === undefined) return undefined;
    posts.push(post);
  }
  const paging = root["paging"];
  if (paging === undefined) return Object.freeze({ posts: Object.freeze(posts), after: null });
  const pagingRecord = record(paging);
  if (pagingRecord === undefined) return undefined;
  const next = pagingRecord["next"];
  if (next === undefined) return Object.freeze({ posts: Object.freeze(posts), after: null });
  // `next` only signals that another page exists; it is never read as a URL or fetched.
  if (typeof next !== "string" || next === "") return undefined;
  const after = parseMetaGraphCursor(record(pagingRecord["cursors"])?.["after"]);
  return after === undefined ? undefined : Object.freeze({ posts: Object.freeze(posts), after });
}

/** `{post-id}?fields=…`: the echoed id must be the requested one. */
function singlePostOf(body: unknown, postId: ProviderObjectId): MetaPost | undefined {
  const post = postOf(body);
  return post?.id === postId ? post : undefined;
}

/** An IG `media_type` / `media_product_type`: a bounded upper-case token (classification is the read port's, closed). */
const MEDIA_ENUM = /^[A-Z][A-Z_]{0,63}$/;
/** An optional enum field: absent → null, a bounded token → itself, anything else → undefined (malformed). */
const mediaEnum = (value: unknown): string | null | undefined => (value === undefined ? null : typeof value === "string" && MEDIA_ENUM.test(value) ? value : undefined);

/** One IG Media node by whitelist: id, media_type, media_product_type, timestamp, caption, owner.id. */
function instagramMediaOf(value: unknown): MetaInstagramMedia | undefined {
  const media = record(value);
  if (media === undefined) return undefined;
  const id = parseProviderObjectId(media["id"]);
  const ownerId = parseProviderObjectId(record(media["owner"])?.["id"]);
  const caption = media["caption"] === undefined ? null : typeof media["caption"] === "string" ? media["caption"] : undefined;
  const timestamp = parseGraphDatetime(media["timestamp"]);
  const mediaType = mediaEnum(media["media_type"]);
  const mediaProductType = mediaEnum(media["media_product_type"]);
  if (id === undefined || ownerId === undefined || caption === undefined || timestamp === undefined || mediaType === undefined || mediaProductType === undefined) return undefined;
  return Object.freeze({ id, ownerId, caption, timestamp, mediaType, mediaProductType });
}

/**
 * `{ig-user-id}/media`: `data[]` of IG Media (whitelist), `paging.next` (presence only) and `paging.cursors.after` —
 * the same continuation rules as `published_posts`. More entries than the requested limit is not the documented shape.
 */
function instagramMediaListOf(body: unknown): MetaInstagramMediaList | undefined {
  const root = record(body);
  if (root === undefined || !Array.isArray(root["data"])) return undefined;
  const data = root["data"] as readonly unknown[];
  if (data.length > META_INSTAGRAM_MEDIA_PAGE_LIMIT) return undefined;
  const media: MetaInstagramMedia[] = [];
  for (const item of data) {
    const one = instagramMediaOf(item);
    if (one === undefined) return undefined;
    media.push(one);
  }
  const paging = root["paging"];
  if (paging === undefined) return Object.freeze({ media: Object.freeze(media), after: null });
  const pagingRecord = record(paging);
  if (pagingRecord === undefined) return undefined;
  const next = pagingRecord["next"];
  if (next === undefined) return Object.freeze({ media: Object.freeze(media), after: null });
  // `next` only signals that another page exists; it is never read as a URL or fetched.
  if (typeof next !== "string" || next === "") return undefined;
  const after = parseMetaGraphCursor(record(pagingRecord["cursors"])?.["after"]);
  return after === undefined ? undefined : Object.freeze({ media: Object.freeze(media), after });
}

/** `{ig-media-id}?fields=…`: the echoed id must be the requested one. */
function singleInstagramMediaOf(body: unknown, mediaId: ProviderObjectId): MetaInstagramMedia | undefined {
  const media = instagramMediaOf(body);
  return media?.id === mediaId ? media : undefined;
}

/** An optional string: absent → null, a string → itself, anything else → undefined (malformed). */
const optionalString = (value: unknown): string | null | undefined => (value === undefined ? null : typeof value === "string" ? value : undefined);
/** An optional boolean: absent → null, a boolean → itself, anything else → undefined (malformed). */
const optionalBoolean = (value: unknown): boolean | null | undefined => (value === undefined ? null : typeof value === "boolean" ? value : undefined);
/** An optional `{id}` reference: absent → null, an object with a valid id → that id, anything else → undefined. */
const optionalRefId = (value: unknown): ProviderObjectId | null | undefined => (value === undefined ? null : parseProviderObjectId(record(value)?.["id"]));
/** An optional bare id: absent → null, a valid id → itself, anything else → undefined. */
const optionalId = (value: unknown): ProviderObjectId | null | undefined => (value === undefined ? null : parseProviderObjectId(value));

/**
 * The shared continuation rule of the comment edges: `paging.next` (presence only) and `paging.cursors.after`. null
 * when the provider reports no next page; undefined (unreadable) when `next` is present without a valid `after`.
 */
function afterOf(root: Record<string, unknown>): MetaGraphCursor | null | undefined {
  const paging = root["paging"];
  if (paging === undefined) return null;
  const pagingRecord = record(paging);
  if (pagingRecord === undefined) return undefined;
  const next = pagingRecord["next"];
  if (next === undefined) return null;
  // `next` only signals that another page exists; it is never read as a URL or fetched.
  if (typeof next !== "string" || next === "") return undefined;
  return parseMetaGraphCursor(record(pagingRecord["cursors"])?.["after"]);
}

/** One Facebook comment by whitelist; `object.id` is read only when the node read requested it. */
function facebookCommentOf(value: unknown, withObject: boolean): MetaComment | undefined {
  const comment = record(value);
  if (comment === undefined) return undefined;
  const from = record(comment["from"]);
  const id = parseProviderObjectId(comment["id"]);
  const fromId = parseProviderObjectId(from?.["id"]);
  const fromName = optionalString(from?.["name"]);
  const message = typeof comment["message"] === "string" ? comment["message"] : undefined;
  const createdTime = parseGraphDatetime(comment["created_time"]);
  const parentId = optionalRefId(comment["parent"]);
  const isHidden = optionalBoolean(comment["is_hidden"]);
  const objectId = withObject ? optionalRefId(comment["object"]) : null;
  if (id === undefined || fromId === undefined || fromName === undefined || message === undefined || createdTime === undefined || parentId === undefined || isHidden === undefined || objectId === undefined) return undefined;
  return Object.freeze({ id, fromId, fromName, message, createdTime, parentId, isHidden, objectId });
}

/** `{post-id}/comments`: `data[]` of comments (whitelist) and the shared continuation. More than the limit is not the documented shape. */
function facebookCommentListOf(body: unknown): MetaCommentList | undefined {
  const root = record(body);
  if (root === undefined || !Array.isArray(root["data"])) return undefined;
  const data = root["data"] as readonly unknown[];
  if (data.length > META_FACEBOOK_COMMENTS_PAGE_LIMIT) return undefined;
  const comments: MetaComment[] = [];
  for (const item of data) {
    const comment = facebookCommentOf(item, false);
    if (comment === undefined) return undefined;
    comments.push(comment);
  }
  const after = afterOf(root);
  return after === undefined ? undefined : Object.freeze({ comments: Object.freeze(comments), after });
}

/** `{comment-id}?fields=…`: the echoed id must be the requested one. */
function singleFacebookCommentOf(body: unknown, commentId: ProviderObjectId): MetaComment | undefined {
  const comment = facebookCommentOf(body, true);
  return comment?.id === commentId ? comment : undefined;
}

/** One IG Comment by whitelist: id, from.id, from.username, text, timestamp, parent_id, hidden, media.id. */
function instagramCommentOf(value: unknown): MetaInstagramComment | undefined {
  const comment = record(value);
  if (comment === undefined) return undefined;
  const from = record(comment["from"]);
  const id = parseProviderObjectId(comment["id"]);
  const fromId = parseProviderObjectId(from?.["id"]);
  const fromUsername = optionalString(from?.["username"]);
  const text = typeof comment["text"] === "string" ? comment["text"] : undefined;
  const timestamp = parseGraphDatetime(comment["timestamp"]);
  const parentId = optionalId(comment["parent_id"]);
  const hidden = optionalBoolean(comment["hidden"]);
  const mediaId = optionalRefId(comment["media"]);
  if (id === undefined || fromId === undefined || fromUsername === undefined || text === undefined || timestamp === undefined || parentId === undefined || hidden === undefined || mediaId === undefined) return undefined;
  return Object.freeze({ id, fromId, fromUsername, text, timestamp, parentId, hidden, mediaId });
}

/** `{ig-media-id}/comments`: `data[]` of IG Comments (whitelist) and the shared continuation. More than the limit is not the documented shape. */
function instagramCommentListOf(body: unknown): MetaInstagramCommentList | undefined {
  const root = record(body);
  if (root === undefined || !Array.isArray(root["data"])) return undefined;
  const data = root["data"] as readonly unknown[];
  if (data.length > META_INSTAGRAM_COMMENTS_PAGE_LIMIT) return undefined;
  const comments: MetaInstagramComment[] = [];
  for (const item of data) {
    const comment = instagramCommentOf(item);
    if (comment === undefined) return undefined;
    comments.push(comment);
  }
  const after = afterOf(root);
  return after === undefined ? undefined : Object.freeze({ comments: Object.freeze(comments), after });
}

/** `{ig-comment-id}?fields=…`: the echoed id must be the requested one. */
function singleInstagramCommentOf(body: unknown, commentId: ProviderObjectId): MetaInstagramComment | undefined {
  const comment = instagramCommentOf(body);
  return comment?.id === commentId ? comment : undefined;
}

export function createMetaGraphTransport(options: MetaGraphTransportOptions = {}): MetaGraphTransport {
  const fetchImpl: MetaGraphFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? META_GRAPH_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? META_GRAPH_RESPONSE_MAX_BYTES;

  /** One GET of a fixed Graph path. `segments` are fixed names or validated provider ids; `query` excludes the token. */
  async function get<T>(segments: readonly string[], query: [string, string][], token: SecretValue, parse: (body: unknown) => T | undefined): Promise<MetaGraphOutcome<T>> {
    let status: number;
    let text: string | undefined;
    try {
      const url = new URL(`/${META_GRAPH_VERSION}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`, META_GRAPH_ORIGIN);
      url.search = new URLSearchParams([...query, ["access_token", token.expose()]]).toString();
      const response = await fetchImpl(url.href, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      if (response.type === "opaqueredirect" || (status >= 300 && status < 400)) {
        await response.body?.cancel();
        return UNREADABLE;
      }
      text = await boundedText(response, maxBytes);
    } catch {
      // Network failure, timeout or abort. Nothing of the error (which may reference the request) is kept.
      return Object.freeze({ kind: "transient", reason: "network" });
    }
    if (text === undefined) return UNREADABLE;
    const body = parseJson(text);
    if (status >= 200 && status < 300) {
      const value = parse(body);
      return value === undefined ? UNREADABLE : ok(value);
    }
    const error = graphErrorFields(body);
    if (error !== null) return Object.freeze({ kind: "graph_error", error });
    return status >= 500 ? Object.freeze({ kind: "transient", reason: "server_error" }) : UNREADABLE;
  }

  return {
    listPages(token, after) {
      return get(["me", "accounts"], after === null ? [["fields", "id,name"]] : [["fields", "id,name"], ["after", after]], token, pageListOf);
    },
    async getPageInstagram(token, pageId) {
      const outcome = await get([pageId], [["fields", "instagram_business_account"]], token, (body) => pageInstagramOf(body, pageId));
      return outcome.kind === "ok" ? ok(outcome.value.id) : outcome;
    },
    getInstagramAccount(token, instagramId) {
      return get([instagramId], [["fields", "id,username"]], token, (body) => instagramAccountOf(body, instagramId));
    },
    getPage(token, pageId) {
      return get([pageId], [["fields", "id,name"]], token, (body) => pageOf(body, pageId));
    },
    listPermissions(token) {
      return get(["me", "permissions"], [["fields", "permission,status"]], token, permissionsOf);
    },
    getPageAccessToken(userToken, pageId) {
      return get([pageId], [["fields", "access_token"]], userToken, (body) => pageAccessTokenOf(body, pageId));
    },
    listPublishedPosts(pageToken, pageId, after) {
      const query: [string, string][] = [["fields", META_POST_FIELDS], ["limit", String(META_PUBLISHED_POSTS_PAGE_LIMIT)]];
      return get([pageId, "published_posts"], after === null ? query : [...query, ["after", after]], pageToken, postListOf);
    },
    getPost(pageToken, postId) {
      return get([postId], [["fields", META_POST_FIELDS]], pageToken, (body) => singlePostOf(body, postId));
    },
    listInstagramMedia(userToken, instagramId, after) {
      const query: [string, string][] = [["fields", META_INSTAGRAM_MEDIA_FIELDS], ["limit", String(META_INSTAGRAM_MEDIA_PAGE_LIMIT)]];
      return get([instagramId, "media"], after === null ? query : [...query, ["after", after]], userToken, instagramMediaListOf);
    },
    getInstagramMedia(userToken, mediaId) {
      return get([mediaId], [["fields", META_INSTAGRAM_MEDIA_FIELDS]], userToken, (body) => singleInstagramMediaOf(body, mediaId));
    },
    listPostComments(pageToken, postId, after) {
      const query: [string, string][] = [["fields", META_FACEBOOK_COMMENT_FIELDS], ["filter", "stream"], ["limit", String(META_FACEBOOK_COMMENTS_PAGE_LIMIT)]];
      return get([postId, "comments"], after === null ? query : [...query, ["after", after]], pageToken, facebookCommentListOf);
    },
    getComment(pageToken, commentId) {
      return get([commentId], [["fields", META_FACEBOOK_COMMENT_NODE_FIELDS]], pageToken, (body) => singleFacebookCommentOf(body, commentId));
    },
    listInstagramComments(userToken, mediaId, after) {
      const query: [string, string][] = [["fields", META_INSTAGRAM_COMMENT_FIELDS], ["limit", String(META_INSTAGRAM_COMMENTS_PAGE_LIMIT)]];
      return get([mediaId, "comments"], after === null ? query : [...query, ["after", after]], userToken, instagramCommentListOf);
    },
    getInstagramComment(userToken, commentId) {
      return get([commentId], [["fields", META_INSTAGRAM_COMMENT_FIELDS]], userToken, (body) => singleInstagramCommentOf(body, commentId));
    },
  };
}
