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
import { codeOf, sourceFiles } from "../support/source-scan";

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
