/**
 * Step H6-F2 — migration 0022 on the real database, through the runtime logins:
 *   - the provider-signal scope (web login → authenticated, NO claims, NO workspace) records verified receipts;
 *   - the system login routes hints (D-F2: all 1..5 ACTIVE matches, > 5 = MULTI_ORG_LIMIT), dispatches due marks and
 *     purges after 7 days;
 *   - the bound worker reads a routed hint for its own ACTIVE account only, and coalesces tenant signal marks;
 *   - reconciliation runs gain a closed `plan`; the request boundary's worker branch may name it (0019 replaced).
 * Synthetic tenants only; no job runs; no provider is called. A webhook is a signal: nothing here writes canonical state.
 */
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserScope, withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { withSystemScope } from "@/platform/db/system-scope";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";
import { sqlState } from "./helpers";

const RECORD = "select outcome, receipt_id, new_hint_count, known_hint_count from system.record_provider_webhook($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)";
const PROCESS = "ingestion.process_signals";

interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly owner: string;
  readonly account: string;
  readonly platform: "facebook" | "instagram";
  readonly asset: string;
}
interface Hint {
  readonly platform: "facebook" | "instagram";
  readonly provider_asset_id: string;
  readonly target_kind: "content" | "interaction";
  readonly provider_target_id: string;
  readonly provider_content_id: string | null;
  readonly provider_parent_id: string | null;
  readonly change: string;
  readonly occurred_at: string | null;
  readonly hint_key: string;
}
interface Receipt {
  readonly object?: "page" | "instagram";
  readonly body?: Buffer;
  readonly retain?: boolean;
  readonly hints?: readonly Hint[];
  readonly unsupported?: number;
  readonly bodyBytes?: number;
  readonly bodyOverride?: Buffer | null;
}

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const key = (): string => sha(Buffer.from(randomUUID()));
const comment = (asset: string, overrides: Partial<Hint> = {}): Hint => ({
  platform: "facebook",
  provider_asset_id: asset,
  target_kind: "interaction",
  provider_target_id: `${asset}_c_${randomUUID().slice(0, 8)}`,
  provider_content_id: `${asset}_p_1`,
  provider_parent_id: null,
  change: "created",
  occurred_at: "2026-10-28T12:00:00.000Z",
  hint_key: key(),
  ...overrides,
});
const bodyOf = (label: string): Buffer => Buffer.from(JSON.stringify({ object: "page", entry: [], synthetic: label, nonce: randomUUID() }));

export function defineProviderWebhookSignalsSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let system: RuntimeDatabase<"system">;
  const organizations: string[] = [];

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const count = async (query: string, values: readonly unknown[] = []): Promise<number> => (await oracle<{ n: number }>(query, values))[0]?.n ?? -1;

  /** The future provider-signal scope (H6-F3): the web login as `authenticated`, no claims, no workspace binding. */
  const asProviderSignal = async <T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await web.pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
  const argsOf = (r: Receipt): unknown[] => {
    const body = r.body ?? bodyOf("receipt");
    const retain = r.retain ?? true;
    const hints = r.hints ?? [];
    return ["meta", r.object ?? "page", sha(body), r.bodyOverride !== undefined ? r.bodyOverride : retain ? body : null, r.bodyBytes ?? body.length, retain,
      1, hints.length + (r.unsupported ?? 0), 0, r.unsupported ?? 0, 0, JSON.stringify(hints)];
  };
  const record = async (r: Receipt = {}) =>
    (await asProviderSignal((client) => client.query<{ outcome: string; receipt_id: string; new_hint_count: number; known_hint_count: number }>(RECORD, argsOf(r)))).rows[0];
  const hintId = async (hintKey: string): Promise<string> => (await oracle<{ id: string }>("select id from system.provider_event_hints where hint_key = $1", [hintKey]))[0]?.id ?? "";
  const route = async (id: string) =>
    (await withSystemScope(system, (tx) => tx.execute<{ outcome: string; routed_count: number | null }>(sql`select outcome, routed_count from system.route_provider_hint(${id})`))).rows[0];
  const signalRows = (hint: string) =>
    oracle<{ workspace_id: string; organization_id: string; subject_ids: Record<string, string>; dispatch_key: string; initiator_type: string; status: string }>(
      "select workspace_id, organization_id, subject_ids, dispatch_key, initiator_type, status from system.outbox where topic = $1 and subject_ids ->> 'provider_event_hint_id' = $2 order by workspace_id",
      [PROCESS, hint]);
  const asWorker = <T>(t: Pick<Tenant, "workspaceId">, work: (tx: DatabaseTransaction) => Promise<T>) => withWorkspaceJobScope(worker, t.workspaceId, work);

  /** An organization + workspace (OWNER member), an ACTIVE connection and one ACTIVE content-bearing account. */
  const tenant = async (asset: string, platform: "facebook" | "instagram" = "facebook"): Promise<Tenant> => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const owner = randomUUID();
    organizations.push(organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Signals', now())", [organizationId]);
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
       values ($1, $2, $3, $4, $5, $6, 'content_bearing', 'Synthetic', now(), now(), now())`, [discovered, organizationId, workspaceId, connection, platform, asset]);
    const account = randomUUID();
    await privileged.query(
      `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
       select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`,
      [account, discovered]);
    return { organizationId, workspaceId, owner, account, platform, asset };
  };
  const content = async (t: Tenant, providerContentId = `${t.asset}_p_${randomUUID().slice(0, 6)}`): Promise<string> => {
    const id = randomUUID();
    await privileged.query(
      `insert into content.content_items (id, organization_id, workspace_id, platform, connected_account_id, provider_asset_id, provider_content_id, content_kind, reported_source,
                                          source_state, first_observed_at, latest_observed_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'post', 'unknown', 'available', now(), now(), now(), now())`,
      [id, t.organizationId, t.workspaceId, t.platform, t.account, t.asset, providerContentId]);
    return id;
  };
  const deactivate = (t: Tenant) =>
    privileged.query("update connections.connected_accounts set status = 'INACTIVE', deactivated_at = now(), deactivation_reason = 'UNLINKED', updated_at = now() where id = $1", [t.account]);
  const upsertMark = (t: Tenant, kind: "relist" | "account", contentItem: string | null, at: Date, workspace: Pick<Tenant, "workspaceId"> = t) =>
    asWorker(workspace, (tx) => tx.execute(sql`
      insert into ingestion.signal_marks (id, organization_id, workspace_id, connected_account_id, kind, content_item_id, first_signal_at, last_signal_at,
                                          signal_count, expires_at, created_at, updated_at)
      values (${randomUUID()}, ${t.organizationId}, ${t.workspaceId}, ${t.account}, ${kind}, ${contentItem}, ${at}, ${at}, 1, ${new Date(at.getTime() + 7 * 86_400_000)}, now(), now())
      on conflict on constraint signal_marks_one_pending do update
        set last_signal_at = greatest(signal_marks.last_signal_at, excluded.last_signal_at), signal_count = signal_marks.signal_count + 1, updated_at = excluded.updated_at`));
  const marksOf = (t: Tenant) =>
    oracle<{ id: string; kind: string; content_item_id: string | null; signal_count: number; first_signal_at: Date; last_signal_at: Date; dispatch_generation: number; deferred_until: Date | null }>(
      "select id, kind, content_item_id, signal_count, first_signal_at, last_signal_at, dispatch_generation, deferred_until from ingestion.signal_marks where workspace_id = $1 order by kind, created_at", [t.workspaceId]);
  const canonicalCounts = async (orgs: readonly string[]) => ({
    content: await count("select count(*)::int as n from content.content_items where organization_id = any($1::uuid[])", [orgs]),
    interactions: await count("select count(*)::int as n from interactions.interactions where organization_id = any($1::uuid[])", [orgs]),
    conversations: await count("select count(*)::int as n from conversations.conversations where organization_id = any($1::uuid[])", [orgs]),
    coverage: await count("select count(*)::int as n from coverage.coverage_records where organization_id = any($1::uuid[])", [orgs]),
    watermarks: await count("select count(*)::int as n from ingestion.reconciliation_watermarks where organization_id = any($1::uuid[])", [orgs]),
  });

  beforeAll(() => {
    const target = getTarget();
    privileged = privilegedPool(target);
    web = runtimeDatabase(target, "web", 2);
    worker = runtimeDatabase(target, "worker", 2);
    system = runtimeDatabase(target, "system", 2);
  });
  afterAll(async () => {
    await Promise.all([web.end(), worker.end(), system.end()]);
    await privileged.query("delete from system.provider_event_inbox");
    await cleanupWorld(privileged, organizations);
    await privileged.end();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("receipt (system.record_provider_webhook)", () => {
    it("1, 3, 10. the provider-signal scope records a receipt, its exact bytes and its hints atomically", async () => {
      const body = bodyOf("first");
      const hints = [comment("910000000000001"), comment("910000000000001", { change: "edited" })];
      const result = await record({ body, hints });
      expect(result).toMatchObject({ outcome: "recorded", new_hint_count: 2, known_hint_count: 0 });
      const [inbox] = await oracle<{ body: Buffer; body_sha256: string; state: string; hint_count: number; raw_body_retainable: boolean; received_at: Date }>(
        "select body, body_sha256, state, hint_count, raw_body_retainable, received_at from system.provider_event_inbox where id = $1", [result?.receipt_id]);
      expect(inbox?.body.equals(body)).toBe(true);
      expect(inbox).toMatchObject({ body_sha256: sha(body), state: "RECEIVED", hint_count: 2, raw_body_retainable: true });
      expect(await count("select count(*)::int as n from system.provider_event_hints where inbox_id = $1 and state = 'PENDING'", [result?.receipt_id])).toBe(2);
    });

    it("2. a duplicate delivery (same bytes) is recognized: no second receipt, no second hint", async () => {
      const body = bodyOf("dup");
      const hints = [comment("910000000000002")];
      const first = await record({ body, hints });
      const second = await record({ body, hints });
      expect(second).toMatchObject({ outcome: "duplicate", receipt_id: first?.receipt_id, new_hint_count: 0, known_hint_count: 0 });
      expect(await count("select count(*)::int as n from system.provider_event_inbox where body_sha256 = $1", [sha(body)])).toBe(1);
      expect(await count("select count(*)::int as n from system.provider_event_hints where hint_key = $1", [hints[0]?.hint_key])).toBe(1);
    });

    it("4, 14. not retainable: NULL body, metadata and hints kept; an unsupported-only delivery keeps metadata only", async () => {
      const withHint = await record({ retain: false, unsupported: 1, hints: [comment("910000000000003")] });
      const unsupportedOnly = await record({ retain: false, unsupported: 2 });
      const rows = await oracle<{ id: string; body: Buffer | null; state: string; unsupported_count: number; body_bytes: number }>(
        "select id, body, state, unsupported_count, body_bytes from system.provider_event_inbox where id = any($1::uuid[]) order by unsupported_count", [[withHint?.receipt_id, unsupportedOnly?.receipt_id]]);
      expect(rows.map((r) => [r.body, r.state, r.unsupported_count])).toEqual([[null, "RECEIVED", 1], [null, "NO_HINTS", 2]]);
      expect(rows.every((r) => r.body_bytes > 0)).toBe(true);
      // A body is refused when the delivery is not retainable.
      expect(await sqlState(record({ retain: false, bodyOverride: bodyOf("x") }))).toMatchObject({ code: "22023" });
    });

    it("5. a body over 1 MiB, a lying length or a body that doesn't hash to its key is refused with a fixed message", async () => {
      const big = Buffer.alloc(1_048_577, 0x20);
      const oversized = await sqlState(record({ body: big }));
      expect(oversized).toMatchObject({ code: "22023" });
      expect(await sqlState(record({ body: bodyOf("len"), bodyBytes: 3 }))).toMatchObject({ code: "22023" });
      const other = bodyOf("other");
      const error = await asProviderSignal((client) => client.query(RECORD, ["meta", "page", sha(bodyOf("not-this")), other, other.length, true, 1, 0, 0, 0, 0, "[]"])).catch((e: unknown) => e as Error);
      expect((error as { code?: string }).code).toBe("22023");
      expect((error as Error).message).toBe("provider webhook receipt: invalid body");
      expect(JSON.stringify(error)).not.toContain("synthetic");
      expect(await count("select count(*)::int as n from system.provider_event_inbox where body_bytes > 1048576")).toBe(0);
    });

    it("6. a member (verified claims) or a bound workspace can't record; neither can the worker or system logins", async () => {
      const t = await tenant("910000000000006");
      expect(await sqlState(withUserScope(web, { sub: t.owner, role: "authenticated" }, t.workspaceId, (tx) => tx.execute(sql`select * from system.record_provider_webhook('meta', 'page', ${sha(bodyOf("m"))}, null, 1, false, 0, 0, 0, 0, 0, '[]'::jsonb)`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(asWorker(t, (tx) => tx.execute(sql`select * from system.record_provider_webhook('meta', 'page', ${sha(bodyOf("w"))}, null, 1, false, 0, 0, 0, 0, 0, '[]'::jsonb)`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(withSystemScope(system, (tx) => tx.execute(sql`select * from system.record_provider_webhook('meta', 'page', ${sha(bodyOf("s"))}, null, 1, false, 0, 0, 0, 0, 0, '[]'::jsonb)`)))).toMatchObject({ code: "42501" });
      // Claims set by hand without a workspace are refused too: the receipt scope is claim-free by construction.
      expect(await sqlState(asProviderSignal(async (client) => {
        await client.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify({ sub: t.owner, role: "authenticated" }), t.owner]);
        return client.query(RECORD, argsOf({}));
      }))).toMatchObject({ code: "42501" });
    });

    it("7–9. no member, worker or system SELECT on the inbox; the system login reads hints only; neither table has tenant columns", async () => {
      const t = await tenant("910000000000007");
      expect(await sqlState(withUserScope(web, { sub: t.owner, role: "authenticated" }, t.workspaceId, (tx) => tx.execute(sql`select 1 from system.provider_event_inbox`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(asWorker(t, (tx) => tx.execute(sql`select 1 from system.provider_event_inbox`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(asWorker(t, (tx) => tx.execute(sql`select 1 from system.provider_event_hints`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(withSystemScope(system, (tx) => tx.execute(sql`select body from system.provider_event_inbox`)))).toMatchObject({ code: "42501" });
      await withSystemScope(system, (tx) => tx.execute(sql`select hint_key from system.provider_event_hints limit 1`));
      const columns = await oracle<{ table_name: string; column_name: string }>(
        "select table_name, column_name from information_schema.columns where table_schema = 'system' and table_name in ('provider_event_inbox', 'provider_event_hints')");
      expect(columns.filter((c) => /workspace|organization|connected_account|user|author|text|message|name/.test(c.column_name))).toEqual([]);
      expect(columns.filter((c) => c.table_name === "provider_event_hints").map((c) => c.column_name)).not.toContain("body");
    });

    it("11. a hint already known from another delivery is not inserted again (cross-delivery dedupe)", async () => {
      const hint = comment("910000000000011");
      await record({ hints: [hint] });
      const again = await record({ body: bodyOf("again"), hints: [hint] });
      expect(again).toMatchObject({ outcome: "recorded", new_hint_count: 0, known_hint_count: 1 });
      expect(await count("select count(*)::int as n from system.provider_event_hints where hint_key = $1", [hint.hint_key])).toBe(1);
      expect((await oracle<{ state: string }>("select state from system.provider_event_inbox where id = $1", [again?.receipt_id]))[0]?.state).toBe("NO_HINTS");
    });

    it("12–13. hints admit only the approved identifier keys and shapes; anything else rejects the whole receipt", async () => {
      const base = comment("910000000000012");
      const bad: Record<string, unknown>[] = [
        { ...base, text: "Synthetic comment text" },
        { ...base, provider_target_id: "has space" },
        { ...base, platform: "instagram" },
        { ...base, change: "deleted" },
        { ...base, target_kind: "content", provider_content_id: "x" },
        { ...base, occurred_at: "yesterday" },
        { ...base, hint_key: "short" },
        Object.fromEntries(Object.entries(base).filter(([k]) => k !== "hint_key")),
      ];
      for (const hint of bad) {
        const body = bodyOf("bad");
        expect(await sqlState(record({ body, hints: [hint as unknown as Hint] })), JSON.stringify(Object.keys(hint))).toMatchObject({ code: "22023" });
        expect(await count("select count(*)::int as n from system.provider_event_inbox where body_sha256 = $1", [sha(body)])).toBe(0);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("routing (system.route_provider_hint, D-F2)", () => {
    it("15. no ACTIVE match: retry (1, 5, 15 min backoff), then UNMAPPED after the fourth attempt; never early", async () => {
      const hint = comment("920000000000015");
      await record({ hints: [hint] });
      const id = await hintId(hint.hint_key);
      expect(await route(id)).toMatchObject({ outcome: "retry" });
      expect(await route(id)).toMatchObject({ outcome: "not_due" });
      const due = () => privileged.query("update system.provider_event_hints set next_route_at = now() - interval '1 second' where id = $1", [id]);
      for (const expected of ["retry", "retry", "unmapped"]) {
        await due();
        expect(await route(id)).toMatchObject({ outcome: expected });
      }
      expect((await oracle<{ state: string; route_attempts: number }>("select state, route_attempts from system.provider_event_hints where id = $1", [id]))[0]).toEqual({ state: "UNMAPPED", route_attempts: 4 });
      expect(await route(id)).toMatchObject({ outcome: "not_pending" });
    });

    it("16. one ACTIVE match: one IDs-only process_signals row for that tenant; the receipt becomes ROUTED", async () => {
      const t = await tenant("920000000000016");
      const hint = comment(t.asset);
      const receipt = await record({ hints: [hint] });
      const id = await hintId(hint.hint_key);
      expect(await route(id)).toEqual({ outcome: "routed", routed_count: 1 });
      expect(await signalRows(id)).toEqual([{
        workspace_id: t.workspaceId, organization_id: t.organizationId, subject_ids: { connected_account_id: t.account, provider_event_hint_id: id },
        dispatch_key: `${PROCESS}:${id}:${t.account}`, initiator_type: "system", status: "PENDING",
      }]);
      expect((await oracle<{ state: string }>("select state from system.provider_event_inbox where id = $1", [receipt?.receipt_id]))[0]?.state).toBe("ROUTED");
      // Re-routing is a no-op: no second row.
      expect(await route(id)).toMatchObject({ outcome: "not_pending" });
      expect(await signalRows(id)).toHaveLength(1);
    });

    it("17–18, 20. the same asset in 2 or 5 organizations: one independent row for EVERY tenant", async () => {
      for (const n of [2, 5]) {
        const asset = `92000000000001${String(n)}`;
        const tenants = await Promise.all(Array.from({ length: n }, () => tenant(asset)));
        const hint = comment(asset);
        await record({ hints: [hint] });
        const id = await hintId(hint.hint_key);
        expect(await route(id)).toEqual({ outcome: "routed", routed_count: n });
        const rows = await signalRows(id);
        expect(rows.map((r) => r.workspace_id).sort()).toEqual(tenants.map((t) => t.workspaceId).sort());
        expect(new Set(rows.map((r) => r.organization_id)).size).toBe(n);
        for (const row of rows) expect(Object.keys(row.subject_ids).sort()).toEqual(["connected_account_id", "provider_event_hint_id"]);
      }
    });

    it("19–20. six organizations: MULTI_ORG_LIMIT, terminal, ZERO rows (never a partial fan-out)", async () => {
      const asset = "920000000000019";
      await Promise.all(Array.from({ length: 6 }, () => tenant(asset)));
      const hint = comment(asset);
      await record({ hints: [hint] });
      const id = await hintId(hint.hint_key);
      expect(await route(id)).toEqual({ outcome: "multi_org_limit", routed_count: null });
      expect(await signalRows(id)).toEqual([]);
      expect((await oracle<{ state: string; decided_at: Date | null }>("select state, decided_at from system.provider_event_hints where id = $1", [id]))[0]).toMatchObject({ state: "MULTI_ORG_LIMIT" });
      expect(await route(id)).toMatchObject({ outcome: "not_pending" });
    });

    it("21–22. inactive accounts and other platforms are never routed; M-01 refuses a second ACTIVE link in one organization", async () => {
      const active = await tenant("920000000000021");
      const inactive = await tenant("920000000000021");
      await deactivate(inactive);
      // Same provider id on another platform is a different asset.
      const instagram = await tenant("920000000000021", "instagram");
      const hint = comment("920000000000021");
      await record({ hints: [hint] });
      const id = await hintId(hint.hint_key);
      expect(await route(id)).toEqual({ outcome: "routed", routed_count: 1 });
      expect((await signalRows(id)).map((r) => r.workspace_id)).toEqual([active.workspaceId]);
      expect(instagram.platform).toBe("instagram");
      // Corrupt mapping (two ACTIVE links of one asset in one organization) can't exist: M-01 refuses it.
      const second = randomUUID();
      const failure = await privileged.query(
        `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
         select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.connected_accounts where id = $2`,
        [second, active.account]).catch((e: unknown) => e as { code?: string });
      expect((failure as { code?: string }).code).toBe("23505");
    });

    it("routing is the system login's only: members and workers can't route", async () => {
      const t = await tenant("920000000000023");
      const hint = comment(t.asset);
      await record({ hints: [hint] });
      const id = await hintId(hint.hint_key);
      expect(await sqlState(asWorker(t, (tx) => tx.execute(sql`select * from system.route_provider_hint(${id})`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(withUserScope(web, { sub: t.owner, role: "authenticated" }, t.workspaceId, (tx) => tx.execute(sql`select * from system.route_provider_hint(${id})`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(asProviderSignal((client) => client.query("select * from system.route_provider_hint($1)", [id])))).toMatchObject({ code: "42501" });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("worker hint read (ingestion.provider_event_hint)", () => {
    it("23–26. the routed tenant reads identifiers only; another tenant can't; an unlinked account is inactive", async () => {
      const a = await tenant("930000000000023");
      const b = await tenant("930000000000024");
      const hint = comment(a.asset, { provider_parent_id: `${a.asset}_c_parent` });
      await record({ hints: [hint] });
      const id = await hintId(hint.hint_key);
      const read = (t: Tenant, account: string) => asWorker(t, (tx) => tx.execute(sql`select * from ingestion.provider_event_hint(${id}, ${account})`));
      // Not routed yet: invisible.
      expect((await read(a, a.account)).rows[0]).toMatchObject({ outcome: "not_found", hint_key: null });
      await route(id);
      const row = (await read(a, a.account)).rows[0];
      expect(row).toMatchObject({ outcome: "ok", platform: "facebook", target_kind: "interaction", provider_target_id: hint.provider_target_id, provider_parent_id: hint.provider_parent_id, change: "created", hint_key: hint.hint_key });
      expect(Object.keys(row ?? {}).sort()).toEqual(["change", "hint_key", "occurred_at", "outcome", "platform", "provider_content_id", "provider_parent_id", "provider_target_id", "target_kind"]);
      expect(JSON.stringify(row)).not.toMatch(/body|synthetic/);
      // Another tenant (other asset) can't read it with its own account, nor name A's account from its workspace.
      expect((await read(b, b.account)).rows[0]).toMatchObject({ outcome: "not_found", hint_key: null });
      expect((await read(b, a.account)).rows[0]).toMatchObject({ outcome: "account_inactive", hint_key: null });
      // Unlinked between routing and processing: a bounded inactive result.
      await deactivate(a);
      expect((await read(a, a.account)).rows[0]).toMatchObject({ outcome: "account_inactive", hint_key: null });
      // Members and the system login can't call it.
      expect(await sqlState(withUserScope(web, { sub: a.owner, role: "authenticated" }, a.workspaceId, (tx) => tx.execute(sql`select * from ingestion.provider_event_hint(${id}, ${a.account})`)))).toMatchObject({ code: "42501" });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("signal marks (tenant coalescing)", () => {
    it("27–29. a relist mark coalesces (one row, count and last time grow); an account mark has no content", async () => {
      const t = await tenant("940000000000027");
      const item = await content(t);
      const first = new Date("2026-10-28T12:00:00.000Z");
      await upsertMark(t, "relist", item, first);
      await upsertMark(t, "relist", item, new Date(first.getTime() + 30_000));
      await upsertMark(t, "relist", item, new Date(first.getTime() + 10_000));
      await upsertMark(t, "account", null, first);
      await upsertMark(t, "account", null, first);
      const marks = await marksOf(t);
      expect(marks.map((m) => [m.kind, m.content_item_id, m.signal_count])).toEqual([["account", null, 2], ["relist", item, 3]]);
      const relist = marks.find((m) => m.kind === "relist");
      expect(relist?.first_signal_at.toISOString()).toBe(first.toISOString());
      expect(relist?.last_signal_at.toISOString()).toBe(new Date(first.getTime() + 30_000).toISOString());
    });

    it("30–31. a relist mark requires a canonical content item of the SAME account; an account mark can't name one", async () => {
      const t = await tenant("940000000000030");
      const other = await tenant("940000000000031");
      const foreign = await content(other);
      expect(await sqlState(upsertMark(t, "relist", null, new Date()))).toMatchObject({ code: "23514" });
      expect(await sqlState(upsertMark(t, "relist", randomUUID(), new Date()))).toMatchObject({ code: "23503" });
      expect(await sqlState(upsertMark(t, "relist", foreign, new Date()))).toMatchObject({ code: "23503" });
      const own = await content(t);
      expect(await sqlState(upsertMark(t, "account", own, new Date()))).toMatchObject({ code: "23514" });
    });

    it("32–33. members can't write marks; a worker can't touch another workspace's marks", async () => {
      const t = await tenant("940000000000032");
      const u = await tenant("940000000000033");
      expect(await sqlState(withUserScope(web, { sub: t.owner, role: "authenticated" }, t.workspaceId, (tx) => tx.execute(sql`
        insert into ingestion.signal_marks (id, organization_id, workspace_id, connected_account_id, kind, first_signal_at, last_signal_at, signal_count, expires_at, created_at, updated_at)
        values (${randomUUID()}, ${t.organizationId}, ${t.workspaceId}, ${t.account}, 'account', now(), now(), 1, now() + interval '7 days', now(), now())`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(withUserScope(web, { sub: t.owner, role: "authenticated" }, t.workspaceId, (tx) => tx.execute(sql`select 1 from ingestion.signal_marks`)))).toMatchObject({ code: "42501" });
      // Worker bound to U writes a mark for T's workspace: refused by the bound-workspace policy.
      expect(await sqlState(upsertMark(t, "account", null, new Date(), u))).toMatchObject({ code: "42501" });
      await upsertMark(t, "account", null, new Date());
      const seen = await asWorker(u, (tx) => tx.execute(sql`select 1 from ingestion.signal_marks where workspace_id = ${t.workspaceId}`));
      expect(seen.rows).toEqual([]);
      const deleted = await asWorker(u, (tx) => tx.execute(sql`delete from ingestion.signal_marks where workspace_id = ${t.workspaceId}`));
      expect(deleted.rowCount).toBe(0);
      expect(await marksOf(t)).toHaveLength(1);
      // dispatch_generation is never the worker's to rewrite.
      expect(await sqlState(asWorker(t, (tx) => tx.execute(sql`update ingestion.signal_marks set dispatch_generation = 9`)))).toMatchObject({ code: "42501" });
    });

    it("34, 49. expiring marks (worker delete) touches no coverage, watermark or canonical row", async () => {
      const t = await tenant("940000000000034");
      const item = await content(t);
      await upsertMark(t, "relist", item, new Date(Date.now() - 8 * 86_400_000));
      const before = await canonicalCounts([t.organizationId]);
      const expired = await asWorker(t, (tx) => tx.execute(sql`delete from ingestion.signal_marks where expires_at < now()`));
      expect(expired.rowCount).toBe(1);
      expect(await canonicalCounts([t.organizationId])).toEqual(before);
    });

    it("due marks: the system definer re-dispatches an account-only row once, then clears the deferral", async () => {
      const t = await tenant("940000000000040");
      const gone = await tenant("940000000000041");
      await upsertMark(t, "account", null, new Date());
      await upsertMark(gone, "account", null, new Date());
      await privileged.query("update ingestion.signal_marks set deferred_until = now() - interval '1 second' where workspace_id = any($1::uuid[])", [[t.workspaceId, gone.workspaceId]]);
      await deactivate(gone);
      const dispatch = async () => (await withSystemScope(system, (tx) => tx.execute<{ dispatched: number }>(sql`select dispatched from system.dispatch_due_signal_marks(${100})`))).rows[0]?.dispatched;
      expect(await dispatch()).toBe(1);
      const [mark] = await marksOf(t);
      const rows = await oracle<{ subject_ids: Record<string, string>; dispatch_key: string }>("select subject_ids, dispatch_key from system.outbox where topic = $1 and workspace_id = $2", [PROCESS, t.workspaceId]);
      expect(rows).toEqual([{ subject_ids: { connected_account_id: t.account }, dispatch_key: `${PROCESS}:mark:${mark?.id ?? ""}:1` }]);
      expect(mark).toMatchObject({ dispatch_generation: 1, deferred_until: null });
      expect(await oracle("select 1 from system.outbox where topic = $1 and workspace_id = $2", [PROCESS, gone.workspaceId])).toEqual([]);
      expect(await dispatch()).toBe(0);
      expect(await sqlState(asWorker(t, (tx) => tx.execute(sql`select * from system.dispatch_due_signal_marks(${10})`)))).toMatchObject({ code: "42501" });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("reconciliation_runs.plan (0019 boundary, same signature)", () => {
    const correlation = (): string => `h6f2-${randomUUID()}`;
    const finish = (t: Tenant) => privileged.query("update ingestion.reconciliation_runs set state = 'SKIPPED_UNAVAILABLE', failure_class = 'test', completed_at = now(), updated_at = now() where workspace_id = $1 and state in ('REQUESTED', 'RUNNING')", [t.workspaceId]);
    const workerRequest = (t: Tenant, budget: Record<string, unknown> | null) =>
      asWorker(t, (tx) => tx.execute<{ outcome: string; reconciliation_run_id: string }>(sql`select outcome, reconciliation_run_id from ingestion.request_reconciliation(${t.account}, ${correlation()}, ${new Date()}, ${budget === null ? null : JSON.stringify(budget)}::jsonb)`));
    const run = async (id: string | undefined) => (await oracle<{ plan: string; max_operations: number; initiator_type: string }>("select plan, max_operations, initiator_type from ingestion.reconciliation_runs where id = $1", [id]))[0];

    it("35–36, 40. the manual (web) path is an account run with the ordinary 40-operation budget; the column defaults to account", async () => {
      const t = await tenant("950000000000035");
      const result = await withUserScope(web, { sub: t.owner, role: "authenticated" }, t.workspaceId, (tx) =>
        tx.execute<{ outcome: string; reconciliation_run_id: string }>(sql`select outcome, reconciliation_run_id from ingestion.request_reconciliation(${t.account}, ${correlation()}, null, null)`));
      expect(result.rows[0]?.outcome).toBe("requested");
      expect(await run(result.rows[0]?.reconciliation_run_id)).toEqual({ plan: "account", max_operations: 40, initiator_type: "user" });
      const [column] = await oracle<{ column_default: string; is_nullable: string }>("select column_default, is_nullable from information_schema.columns where table_schema = 'ingestion' and table_name = 'reconciliation_runs' and column_name = 'plan'");
      expect(column).toEqual({ column_default: "'account'::text", is_nullable: "NO" });
      // The browser still names neither a budget nor (therefore) a plan.
      await finish(t);
      expect(await sqlState(withUserScope(web, { sub: t.owner, role: "authenticated" }, t.workspaceId, (tx) =>
        tx.execute(sql`select * from ingestion.request_reconciliation(${t.account}, ${correlation()}, null, ${JSON.stringify({ plan: "relist" })}::jsonb)`)))).toMatchObject({ code: "42501" });
    });

    it("37, 41. the worker requests a relist run with the 10-operation signal budget; an account run without a plan", async () => {
      const t = await tenant("950000000000037");
      const relist = await workerRequest(t, { plan: "relist", max_operations: 10 });
      expect(await run(relist.rows[0]?.reconciliation_run_id)).toEqual({ plan: "relist", max_operations: 10, initiator_type: "system" });
      await finish(t);
      const account = await workerRequest(t, { max_operations: 10 });
      expect(await run(account.rows[0]?.reconciliation_run_id)).toEqual({ plan: "account", max_operations: 10, initiator_type: "system" });
      await finish(t);
      const defaults = await workerRequest(t, null);
      expect(await run(defaults.rows[0]?.reconciliation_run_id)).toEqual({ plan: "account", max_operations: 40, initiator_type: "system" });
      await finish(t);
    });

    it("38–39. an unknown or non-string plan is refused; the 1..40 operation ceiling is unchanged", async () => {
      const t = await tenant("950000000000038");
      for (const budget of [{ plan: "content" }, { plan: 1 }, { plan: null }, { plan: "RELIST" }]) {
        expect(await sqlState(workerRequest(t, budget)), JSON.stringify(budget)).toMatchObject({ code: "22023" });
      }
      expect(await sqlState(workerRequest(t, { plan: "relist", max_operations: 41 }))).toMatchObject({ code: "23514" });
      expect(await sqlState(workerRequest(t, { max_operations: 0 }))).toMatchObject({ code: "23514" });
      const bogus = await privileged.query(
        "insert into ingestion.reconciliation_runs (id, organization_id, workspace_id, connected_account_id, state, initiator_type, correlation_id, requested_at, budget_listing_pages_per_slice, budget_interaction_pages_per_slice, budget_continuations_per_content, budget_interaction_pages_per_content, budget_content_items, budget_overlap_seconds, max_operations, plan, created_at, updated_at) values ($1, $2, $3, $4, 'REQUESTED', 'system', 'h6f2-bogus-plan-0001', now(), 1, 5, 2, 15, 10, 86400, 40, 'bogus', now(), now())",
        [randomUUID(), t.organizationId, t.workspaceId, t.account]).catch((e: unknown) => e as { code?: string });
      expect((bogus as { code?: string }).code).toBe("23514");
      // The worker can't rewrite a run's plan afterwards.
      expect(await sqlState(asWorker(t, (tx) => tx.execute(sql`update ingestion.reconciliation_runs set plan = 'relist'`)))).toMatchObject({ code: "42501" });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("outbox: ingestion.process_signals is internal", () => {
    it("42–44. members and workers can't append it; a legitimate member topic still can; the definers' path works (16)", async () => {
      const t = await tenant("960000000000042");
      const row = (topic: string, initiator: "user" | "system", user: string | null) => sql`
        insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type, initiator_user_id, dispatch_key, status, created_at)
        values (${randomUUID()}, ${topic}, ${t.organizationId}, ${t.workspaceId}, ${JSON.stringify({ connected_account_id: t.account, provider_event_hint_id: randomUUID() })}::jsonb,
                ${`h6f2-${randomUUID()}`}, ${initiator}, ${user}, ${`h6f2:${randomUUID()}`}, 'PENDING', now())`;
      expect(await sqlState(withUserScope(web, { sub: t.owner, role: "authenticated" }, t.workspaceId, (tx) => tx.execute(row(PROCESS, "user", t.owner))))).toMatchObject({ code: "42501" });
      expect(await sqlState(asWorker(t, (tx) => tx.execute(row(PROCESS, "system", null))))).toMatchObject({ code: "42501" });
      await withUserScope(web, { sub: t.owner, role: "authenticated" }, t.workspaceId, (tx) => tx.execute(sql`
        insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type, initiator_user_id, dispatch_key, status, created_at)
        values (${randomUUID()}, 'connections.discover_assets', ${t.organizationId}, ${t.workspaceId}, ${JSON.stringify({ connection_id: randomUUID() })}::jsonb,
                ${`h6f2-${randomUUID()}`}, 'user', ${t.owner}, ${`h6f2:${randomUUID()}`}, 'PENDING', now())`));
      expect(await count("select count(*)::int as n from system.outbox where workspace_id = $1 and topic = $2", [t.workspaceId, PROCESS])).toBe(0);
      await privileged.query("delete from system.outbox where workspace_id = $1", [t.workspaceId]);
    });

    it("45. the four restrictive member policies coexist; process_signals is covered, member topics are not", async () => {
      const restrictive = await oracle<{ name: string; roles: string[]; with_check: string }>(
        `select p.polname as name, array(select pg_get_userbyid(r)::text from unnest(p.polroles) r order by 1) as roles, pg_get_expr(p.polwithcheck, p.polrelid) as with_check
           from pg_policy p where p.polrelid = 'system.outbox'::regclass and not p.polpermissive and p.polcmd = 'a' order by 1`);
      expect(restrictive.map((p) => [p.name, p.roles])).toEqual([
        ["no_direct_internal_topics", ["authenticated"]],
        ["no_direct_move_routing", ["app_worker", "authenticated"]],
        ["no_direct_reconciliation_routing", ["authenticated"]],
        ["no_direct_signal_routing", ["app_worker", "authenticated"]],
      ]);
      const union = new Set(restrictive.flatMap((p) => [...p.with_check.matchAll(/'([a-z_]+(?:\.[a-z_]+)+)'::text/g)].map((m) => m[1])));
      expect(union.has(PROCESS)).toBe(true);
      for (const topic of ["connections.discover_assets", "capability.evaluate_account"]) expect(union.has(topic), topic).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("concurrency (the database is the dedupe authority)", () => {
    it("51. two concurrent identical deliveries: one receipt", async () => {
      const body = bodyOf("race");
      const hints = [comment("970000000000051")];
      const outcomes = await Promise.all([record({ body, hints }), record({ body, hints })]);
      expect(outcomes.map((o) => o?.outcome).sort()).toEqual(["duplicate", "recorded"]);
      expect(await count("select count(*)::int as n from system.provider_event_inbox where body_sha256 = $1", [sha(body)])).toBe(1);
    });

    it("52. two concurrent deliveries sharing one hint: one hint", async () => {
      const hint = comment("970000000000052");
      const outcomes = await Promise.all([record({ body: bodyOf("a"), hints: [hint] }), record({ body: bodyOf("b"), hints: [hint] })]);
      expect(outcomes.map((o) => [o?.new_hint_count, o?.known_hint_count]).sort()).toEqual([[0, 1], [1, 0]]);
      expect(await count("select count(*)::int as n from system.provider_event_hints where hint_key = $1", [hint.hint_key])).toBe(1);
    });

    it("53. two concurrent upserts of one mark: one row, both counted", async () => {
      const t = await tenant("970000000000053");
      const item = await content(t);
      const at = new Date();
      await Promise.all([upsertMark(t, "relist", item, at), upsertMark(t, "relist", item, new Date(at.getTime() + 1000))]);
      const marks = await marksOf(t);
      expect(marks).toHaveLength(1);
      expect(marks[0]?.signal_count).toBe(2);
      expect(marks[0]?.last_signal_at.toISOString()).toBe(new Date(at.getTime() + 1000).toISOString());
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("purge (system.purge_provider_events, 7 days)", () => {
    it("46–48, 50. receipts older than 7 days go in bounded batches (hints with them); fresh ones and tenant data stay", async () => {
      const t = await tenant("980000000000046");
      await content(t);
      const fresh = await record({ hints: [comment(t.asset)] });
      const old1 = await record({ hints: [comment(t.asset), comment(t.asset)] });
      const old2 = await record({ hints: [comment(t.asset)] });
      await route(await hintId((await oracle<{ hint_key: string }>("select hint_key from system.provider_event_hints where inbox_id = $1", [fresh?.receipt_id]))[0]?.hint_key ?? ""));
      await privileged.query("update system.provider_event_inbox set received_at = now() - interval '8 days' where id = any($1::uuid[])", [[old1?.receipt_id, old2?.receipt_id]]);
      // Everything else in the inbox is fresh (this suite's earlier receipts): only the two backdated rows qualify.
      const before = await canonicalCounts([t.organizationId]);
      const purge = async (limit: number) => (await withSystemScope(system, (tx) => tx.execute<{ inbox_deleted: number; hints_deleted: number }>(sql`select inbox_deleted, hints_deleted from system.purge_provider_events(${limit})`))).rows[0];
      const first = await purge(1);
      expect(first?.inbox_deleted).toBe(1);
      const second = await purge(100);
      expect(second?.inbox_deleted).toBe(1);
      expect((first?.hints_deleted ?? 0) + (second?.hints_deleted ?? 0)).toBe(3);
      expect(await purge(100)).toEqual({ inbox_deleted: 0, hints_deleted: 0 });
      expect(await count("select count(*)::int as n from system.provider_event_inbox where id = any($1::uuid[])", [[old1?.receipt_id, old2?.receipt_id]])).toBe(0);
      expect(await count("select count(*)::int as n from system.provider_event_inbox where id = $1", [fresh?.receipt_id])).toBe(1);
      expect(await canonicalCounts([t.organizationId])).toEqual(before);
      // Routed process_signals rows are identifiers only and survive (the hint is simply gone when processed later).
      expect(await count("select count(*)::int as n from system.outbox where topic = $1 and workspace_id = $2", [PROCESS, t.workspaceId])).toBe(1);
      for (const limit of [0, 5001]) expect(await sqlState(purge(limit)), String(limit)).toMatchObject({ code: "22023" });
      expect(await sqlState(asWorker(t, (tx) => tx.execute(sql`select * from system.purge_provider_events(${10})`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(withUserScope(web, { sub: t.owner, role: "authenticated" }, t.workspaceId, (tx) => tx.execute(sql`select * from system.purge_provider_events(${10})`)))).toMatchObject({ code: "42501" });
    });
  });
}
