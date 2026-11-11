/**
 * Step 7B-14F1 — the 0027 → 0028 upgrade on a database that already holds 0027-era intents (its own disposable cluster,
 * migrated through 0027 only): a PENDING intent and one already OUTCOME_UNKNOWN, with their reply rows. The real runner
 * applies exactly 0028; every pre-existing row keeps its values and has no validation authorization; the ordinary
 * lifecycle continues unchanged afterwards (PENDING → EXECUTING → CONFIRMED; OUTCOME_UNKNOWN → CONFIRMED), and the new
 * table starts empty. dev-v2 holds no intent at all (0 rows), so this is the stricter case.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDatabaseUrl } from "@/platform/db";
import { applyMigrations, migrationStatus, readMigrations } from "@/tools/db/migrations";
import { spawnLocalCluster, type SpawnedCluster } from "../support/spawn-cluster";

const THROUGH = "0027_mutation_intents.sql";
const M0028 = "0028_mutation_validation_authorizations.sql";
const OLD = { organizationId: randomUUID(), workspaceId: randomUUID(), user: randomUUID(), account: randomUUID(), interaction: randomUUID(), pending: randomUUID(), unknown: randomUUID() };

describe("0027 → 0028 upgrade with 0027-era intents", () => {
  let cluster: SpawnedCluster;
  let client: pg.Client;
  const rows = async <T extends pg.QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<T[]> => (await client.query<T>(text, [...values])).rows;
  const snapshot = () => rows<{ row: string | null }>(`
    select (select json_agg(i order by i.id)::text from (select id, status, attempt, run_reference, outcome_code, idempotency_key, updated_at from mutations.mutation_intents where workspace_id = $1) i) as row
    union all select (select json_agg(r order by r.id)::text from (select id, intent_id, text, provider_reply_id from mutations.outbound_replies where workspace_id = $1) r)`,
  [OLD.workspaceId]);

  beforeAll(async () => {
    cluster = await spawnLocalCluster({ migrateThrough: THROUGH });
    const url = parseDatabaseUrl(cluster.target.privilegedUrl, "privileged URL");
    client = new pg.Client({ host: url.host, port: url.port, database: url.database, user: url.user, password: url.password });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
    await cluster.stop();
  });

  it("starts at exactly 27 applied migrations, 0028 pending", async () => {
    const status = await migrationStatus(client, readMigrations());
    expect(status.applied.at(-1)).toBe(THROUGH);
    expect(status.applied).toHaveLength(27);
    expect(status.pending.map((m) => m.name)).toEqual([M0028]);
  });

  it("seeds the 0027-era shapes", async () => {
    const { organizationId: org, workspaceId: ws } = OLD;
    await client.query("insert into tenancy.organizations (id, name, created_at) values ($1, '7B14F1-upgrade', now())", [org]);
    await client.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'STANDARD', now())", [ws, org]);
    await client.query("insert into tenancy.organization_memberships values ($1, $2, 'OWNER', now())", [org, OLD.user]);
    await client.query("insert into tenancy.workspace_memberships values ($1, $2, $3, 'RESPONDER', '{}', now())", [org, ws, OLD.user]);
    const connection = randomUUID();
    await client.query(`insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
      values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`, [connection, org, ws, OLD.user]);
    const discovered = randomUUID();
    await client.query(`insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
      values ($1, $2, $3, $4, 'instagram', 'upgrade_ig', 'content_bearing', 'Synthetic', now(), now(), now())`, [discovered, org, ws, connection]);
    await client.query(`insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
      select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`, [OLD.account, discovered]);
    const content = randomUUID();
    await client.query(`insert into content.content_items (id, organization_id, workspace_id, platform, connected_account_id, provider_asset_id, provider_content_id, content_kind, reported_source,
      source_state, first_observed_at, latest_observed_at, created_at, updated_at) values ($1, $2, $3, 'instagram', $4, 'upgrade_ig', 'upgrade_post', 'post', 'organic', 'available', now(), now(), now(), now())`,
    [content, org, ws, OLD.account]);
    await client.query(`insert into interactions.interactions (id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id,
      provider_content_id, observed, created_at, updated_at) values ($1, $2, $3, 'instagram', 'upgrade_comment', $4, 'upgrade_ig', $5, 'upgrade_post', false, now(), now())`, [OLD.interaction, org, ws, OLD.account, content]);
    for (const [id, status, attempt, run, outcome] of [[OLD.pending, "PENDING", 0, null, null], [OLD.unknown, "OUTCOME_UNKNOWN", 1, "run_upgrade_1", "RESPONSE_LOST"]] as const) {
      await client.query(`insert into mutations.mutation_intents (id, organization_id, workspace_id, kind, request_type, target_interaction_id, connected_account_id, initiator_user_id, idempotency_key,
        status, attempt, run_reference, outcome_code, capability_catalog_id, capability_catalog_revision, correlation_id, created_at, updated_at)
        values ($1, $2, $3, 'reply_public', 'human', $4, $5, $6, $7, $8, $9, $10, $11, 'platform', 5, $12, now(), now())`,
      [id, org, ws, OLD.interaction, OLD.account, OLD.user, `key-${id}`, status, attempt, run, outcome, `corr-upgrade-${id}`]);
      await client.query(`insert into mutations.outbound_replies (id, organization_id, workspace_id, intent_id, parent_interaction_id, connected_account_id, platform, text, created_at)
        values ($1, $2, $3, $4, $5, $6, 'instagram', 'Respuesta sintética', now())`, [randomUUID(), org, ws, id, OLD.interaction, OLD.account]);
    }
    expect((await snapshot()).every((r) => r.row !== null)).toBe(true);
  });

  it("the real runner applies exactly 0028; every 0027-era row keeps its values and names no authorization; a re-run is a no-op", async () => {
    const before = await snapshot();
    expect(await applyMigrations(client, readMigrations())).toEqual([M0028]);
    expect((await migrationStatus(client, readMigrations())).applied).toHaveLength(28);
    expect(await snapshot()).toEqual(before);
    expect(await rows("select count(*)::int as n from mutations.mutation_intents where validation_authorization_id is not null")).toEqual([{ n: 0 }]);
    expect(await rows("select count(*)::int as n from mutations.validation_authorizations")).toEqual([{ n: 0 }]);
    expect(await applyMigrations(client, readMigrations())).toEqual([]);
  });

  it("after the upgrade the ordinary lifecycle of those intents is unchanged", async () => {
    const move = (id: string, from: string, to: string, attempt: number, run: string | null, outcome: string | null) =>
      client.query("update mutations.mutation_intents set status = $3, attempt = $4, run_reference = $5, outcome_code = $6, updated_at = now() where workspace_id = $1 and id = $2 and status = $7",
        [OLD.workspaceId, id, to, attempt, run, outcome, from]);
    expect((await move(OLD.pending, "PENDING", "EXECUTING", 1, "run_upgrade_2", null)).rowCount).toBe(1);
    expect((await move(OLD.pending, "EXECUTING", "CONFIRMED", 1, "run_upgrade_2", null)).rowCount).toBe(1);
    expect((await move(OLD.unknown, "OUTCOME_UNKNOWN", "CONFIRMED", 1, "run_upgrade_1", null)).rowCount).toBe(1);
    expect(await rows("select status, validation_authorization_id from mutations.mutation_intents where workspace_id = $1 order by status", [OLD.workspaceId]))
      .toEqual([{ status: "CONFIRMED", validation_authorization_id: null }, { status: "CONFIRMED", validation_authorization_id: null }]);
  });
});
