/**
 * Static provider-boundary guards (Step 4; TA §6.3, §15, §27.3, §53). Run in every CI build without network.
 *
 *   contract surface  — exact read/mutation/authorization operation sets (type-level and runtime); no DM-like operation,
 *                       type or interaction kind; the mutation port isn't re-exported by any public index
 *   leakage           — the contract imports only its own files and the shared kernel (no SDK/HTTP types)
 *   no network        — simulator and contract never reach the network or HTTP clients
 *   dependencies      — no provider SDK or generic HTTP client package in the repository
 *   fixtures          — provider fixtures are marked simulated, carry no URL schemes, claim no real API version
 *
 * Dependency-direction rules (contract purity, mutation-port reachability) live in .dependency-cruiser.cjs.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_OPERATIONS,
  INTERACTION_KINDS,
  MUTATION_OPERATIONS,
  PAGE_CURSOR_MAX_LENGTH,
  READ_OPERATIONS,
  type AuthorizationOperation,
  type MutationOperation,
  type ProviderAuthorizationPort,
  type ProviderReadPort,
  type ReadOperation,
} from "@/integrations/providers/contract";
import type { ProviderMutationPort } from "@/integrations/providers/contract/mutation-port";
import { META_GRAPH_CURSOR_MAX_LENGTH } from "@/integrations/providers/meta/graph-transport";
import { META_PAGE_CURSOR_PREFIX } from "@/integrations/providers/meta/read-port";
import { PLANE_ENVIRONMENT_GUARD, codeOf, codeWithoutPlaneRefusals, findReferences, sourceFiles } from "../support/source-scan";

const root = path.resolve(import.meta.dirname, "../..");

// ── Type-level: the operation lists are exactly the port interfaces (both directions) ─────────────────────
type ReadKeys = Exclude<keyof ProviderReadPort, "provider">;
type MutationKeys = Exclude<keyof ProviderMutationPort, "provider">;
type AuthorizationKeys = Exclude<keyof ProviderAuthorizationPort, "provider" | "pkce">;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const readListIsExact: Exact<ReadKeys, ReadOperation> = true;
const mutationListIsExact: Exact<MutationKeys, MutationOperation> = true;
const authorizationListIsExact: Exact<AuthorizationKeys, AuthorizationOperation> = true;

/** Camel- and snake-case DM vocabulary anywhere inside identifiers, plus short words on word boundaries. */
const DM_LIKE_IDENTIFIER = /direct_?messages?|private_?messages?|inbox|(?:message|conversation|dm)_?threads?|(?:read|list|get|fetch)_?messages?|\b(?:dms?|threads?|conversations?)\b/i;

const contractFiles = sourceFiles(["integrations/providers/contract"]);
const simulatorFiles = sourceFiles(["integrations/providers/simulator"]);

describe("provider contract surface", () => {
  it("declares exactly the TA §15.1 read and mutation operations", () => {
    expect([readListIsExact, mutationListIsExact]).toEqual([true, true]);
    expect([...READ_OPERATIONS]).toEqual([
      "discoverAssets", "describeAccount", "listContent", "listInteractions", "getInteraction", "getContent",
      "getCurrentState", "retrievePaidContext", "parseWebhook", "subscribe", "unsubscribe", "refreshCredential",
    ]);
    expect([...MUTATION_OPERATIONS]).toEqual(["replyPublicly", "replyPrivately", "hide", "unhide", "delete", "block"]);
  });

  it("declares exactly the Step 5C authorization operations, with no persistence, session or crypto surface", () => {
    expect(authorizationListIsExact).toBe(true);
    expect([...AUTHORIZATION_OPERATIONS]).toEqual(["authorizationRequest", "parseCallback", "exchangeCode"]);
    const code = codeOf("integrations/providers/contract/authorization-port.ts");
    expect(code).not.toMatch(/workspace|connect_?attempt|seal|envelope|keyring|session|cookie|persist|repository/i);
  });

  it("the DM vocabulary detector catches camelCase, snake_case and short forms", () => {
    for (const sample of ["listDirectMessages", "read_private_message", "getInbox", "fetchMessages", "dm", "conversationThread", "threads"]) {
      expect(DM_LIKE_IDENTIFIER.test(sample), sample).toBe(true);
    }
    for (const sample of ["replyPrivately", "PrivateReplyReceipt", "interactions", "listInteractions"]) expect(DM_LIKE_IDENTIFIER.test(sample), sample).toBe(false);
  });

  it("has no direct-message read surface: no DM-like operation, identifier or interaction kind", () => {
    expect([...READ_OPERATIONS, ...MUTATION_OPERATIONS].filter((name) => /message|inbox|thread|conversation|\bdm/i.test(name))).toEqual([]);
    expect([...INTERACTION_KINDS]).toEqual(["comment", "reply"]);
    const offenders = [...contractFiles, ...simulatorFiles].filter((file) => DM_LIKE_IDENTIFIER.test(codeOf(file)));
    expect(offenders).toEqual([]);
  });

  it("the mutation port is not re-exported by the contract's or the simulator's public index", () => {
    for (const index of ["integrations/providers/contract/index.ts", "integrations/providers/simulator/index.ts"]) {
      expect(codeOf(index)).not.toMatch(/mutation-port|ProviderMutationPort|createSimulatorMutationPort/);
    }
  });

  it("no metadata escape hatch: no index-signature records or `any` in the contract", () => {
    for (const file of contractFiles) {
      expect(codeOf(file), file).not.toMatch(/Record<string,\s*unknown>|\[key: string\]|:\s*any\b|<any>/);
    }
  });
});

describe("no provider SDK or HTTP types leak through the contract", () => {
  it("contract files import only sibling contract files and the shared kernel", () => {
    for (const file of contractFiles) {
      const specifiers = [...codeOf(file).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
      for (const specifier of specifiers) expect(/^\.\/[a-z-]+$|^\.\.\/\.\.\/\.\.\/domain\//.test(specifier), `${file} → ${specifier}`).toBe(true);
    }
  });
});

describe("no network in the simulator or the contract", () => {
  it("imports no networking module or HTTP client and calls no network API", () => {
    const network = [
      /from\s+["'](?:node:)?(?:http|https|http2|net|tls|dgram|dns)["']/,
      /from\s+["'](?:undici|axios|node-fetch|got|superagent|ws)["']/,
      /\bfetch\s*\(/,
      /\bWebSocket\b/,
      /\bXMLHttpRequest\b/,
    ];
    for (const file of [...contractFiles, ...simulatorFiles]) {
      for (const pattern of network) expect(pattern.test(codeOf(file)), `${file}: ${pattern.source}`).toBe(false);
    }
  });
});

describe("dependencies", () => {
  it("no provider SDK or generic HTTP client package is installed in Step 4", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    const forbidden = /facebook|^fb$|instagram|tiktok|meta-?(business|graph|sdk)|^axios$|^node-fetch$|^undici$|^got$|^superagent$|^request$/i;
    expect(names.filter((name) => forbidden.test(name))).toEqual([]);
  });
});

describe("Meta enablement (Step 7G-C): domain and hosted configuration only, no adapter", () => {
  const RUNTIME = ["app", "ui", "server", "platform", "jobs", "modules", "integrations", "domain", "proxy.ts", "next.config.ts", "trigger.config.ts", "trigger.integration.config.ts"];
  const META_APP_NAMES = /\bPROVIDER_META_(CLIENT_ID|CONFIG_ID|CLIENT_SECRET)\b/;
  const META_APP_CONFIG = "server/connections/meta-app-config.ts";

  it("the Meta app configuration is named only by its hosted-web owner and, to refuse it, the jobs per-plane contract", () => {
    expect(findReferences(sourceFiles(RUNTIME), [META_APP_NAMES]).map(([file]) => file)).toEqual([PLANE_ENVIRONMENT_GUARD, META_APP_CONFIG]);
    expect(META_APP_NAMES.test(codeWithoutPlaneRefusals(PLANE_ENVIRONMENT_GUARD))).toBe(false);
  });

  it("no runtime code configures or reads a Meta Client Token", () => {
    expect(findReferences(sourceFiles(RUNTIME), [/META_CLIENT_TOKEN|\bclient_token\b|\bclientToken\b/])).toEqual([]);
  });

  it("the web's connection runtime is the configuration's only reader, and it composes the Meta authorization adapter from it", () => {
    const web = codeOf("server/connections/runtime.ts");
    expect(web).toMatch(/const meta = readMetaAppConfig\(environment\);/);
    expect(web).toMatch(/isLocalSimulatorRuntime\(environment\) \? \{ simulator: localSimulator\(environment\)\.authorization \} : \{\}/);
    expect(web).toMatch(/meta === undefined \? \{\} : \{ meta: createMetaAuthorizationPort\(/);
    expect(findReferences(sourceFiles(RUNTIME).filter((file) => file !== META_APP_CONFIG), [/meta-app-config|readMetaAppConfig/]).map(([file]) => file)).toEqual(["server/connections/runtime.ts"]);
  });
});

describe("Meta authorization adapter (Step 7G-D): offline, authorization only", () => {
  const RUNTIME = ["app", "ui", "server", "platform", "jobs", "modules", "integrations", "domain", "proxy.ts", "next.config.ts", "trigger.config.ts", "trigger.integration.config.ts"];
  const META = "integrations/providers/meta";
  const files = () => sourceFiles([META]);

  const AUTHORIZATION_SIDE = [`${META}/authorization.ts`, `${META}/endpoints.ts`, `${META}/errors.ts`, `${META}/oauth-transport.ts`];

  it("the Meta tree is the authorization adapter and its token transport, the read port and its Graph transport, error normalization and the fixed endpoints", () => {
    expect(files()).toEqual([`${META}/authorization.ts`, `${META}/endpoints.ts`, `${META}/errors.ts`, `${META}/graph-transport.ts`, `${META}/oauth-transport.ts`, `${META}/read-port.ts`]);
    // The authorization side knows nothing of reads; nothing anywhere in the tree mutates, refreshes or proves.
    for (const file of AUTHORIZATION_SIDE) expect(codeOf(file), file).not.toMatch(/discoverAssets|\/me\/accounts|instagram_business_account|ProviderReadPort/);
    for (const file of files()) expect(codeOf(file), file).not.toMatch(/ProviderMutationPort|fb_exchange_token|appsecret_proof/);
  });

  it("reads no environment, and only the two narrow transports touch the network", () => {
    for (const file of files()) expect(codeOf(file), file).not.toMatch(/process\.env/);
    expect(findReferences(sourceFiles(RUNTIME), [/\bfetch\s*\(/]).map(([file]) => file)).toEqual([`${META}/graph-transport.ts`, `${META}/oauth-transport.ts`]);
    for (const file of files()) expect(codeOf(file), file).not.toMatch(/from\s+["'](?:node:)?(?:http|https|http2|net|tls|dgram|dns)["']/);
  });

  it("one pinned version and two fixed origins, declared once (never configuration)", () => {
    expect(findReferences(sourceFiles(RUNTIME), [/"v\d+\.\d+"|\/v\d+\.\d+\//]).map(([file]) => file)).toEqual([`${META}/endpoints.ts`]);
    expect(findReferences(sourceFiles(RUNTIME), [/www\.facebook\.com|graph\.facebook\.com/]).map(([file]) => file)).toEqual([`${META}/endpoints.ts`]);
    expect(codeOf(`${META}/endpoints.ts`)).toMatch(/export const META_GRAPH_VERSION = "v25\.0";/);
  });

  it("the App Secret and the authorization code are unwrapped only where the token request is built", () => {
    // The simulator redeems its own synthetic codes in-process; it never holds the Meta App Secret.
    const real = sourceFiles(RUNTIME).filter((file) => !file.startsWith("integrations/providers/simulator/"));
    expect(findReferences(real, [/(clientSecret|\.code)\.expose\(\)/]).map(([file]) => file)).toEqual([`${META}/oauth-transport.ts`]);
  });

  it("no PKCE, scope or Client Token in the dialog; no config_id, scope or proof in the exchange", () => {
    const authorization = codeOf(`${META}/authorization.ts`);
    const transport = codeOf(`${META}/oauth-transport.ts`);
    expect(authorization).toMatch(/pkce: "not_supported"/);
    for (const code of [authorization, transport]) expect(code).not.toMatch(/"scope"|code_challenge|code_verifier|client_token|appsecret_proof/);
    expect(transport).not.toMatch(/config_id/);
  });
});

describe("Meta read port (Step 7G-E; P5-B read_content): the contained query-token Graph transport", () => {
  const RUNTIME = ["app", "ui", "server", "platform", "jobs", "modules", "integrations", "domain", "proxy.ts", "next.config.ts", "trigger.config.ts", "trigger.integration.config.ts"];
  const META = "integrations/providers/meta";
  const READ = [`${META}/read-port.ts`, `${META}/graph-transport.ts`];
  const transport = () => codeOf(`${META}/graph-transport.ts`);

  it("the access token is unwrapped only where the Graph request is built, and placed exactly once, as the documented query parameter", () => {
    const real = sourceFiles(RUNTIME).filter((file) => !file.startsWith("integrations/providers/simulator/"));
    expect(findReferences(real, [/\btoken\.expose\(\)/]).map(([file]) => file)).toEqual([`${META}/graph-transport.ts`]);
    // Step 7G-H5.5-P5-B: besides the query parameter, `access_token` names exactly the derived Page token's field
    // request and its one parser read; doc comments aside (stripped), nothing else in the transport mentions it.
    expect(transport().match(/access_token/g)).toHaveLength(3);
    expect(transport()).toMatch(/\["access_token", token\.expose\(\)\]/);
    expect(transport()).toMatch(/get\(\[pageId\], \[\["fields", "access_token"\]\], userToken, /);
    expect(transport()).toMatch(/const token = root\["access_token"\];\n {2}return typeof token === "string" && PAGE_ACCESS_TOKEN\.test\(token\) \? new SecretValue\(token\) : undefined;/);
    expect(codeOf(`${META}/read-port.ts`)).not.toMatch(/\.expose\(|access_token/);
  });

  it("P5-B: the derived Page Access Token is a SecretValue local to one read-port call — never stored, returned or serialized", () => {
    const readPort = codeOf(`${META}/read-port.ts`);
    // Derived inside the call, handed straight to the one content read; no module or closure state keeps it.
    expect(readPort).toMatch(/const token = await pageToken\(transport, access, page, "listContent"\);/);
    expect(readPort).toMatch(/const token = await pageToken\(transport, access, page, "getContent"\);/);
    expect(readPort.match(/\bpageToken\(/g)).toHaveLength(3); // the helper + its two call sites
    expect(readPort).toMatch(/transport\.listPublishedPosts\(token, page, after\)/);
    expect(readPort).toMatch(/transport\.getPost\(token, postId\)/);
    expect(readPort).not.toMatch(/new Map<[^>]*SecretValue|cache|memo|WeakMap|globalThis/i);
    // The DTO mapper never sees a token; nothing persists, logs or emits anything from the provider layer.
    const mapper = readPort.slice(readPort.indexOf("function contentOf("), readPort.indexOf("function windowBounds("));
    expect(mapper).not.toMatch(/token|secret|credential/i);
    for (const file of READ) expect(codeOf(file), file).not.toMatch(/console\.|logger|\.log\(|writeFile|insert\(|telemetry|posthog|Sentry/i);
  });

  it("the Graph transport never uses a header token, the provider URL or anything of the app's secrets", () => {
    expect(transport()).not.toMatch(/authorization|Bearer|response\.url|\.url\b(?!\.)|paging\.next|client_secret|appsecret|client_token|PROVIDER_META_|clientSecret/i);
    expect(transport()).toMatch(/redirect: "manual"/);
    expect(transport()).toMatch(/credentials: "omit"/);
    expect(transport()).toMatch(/signal: AbortSignal\.timeout\(timeoutMs\)/);
    expect(transport()).toMatch(/headers: \{ accept: "application\/json" \}/);
  });

  it("only documented reads: /me/accounts with id,name (no limit), the Page's instagram_business_account and the IG account's id,username; describeAccount's Page id,name and me/permissions; P5-B's Page token, published_posts and post reads", () => {
    expect(transport()).toMatch(/\["me", "accounts"\]/);
    expect(transport()).toMatch(/\["me", "permissions"\]/);
    expect([...transport().matchAll(/\["fields", "([^"]+)"\]/g)].map((match) => match[1]).sort()).toEqual(["access_token", "id,name", "id,name", "id,name", "id,username", "instagram_business_account", "permission,status"]);
    // P5-B: the post fields are ONE whitelist constant, used by published_posts and the post read only; never /feed.
    expect(transport()).toMatch(/export const META_POST_FIELDS = "id,from,message,created_time,updated_time,status_type";/);
    expect(transport().match(/\["fields", META_POST_FIELDS\]/g)).toHaveLength(2);
    expect(transport()).toMatch(/get\(\[pageId, "published_posts"\]/);
    expect(transport()).not.toMatch(/"feed"|\/feed|attachments|full_picture|permalink_url|insights|"story"|pages_read_user_content/);
    // The one fixed page size travels with published_posts only; /me/accounts stays limit-free; no field expansion.
    expect(transport().match(/\["limit", String\(META_PUBLISHED_POSTS_PAGE_LIMIT\)\]/g)).toHaveLength(1);
    expect(transport()).toMatch(/export const META_PUBLISHED_POSTS_PAGE_LIMIT = 10;/);
    expect(transport()).not.toMatch(/\.limit\(|"fields", "[^"]*\{/);
  });

  it("the read side holds no Meta app configuration and no state", () => {
    for (const file of READ) {
      expect(codeOf(file), file).not.toMatch(/PROVIDER_META_|readMetaAppConfig|MetaAppCredentials|clientId|configId|process\.env/);
      expect(codeOf(file), file).not.toMatch(/^(?:export\s+)?(?:let|var)\s/m);
    }
    expect(codeOf(`${META}/read-port.ts`)).toMatch(/export const DISCOVER_ASSETS_MAX_PAGES = 20;/);
  });

  it("the integration worker's composition is the read port's only composer", () => {
    expect(findReferences(sourceFiles(RUNTIME), [/\bcreateMetaReadPort\(/]).map(([file]) => file)).toEqual(["integrations/providers/meta/read-port.ts", "jobs/connections.ts"]);
    expect(codeOf("jobs/connections.ts")).toMatch(/provider === "meta" \? meta : undefined/);
  });
});

describe("Meta Instagram read_content (Step 7G-H5.5-P11-B): /media and the media node, User token directly, closed kinds", () => {
  const META = "integrations/providers/meta";
  const transport = () => codeOf(`${META}/graph-transport.ts`);
  const readPort = () => codeOf(`${META}/read-port.ts`);
  const instagramBranch = () => readPort().slice(readPort().indexOf("function managedInstagramAccount("), readPort().indexOf("async function discover("));

  it("only the two documented Instagram reads: GET {ig-user-id}/media (fixed limit) and GET {ig-media-id}, one shared field whitelist", () => {
    expect(transport()).toMatch(/export const META_INSTAGRAM_MEDIA_FIELDS = "id,media_type,media_product_type,timestamp,caption,owner";/);
    expect(transport().match(/\["fields", META_INSTAGRAM_MEDIA_FIELDS\]/g)).toHaveLength(2);
    expect(transport()).toMatch(/get\(\[instagramId, "media"\], /);
    expect(transport()).toMatch(/get\(\[mediaId\], \[\["fields", META_INSTAGRAM_MEDIA_FIELDS\]\], userToken, /);
    expect(transport()).toMatch(/export const META_INSTAGRAM_MEDIA_PAGE_LIMIT = 10;/);
    expect(transport().match(/\["limit", String\(META_INSTAGRAM_MEDIA_PAGE_LIMIT\)\]/g)).toHaveLength(1);
    // Never stories, live media, tags, mentions, album children, media URLs, thumbnails, permalinks, counts or boost data.
    expect(transport()).not.toMatch(/"stories"|"live_media"|"tags"|"mentioned_media"|"children"|media_url|thumbnail_url|permalink|like_count|comments_count|boost_/);
  });

  it("the Instagram branch reads with the sealed User token directly: no Page token derivation, no published_posts", () => {
    const branch = instagramBranch();
    expect(branch.length).toBeGreaterThan(0);
    expect(branch).toMatch(/transport\.listInstagramMedia\(access\.credential\.secret, account, after\)/);
    expect(branch).toMatch(/transport\.getInstagramMedia\(access\.credential\.secret, mediaId\)/);
    expect(branch).not.toMatch(/pageToken|getPageAccessToken|listPublishedPosts|getPost\b|META_POST_FIELDS|status_type/);
    // The branch is selected by the account's platform only (no fallback); TikTok and the rest take the refusing Page path.
    expect(readPort().match(/access\.account\.platform === "instagram" \? await (listMedia|getMedia)\(/g)).toHaveLength(2);
  });

  it("the kind table is CLOSED on (media_type, media_product_type) and read by own key only; the source is always unknown", () => {
    expect(readPort()).toMatch(/export const META_INSTAGRAM_MEDIA_CONTENT_KINDS: Readonly<Record<string, ContentKind>> = Object\.freeze\(\{\n {2}"IMAGE:FEED": "post",\n {2}"VIDEO:FEED": "video",\n {2}"VIDEO:REELS": "reel",\n {2}"CAROUSEL_ALBUM:FEED": "carousel",\n\}\);/);
    const mapper = readPort().slice(readPort().indexOf("function contentOfMedia("), readPort().indexOf("async function listMedia("));
    expect(mapper).toMatch(/Object\.hasOwn\(META_INSTAGRAM_MEDIA_CONTENT_KINDS, key\)/);
    expect(mapper).toMatch(/if \(media\.ownerId !== account\) throw new PermanentRejectedError\(operation, "unknown"\);/);
    expect(mapper).toMatch(/reportedSource: "unknown",/);
    expect(mapper).not.toMatch(/"organic"|"paid"|"mixed"|"any"|"other"|token|secret|credential/);
  });

  it("the README records the P11-B slice: offline only, the two permissions, pages_show_list not required, post/unknown first, no catalog change", () => {
    const doc = readFileSync(path.join(root, "design/phase-7g/meta-provider/README.md"), "utf8");
    const section = doc.slice(doc.indexOf("## Instagram read_content (Step 7G-H5.5-P11-B) — IMPLEMENTED_OFFLINE_NOT_LIVE_VALIDATED"));
    expect(section.length).toBeGreaterThan(0);
    for (const phrase of [
      "`META_INSTAGRAM_MEDIA_FIELDS` = `id,media_type,media_product_type,timestamp,caption,owner`",
      "`instagram_basic` and `pages_read_engagement`",
      "it is NOT a requirement of this capability's operation set as implemented",
      "No globally minimal permission set is claimed.",
      "`reportedSource` is always `unknown`",
      "`IMPLEMENTED_PLATFORM_OPERATIONS` stays Facebook-only",
      "One observed post never validates `video`, `reel` or `carousel`",
    ]) expect(section, phrase).toContain(phrase);
  });

  it("the Facebook Page path keeps its derivation, endpoint, fields and closed table (regression pin)", () => {
    expect(transport()).toMatch(/export const META_POST_FIELDS = "id,from,message,created_time,updated_time,status_type";/);
    expect(transport()).toMatch(/get\(\[pageId, "published_posts"\], /);
    expect(readPort()).toMatch(/const token = await pageToken\(transport, access, page, "listContent"\);/);
    expect(readPort()).toMatch(/const token = await pageToken\(transport, access, page, "getContent"\);/);
    expect(readPort()).toMatch(/export const META_STATUS_TYPE_CONTENT_KINDS: Readonly<Record<string, ContentKind>> = Object\.freeze\(\{\n {2}added_video: "video",\n {2}mobile_status_update: "post",\n {2}added_photos: "post",\n {2}shared_story: "post",\n\}\);/);
    // Step 7G-H5.5-P11-B-H1: both closed tables are read by own key only (no inherited Object.prototype name).
    expect(readPort()).toMatch(/post\.statusType !== null && Object\.hasOwn\(META_STATUS_TYPE_CONTENT_KINDS, post\.statusType\)/);
    expect(readPort()).not.toMatch(/META_STATUS_TYPE_CONTENT_KINDS\[post\.statusType\];/);
  });
});

describe("Meta pagination cursor envelope (Step 7G-H5.5-P5-C7): the raw Graph cursor never crosses the port", () => {
  const META = "integrations/providers/meta";
  const readPort = () => codeOf(`${META}/read-port.ts`);
  const PRODUCTION = ["app", "ui", "server", "domain", "modules", "platform", "integrations", "ai", "mutations", "jobs", "db", "tools"];

  it("the PageCursor capacity covers the envelope of the longest accepted raw Graph cursor (prefix + unpadded base64url)", () => {
    const required = META_PAGE_CURSOR_PREFIX.length + Math.ceil((4 * META_GRAPH_CURSOR_MAX_LENGTH) / 3);
    expect([META_GRAPH_CURSOR_MAX_LENGTH, META_PAGE_CURSOR_PREFIX.length, required]).toEqual([1024, 6, 1372]);
    expect(PAGE_CURSOR_MAX_LENGTH).toBeGreaterThanOrEqual(required);
    // The validators are built from the exported constants (no duplicated literal).
    expect(codeOf("integrations/providers/contract/pagination.ts")).toMatch(/\{1,\$\{String\(PAGE_CURSOR_MAX_LENGTH\)\}\}/);
    expect(codeOf(`${META}/graph-transport.ts`)).toMatch(/\{1,\$\{String\(META_GRAPH_CURSOR_MAX_LENGTH\)\}\}/);
  });

  it("the envelope prefix is provider-specific and versioned, distinct from the simulator's", () => {
    expect(META_PAGE_CURSOR_PREFIX).toMatch(/^meta[0-9]+\.$/);
    expect(codeOf("integrations/providers/simulator/read-port.ts")).toMatch(/`sim1\./);
    expect(codeOf("integrations/providers/simulator/read-port.ts")).not.toMatch(/meta1/);
  });

  it("outgoing continuation goes ONLY through the envelope; the raw Graph cursor is never offered as a PageCursor", () => {
    const code = readPort();
    expect(code).not.toMatch(/parsePageCursor\(list\.after\)/);
    expect(code).toMatch(/const next = encodeMetaPageCursor\(list\.after\);/);
    // parsePageCursor appears exactly three times: inside the encoder (over the prefixed payload) and as the input check
    // of each listContent branch (Facebook Page, Instagram account — Step 7G-H5.5-P11-B).
    expect(code.match(/parsePageCursor\(/g)).toHaveLength(3);
    expect(code.match(/if \(cursor !== null && parsePageCursor\(cursor\) === undefined\) throw new PermanentRejectedError\("listContent", "invalid_cursor"\);/g)).toHaveLength(2);
    expect(code.match(/const next = encodeMetaPageCursor\(list\.after\);/g)).toHaveLength(2);
    expect(code).toMatch(/parsePageCursor\(META_PAGE_CURSOR_PREFIX \+ Buffer\.from\(raw, "latin1"\)\.toString\("base64url"\)\)/);
    // Incoming cursors are decoded (strict alphabet, canonical re-encode, raw re-validation) before any request.
    expect(code.match(/const after: MetaGraphCursor \| null = cursor === null \? null : decodeMetaPageCursor\(cursor\);/g)).toHaveLength(2);
    expect(code).toMatch(/bytes\.toString\("base64url"\) === payload \? parseMetaGraphCursor\(bytes\.toString\("latin1"\)\) : undefined/);
    // The helpers stay private to the adapter.
    expect(code).not.toMatch(/export function (encode|decode)MetaPageCursor/);
  });

  it("paging.next is never followed: neither the adapter nor its transport reads it as a URL", () => {
    expect(readPort()).not.toMatch(/paging|\.next\b(?!\.kind)|fetch\(/);
    expect(codeOf(`${META}/graph-transport.ts`)).not.toMatch(/new URL\(next|fetchImpl\(next|paging\.next/);
  });

  it("no cursor is persisted or exposed: PageCursor lives only in provider adapters and the contract", () => {
    const users = findReferences(sourceFiles(PRODUCTION), [/\bPageCursor\b|\bparsePageCursor\b|META_PAGE_CURSOR_PREFIX|MetaGraphCursor/]).map(([file]) => file);
    expect(users.filter((file) => !file.startsWith("integrations/providers/"))).toEqual([]);
    expect(findReferences(sourceFiles(["db"]), [/cursor/i])).toEqual([]);
    // The diagnostic reports only the pagination kind, never a cursor.
    const diagnostic = codeOf("jobs/integration-read-content-validation.ts");
    expect(diagnostic).toMatch(/readonly pagination: "more" \| "end" \| null;/);
    expect(diagnostic).not.toMatch(/\bcursor\s*:|next\.cursor/);
  });
});

describe("provider fixtures", () => {
  const dir = path.join(root, "fixtures/providers");
  const jsonFiles = (sub: string) =>
    readdirSync(path.join(dir, sub)).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, sub, f));

  it("every simulator fixture is marked simulated and claims no real API version", () => {
    for (const file of jsonFiles("simulator")) {
      const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      expect(json["simulated"], file).toBe(true);
      if ("apiVersion" in json) expect(String(json["apiVersion"]).startsWith("simulator-"), file).toBe(true);
    }
  });

  it("fixtures and golden files contain no URL schemes (no live links, no captured endpoints)", () => {
    for (const file of [...jsonFiles("simulator"), ...jsonFiles("golden")]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/\b(?:https?|wss?):\/\//i);
    }
  });
});
