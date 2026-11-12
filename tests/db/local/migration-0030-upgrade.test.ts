/**
 * Step 7B-14I3H — the 0029 → 0030 upgrade on a database that already holds 0029-era operator-path rows (its own
 * disposable cluster, migrated through 0029 only): a USED PREFLIGHT evidence row with its issued authorization, and an
 * UNUSED one. The real runner applies exactly 0030 — but only in the controlled window: while any role other than the
 * migration role holds app_validation_operator (a login provisioned in the intermediate state) it refuses and changes
 * nothing. Every pre-existing row keeps its values; afterwards the operator path pins pg_catalog first / pg_temp last,
 * the bound worker reads only USED evidence (it could read none before: code that needs the binding fails closed on a
 * 0029-only schema), and the web still reads none. A re-run is a no-op.
 */
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CATALOG_FIRST_SEARCH_PATH_FUNCTIONS } from "@/db/schema/classification";
import { parseDatabaseUrl } from "@/platform/db";
import { applyMigrations, migrationStatus, readMigrations } from "@/tools/db/migrations";
import { spawnLocalCluster, type SpawnedCluster } from "../support/spawn-cluster";

const THROUGH = "0029_validation_operator_path.sql";
const M0030 = "0030_validation_operator_hardening.sql";
// Step 7B-14P1: 0031 follows (its own upgrade test); this test applies the repository migrations up to 0030 only.
const M0031 = "0031_privileged_name_resolution_hardening.sql";
const throughM0030 = () => readMigrations().filter((migration) => migration.name <= M0030);
const OLD = { organizationId: randomUUID(), workspaceId: randomUUID(), user: randomUUID(), connection: randomUUID(), credential: randomUUID(), account: randomUUID(), comment: randomUUID(), other: randomUUID(), used: randomUUID(), unused: randomUUID(), authorization: randomUUID() };

describe("0029 → 0030 upgrade with 0029-era operator-path rows", () => {
  let cluster: SpawnedCluster;
  let client: pg.Client;
  const rows = async <T extends pg.QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<T[]> => (await client.query<T>(text, [...values])).rows;
  const snapshot = () => rows<{ row: string | null }>(`
    select (select json_agg(p order by p.id)::text from (select * from mutations.validation_preflights where workspace_id = $1) p) as row
    union all select (select json_agg(v order by v.id)::text from (select * from mutations.validation_authorizations where workspace_id = $1) v)`, [OLD.workspaceId]);
  const configs = () => rows<{ signature: string; config: string[] | null }>(
    "select replace(p.oid::regprocedure::text, ', ', ',') as signature, p.proconfig::text[] as config from pg_proc p where replace(p.oid::regprocedure::text, ', ', ',') = any($1::text[])", [[...CATALOG_FIRST_SEARCH_PATH_FUNCTIONS]]);

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

  it("starts at exactly 29 applied migrations, 0030 (then 0031) pending, with the 0029 shape (empty search_path, no worker read of the evidence)", async () => {
    const status = await migrationStatus(client, readMigrations());
    expect(status.applied.at(-1)).toBe(THROUGH);
    expect(status.applied).toHaveLength(29);
    expect(status.pending.map((m) => m.name)).toEqual([M0030, M0031]);
    const definers = (await configs()).filter((row) => row.signature !== "mutations.validation_operator_login()");
    expect(definers.every((row) => (row.config ?? []).includes('search_path=""'))).toBe(true);
    expect(await rows("select has_table_privilege('app_worker', 'mutations.validation_preflights', 'SELECT') as worker")).toEqual([{ worker: false }]);
  });

  it("seeds the 0029-era shapes: a used evidence row with its authorization, and an unused one", async () => {
    const { organizationId: org, workspaceId: ws } = OLD;
    await client.query("insert into tenancy.organizations (id, name, created_at) values ($1, '7B14I3H-upgrade', now())", [org]);
    await client.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'STANDARD', now())", [ws, org]);
    await client.query("insert into tenancy.organization_memberships values ($1, $2, 'OWNER', now())", [org, OLD.user]);
    await client.query("insert into tenancy.workspace_memberships values ($1, $2, $3, 'RESPONDER', '{}', now())", [org, ws, OLD.user]);
    await client.query(`insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
      values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`, [OLD.connection, org, ws, OLD.user]);
    await client.query("insert into credentials.provider_credentials (id, organization_id, workspace_id, connection_id, credential_version, envelope, created_at) values ($1, $2, $3, $4, 1, $5, now())",
      [OLD.credential, org, ws, OLD.connection, Buffer.concat([Buffer.from("5349504501", "hex"), randomBytes(64)])]);
    await client.query("update connections.connections set active_credential_id = $1 where id = $2", [OLD.credential, OLD.connection]);
    const discovered = randomUUID();
    await client.query(`insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
      values ($1, $2, $3, $4, 'instagram', 'upgrade_ig_0030', 'content_bearing', 'Synthetic', now(), now(), now())`, [discovered, org, ws, OLD.connection]);
    await client.query(`insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
      select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`, [OLD.account, discovered]);
    const content = randomUUID();
    await client.query(`insert into content.content_items (id, organization_id, workspace_id, platform, connected_account_id, provider_asset_id, provider_content_id, content_kind, reported_source,
      source_state, first_observed_at, latest_observed_at, created_at, updated_at) values ($1, $2, $3, 'instagram', $4, 'upgrade_ig_0030', 'upgrade_post_0030', 'post', 'organic', 'available', now(), now(), now(), now())`,
    [content, org, ws, OLD.account]);
    for (const [id, provider] of [[OLD.comment, "upgrade_c1"], [OLD.other, "upgrade_c2"]] as const) {
      await client.query(`insert into interactions.interactions (id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id,
        provider_content_id, observed, created_at, updated_at) values ($1, $2, $3, 'instagram', $4, $5, 'upgrade_ig_0030', $6, 'upgrade_post_0030', false, now(), now())`, [id, org, ws, provider, OLD.account, content]);
    }
    for (const [id, target] of [[OLD.used, OLD.comment], [OLD.unused, OLD.other]] as const) {
      await client.query(`insert into mutations.validation_preflights (id, organization_id, workspace_id, connected_account_id, target_interaction_id, connection_id, credential_id, run_reference, status, checks_verified,
        required_permissions_granted, replies_complete, replies_by_managed_account, replies_unattributed, stopped_early, token_type, recorded_at)
        values ($1, $2, $3, $4, $5, $6, $7, 'run_upgrade_0030', 'VERIFIED', 10, true, true, 0, 0, false, 'NOT_VERIFIED', clock_timestamp() - interval '2 minutes')`,
      [id, org, ws, OLD.account, target, OLD.connection, OLD.credential]);
    }
    await client.query("begin");
    await client.query("select set_config('app.operator_id', 'validation_operator_upgrade', true), set_config('app.change_reason', 'test', true)");
    await client.query(`insert into mutations.validation_authorizations (id, organization_id, workspace_id, connected_account_id, target_interaction_id, initiator_user_id, provider, platform, kind,
      preflight_run_reference, preflight_completed_at, expires_at)
      select $1, $2, $3, $4, $5, $6, 'meta', 'instagram', 'reply_public', p.run_reference, p.recorded_at, now() + interval '60 minutes' from mutations.validation_preflights p where p.id = $7`,
    [OLD.authorization, org, ws, OLD.account, OLD.comment, OLD.user, OLD.used]);
    await client.query("update mutations.validation_preflights set authorization_id = $1, used_at = clock_timestamp() where id = $2", [OLD.authorization, OLD.used]);
    await client.query("commit");
    expect((await snapshot()).every((r) => r.row !== null)).toBe(true);
  });

  it("refuses to apply 0030 while a login already holds app_validation_operator (the intermediate window), changing nothing", async () => {
    const before = await snapshot();
    await client.query("create role validation_operator_window login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls");
    await client.query("grant app_validation_operator to validation_operator_window with inherit false, set true");
    await expect(applyMigrations(client, readMigrations())).rejects.toThrow(/validation operator logins are provisioned only after 0030/);
    expect((await migrationStatus(client, readMigrations())).pending.map((m) => m.name)).toEqual([M0030, M0031]);
    expect(await snapshot()).toEqual(before);
    // R8: roles are never dropped; the membership is revoked (the role stays, NOLOGIN membership-free, in this disposable cluster).
    await client.query("revoke app_validation_operator from validation_operator_window");
  });

  it("the real runner applies exactly 0030; every 0029-era row keeps its values; a re-run is a no-op", async () => {
    const before = await snapshot();
    expect(await applyMigrations(client, throughM0030())).toEqual([M0030]);
    expect((await migrationStatus(client, readMigrations())).applied).toHaveLength(30);
    expect((await migrationStatus(client, readMigrations())).pending.map((m) => m.name)).toEqual([M0031]);
    expect(await snapshot()).toEqual(before);
    expect(await applyMigrations(client, throughM0030())).toEqual([]);
  });

  it("afterwards: the operator path pins pg_catalog first and pg_temp last; the worker reads only USED evidence of its bound workspace; the web none", async () => {
    const after = await configs();
    expect(after).toHaveLength(CATALOG_FIRST_SEARCH_PATH_FUNCTIONS.length);
    for (const row of after) expect(row.config, row.signature).toEqual(["search_path=pg_catalog, pg_temp"]);
    expect(await rows("select has_table_privilege('app_worker', 'mutations.validation_preflights', 'SELECT') as worker, has_table_privilege('authenticated', 'mutations.validation_preflights', 'SELECT') as web"))
      .toEqual([{ worker: true, web: false }]);
    expect(await rows("select pg_get_expr(polqual, polrelid) as using from pg_policy where polname = 'worker_read' and polrelid = 'mutations.validation_preflights'::regclass"))
      .toEqual([{ using: expect.stringMatching(/current_workspace\(\).*authorization_id IS NOT NULL/s) as unknown }]);
  });
});
