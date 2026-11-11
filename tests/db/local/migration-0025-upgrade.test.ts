/**
 * Step H7-D1c — the 0024 → 0025 upgrade on a database that already holds 0024-era rows (its own disposable cluster,
 * migrated through 0024 only): a deterministic.v1 request left DETERMINISTIC_DONE, a link_present signal, rule and
 * human assessments, and bound (main / integration) and unbound outbox rows — the shapes dev-v2 holds. The real runner
 * applies exactly 0025 (and 0026, which only adds the H7-D1e2b call-intent table — migration-0026-upgrade.test.ts); every pre-existing row keeps its values, the new columns take their safe defaults, and the old
 * request can't be continued by the intelligence pipeline. 0025 fails closed over a pre-0025 AI assessment.
 */
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDatabaseUrl } from "@/platform/db";
import { applyMigrations, migrationStatus, readMigrations } from "@/tools/db/migrations";
import { spawnLocalCluster, type SpawnedCluster } from "../support/spawn-cluster";

const THROUGH = "0024_classification_persistence.sql";
const M0025 = "0025_intelligence_persistence.sql";
const M0026 = "0026_ai_call_intents.sql";
/** Step 7B-1: the executor's persistence follows; a pure expansion that names no classification object. */
const M0027 = "0027_mutation_intents.sql";
/** Step 7B-14F1: one-time validation authorizations follow; a pure expansion that names no classification object. */
const M0028 = "0028_mutation_validation_authorizations.sql";
const OLD = { organizationId: randomUUID(), workspaceId: randomUUID(), user: randomUUID(), interaction: randomUUID(), version: randomUUID(), request: randomUUID() };
const OUTBOX = { main: randomUUID(), integration: randomUUID(), unbound: randomUUID() };
const ASSESSMENTS = { rule: randomUUID(), human: randomUUID() };

describe("0024 → 0025 upgrade with 0024-era data", () => {
  let cluster: SpawnedCluster;
  let client: pg.Client;
  const rows = async <T extends pg.QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<T[]> => (await client.query<T>(text, [...values])).rows;
  /** The 0024-era rows exactly as they are (old columns only), for a before/after comparison. */
  const snapshot = () => rows<{ row: string | null }>(`
    select 'request' as k, (select row_to_json(r)::text from (select id, pipeline_version, arrival, state, created_at, updated_at, completed_at from classification.understanding_requests where id = $1) r) as row
    union all select 'signal', (select row_to_json(s)::text from (select id, kind, span_starts, span_ends from classification.signals where workspace_id = $2) s)
    union all select 'assessments', (select json_agg(a order by a.id)::text from (select id, origin, dimension, value_keys, rule_kind, actor_user_id from classification.assessments where workspace_id = $2) a)
    union all select 'outbox', (select json_agg(o order by o.id)::text from (select id, topic, status, execution_plane, claimed_until from system.outbox where id = any($3::uuid[])) o)`,
  [OLD.request, OLD.workspaceId, Object.values(OUTBOX)]);

  beforeAll(async () => {
    cluster = await spawnLocalCluster({ migrateThrough: THROUGH });
    const target = parseDatabaseUrl(cluster.target.privilegedUrl, "privileged URL");
    client = new pg.Client({ host: target.host, port: target.port, database: target.database, user: target.user, password: target.password });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
    await cluster.stop();
  });

  it("starts at exactly 24 applied migrations, 0025 (and 0026, 0027, 0028) pending", async () => {
    const status = await migrationStatus(client, readMigrations());
    expect(status.applied.at(-1)).toBe(THROUGH);
    expect(status.applied).toHaveLength(24);
    expect(status.pending.map((m) => m.name)).toEqual([M0025, M0026, M0027, M0028]);
  });

  it("seeds the 0024-era shapes (as dev-v2 holds them)", async () => {
    const { organizationId: org, workspaceId: ws } = OLD;
    await client.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'H7D1C-upgrade', now())", [org]);
    await client.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'MONITOR_ONLY', now())", [ws, org]);
    await client.query("insert into tenancy.organization_memberships values ($1, $2, 'OWNER', now())", [org, OLD.user]);
    await client.query("insert into tenancy.workspace_memberships values ($1, $2, $3, 'OWNER', '{}', now())", [org, ws, OLD.user]);
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
    const text = "Ver example.com/h7-d1c";
    await client.query(`insert into interactions.source_text_versions (id, organization_id, workspace_id, interaction_id, text_hash, source_text, provider_edited_at, observed_at, created_at)
      values ($1, $2, $3, $4, $5, $6, null, now(), now())`, [OLD.version, org, ws, OLD.interaction, createHash("sha256").update(text, "utf8").digest("hex"), text]);
    // The H7-B shape: a deterministic.v1 request left DETERMINISTIC_DONE and its link_present signal.
    await client.query(`insert into classification.understanding_requests (id, organization_id, workspace_id, interaction_id, source_text_version_id, pipeline_version, arrival, state, created_at, updated_at)
      values ($1, $2, $3, $4, $5, 'classification.deterministic.v1', 'backfill', 'DETERMINISTIC_DONE', now(), now())`, [OLD.request, org, ws, OLD.interaction, OLD.version]);
    await client.query(`insert into classification.signals (id, organization_id, workspace_id, interaction_id, source_text_version_id, kind, signals_version, span_starts, span_ends, created_at)
      values ($1, $2, $3, $4, $5, 'link_present', 'signals.v1', '{4}', '{22}', now())`, [randomUUID(), org, ws, OLD.interaction, OLD.version]);
    // Non-AI assessments in the 0024 shape (no 0025 column exists yet).
    await client.query(`insert into classification.assessments (id, organization_id, workspace_id, interaction_id, source_text_version_id, dimension, origin, outcome, value_keys, confidence_levels,
      confidence_scores, reason_codes, taxonomy_version, rule_kind, rule_version, assessed_at, created_at)
      values ($1, $2, $3, $4, $5, 'safety', 'rule', 'values', '{malicious_link}', '{high}', '{NULL}', '{}', 'taxonomy.v1', 'link_reputation_malicious', 'link-reputation.v1', now(), now())`,
    [ASSESSMENTS.rule, org, ws, OLD.interaction, OLD.version]);
    await client.query(`insert into classification.assessments (id, organization_id, workspace_id, interaction_id, source_text_version_id, dimension, origin, outcome, value_keys, confidence_levels,
      confidence_scores, reason_codes, taxonomy_version, actor_user_id, assessed_at, created_at)
      values ($1, $2, $3, $4, $5, 'intent', 'human', 'values', '{complaint}', '{high}', '{NULL}', '{}', 'taxonomy.v1', $6, now(), now())`, [ASSESSMENTS.human, org, ws, OLD.interaction, OLD.version, OLD.user]);
    // Outbox: bound main and integration deliveries (bound by a claim) and one unbound PENDING row.
    for (const [key, topic, plane] of [["main", "interactions.observed", "main"], ["integration", "ingestion.confirm_interaction", "integration"], ["unbound", "interactions.observed", null]] as const) {
      const id = OUTBOX[key];
      await client.query(`insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type, dispatch_key, created_at)
        values ($1, $2, $3, $4, '{}', 'corr-h7-d1c-upgrade', 'system', $5, '2999-01-01T00:00:00Z')`, [id, topic, org, ws, `${topic}:${id}`]);
      if (plane !== null) await client.query("update system.outbox set claimed_until = '2999-01-01T00:01:00Z', execution_plane = $2 where id = $1", [id, plane]);
    }
    expect((await snapshot()).every((r) => r.row !== null)).toBe(true);
  });

  it("fails closed over a pre-0025 AI assessment (no AI row may exist without its shadow result): nothing is applied", async () => {
    const sql = readMigrations().find((m) => m.name === M0025)?.sql ?? "";
    await client.query("begin");
    try {
      await client.query(`insert into classification.assessments (id, organization_id, workspace_id, interaction_id, source_text_version_id, dimension, origin, outcome, value_keys, confidence_levels,
        confidence_scores, reason_codes, taxonomy_version, provider, model, task_id, task_version, prompt_version, prompt_hash, schema_version, confidence_policy_version, assessed_at, created_at)
        values ($1, $2, $3, $4, $5, 'sentiment', 'ai', 'values', '{negative}', '{high}', '{NULL}', '{}', 'taxonomy.v1', 'simulator', 'm', 't', '1', 'p', 'h', 's', 'c', now(), now())`,
      [randomUUID(), OLD.organizationId, OLD.workspaceId, OLD.interaction, OLD.version]);
      await expect(client.query(sql)).rejects.toMatchObject({ code: "23514", constraint: "assessments_ai_shadow_only" });
    } finally {
      await client.query("rollback");
    }
    expect((await migrationStatus(client, readMigrations())).pending.map((m) => m.name)).toEqual([M0025, M0026, M0027, M0028]);
  });

  it("2 · 26. the real runner applies exactly 0025 (then 0026, 0027, 0028); every 0024-era row keeps its values and takes the safe defaults", async () => {
    const before = await snapshot();
    expect(await applyMigrations(client, readMigrations())).toEqual([M0025, M0026, M0027, M0028]);
    expect((await migrationStatus(client, readMigrations())).applied).toHaveLength(28);
    expect(await snapshot()).toEqual(before);
    expect(await rows("select ai_generation, ai_failure_class, state from classification.understanding_requests where id = $1", [OLD.request]))
      .toEqual([{ ai_generation: null, ai_failure_class: null, state: "DETERMINISTIC_DONE" }]);
    expect(await rows("select origin, acceptance_mode, pipeline_version, language_policy_version, ai_result_id from classification.assessments where workspace_id = $1 order by origin", [OLD.workspaceId]))
      .toEqual([
        { origin: "human", acceptance_mode: "accepting", pipeline_version: null, language_policy_version: null, ai_result_id: null },
        { origin: "rule", acceptance_mode: "accepting", pipeline_version: null, language_policy_version: null, ai_result_id: null },
      ]);
    expect(await rows("select id, execution_plane from system.outbox where id = any($1::uuid[]) order by execution_plane nulls last", [Object.values(OUTBOX)]))
      .toEqual([{ id: OUTBOX.integration, execution_plane: "integration" }, { id: OUTBOX.main, execution_plane: "main" }, { id: OUTBOX.unbound, execution_plane: null }]);
    expect(await applyMigrations(client, readMigrations())).toEqual([]);
  });

  it("26. after the upgrade the old deterministic.v1 request can't be continued; the unbound row still binds to main", async () => {
    await expect(client.query("update classification.understanding_requests set state = 'AI_PENDING', ai_generation = 1, updated_at = now() where id = $1", [OLD.request]))
      .rejects.toMatchObject({ code: "23514", constraint: "understanding_requests_ai_state" });
    await client.query("begin");
    try {
      await client.query("update system.outbox set claimed_until = '2999-01-01T00:01:00Z', execution_plane = 'main' where id = $1", [OUTBOX.unbound]);
      // Once bound, a plane never changes (0011's guard) — not even to the new intelligence plane.
      await expect(client.query("update system.outbox set execution_plane = 'intelligence' where id = $1", [OUTBOX.unbound])).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("rollback");
    }
  });
});
