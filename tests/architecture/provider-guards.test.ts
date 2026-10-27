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
  OUTCOME_UNKNOWN_REASONS,
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

  it("no credential lifetime is ever invented (Step 7G-H5.5-P12-C0-R5F): expiry is the reported expires_in or null (unknown)", () => {
    const transport = codeOf(`${META}/oauth-transport.ts`);
    const authorization = codeOf(`${META}/authorization.ts`);
    // The token's expiry field is set in exactly two places: null when absent, or the validated value.
    expect([...transport.matchAll(/expiresInSeconds: ([A-Za-z0-9_.]+)\s*\}\)/g)].map((match) => match[1])).toEqual(["null", "expiresIn"]);
    expect(transport).toMatch(/if \(expiresIn === undefined\) return Object\.freeze\(\{ kind: "token", accessToken: new SecretValue\(accessToken\), expiresInSeconds: null \}\);/);
    // The adapter computes expiresAt once: unknown stays null, a reported lifetime is added to the issue time.
    expect([...authorization.matchAll(/expiresAt =/g)]).toHaveLength(1);
    expect(authorization).toMatch(/const expiresAt = outcome\.expiresInSeconds === null \? null : isoInstant\(new Date\(now\(\)\.getTime\(\) \+ outcome\.expiresInSeconds \* 1000\)\);/);
    for (const code of [transport, authorization]) {
      // No defaulting of an expiry (`??`/`||` on an expiry-bearing expression) and no default-lifetime constant.
      for (const line of code.split("\n").filter((l) => /expir/i.test(l))) expect(line, line).not.toMatch(/\?\?|\|\|\s*\d/);
      expect(code).not.toMatch(/DEFAULT_\w*(LIFETIME|EXPIR|TTL)|5184000|86400|60 \* 60 \* 24|24 \* 60 \* 60/);
    }
    // The only duration literal is the declared upper BOUND for a reported expires_in (never a default).
    expect([...transport.matchAll(/\d+ \* \d+ \* \d+/g)].map((match) => match[0])).toEqual(["10 * 365 * 24"]);
    expect(transport).toMatch(/const MAX_EXPIRES_IN_SECONDS = 10 \* 365 \* 24 \* 3600;/);
  });

  it("a stored credential expiry has no runtime reader, so nothing can read null as permanent or expired (Step 7G-H5.5-P12-C0-R5F)", () => {
    const store = codeOf("modules/connections/persistence/store.ts");
    // The worker loads identity and envelope bytes only; the expiry column is never selected or returned.
    expect(store).toMatch(/sql`select connection_id, envelope from credentials\.load_envelope\(\$\{credentialId\}::uuid\)`/);
    expect(store).toMatch(/return row === undefined \? undefined : \{ connectionId: row\.connection_id, envelope: new Uint8Array\(row\.envelope\) \};/);
    expect(findReferences(sourceFiles(RUNTIME), [/load_envelope/]).map(([file]) => file)).toEqual(["modules/connections/persistence/store.ts"]);
    // Outside the Meta exchange (producer) and its pass-through to storage, no runtime code compares a credential expiry.
    // The contract's own type declarations (CodeExchangeResult, CredentialRefreshResult) define `IsoInstant | null`; they read nothing.
    const PASS_THROUGH = ["integrations/providers/contract/authorization-port.ts", "integrations/providers/contract/dto.ts", `${META}/authorization.ts`, `${META}/oauth-transport.ts`, "server/connections/authorization.ts", "server/commands/connections.ts", "modules/connections/application/authorization.ts", "modules/connections/application/ports.ts", "modules/connections/persistence/store.ts"];
    const readers = sourceFiles(RUNTIME)
      .filter((file) => !file.startsWith("integrations/providers/simulator/") && !PASS_THROUGH.includes(file))
      .filter((file) => /credential[^\n]{0,80}expiresAt|expiresAt[^\n]{0,80}credential|provider_credentials[^\n]{0,120}expires_at/i.test(codeOf(file)));
    expect(readers).toEqual([]);
  });

  it("ambiguity sub-reasons (Step 7G-H5.5-P12-C0-R5A) are closed literals or the reviewed classifiers, never runtime values; the error is never read", () => {
    const transport = codeOf(`${META}/oauth-transport.ts`);
    const allowed = new Set([...OUTCOME_UNKNOWN_REASONS.map((reason) => `"${reason}"`), "reason", "body.reason", 'signal.aborted ? "timeout" : "network_error"', "unrecognizedStatus(status)"]);
    const calls = [...transport.matchAll(/\bambiguous\(([^)]*\)?)\)/g)].map((match) => match[1] ?? "");
    expect(calls).toHaveLength(9); // 5 token-response checks (an absent expires_in is not one: R5F), redirect, the catch, the body read, the unrecognized status
    for (const argument of calls) expect(allowed.has(argument), argument).toBe(true);
    // `ok: false` reasons are the two body literals only; the classifiers return literals only.
    expect([...transport.matchAll(/ok: false, reason: ("[a-z0-9_]+")/g)].map((match) => match[1]).sort()).toEqual(['"response_not_utf8"', '"response_too_large"', '"response_too_large"']);
    // No catch binds the error: nothing of it can be classified, kept or rendered.
    expect(transport).not.toMatch(/catch\s*\(/);
    // The callback logs the reason as an event name, from the typed error's closed field only.
    const callback = codeOf("server/connections/authorization.ts");
    expect([...callback.matchAll(/exchange_ambiguous\.\$\{([^}]+)\}/g)].map((match) => match[1])).toEqual(["error.reason"]);
    expect(callback).toMatch(/if \(error instanceof OutcomeUnknownError && error\.reason !== null\) log\.info\(`connections\.authorization\.exchange_ambiguous\.\$\{error\.reason\}`, \{ outcome: "error", workspaceId \}\);/);
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
    // Step 7G-H5.5-P12-B1: the Facebook interaction reads derive their own Page token per call, the same way.
    expect(readPort).toMatch(/const token = await pageToken\(transport, access, page, "listInteractions"\);/);
    expect(readPort).toMatch(/const token = await pageToken\(transport, access, page, "getInteraction"\);/);
    expect(readPort.match(/\bpageToken\(/g)).toHaveLength(5); // the helper + its four call sites
    expect(readPort).toMatch(/transport\.listPublishedPosts\(token, page, after\)/);
    expect(readPort).toMatch(/transport\.getPost\(token, postId\)/);
    expect(readPort).toMatch(/transport\.listPostComments\(token, post, after\)/);
    expect(readPort).toMatch(/transport\.getComment\(token, commentId\)/);
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

describe("Meta read_interactions (Step 7G-H5.5-P12-B1): Facebook comments + replies, Instagram top-level comments, offline only", () => {
  const META = "integrations/providers/meta";
  const transport = () => codeOf(`${META}/graph-transport.ts`);
  const readPort = () => codeOf(`${META}/read-port.ts`);
  const between = (code: string, from: string, to: string) => code.slice(code.indexOf(from), code.indexOf(to));

  it("only the four documented comment reads, each with ONE whitelist constant and a fixed limit; no replies edge, no field expansion", () => {
    expect(transport()).toMatch(/export const META_FACEBOOK_COMMENT_FIELDS = "id,from,message,created_time,parent,is_hidden";/);
    expect(transport()).toMatch(/export const META_FACEBOOK_COMMENT_NODE_FIELDS = "id,from,message,created_time,parent,is_hidden,object";/);
    expect(transport()).toMatch(/export const META_INSTAGRAM_COMMENT_FIELDS = "id,from,text,timestamp,parent_id,hidden,media";/);
    expect(transport().match(/\["fields", META_FACEBOOK_COMMENT_FIELDS\]/g)).toHaveLength(1);
    expect(transport().match(/\["fields", META_FACEBOOK_COMMENT_NODE_FIELDS\]/g)).toHaveLength(1);
    expect(transport().match(/\["fields", META_INSTAGRAM_COMMENT_FIELDS\]/g)).toHaveLength(2);
    expect(transport().match(/\["filter", "stream"\]/g)).toHaveLength(1);
    expect(transport()).toMatch(/get\(\[postId, "comments"\], /);
    expect(transport()).toMatch(/get\(\[mediaId, "comments"\], /);
    expect(transport()).toMatch(/export const META_FACEBOOK_COMMENTS_PAGE_LIMIT = 10;/);
    expect(transport()).toMatch(/export const META_INSTAGRAM_COMMENTS_PAGE_LIMIT = 10;/);
    expect(transport()).not.toMatch(/"replies"|"reactions"|"likes"|"private_replies"|"ordered_comments"|"order"|"since"|"until"/);
    for (const fields of ["id,from,message,created_time,parent,is_hidden", "id,from,text,timestamp,parent_id,hidden,media"]) expect(fields).not.toMatch(/\{|attachment|like|reaction|replies|permalink|private/);
  });

  it("the Facebook interaction reads derive a Page token per call; the Instagram ones use the User token directly and never derive", () => {
    const facebookReads = between(readPort(), "async function listPageComments(", "function interactionOfInstagramComment(");
    expect(facebookReads).toMatch(/transport\.listPostComments\(token, post, after\)/);
    expect(facebookReads).toMatch(/transport\.getComment\(token, commentId\)/);
    const instagramReads = between(readPort(), "function interactionOfInstagramComment(", "function contentOfScope(");
    expect(instagramReads.length).toBeGreaterThan(0);
    expect(instagramReads).toMatch(/transport\.listInstagramComments\(access\.credential\.secret, media, after\)/);
    expect(instagramReads).toMatch(/transport\.getInstagramComment\(access\.credential\.secret, commentId\)/);
    expect(instagramReads).not.toMatch(/pageToken|getPageAccessToken|listPostComments|getComment\(/);
    expect(readPort().match(/access\.account\.platform === "instagram" \? await (listMediaComments|getMediaComment)\(/g)).toHaveLength(2);
  });

  it("the mappers never see a token; replies only from parent.id (Facebook); Instagram refuses parent_id and a foreign media.id; content of a node only from object / media", () => {
    const facebookMapper = between(readPort(), "function interactionOfComment(", "async function listPageComments(");
    expect(facebookMapper).toMatch(/interactionKind: comment\.parentId === null \? "comment" : "reply",/);
    expect(facebookMapper).toMatch(/role: comment\.fromId === page \? "account_identity" : "user",/);
    const instagramMapper = between(readPort(), "function interactionOfInstagramComment(", "async function listMediaComments(");
    expect(instagramMapper).toMatch(/if \(comment\.parentId !== null\) throw new PermanentRejectedError\(operation, "unknown"\);/);
    expect(instagramMapper).toMatch(/if \(comment\.mediaId !== null && comment\.mediaId !== media\) throw new PermanentRejectedError\(operation, "unknown"\);/);
    expect(instagramMapper).toMatch(/interactionKind: "comment",/);
    expect(instagramMapper).not.toMatch(/"reply"/);
    for (const mapper of [facebookMapper, instagramMapper]) expect(mapper).not.toMatch(/token|secret|credential|"organic"|"paid"|"mixed"|reportedSource/);
    // Step 7G-H5.5-P12-C6: the same refusal set (no object, an odd object, one naming the comment itself or its parent,
    // an unreadable node), the same error and code — each now NAMES its case with a closed diagnostic, never an id.
    const authority = between(readPort(), "function contentAuthorityProblem(", "async function getPageComment(");
    expect(authority).toMatch(/if \(comment\.objectState === "malformed"\) return "interaction_content_malformed";/);
    expect(authority).toMatch(/if \(comment\.objectState === "id_missing"\) return "interaction_content_id_missing";/);
    expect(authority).toMatch(/if \(comment\.objectId === null\) return "interaction_content_missing";/);
    expect(authority).toMatch(/if \(comment\.objectId === comment\.id\) return "interaction_content_equals_interaction";/);
    expect(authority).toMatch(/if \(comment\.objectId === comment\.parentId\) return "interaction_content_equals_parent";/);
    expect(readPort()).toMatch(/if \(authority !== null \|\| comment\.objectId === null\) throw new PermanentRejectedError\("getInteraction", "unknown", authority \?\? "interaction_content_missing"\);/);
    expect(readPort()).toMatch(/if \(outcome\.kind === "unreadable"\) throw new PermanentRejectedError\("getInteraction", "unknown", "interaction_node_unreadable"\);/);
    expect(readPort()).toMatch(/if \(comment\.mediaId === null\) throw new PermanentRejectedError\("getInteraction", "unknown", "interaction_content_missing"\);/);
    // The diagnostic never carries a value: every literal passed is a closed vocabulary member.
    expect([...readPort().matchAll(/PermanentRejectedError\("getInteraction", "unknown", ([^)]+)\)/g)].map((m) => m[1])).toEqual(['"interaction_node_unreadable"', 'authority ?? "interaction_content_missing"', '"interaction_content_missing"']);
    // No account-wide comment feed, on any platform.
    expect(readPort()).toMatch(/if \(scope\.kind === "account"\) throw new TargetNotEligibleError\("listInteractions", "unsupported_for_target"\);/);
  });

  it("the transport requires from.id on every comment (no author → unreadable) and reads visibility only from the reported boolean", () => {
    for (const parser of [between(transport(), "function facebookCommentOf(", "function facebookCommentListOf("), between(transport(), "function instagramCommentOf(", "function instagramCommentListOf(")]) {
      expect(parser).toMatch(/const fromId = parseProviderObjectId\(from\?\.\["id"\]\);/);
      expect(parser).toMatch(/fromId === undefined \|\|/);
    }
    expect(readPort()).toMatch(/const visibilityOf = \(hidden: boolean \| null\): InteractionDto\["visibility"\] => \(hidden === null \? "unknown" : hidden \? "hidden" : "visible"\);/);
  });

  it("the README records the P12-B1 slice: offline, unregistered, the per-platform kinds, the author rule and the LIVE-verify items", () => {
    const doc = readFileSync(path.join(root, "design/phase-7g/meta-provider/README.md"), "utf8");
    const section = doc.slice(doc.indexOf("## read_interactions (Step 7G-H5.5-P12-B1) — IMPLEMENTED_OFFLINE_NOT_REGISTERED"));
    expect(section.length).toBeGreaterThan(0);
    for (const phrase of [
      "belong to P12-B2, atomically",
      "Every Meta `read_interactions` scope stays\nUNKNOWN_NOT_VALIDATED",
      "`comment` and `reply`",
      "`comment` only (top-level)",
      "a missing `from` or `from.id` fails the WHOLE page",
      "Facebook's ONLY\ncontent authority is `object.id`",
      "no permission set is claimed here and none is minimal",
    ]) expect(section, phrase).toContain(phrase);
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
    // parsePageCursor appears exactly five times: inside the encoder (over the prefixed payload) and as the input check
    // of each listContent branch (Facebook Page, Instagram account — Step 7G-H5.5-P11-B) and each listInteractions
    // branch (Step 7G-H5.5-P12-B1).
    expect(code.match(/parsePageCursor\(/g)).toHaveLength(5);
    expect(code.match(/if \(cursor !== null && parsePageCursor\(cursor\) === undefined\) throw new PermanentRejectedError\("listContent", "invalid_cursor"\);/g)).toHaveLength(2);
    expect(code.match(/if \(cursor !== null && parsePageCursor\(cursor\) === undefined\) throw new PermanentRejectedError\("listInteractions", "invalid_cursor"\);/g)).toHaveLength(2);
    expect(code.match(/const next = encodeMetaPageCursor\(list\.after\);/g)).toHaveLength(2);
    // The interaction pages continue through the same envelope, decoded and encoded under their own operation.
    expect(code.match(/const after: MetaGraphCursor \| null = cursor === null \? null : decodeMetaPageCursor\(cursor, "listInteractions"\);/g)).toHaveLength(2);
    expect(code.match(/encodeMetaPageCursor\(/g)).toHaveLength(4); // the helper, two content pages, one shared interaction page
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
    // Step 7G-H5.5-P12-B2: the read_interactions diagnostic too — one first page of each list, its kind only, no cursor.
    const interactions = codeOf("jobs/integration-read-interactions-validation.ts");
    expect(interactions).toMatch(/readonly pagination: "more" \| "end" \| null;/);
    expect(interactions).not.toMatch(/\bcursor\s*:|next\.cursor|rawReference|\.text\b|displayName|handle\b/);
    expect(interactions.match(/, window, null\)/g)).toHaveLength(2);
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
