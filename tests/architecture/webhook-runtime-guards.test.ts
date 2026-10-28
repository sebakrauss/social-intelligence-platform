/**
 * Step H6-F3 — static guards around the webhook HTTP receiver and the MAIN inbox tasks (design H6-F0 §3–§5):
 *   - the route is thin and Meta-only; the receiver never decodes JSON itself and passes only the signature header;
 *   - the webhook configuration (App Secret + verify token) is opened in ONE web composition file;
 *   - the provider-signal scope is used by that composition only; no other scope helper appears in the webhook path;
 *   - the MAIN task file uses literal ids equal to the module constants, builds its own system payload, and reaches no
 *     provider, credential or raw body; process_signals (H6-F4) is a TENANT task, never a system one.
 */
import { describe, expect, it } from "vitest";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { PROVIDER_EVENT_RUNTIME, PURGE_PROVIDER_EVENTS_TASK, ROUTE_PROVIDER_EVENTS_TASK } from "@/modules/ingestion";
import { SYSTEM_TASKS } from "@/platform/jobs/registry";
import { codeOf, sourceFiles } from "../support/source-scan";

const ROUTE = "app/api/webhooks/meta/route.ts";
const RECEIVER = "server/webhooks/meta-receiver.ts";
const RUNTIME = "server/webhooks/runtime.ts";
const CONFIG = "server/webhooks/meta-config.ts";
const TASKS = "jobs/trigger/main/provider-events.ts";
const JOBS = "jobs/provider-events.ts";
const PRODUCTION = ["app", "ui", "server", "domain", "modules", "platform", "integrations", "jobs", "db", "tools"];
const stripComments = (code: string): string => code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
const importsOf = (file: string): string[] => [...codeOf(file).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");

describe("H6-F3: the HTTP receiver", () => {
  it("the route only delegates to the server receiver (no provider, database, scope or secret in app/)", () => {
    expect(importsOf(ROUTE).sort()).toEqual(["@/server/webhooks/meta-receiver", "@/server/webhooks/runtime"]);
    const code = stripComments(codeOf(ROUTE));
    expect(code).toMatch(/export const runtime = "nodejs";/);
    expect(code).toMatch(/export const dynamic = "force-dynamic";/);
    expect(code).not.toMatch(/request\.(json|text|arrayBuffer|formData)\(|cookies\(|headers\(\)|process\.env/);
  });

  it("the receiver is provider-neutral, reads raw bytes only, and orders its checks before any persistence", () => {
    for (const specifier of importsOf(RECEIVER)) expect(specifier, specifier).toMatch(/^@\/(integrations\/providers\/contract|platform\/observability)$/);
    const code = stripComments(codeOf(RECEIVER));
    expect(code).not.toMatch(/request\.(json|text|arrayBuffer|formData)\(|JSON\.parse|JSON\.stringify|cookie|withUserScope|withSystemScope|withWorkspaceJobScope|process\.env/i);
    const order = ["respond(503)", "respond(415)", "MAX_WEBHOOK_REQUEST_BYTES)) {", "readBounded(request", "port.parseWebhook(", "deps.record(", "deps.afterResponse("];
    const post = code.slice(code.indexOf("export async function handleMetaWebhookPost"));
    const positions = order.map((needle) => post.indexOf(needle));
    for (const [i, position] of positions.entries()) expect(position, order[i]).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // A nudge only after a NEW receipt with new hints; the nudge's failure is swallowed.
    expect(code).toMatch(/if \(receipt\.outcome === "recorded" && receipt\.newHintCount > 0\) \{/);
  });

  it("the webhook configuration is opened only in the web composition, and only the composition uses the provider-signal scope", () => {
    expect(sourceFiles(PRODUCTION).filter((file) => /readMetaWebhookConfig\(/.test(stripComments(codeOf(file))) && file !== CONFIG)).toEqual([RUNTIME]);
    expect(sourceFiles(PRODUCTION).filter((file) => /withProviderSignalScope\(/.test(stripComments(codeOf(file))) && !file.startsWith("platform/db/"))).toEqual([RUNTIME]);
    const runtime = stripComments(codeOf(RUNTIME));
    expect(runtime).not.toMatch(/withUserScope|withSystemScope|withWorkspaceJobScope|console\.|\.expose\(\)/);
    // The provider-signal scope: web login only, fixed literal role, no claims, no workspace binding.
    const scopes = codeOf("platform/db/scopes.ts");
    const body = scopes.slice(scopes.indexOf("export async function withProviderSignalScope"), scopes.indexOf("}\n", scopes.indexOf("export async function withProviderSignalScope")));
    expect(body).toMatch(/assertKind\(database, "web"\);/);
    expect(body).toMatch(/set local role authenticated/);
    expect(body).not.toMatch(/claims|bind|workspace|set_config/i);
  });

  it("the proxy exempts exactly the Meta webhook path, after the forbidden-environment refusal", () => {
    const code = stripComments(codeOf("proxy.ts"));
    expect(code).toMatch(/SESSIONLESS_PATHS: readonly string\[\] = Object\.freeze\(\["\/api\/webhooks\/meta"\]\);/);
    expect(code).toMatch(/SESSIONLESS_PATHS\.includes\(request\.nextUrl\.pathname\)/);
    expect(code).not.toMatch(/startsWith|\/api\/webhooks\/["'`]/);
    expect(code.indexOf("rejectForbiddenWebEnvironment()")).toBeLessThan(code.indexOf("SESSIONLESS_PATHS.includes"));
  });
});

describe("H6-F3: the MAIN inbox tasks", () => {
  it("are exactly two named system tasks with the frozen crons, batches and MAIN plane; process_signals is a tenant task", () => {
    expect(SYSTEM_TASKS).toContain(ROUTE_PROVIDER_EVENTS_TASK);
    expect(SYSTEM_TASKS).toContain(PURGE_PROVIDER_EVENTS_TASK);
    expect(SYSTEM_TASKS).not.toContain("ingestion.process_signals");
    expect(PRODUCTION_TASKS.get(ROUTE_PROVIDER_EVENTS_TASK)).toMatchObject({ scope: "system", executionPlane: "main", schedule: { cron: "* * * * *" } });
    expect(PRODUCTION_TASKS.get(PURGE_PROVIDER_EVENTS_TASK)).toMatchObject({ scope: "system", executionPlane: "main", schedule: { cron: "*/15 * * * *" } });
    expect(PRODUCTION_TASKS.tenant("ingestion.process_signals")?.scope).toBe("workspace");
    expect(PROVIDER_EVENT_RUNTIME).toEqual({ routerBatchLimit: 500, purgeBatchSize: 1000, purgeMaxBatches: 5 });
    expect(PROVIDER_EVENT_RUNTIME.purgeBatchSize * PROVIDER_EVENT_RUNTIME.purgeMaxBatches).toBeLessThanOrEqual(5000);
  });

  it("the Trigger file uses literal ids equal to the module constants and never trusts the vendor payload", () => {
    const code = codeOf(TASKS);
    expect([...code.matchAll(/^\s+id: "([^"]+)",$/gm)].map((m) => m[1])).toEqual([ROUTE_PROVIDER_EVENTS_TASK, PURGE_PROVIDER_EVENTS_TASK]);
    expect(code).toMatch(/run: async \(_payload, \{ ctx \}\) =>\s+runSystem\(ROUTE_PROVIDER_EVENTS_TASK, schedulePayload\(ROUTE_PROVIDER_EVENTS_TASK\)/);
    expect(code).toMatch(/run: async \(_payload, \{ ctx \}\) =>\s+runSystem\(PURGE_PROVIDER_EVENTS_TASK, schedulePayload\(PURGE_PROVIDER_EVENTS_TASK\)/);
    expect(stripComments(code)).not.toMatch(/\b_payload\./);
  });

  it("the task bodies reach no provider, credential, raw body, mutation or outbox delivery state", () => {
    for (const file of [TASKS, JOBS, "modules/ingestion/application/provider-events.ts", "modules/ingestion/persistence/provider-events-store.ts"]) {
      const code = stripComments(codeOf(file));
      expect(code, file).not.toMatch(/integrations\/providers\/(meta|tiktok|simulator)|withCredential|openCredential|credential-access|mutations\/|outbox-delivery|dispatchOutbox/);
    }
    // The system store never selects a receipt body; the only body write is the web receipt adapter.
    const store = stripComments(codeOf("modules/ingestion/persistence/provider-events-store.ts"));
    expect(store).not.toMatch(/from system\.provider_event_inbox/);
    expect(store).toMatch(/const body = delivery\.rawBodyRetainable \? Buffer\.from\(bytes\.buffer, bytes\.byteOffset, bytes\.byteLength\) : null;/);
  });
});
