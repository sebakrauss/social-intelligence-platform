/**
 * Step H7-D1e2b — the 0025 → 0026 upgrade on a database that already holds 0025-era rows (its own disposable cluster,
 * migrated through 0025 only): a deterministic.v1 request, an intelligence.v1 request in AI_PENDING, a budget counter —
 * the shapes dev-v2 can hold (its AI ledger is empty). The real runner applies exactly 0026; every pre-existing row keeps
 * its values; afterwards an attempt without its prior call intent is refused. 0026 fails closed over a pre-0026 attempt
 * row (one without an intent can't exist after it).
 */
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDatabaseUrl } from "@/platform/db";
import { applyMigrations, migrationStatus, readMigrations } from "@/tools/db/migrations";
import { spawnLocalCluster, type SpawnedCluster } from "../support/spawn-cluster";
import { attemptColumns, insertIntent, insertRow } from "../suites/intelligence-fixtures";

const THROUGH = "0025_intelligence_persistence.sql";
const M0026 = "0026_ai_call_intents.sql";
/** Step 7B-1: the executor's persistence follows; a pure expansion that names no classification object. */
const M0027 = "0027_mutation_intents.sql";
/** Step 7B-14F1: one-time validation authorizations follow; a pure expansion that names no classification object. */
const M0028 = "0028_mutation_validation_authorizations.sql";
const OLD = { organizationId: randomUUID(), workspaceId: randomUUID(), user: randomUUID(), interaction: randomUUID(), version: randomUUID(), deterministic: randomUUID(), intelligence: randomUUID() };

describe("0025 → 0026 upgrade with 0025-era data", () => {
  let cluster: SpawnedCluster;
  let client: pg.Client;
  let pool: pg.Pool;
  const target = { organizationId: OLD.organizationId, workspaceId: OLD.workspaceId, interaction: OLD.interaction, version: OLD.version };
  const rows = async <T extends pg.QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<T[]> => (await client.query<T>(text, [...values])).rows;
  /** The 0025-era rows exactly as they are, for a before/after comparison. */
  const snapshot = () => rows<{ row: string | null }>(`
    select 'requests' as k, (select json_agg(r order by r.id)::text from (select id, pipeline_version, state, ai_generation, ai_failure_class, updated_at from classification.understanding_requests where workspace_id = $1) r) as row
    union all select 'budget', (select json_agg(b)::text from (select task_id, budget_day, reserved_calls, reserved_input_chars from classification.ai_budget_reservations where workspace_id = $1) b)`,
  [OLD.workspaceId]);

  beforeAll(async () => {
    cluster = await spawnLocalCluster({ migrateThrough: THROUGH });
    const url = parseDatabaseUrl(cluster.target.privilegedUrl, "privileged URL");
    const config = { host: url.host, port: url.port, database: url.database, user: url.user, password: url.password };
    client = new pg.Client(config);
    await client.connect();
    pool = new pg.Pool({ ...config, max: 2 });
  });
  afterAll(async () => {
    await pool.end();
    await client.end();
    await cluster.stop();
  });

  it("starts at exactly 25 applied migrations, 0026 (and 0027, 0028) pending", async () => {
    const status = await migrationStatus(client, readMigrations());
    expect(status.applied.at(-1)).toBe(THROUGH);
    expect(status.applied).toHaveLength(25);
    expect(status.pending.map((m) => m.name)).toEqual([M0026, M0027, M0028]);
  });

  it("seeds the 0025-era shapes", async () => {
    const { organizationId: org, workspaceId: ws } = OLD;
    await client.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'H7D1E2B-upgrade', now())", [org]);
    await client.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'MONITOR_ONLY', now())", [ws, org]);
    const connection = randomUUID();
    await client.query(`insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
      values ($1, $2, $3, 'simulator', 'ACTIVE', null, $4, now(), 1, now(), now())`, [connection, org, ws, OLD.user]);
    const discovered = randomUUID();
    await client.query(`insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
      values ($1, $2, $3, $4, 'facebook', 'upgrade_page', 'content_bearing', 'Synthetic', now(), now(), now())`, [discovered, org, ws, connection]);
    const account = randomUUID();
    await client.query(`insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
      select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`, [account, discovered]);
    const content = randomUUID();
    await client.query(`insert into content.content_items (id, organization_id, workspace_id, platform, connected_account_id, provider_asset_id, provider_content_id, content_kind, reported_source,
      source_state, first_observed_at, latest_observed_at, created_at, updated_at) values ($1, $2, $3, 'facebook', $4, 'upgrade_page', 'upgrade_post', 'post', 'unknown', 'available', now(), now(), now(), now())`,
    [content, org, ws, account]);
    await client.query(`insert into interactions.interactions (id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id,
      provider_content_id, observed, created_at, updated_at) values ($1, $2, $3, 'facebook', 'upgrade_comment', $4, 'upgrade_page', $5, 'upgrade_post', false, now(), now())`, [OLD.interaction, org, ws, account, content]);
    const text = "Texto sintético de la actualización";
    await client.query(`insert into interactions.source_text_versions (id, organization_id, workspace_id, interaction_id, text_hash, source_text, provider_edited_at, observed_at, created_at)
      values ($1, $2, $3, $4, $5, $6, null, now(), now())`, [OLD.version, org, ws, OLD.interaction, createHash("sha256").update(text, "utf8").digest("hex"), text]);
    await client.query(`insert into classification.understanding_requests (id, organization_id, workspace_id, interaction_id, source_text_version_id, pipeline_version, arrival, state, created_at, updated_at)
      values ($1, $2, $3, $4, $5, 'classification.deterministic.v1', 'realtime', 'DETERMINISTIC_DONE', now(), now())`, [OLD.deterministic, org, ws, OLD.interaction, OLD.version]);
    await client.query(`insert into classification.understanding_requests (id, organization_id, workspace_id, interaction_id, source_text_version_id, pipeline_version, arrival, state, ai_generation,
      created_at, updated_at) values ($1, $2, $3, $4, $5, 'classification.intelligence.v1', 'realtime', 'AI_PENDING', 1, now(), now())`, [OLD.intelligence, org, ws, OLD.interaction, OLD.version]);
    await client.query(`insert into classification.ai_budget_reservations (organization_id, workspace_id, task_id, budget_day, reserved_calls, reserved_input_chars, created_at, updated_at)
      values ($1, $2, 'classification.understanding', '2026-11-02', 2, 8400, now(), now())`, [org, ws]);
    expect((await snapshot()).every((r) => r.row !== null)).toBe(true);
  });

  it("fails closed over a pre-0026 attempt row (no intent can name it): nothing is applied", async () => {
    const sql = readMigrations().find((m) => m.name === M0026)?.sql ?? "";
    await client.query("begin");
    try {
      const attempt = insertRow("classification.ai_attempts", attemptColumns(target, OLD.intelligence));
      await client.query(attempt.text, attempt.values);
      await expect(client.query(sql)).rejects.toMatchObject({ code: "23503", constraint: "ai_attempts_intent" });
    } finally {
      await client.query("rollback");
    }
    expect((await migrationStatus(client, readMigrations())).pending.map((m) => m.name)).toEqual([M0026, M0027, M0028]);
  });

  it("2 · 4. the real runner applies exactly 0026 (then 0027, 0028); every 0025-era row keeps its values; a re-run is a no-op", async () => {
    const before = await snapshot();
    expect(await applyMigrations(client, readMigrations())).toEqual([M0026, M0027, M0028]);
    expect((await migrationStatus(client, readMigrations())).applied).toHaveLength(28);
    expect(await snapshot()).toEqual(before);
    expect(await rows("select count(*)::int as n from classification.ai_call_intents")).toEqual([{ n: 0 }]);
    expect(await applyMigrations(client, readMigrations())).toEqual([]);
  });

  it("14. after the upgrade an attempt needs its prior intent (same request, generation and attempt); with it, it is accepted", async () => {
    const lonely = insertRow("classification.ai_attempts", attemptColumns(target, OLD.intelligence, { dispatch_generation: 5 }));
    await expect(client.query(lonely.text, lonely.values)).rejects.toMatchObject({ code: "23503", constraint: "ai_attempts_intent" });
    await insertIntent(pool, target, OLD.intelligence, 6, 1);
    const named = insertRow("classification.ai_attempts", attemptColumns(target, OLD.intelligence, { dispatch_generation: 6 }));
    await client.query(named.text, named.values);
    expect(await rows("select count(*)::int as n from classification.ai_attempts where workspace_id = $1", [OLD.workspaceId])).toEqual([{ n: 1 }]);
  });
});
