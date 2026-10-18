/**
 * Meta implementation of the provider READ port — `discoverAssets` only (Step 7G-E; design/phase-7g/meta-provider/
 * README.md, E1 — the implementation authority). Composed only by the integration worker (jobs/connections.ts), with
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
 * the whole call; no partial asset list is ever returned. Every other read operation is refused (permanent).
 */
import type { ProviderCredential } from "../contract/credential";
import { PermanentRejectedError, TransientError, type ReadOperation } from "../contract/errors";
import type { SocialAssetDto } from "../contract/dto";
import { providerObjectRef, rawReference, type ProviderObjectId, type ProviderObjectRef } from "../contract/identity";
import { BUDGET_NOT_REPORTED } from "../contract/pagination";
import type { ProviderReadPort } from "../contract/read-port";
import { WebhookRejectedError } from "../contract/webhooks";
import { META_GRAPH_VERSION } from "./endpoints";
import { metaGraphReadError } from "./errors";
import { createMetaGraphTransport, type MetaGraphCursor, type MetaGraphOutcome, type MetaGraphTransport, type MetaPageList } from "./graph-transport";

/** The most /me/accounts pages one discovery reads. Fixed (never configuration); revised only with evidence. */
export const DISCOVER_ASSETS_MAX_PAGES = 20;

export interface MetaReadPortOptions {
  readonly transport?: MetaGraphTransport;
}

const OPERATION = "discoverAssets";

/** Code-unit order: deterministic, locale-independent. */
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The value of a successful outcome; every failure becomes one normalized provider error. */
function valueOf<T>(outcome: MetaGraphOutcome<T>): T {
  switch (outcome.kind) {
    case "ok":
      return outcome.value;
    case "graph_error":
      throw metaGraphReadError(OPERATION, outcome.error, "discover_assets");
    case "transient":
      throw new TransientError(OPERATION, outcome.reason);
    case "unreadable":
      throw new PermanentRejectedError(OPERATION, "unknown");
  }
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

export function createMetaReadPort(options: MetaReadPortOptions = {}): ProviderReadPort {
  const transport = options.transport ?? createMetaGraphTransport();
  const refuse = (operation: Exclude<ReadOperation, "discoverAssets" | "parseWebhook">): Promise<never> => Promise.reject(new PermanentRejectedError(operation, "invalid_request"));

  return Object.freeze({
    provider: "meta",

    async discoverAssets(credential) {
      return Object.freeze({ data: await discover(transport, credential), budget: BUDGET_NOT_REPORTED });
    },

    describeAccount: () => refuse("describeAccount"),
    listContent: () => refuse("listContent"),
    listInteractions: () => refuse("listInteractions"),
    getInteraction: () => refuse("getInteraction"),
    getContent: () => refuse("getContent"),
    getCurrentState: () => refuse("getCurrentState"),
    retrievePaidContext: () => refuse("retrievePaidContext"),
    parseWebhook: () => Promise.reject(new WebhookRejectedError("invalid_signature")),
    subscribe: () => refuse("subscribe"),
    unsubscribe: () => refuse("unsubscribe"),
    refreshCredential: () => refuse("refreshCredential"),
  } satisfies ProviderReadPort);
}
