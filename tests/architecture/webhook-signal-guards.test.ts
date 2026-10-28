/**
 * Step H6-F1 — static guards around the pure webhook boundary (design H6-F0 §2, §4–§6, §11):
 *   - the Meta webhook module is PURE: contract, identity and node:crypto only — no persistence, scope, HTTP, clock,
 *     environment, provider transport or credential opener;
 *   - signatures are HMAC-SHA256 over the raw bytes; no SHA-1, no bypass, no JSON re-serialization before verifying;
 *   - hints are identifiers only: the contract type has exactly the pinned fields, and no webhook module can name a
 *     source fact, a removal basis, an availability, coverage or a watermark;
 *   - H6-F1 added no route, no migration, no task and opened no new secret.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { WebhookEventHint } from "@/integrations/providers/contract";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { RELEASE_PLANES } from "@/tools/trigger/release-pair";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../support/source-scan";

const META = "integrations/providers/meta/webhooks.ts";
const CONTRACT = "integrations/providers/contract/webhooks.ts";
const WEBHOOK_MODULES = [CONTRACT, META, "integrations/providers/simulator/webhooks.ts"];
const PRODUCTION = ["app", "ui", "server", "domain", "modules", "platform", "integrations", "jobs", "db", "tools"];
const importsOf = (file: string): string[] => [...codeOf(file).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");

describe("H6-F1: the Meta webhook module is pure", () => {
  it("imports only node:crypto and the provider contract (not even the domain directly: the adapter rule)", () => {
    const imports = importsOf(META);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) expect(specifier, specifier).toMatch(/^(node:crypto|\.\.\/contract\/(credential|identity|webhooks))$/);
    const code = codeOf(META);
    expect(code).not.toMatch(/Date\.now|new Date\(\)|process\.env|fetch\(|readFileSync|setTimeout|Math\.random|randomUUID|randomBytes/);
    expect(code).not.toMatch(/withUserScope|withWorkspaceJobScope|withSystemScope|platform\/db|drizzle|workspace_id|workspaceId|connectedAccountId|graph-transport|MetaGraphTransport|withCredential|openCredential/);
  });

  it("verifies HMAC-SHA256 over the raw bytes, compares in constant time, accepts no other scheme and never re-serializes before verifying", () => {
    const code = codeOf(META);
    expect([...code.matchAll(/createHmac\(("[^"]+"),/g)].map((m) => m[1])).toEqual(['"sha256"']);
    expect(code).toMatch(/createHmac\("sha256", appSecret\)\.update\(rawBody\)\.digest\(\)/);
    expect(code).toMatch(/timingSafeEqual\(presented, expected\)/);
    expect(code).toMatch(/if \(match\[1\] !== "sha256"\) return \{ ok: false, reason: "unsupported_signature_scheme" \};/);
    expect(code).not.toMatch(/sha1|JSON\.stringify/);
    // Verification precedes decoding: the JSON parse appears after the verdict check, and only once.
    expect(code.indexOf("if (!verdict.ok) return rejected(verdict.reason);")).toBeLessThan(code.indexOf("JSON.parse("));
    expect([...code.matchAll(/JSON\.parse\(/g)]).toHaveLength(1);
    expect(code).toMatch(/if \(bytes\.byteLength > MAX_WEBHOOK_BODY_BYTES\) return rejected\("body_too_large"\);/);
    // No development/test bypass of any kind.
    expect(code).not.toMatch(/NODE_ENV|skipSignature|bypass|insecure|allowUnsigned/i);
  });

  it("the secret is explicit material: the pure functions take a string, the port opens a SecretValue only inside the call", () => {
    const code = codeOf(META);
    expect(code).toMatch(/export function verifyMetaWebhookSignature\(appSecret: string, rawBody: Uint8Array, header: string \| undefined\)/);
    expect(code).toMatch(/export function parseMetaWebhook\(appSecret: string, request: WebhookRequest\)/);
    expect([...code.matchAll(/\.expose\(\)/g)]).toHaveLength(2);
    expect(code).not.toMatch(/console\.|log\(|logger/);
  });
});

describe("H6-F1: hints are identifiers only", () => {
  it("the contract hint type has exactly the pinned fields (type-level and text-level)", () => {
    const fields = { eventId: true, deliveryId: true, account: true, target: true, content: true, parent: true, change: true, occurredAt: true, sequence: true } satisfies Record<keyof WebhookEventHint, true>;
    expect(Object.keys(fields).sort()).toEqual(["account", "change", "content", "deliveryId", "eventId", "occurredAt", "parent", "sequence", "target"]);
    const declaration = codeOf(CONTRACT).slice(codeOf(CONTRACT).indexOf("export interface WebhookEventHint"), codeOf(CONTRACT).indexOf("export interface WebhookParseResult"));
    expect([...declaration.matchAll(/^\s+readonly (\w+):/gm)].map((m) => m[1])).toEqual(["eventId", "deliveryId", "account", "target", "content", "parent", "change", "occurredAt", "sequence"]);
    expect(declaration).not.toMatch(/text|message|name|username|from|author|value|body|token|secret/i);
  });

  it("the Meta parser never reads text or author fields and drops the provider value object", () => {
    const code = codeOf(META);
    for (const forbidden of ['value["message"]', 'value["text"]', 'value["from"]', 'value["name"]', 'value["username"]', 'value["sender_name"]', 'value["link"]', 'value["story"]']) expect(code).not.toContain(forbidden);
    // Only identifier-bearing keys are read from a change value.
    const read = [...code.matchAll(/value\["([a-z_]+)"\]/g)].map((m) => m[1]).sort();
    expect([...new Set(read)]).toEqual(["comment_id", "id", "item", "media", "parent_id", "post_id", "verb"]);
    expect([...code.matchAll(/media\["([a-z_]+)"\]/g)].map((m) => m[1])).toEqual(["id"]);
    expect([...code.matchAll(/entry\["([a-z_]+)"\]/g)].map((m) => m[1]).sort()).toEqual(["changes", "id", "messaging", "time"]);
  });

  it("no webhook module can produce a source fact, a removal, a visibility, coverage or a watermark", () => {
    for (const file of WEBHOOK_MODULES) {
      const code = codeOf(file).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      expect(code, file).not.toMatch(/InteractionSourceFact|removed_at_source|explicit_provider_signal|direct_fetch_confirmed|removalBasis|availability|visibility|coverage|watermark|synced_through|ingestInteractionFact|confirmStoredInteraction/);
    }
    // The Meta parser's consumers: the read port (fails closed without the secret) and, since H6-F3, the web receiver's
    // composition — the only place the webhook port is built from the web's secrets.
    const consumers = sourceFiles(PRODUCTION).filter((file) => /providers\/meta\/webhooks|parseMetaWebhook|createMetaWebhookPort|verifyMetaWebhookHandshake/.test(codeOf(file)) && file !== META);
    expect(consumers).toEqual(["integrations/providers/meta/read-port.ts", "server/webhooks/runtime.ts"]);
    expect(codeOf("integrations/providers/meta/read-port.ts")).toMatch(/if \(secret === undefined\) return Promise\.reject\(new WebhookRejectedError\("invalid_signature"\)\);/);
  });

  it("the staging stub keeps failing closed and the simulator keeps its own scheme over the exact bytes", () => {
    expect(codeOf("integrations/providers/staging-stub/index.ts")).toMatch(/parseWebhook: \(\) => Promise\.reject\(new WebhookRejectedError\("invalid_signature"\)\)/);
    const simulator = codeOf("integrations/providers/simulator/webhooks.ts");
    expect(simulator).toMatch(/\.update\(webhookRawBytes\(\{ rawBody \}\)\)/);
    expect(simulator).toMatch(/new TextDecoder\("utf-8", \{ fatal: true \}\)\.decode\(webhookRawBytes\(request\)\)/);
  });
});

describe("H6-F1 → H6-F3: scope", () => {
  it("one Meta-only route, no further migration, exactly the two F3 system tasks, the verify token web-only", () => {
    // H6-F3: exactly one webhook route, Meta-only (no generic provider dispatch).
    expect(sourceFiles(["app"]).filter((file) => file.startsWith("app/api/webhooks/"))).toEqual(["app/api/webhooks/meta/route.ts"]);
    for (const file of sourceFiles(["app", "server"]).filter((f) => !f.startsWith("server/webhooks/") && f !== "app/api/webhooks/meta/route.ts")) {
      expect(codeOf(file), file).not.toMatch(/parseWebhook|x-hub-signature|hub\.challenge/);
    }
    const migrations = readdirSync(path.join(REPOSITORY_ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    // H6-F2 added exactly 0022; H6-F3 and H6-F4 none; H6-F4b exactly 0023 (persistence only).
    expect(migrations.slice(-2)).toEqual(["0022_provider_webhook_signals.sql", "0023_resumable_signal_progress.sql"]);
    expect(PRODUCTION_TASKS.tasks.map((t) => t.name).filter((n) => /webhook|provider_event|process_signal|purge/.test(n)).sort()).toEqual(["ingestion.process_signals", "ingestion.purge_provider_events", "ingestion.route_provider_events"]);
    // H6-F4: the tenant consumer of the routed rows.
    expect(PRODUCTION_TASKS.tenant("ingestion.process_signals")?.executionPlane).toBe("main");
    expect(RELEASE_PLANES.map((p) => [p.plane, p.expectedTasks])).toEqual([["integration", 7], ["main", 11]]);
    // The verify token: read by the web receiver's config only; refused by both jobs planes.
    expect(sourceFiles(PRODUCTION).filter((file) => /PROVIDER_META_WEBHOOK_VERIFY_TOKEN/.test(codeOf(file))).sort()).toEqual(["jobs/plane-environment.ts", "server/webhooks/meta-config.ts"]);
    // The App Secret still reaches only the web's Meta app configuration; no jobs-plane code names the webhook secret.
    expect(sourceFiles(["jobs"]).filter((file) => /webhookSecret/.test(codeOf(file)))).toEqual([]);
    expect(sourceFiles(PRODUCTION).filter((file) => /webhookSecret/.test(codeOf(file)))).toEqual(["integrations/providers/meta/read-port.ts"]);
  });
});
