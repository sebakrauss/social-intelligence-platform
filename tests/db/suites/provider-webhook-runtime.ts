/**
 * Step H6-F3 — the webhook runtime on the real database, through the runtime logins and the PRODUCTION adapters:
 *   - withProviderSignalScope (web login → authenticated, no claims, no workspace) + recordProviderWebhook record the
 *     REAL H6-F1 parse output of signed synthetic deliveries; duplicates are recognized; retention is the adapter's;
 *   - the scope reaches nothing else: no tenant row, no inbox read, no routing, no reconciliation request;
 *   - runRouteProviderEvents / runPurgeProviderEvents (the MAIN task bodies) over the system login: routed, retry left
 *     not-due, MULTI_ORG_LIMIT terminal with zero rows, overlapping runs never route a hint twice, bounded purge;
 *   - logs carry counts only.
 * Synthetic tenants only; no provider is called; nothing is dispatched (process_signals rows stay PENDING).
 */
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SecretValue, isoInstant, type VerifiedWebhookDelivery } from "@/integrations/providers/contract";
import { createMetaWebhookPort } from "@/integrations/providers/meta/webhooks";
import { runPurgeProviderEvents, runRouteProviderEvents } from "@/jobs/provider-events";
import { recordProviderWebhook } from "@/modules/ingestion/persistence";
import { postgresError, withProviderSignalScope, withWorkspaceJobScope, type RuntimeDatabase } from "@/platform/db";
import { parseSystemJobPayload, type SystemJobContext } from "@/platform/jobs";
import { createLogger } from "@/platform/observability";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";
import { sqlState } from "./helpers";

const SECRET = "synthetic-meta-app-secret-for-db-tests";
const PORT = createMetaWebhookPort({ appSecret: new SecretValue(SECRET), verifyToken: new SecretValue("synthetic-verify-token-0001") });
const FIXTURES = path.resolve(import.meta.dirname, "../../../fixtures/providers/meta-webhooks");
const PROCESS = "ingestion.process_signals";
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

const parse = (bytes: Uint8Array): Promise<VerifiedWebhookDelivery> =>
  PORT.parseWebhook({ headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(bytes).digest("hex")}` }, rawBody: bytes, receivedAt: isoInstant(new Date()) });
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(path.join(FIXTURES, `${name}.json`)));
/** A signed-able synthetic Page delivery: one comment `add` per id on the given Page asset. */
const pageComments = (asset: string, count: number): Uint8Array => new TextEncoder().encode(JSON.stringify({
  object: "page",
  entry: [{
    id: asset,
    time: 1_793_188_800,
    changes: Array.from({ length: count }, (_, i) => ({
      field: "feed",
      value: { item: "comment", verb: "add", comment_id: `${asset}_9${String(i).padStart(5, "0")}${randomUUID().replace(/\D/g, "").slice(0, 6)}`, post_id: `${asset}_1`, parent_id: `${asset}_1`, created_time: 1_793_188_800 },
    })),
  }],
}));

interface Tenant { readonly organizationId: string; readonly workspaceId: string; readonly account: string }

export function defineProviderWebhookRuntimeSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let system: RuntimeDatabase<"system">;
  const organizations: string[] = [];
  const lines: string[] = [];
  const logger = createLogger({ sink: (line) => lines.push(line) });

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const record = (delivery: VerifiedWebhookDelivery, bytes: Uint8Array) => withProviderSignalScope(web, (tx) => recordProviderWebhook(tx, delivery, bytes));
  const hintsOf = (keys: readonly string[]) =>
    oracle<{ id: string; hint_key: string; state: string; next_route_at: Date | null }>("select id, hint_key, state, next_route_at from system.provider_event_hints where hint_key = any($1::text[]) order by hint_key", [keys]);
  const context = (task: "ingestion.route_provider_events" | "ingestion.purge_provider_events"): SystemJobContext => ({
    payload: parseSystemJobPayload({ v: 1, scope: "system", task, correlationId: `test-${randomUUID()}`, initiator: { type: "system" } }),
    run: { runId: `run_${randomUUID().slice(0, 8)}`, attempt: 1 },
    system,
  });
  const route = () => runRouteProviderEvents(context("ingestion.route_provider_events"), logger);

  const tenant = async (asset: string): Promise<Tenant> => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const owner = randomUUID();
    organizations.push(organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Runtime', now())", [organizationId]);
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'MONITOR_ONLY', now())", [workspaceId, organizationId]);
    await privileged.query("insert into tenancy.organization_memberships values ($1, $2, 'OWNER', now())", [organizationId, owner]);
    await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, 'OWNER', '{}', now())", [organizationId, workspaceId, owner]);
    const connection = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`, [connection, organizationId, workspaceId, owner]);
    const discovered = randomUUID();
    await privileged.query(
      `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'facebook', $5, 'content_bearing', 'Synthetic', now(), now(), now())`, [discovered, organizationId, workspaceId, connection, asset]);
    const account = randomUUID();
    await privileged.query(
      `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
       select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`,
      [account, discovered]);
    return { organizationId, workspaceId, account };
  };

  beforeAll(() => {
    const target = getTarget();
    privileged = privilegedPool(target);
    web = runtimeDatabase(target, "web", 2);
    worker = runtimeDatabase(target, "worker", 1);
    system = runtimeDatabase(target, "system", 4);
  });
  afterAll(async () => {
    await Promise.all([web.end(), worker.end(), system.end()]);
    await privileged.query("delete from system.provider_event_inbox");
    await cleanupWorld(privileged, organizations);
    await privileged.end();
  });

  describe("receipt through the provider-signal scope and the production adapter", () => {
    it("records the real H6-F1 parse output: exact bytes, one hint row per hint (eventId = hint_key); a re-delivery is a duplicate", async () => {
      const bytes = fixture("page-comment-add");
      const delivery = await parse(bytes);
      const first = await record(delivery, bytes);
      expect(first).toMatchObject({ outcome: "recorded", newHintCount: delivery.hints.length, knownHintCount: 0 });
      const [inbox] = await oracle<{ body: Buffer | null; body_sha256: string; raw_body_retainable: boolean; hint_count: number }>(
        "select body, body_sha256, raw_body_retainable, hint_count from system.provider_event_inbox where id = $1", [first.receiptId]);
      expect(inbox?.body?.equals(Buffer.from(bytes))).toBe(true);
      expect(inbox).toMatchObject({ body_sha256: delivery.bodySha256, raw_body_retainable: true, hint_count: delivery.hints.length });
      expect((await hintsOf(delivery.hints.map((h) => h.eventId))).map((h) => h.state)).toEqual(delivery.hints.map(() => "PENDING"));
      const again = await record(await parse(bytes), bytes);
      expect(again).toEqual({ outcome: "duplicate", receiptId: first.receiptId, newHintCount: 0, knownHintCount: 0 });
      expect((await oracle<{ n: number }>("select count(*)::int as n from system.provider_event_inbox where body_sha256 = $1", [delivery.bodySha256]))[0]?.n).toBe(1);
    });

    it("honors the adapter's retention verdict: a delivery carrying a disallowed field keeps metadata and hints, never the body", async () => {
      const bytes = fixture("page-feed-plus-messaging");
      const delivery = await parse(bytes);
      expect(delivery.rawBodyRetainable).toBe(false);
      const receipt = await record(delivery, bytes);
      const [inbox] = await oracle<{ body: Buffer | null; body_bytes: number; unsupported_count: number }>("select body, body_bytes, unsupported_count from system.provider_event_inbox where id = $1", [receipt.receiptId]);
      expect(inbox).toMatchObject({ body: null, body_bytes: bytes.byteLength, unsupported_count: 1 });
    });

    it("the scope is the web login only, and reaches nothing but the receipt definer", async () => {
      await expect(withProviderSignalScope(worker as unknown as RuntimeDatabase<"web">, () => Promise.resolve(1))).rejects.toThrow();
      await expect(withProviderSignalScope(system as unknown as RuntimeDatabase<"web">, () => Promise.resolve(1))).rejects.toThrow();
      const t = await tenant("930000000000001");
      // No claims, no workspace: every tenant table is invisible (RLS) or unreadable.
      for (const table of ["tenancy.workspaces", "connections.connected_accounts", "content.content_items", "interactions.interactions", "ingestion.signal_marks"]) {
        const rows = await withProviderSignalScope(web, (tx) => tx.execute(sql.raw(`select 1 from ${table} limit 1`))).then((r) => r.rows.length, (e: unknown) => postgresError(e)?.code ?? "error");
        expect([0, "42501"], table).toContain(rows);
      }
      expect(await sqlState(withProviderSignalScope(web, (tx) => tx.execute(sql`select 1 from system.provider_event_inbox`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(withProviderSignalScope(web, (tx) => tx.execute(sql`select 1 from system.provider_event_hints`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(withProviderSignalScope(web, (tx) => tx.execute(sql`select * from system.route_provider_hint(${randomUUID()}::uuid)`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(withProviderSignalScope(web, (tx) => tx.execute(sql`select * from system.purge_provider_events(${10})`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(withProviderSignalScope(web, (tx) => tx.execute(sql`select * from system.dispatch_due_signal_marks(${10})`)))).toMatchObject({ code: "42501" });
      const reconciliation = await withProviderSignalScope(web, (tx) => tx.execute(sql`select * from ingestion.request_reconciliation(${t.account}::uuid, ${"whk-test"}, null, null)`)).then(() => "allowed", (e: unknown) => postgresError(e)?.code ?? "error");
      expect(reconciliation).toBe("42501");
      expect((await oracle<{ n: number }>("select count(*)::int as n from ingestion.reconciliation_runs where workspace_id = $1", [t.workspaceId]))[0]?.n).toBe(0);
    });
  });

  describe("MAIN router task body (runRouteProviderEvents)", () => {
    it("routes a matched hint to one IDs-only process_signals row; an unmatched one is left RETRYABLE and not due", async () => {
      const t = await tenant("930000000000002");
      const matchedBytes = pageComments("930000000000002", 1);
      const matched = await parse(matchedBytes);
      await record(matched, matchedBytes);
      const orphanBytes = pageComments("930000000000099", 1);
      const orphan = await parse(orphanBytes);
      await record(orphan, orphanBytes);
      const summary = await route();
      expect(summary.outcomes.routed).toBeGreaterThanOrEqual(1);
      expect(summary.outcomes.retry).toBeGreaterThanOrEqual(1);
      const [routedHint] = await hintsOf([matched.hints[0]?.eventId ?? ""]);
      const [orphanHint] = await hintsOf([orphan.hints[0]?.eventId ?? ""]);
      expect(routedHint?.state).toBe("ROUTED");
      expect(orphanHint?.state).toBe("RETRYABLE");
      expect(orphanHint?.next_route_at?.getTime()).toBeGreaterThan(Date.now());
      const rows = await oracle<{ workspace_id: string; subject_ids: Record<string, string>; status: string }>(
        "select workspace_id, subject_ids, status from system.outbox where topic = $1 and subject_ids ->> 'provider_event_hint_id' = $2", [PROCESS, routedHint?.id]);
      expect(rows).toEqual([{ workspace_id: t.workspaceId, subject_ids: { connected_account_id: t.account, provider_event_hint_id: routedHint?.id }, status: "PENDING" }]);
      // The next run does not see the not-due orphan, and never re-routes the routed hint.
      const next = await route();
      expect(next.outcomes.retry).toBe(0);
      expect(next.outcomes.routed).toBe(0);
    });

    it("more than five organizations: MULTI_ORG_LIMIT, zero rows, and an error-level alert with a count", async () => {
      const asset = "930000000000003";
      await Promise.all(Array.from({ length: 6 }, () => tenant(asset)));
      const bytes = pageComments(asset, 1);
      const delivery = await parse(bytes);
      await record(delivery, bytes);
      lines.length = 0;
      const summary = await route();
      expect(summary.outcomes.multi_org_limit).toBe(1);
      const [hint] = await hintsOf([delivery.hints[0]?.eventId ?? ""]);
      expect(hint?.state).toBe("MULTI_ORG_LIMIT");
      expect((await oracle<{ n: number }>("select count(*)::int as n from system.outbox where topic = $1 and subject_ids ->> 'provider_event_hint_id' = $2", [PROCESS, hint?.id]))[0]?.n).toBe(0);
      expect(lines.some((line) => line.includes("webhook.route.multi_org_limit_alert") && line.includes('"level":"error"'))).toBe(true);
    });

    it("overlapping router runs never route a hint twice (row lock in the definer; one transaction per hint)", async () => {
      const t = await tenant("930000000000004");
      const bytes = pageComments("930000000000004", 10);
      const delivery = await parse(bytes);
      await record(delivery, bytes);
      const bytes2 = pageComments("930000000000004", 10);
      const delivery2 = await parse(bytes2);
      await record(delivery2, bytes2);
      const keys = [...delivery.hints, ...delivery2.hints].map((h) => h.eventId);
      expect(new Set(keys).size).toBe(20);
      const [a, b] = await Promise.all([route(), route()]);
      expect(a.outcomes.routed + b.outcomes.routed).toBeGreaterThanOrEqual(20);
      const hints = await hintsOf(keys);
      expect(hints.map((h) => h.state)).toEqual(keys.map(() => "ROUTED"));
      const perHint = await oracle<{ hint: string; n: number }>(
        "select subject_ids ->> 'provider_event_hint_id' as hint, count(*)::int as n from system.outbox where topic = $1 and workspace_id = $2 group by 1", [PROCESS, t.workspaceId]);
      expect(perHint).toHaveLength(20);
      expect(perHint.every((row) => row.n === 1)).toBe(true);
    });

    it("the router reads hints only: the system login still cannot read a receipt body", async () => {
      expect(await sqlState(withWorkspaceJobScope(worker, randomUUID(), (tx) => tx.execute(sql`select 1 from system.provider_event_hints`)))).toMatchObject({ code: "42501" });
      const { withSystemScope } = await import("@/platform/db/system-scope");
      expect(await sqlState(withSystemScope(system, (tx) => tx.execute(sql`select body from system.provider_event_inbox`)))).toMatchObject({ code: "42501" });
    });
  });

  describe("MAIN purge task body (runPurgeProviderEvents)", () => {
    it("deletes receipts older than 7 days with their hints, keeps fresh ones, and reports bounded batches", async () => {
      const oldBytes = pageComments("930000000000005", 2);
      const old = await record(await parse(oldBytes), oldBytes);
      const freshBytes = pageComments("930000000000006", 1);
      const fresh = await record(await parse(freshBytes), freshBytes);
      await privileged.query("update system.provider_event_inbox set received_at = now() - interval '8 days' where id = $1", [old.receiptId]);
      const summary = await runPurgeProviderEvents(context("ingestion.purge_provider_events"), logger);
      expect(summary.inboxDeleted).toBeGreaterThanOrEqual(1);
      expect(summary.hintsDeleted).toBeGreaterThanOrEqual(2);
      expect(summary.batches).toBeLessThanOrEqual(5);
      expect(summary.remainderPossible).toBe(false);
      const left = await oracle<{ id: string }>("select id from system.provider_event_inbox where id = any($1::uuid[])", [[old.receiptId, fresh.receiptId]]);
      expect(left.map((r) => r.id)).toEqual([fresh.receiptId]);
      expect((await oracle<{ n: number }>("select count(*)::int as n from system.provider_event_hints where inbox_id = $1", [old.receiptId]))[0]?.n).toBe(0);
    });
  });

  describe("logs", () => {
    it("router and purge logs carry event names and counts only — no hint, receipt, tenant or provider id", () => {
      expect(lines.length).toBeGreaterThan(0);
      const all = lines.join("\n");
      expect(all).not.toMatch(UUID_IN_TEXT);
      expect(all).not.toMatch(/9300000000000\d\d/);
      expect(all).not.toMatch(/Synthetic|body|hint_key/);
    });
  });
}
