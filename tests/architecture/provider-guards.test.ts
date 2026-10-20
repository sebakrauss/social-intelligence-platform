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
  READ_OPERATIONS,
  type AuthorizationOperation,
  type MutationOperation,
  type ProviderAuthorizationPort,
  type ProviderReadPort,
  type ReadOperation,
} from "@/integrations/providers/contract";
import type { ProviderMutationPort } from "@/integrations/providers/contract/mutation-port";
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

describe("Meta read port (Step 7G-E): discoverAssets only, the contained query-token Graph transport", () => {
  const RUNTIME = ["app", "ui", "server", "platform", "jobs", "modules", "integrations", "domain", "proxy.ts", "next.config.ts", "trigger.config.ts", "trigger.integration.config.ts"];
  const META = "integrations/providers/meta";
  const READ = [`${META}/read-port.ts`, `${META}/graph-transport.ts`];
  const transport = () => codeOf(`${META}/graph-transport.ts`);

  it("the access token is unwrapped only where the Graph request is built, and placed exactly once, as the documented query parameter", () => {
    const real = sourceFiles(RUNTIME).filter((file) => !file.startsWith("integrations/providers/simulator/"));
    expect(findReferences(real, [/\btoken\.expose\(\)/]).map(([file]) => file)).toEqual([`${META}/graph-transport.ts`]);
    expect(transport().match(/access_token/g)).toHaveLength(1);
    expect(transport()).toMatch(/\["access_token", token\.expose\(\)\]/);
    expect(codeOf(`${META}/read-port.ts`)).not.toMatch(/\.expose\(|access_token/);
  });

  it("the Graph transport never uses a header token, the provider URL or anything of the app's secrets", () => {
    expect(transport()).not.toMatch(/authorization|Bearer|response\.url|\.url\b(?!\.)|paging\.next|client_secret|appsecret|client_token|PROVIDER_META_|clientSecret/i);
    expect(transport()).toMatch(/redirect: "manual"/);
    expect(transport()).toMatch(/credentials: "omit"/);
    expect(transport()).toMatch(/signal: AbortSignal\.timeout\(timeoutMs\)/);
    expect(transport()).toMatch(/headers: \{ accept: "application\/json" \}/);
  });

  it("only documented reads: /me/accounts with id,name (no limit), the Page's instagram_business_account and the IG account's id,username; describeAccount's Page id,name and me/permissions", () => {
    expect(transport()).toMatch(/\["me", "accounts"\]/);
    expect(transport()).toMatch(/\["me", "permissions"\]/);
    expect([...transport().matchAll(/\["fields", "([^"]+)"\]/g)].map((match) => match[1]).sort()).toEqual(["id,name", "id,name", "id,name", "id,username", "instagram_business_account", "permission,status"]);
    expect(transport()).not.toMatch(/"limit"|\{[a-z_,]+\}|\.limit\(/);
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
