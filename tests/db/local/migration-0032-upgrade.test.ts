/**
 * Step 7B-16B — the 0031 → 0032 upgrade (REPLY_IN_FLIGHT) on its own disposable cluster migrated through 0031 (the
 * development project's ledger today), seeded with intents of the 0031 era. Synthetic rows only.
 *
 *   refuse   a workspace that already holds TWO open public-reply intents on one target (PENDING + OUTCOME_UNKNOWN —
 *            possible before 0032) makes the index creation fail: the runner rolls 0032 back, the ledger stays at 31,
 *            no index exists and EVERY row is unchanged (nothing deduplicated, closed or deleted automatically). The
 *            read-only preflight query recorded in the migration finds exactly that pair.
 *   apply    once a reviewed decision settled one of them (here: the never-sent PENDING intent BLOCKED), the preflight
 *            is empty and the runner applies exactly 0032; every row keeps its values; the index is exactly the
 *            reviewed definition; a re-run is a no-op
 *   after    the remaining OUTCOME_UNKNOWN intent holds its target (a new open intent is a unique violation); other
 *            targets, other workspaces and terminal intents are unaffected; the lifecycle out of OUTCOME_UNKNOWN
 *            (→ CONFIRMED) releases it
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDatabaseUrl, postgresError } from "@/platform/db";
import { applyMigrations, migrationStatus, readMigrations } from "@/tools/db/migrations";
import { spawnLocalCluster, type SpawnedCluster } from "../support/spawn-cluster";

const THROUGH = "0031_privileged_name_resolution_hardening.sql";
const M0032 = "0032_reply_in_flight_admission.sql";
const INDEX = "mutation_intents_one_open_reply_per_target";
/** The read-only preflight recorded in the migration's header, verbatim in substance. */
const PREFLIGHT = `select workspace_id, target_interaction_id, count(*)::int as open_intents
  from mutations.mutation_intents
 where kind = 'reply_public' and status in ('PENDING', 'EXECUTING', 'OUTCOME_UNKNOWN')
 group by workspace_id, target_interaction_id
having count(*) > 1`;

interface World {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly user: string;
  readonly account: string;
  readonly target: string;
  readonly otherTarget: string;
}

describe("0031 → 0032 upgrade: one open public reply per target", () => {
  let cluster: SpawnedCluster;
  let client: pg.Client;
  let A: World;
  let B: World;
  const ids = { pending: randomUUID(), unknown: randomUUID(), otherOpen: randomUUID(), confirmed: randomUUID(), failed: randomUUID(), bOpen: randomUUID() };
  const rows = async <T extends pg.QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<T[]> => (await client.query<T>(text, [...values])).rows;
  const snapshot = () => rows<{ id: string; status: string; attempt: number; run_reference: string | null; outcome_code: string | null; target_interaction_id: string; updated_at: Date }>(
    "select id, status, attempt, run_reference, outcome_code, target_interaction_id, updated_at from mutations.mutation_intents order by id");
  const indexRow = () => rows<{ indexdef: string }>("select indexdef from pg_indexes where schemaname = 'mutations' and indexname = $1", [INDEX]);

  const world = async (label: string): Promise<World> => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const user = randomUUID();
    await client.query("insert into tenancy.organizations (id, name, created_at) values ($1, $2, now())", [organizationId, `7B16B-${label}`]);
    await client.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'STANDARD', now())", [workspaceId, organizationId]);
    await client.query("insert into tenancy.organization_memberships values ($1, $2, 'OWNER', now())", [organizationId, user]);
    await client.query("insert into tenancy.workspace_memberships values ($1, $2, $3, 'RESPONDER', '{}', now())", [organizationId, workspaceId, user]);
    const connection = randomUUID();
    await client.query(`insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
      values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`, [connection, organizationId, workspaceId, user]);
    const discovered = randomUUID();
    const asset = `upgrade_ig_${label}`;
    await client.query(`insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
      values ($1, $2, $3, $4, 'instagram', $5, 'content_bearing', 'Synthetic', now(), now(), now())`, [discovered, organizationId, workspaceId, connection, asset]);
    const account = randomUUID();
    await client.query(`insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
      select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`, [account, discovered]);
    const content = randomUUID();
    await client.query(`insert into content.content_items (id, organization_id, workspace_id, platform, connected_account_id, provider_asset_id, provider_content_id, content_kind, reported_source,
      source_state, first_observed_at, latest_observed_at, created_at, updated_at) values ($1, $2, $3, 'instagram', $4, $5, 'upgrade_post', 'post', 'organic', 'available', now(), now(), now(), now())`,
    [content, organizationId, workspaceId, account, asset]);
    const interaction = async (providerId: string): Promise<string> => {
      const id = randomUUID();
      await client.query(`insert into interactions.interactions (id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id,
        provider_content_id, observed, created_at, updated_at) values ($1, $2, $3, 'instagram', $4, $5, $6, $7, 'upgrade_post', false, now(), now())`, [id, organizationId, workspaceId, providerId, account, asset, content]);
      return id;
    };
    return { organizationId, workspaceId, user, account, target: await interaction("upgrade_comment"), otherTarget: await interaction("upgrade_comment_2") };
  };
  const intent = (w: World, id: string, target: string, status: string, attempt: number, run: string | null, outcome: string | null) =>
    client.query(`insert into mutations.mutation_intents (id, organization_id, workspace_id, kind, request_type, target_interaction_id, connected_account_id, initiator_user_id, idempotency_key,
      status, attempt, run_reference, outcome_code, capability_catalog_id, capability_catalog_revision, correlation_id, created_at, updated_at)
      values ($1, $2, $3, 'reply_public', 'human', $4, $5, $6, $7, $8, $9, $10, $11, 'platform', 5, $12, now(), now())`,
    [id, w.organizationId, w.workspaceId, target, w.account, w.user, `key-${id}`, status, attempt, run, outcome, `corr-upgrade-${id}`]);

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

  it("starts at exactly 31 applied migrations, 0032 pending, no index", async () => {
    const status = await migrationStatus(client, readMigrations());
    expect(status.applied.at(-1)).toBe(THROUGH);
    expect(status.applied).toHaveLength(31);
    expect(status.pending.map((m) => m.name)).toEqual([M0032]);
    expect(await indexRow()).toEqual([]);
  });

  it("seeds the 0031-era shapes: two open intents on one target, one open elsewhere, terminal ones, another workspace", async () => {
    A = await world("a");
    B = await world("b");
    await intent(A, ids.pending, A.target, "PENDING", 0, null, null);
    await intent(A, ids.unknown, A.target, "OUTCOME_UNKNOWN", 1, "run_upgrade_1", "RESPONSE_LOST");
    await intent(A, ids.otherOpen, A.otherTarget, "EXECUTING", 1, "run_upgrade_2", null);
    await intent(A, ids.confirmed, A.target, "CONFIRMED", 1, "run_upgrade_3", null);
    await intent(A, ids.failed, A.target, "FAILED", 1, "run_upgrade_4", "PROVIDER_REJECTED");
    await intent(B, ids.bOpen, B.target, "PENDING", 0, null, null);
    expect(await rows(PREFLIGHT)).toEqual([{ workspace_id: A.workspaceId, target_interaction_id: A.target, open_intents: 2 }]);
  });

  it("refuses: the index cannot be created over the duplicate; the runner rolls 0032 back and NOTHING changes", async () => {
    const before = await snapshot();
    const failure = await applyMigrations(client, readMigrations()).then(() => undefined, (error: unknown) => error);
    expect(postgresError(failure)).toEqual({ code: "23505", constraint: INDEX });
    const status = await migrationStatus(client, readMigrations());
    expect(status.applied).toHaveLength(31);
    expect(status.pending.map((m) => m.name)).toEqual([M0032]);
    expect(await indexRow()).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("applies exactly 0032 once a reviewed decision settled the never-sent PENDING intent; every row keeps its values; a re-run is a no-op", async () => {
    // The reviewed decision (outside any migration): the PENDING intent never reached the provider, so it may be BLOCKED.
    await client.query("update mutations.mutation_intents set status = 'BLOCKED', attempt = 1, run_reference = 'run_reviewed', outcome_code = 'PROVIDER_ACTIONS_DISABLED' where id = $1 and status = 'PENDING'", [ids.pending]);
    expect(await rows(PREFLIGHT)).toEqual([]);
    const before = await snapshot();
    expect(await applyMigrations(client, readMigrations())).toEqual([M0032]);
    expect((await migrationStatus(client, readMigrations())).applied).toHaveLength(32);
    expect(await snapshot()).toEqual(before);
    expect(await indexRow()).toEqual([{ indexdef: `CREATE UNIQUE INDEX ${INDEX} ON mutations.mutation_intents USING btree (workspace_id, target_interaction_id) WHERE ((kind = 'reply_public'::text) AND (status = ANY (ARRAY['PENDING'::text, 'EXECUTING'::text, 'OUTCOME_UNKNOWN'::text])))` }]);
    expect(await applyMigrations(client, readMigrations())).toEqual([]);
  });

  it("after: the OUTCOME_UNKNOWN intent holds its target; other targets, workspaces and terminal intents are unaffected; CONFIRMED releases it", async () => {
    const extra = randomUUID();
    expect(postgresError(await intent(A, extra, A.target, "PENDING", 0, null, null).then(() => undefined, (error: unknown) => error))).toEqual({ code: "23505", constraint: INDEX });
    // The other target already holds its own open intent; a terminal row on the held target never conflicted.
    expect(postgresError(await intent(A, randomUUID(), A.otherTarget, "PENDING", 0, null, null).then(() => undefined, (error: unknown) => error))).toEqual({ code: "23505", constraint: INDEX });
    await intent(A, randomUUID(), A.target, "FAILED", 1, "run_upgrade_5", "PROVIDER_REJECTED");
    // B's open intent on its own target is untouched by A's rows (the key includes the workspace).
    expect(await rows("select status from mutations.mutation_intents where id = $1", [ids.bOpen])).toEqual([{ status: "PENDING" }]);
    // OUTCOME_UNKNOWN → CONFIRMED (positive evidence) releases the target: a new open intent is admitted.
    expect((await client.query("update mutations.mutation_intents set status = 'CONFIRMED', outcome_code = null where id = $1 and status = 'OUTCOME_UNKNOWN'", [ids.unknown])).rowCount).toBe(1);
    await intent(A, extra, A.target, "PENDING", 0, null, null);
    expect(await rows("select count(*)::int as n from mutations.mutation_intents where workspace_id = $1 and target_interaction_id = $2 and status in ('PENDING', 'EXECUTING', 'OUTCOME_UNKNOWN')", [A.workspaceId, A.target])).toEqual([{ n: 1 }]);
  });
});
