/**
 * The Meta Graph READ transport for discoverAssets (Step 7G-E; design/phase-7g/meta-provider/README.md, E1 — the
 * implementation authority) and describeAccount (Step 7G-H5.5, contract H55). Five typed operations, nothing else:
 *
 *   listPages            GET https://graph.facebook.com/v25.0/me/accounts?fields=id,name[&after={cursor}]
 *   getPageInstagram     GET https://graph.facebook.com/v25.0/{page-id}?fields=instagram_business_account
 *   getInstagramAccount  GET https://graph.facebook.com/v25.0/{ig-user-id}?fields=id,username
 *   getPage              GET https://graph.facebook.com/v25.0/{page-id}?fields=id,name
 *   listPermissions      GET https://graph.facebook.com/v25.0/me/permissions?fields=permission,status
 *
 * Callers name an operation and pass a SecretValue token plus validated provider ids or a validated cursor — never a
 * URL. Meta documents the User Access Token as the `access_token` query parameter for these exact endpoints, so the
 * request URL is sensitive: this is the approved, documented provider exception (QUERY_PARAMETER, Meta Graph reads
 * only). The URL is built here, handed to `fetch`, and never logged, thrown, returned or serialized; `response.url`,
 * raw fetch errors and raw bodies never leave this module. Each operation makes exactly ONE request: no retry, no
 * redirect (`manual`, any 3xx refused), no cookies, no Authorization header, a finite timeout over the whole exchange
 * and a bounded body. Never the App Secret, the Client Token or appsecret_proof.
 *
 * Bodies are parsed here by whitelist into closed results; only the fields the contract maps are read (no Page
 * access token is ever read or returned). A provider id is used in a later path only after the provider-id rule,
 * as one encoded path segment. Results: the parsed value, the closed fields of a Graph error, `transient` (no
 * response, timeout, or a 5xx without a Graph error — reads have no effect, so these are retryable by the task) or
 * `unreadable` (redirect, oversized, not UTF-8 JSON, or a body that is not the documented shape).
 */
import type { SecretValue } from "../contract/credential";
import { parseProviderObjectId, type ProviderObjectId } from "../contract/identity";
import { META_GRAPH_ORIGIN, META_GRAPH_VERSION } from "./endpoints";
import { graphErrorFields, type MetaGraphErrorFields } from "./errors";

/** The same reviewed bounds as the token exchange: the whole request within 10 s, at most 64 KiB of body. */
export const META_GRAPH_TIMEOUT_MS = 10_000;
export const META_GRAPH_RESPONSE_MAX_BYTES = 64 * 1024;

declare const cursorBrand: unique symbol;
/** An opaque Graph pagination cursor: printable ASCII without whitespace, bounded. Never a URL, never stored. */
export type MetaGraphCursor = string & { readonly [cursorBrand]: true };
const CURSOR = /^[\x21-\x7E]{1,1024}$/;

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
  };
}
