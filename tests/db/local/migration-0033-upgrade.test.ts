/**
 * Step 7B-16E — the 0032 → 0033 upgrade (the intent state-transition guard) on its own disposable cluster migrated
 * through 0032, seeded with 0032-era intents in EVERY status (legacy terminal ones included). Synthetic rows only.
 *
 *   before   the gap, shown inside a rolled-back transaction: the database accepts a terminal intent's resurrection
 *            (BLOCKED → PENDING) and a skipped EXECUTING (PENDING → CONFIRMED)
 *   apply    the real runner applies exactly 0033; EVERY row keeps its values (no status or content changes); the trigger
 *            and its function exist exactly once; a re-run is a no-op
 *   after    legacy terminal intents cannot be resurrected or moved; legacy open intents finish through legal
 *            transitions only (PENDING → BLOCKED, EXECUTING → CONFIRMED, OUTCOME_UNKNOWN → CONFIRMED)
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDatabaseUrl, postgresError } from "@/platform/db";
import { applyMigrations, migrationStatus, readMigrations } from "@/tools/db/migrations";
import { spawnLocalCluster, type SpawnedCluster } from "../support/spawn-cluster";

const THROUGH = "0032_reply_in_flight_admission.sql";
const M0033 = "0033_mutation_intent_state_transition_guard.sql";
const STATUSES = ["PENDING", "EXECUTING", "OUTCOME_UNKNOWN", "CONFIRMED", "FAILED", "BLOCKED"] as const;
type Status = (typeof STATUSES)[number];
const SHAPE: Readonly<Record<Status, readonly [number, string | null, string | null]>> = {
  PENDING: [0, null, null],
  EXECUTING: [1, "run_legacy", null],
  OUTCOME_UNKNOWN: [1, "run_legacy", "RESPONSE_LOST"],
  CONFIRMED: [1, "run_legacy", null],
  FAILED: [1, "run_legacy", "PROVIDER_REJECTED"],
  BLOCKED: [1, "run_legacy", "MODE_NOT_STANDARD"],
};

describe("0032 → 0033 upgrade: the intent state-transition guard over legacy intents", () => {
  let cluster: SpawnedCluster;
  let client: pg.Client;
  const ids = new Map<Status, string>();
  const rows = async <T extends pg.QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<T[]> => (await client.query<T>(text, [...values])).rows;
  const snapshot = () => rows<{ id: string; status: string; attempt: number; run_reference: string | null; outcome_code: string | null; target_interaction_id: string; updated_at: Date }>(
    "select id, status, attempt, run_reference, outcome_code, target_interaction_id, updated_at from mutations.mutation_intents order by id");
  const triggers = () => rows<{ n: number }>("select count(*)::int as n from pg_trigger where tgrelid = 'mutations.mutation_intents'::regclass and tgname = 'intent_transition_guard'");
  const move = (status: Status, to: Status) => {
    const [attempt, run, code] = SHAPE[to];
    return client.query("update mutations.mutation_intents set status = $2, attempt = $3, run_reference = $4, outcome_code = $5, updated_at = now() where id = $1", [ids.get(status), to, attempt, run, code]);
  };
  const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => postgresError(error)?.code);

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

  it("starts at exactly 32 applied migrations, 0033 pending, no transition trigger", async () => {
    const status = await migrationStatus(client, readMigrations());
    expect(status.applied.at(-1)).toBe(THROUGH);
    expect(status.applied).toHaveLength(32);
    expect(status.pending.map((m) => m.name)).toEqual([M0033]);
    expect(await triggers()).toEqual([{ n: 0 }]);
  });

  it("seeds one 0032-era intent in every status (the open ones on their own targets: 0032 allows one open intent per target)", async () => {
    const org = randomUUID();
    const ws = randomUUID();
    const user = randomUUID();
    await client.query("insert into tenancy.organizations (id, name, created_at) values ($1, '7B16E-upgrade', now())", [org]);
    await client.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'STANDARD', now())", [ws, org]);
    await client.query("insert into tenancy.organization_memberships values ($1, $2, 'OWNER', now())", [org, user]);
    await client.query("insert into tenancy.workspace_memberships values ($1, $2, $3, 'RESPONDER', '{}', now())", [org, ws, user]);
    const connection = randomUUID();
    await client.query(`insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
      values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`, [connection, org, ws, user]);
    const discovered = randomUUID();
    await client.query(`insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
      values ($1, $2, $3, $4, 'instagram', 'upgrade_ig_16e', 'content_bearing', 'Synthetic', now(), now(), now())`, [discovered, org, ws, connection]);
    const account = randomUUID();
    await client.query(`insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
      select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`, [account, discovered]);
    const content = randomUUID();
    await client.query(`insert into content.content_items (id, organization_id, workspace_id, platform, connected_account_id, provider_asset_id, provider_content_id, content_kind, reported_source,
      source_state, first_observed_at, latest_observed_at, created_at, updated_at) values ($1, $2, $3, 'instagram', $4, 'upgrade_ig_16e', 'upgrade_post', 'post', 'organic', 'available', now(), now(), now(), now())`,
    [content, org, ws, account]);
    for (const status of STATUSES) {
      const target = randomUUID();
      await client.query(`insert into interactions.interactions (id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id,
        provider_content_id, observed, created_at, updated_at) values ($1, $2, $3, 'instagram', $4, $5, 'upgrade_ig_16e', $6, 'upgrade_post', false, now(), now())`, [target, org, ws, `upgrade_comment_${status.toLowerCase()}`, account, content]);
      const id = randomUUID();
      const [attempt, run, code] = SHAPE[status];
      await client.query(`insert into mutations.mutation_intents (id, organization_id, workspace_id, kind, request_type, target_interaction_id, connected_account_id, initiator_user_id, idempotency_key,
        status, attempt, run_reference, outcome_code, capability_catalog_id, capability_catalog_revision, correlation_id, created_at, updated_at)
        values ($1, $2, $3, 'reply_public', 'human', $4, $5, $6, $7, $8, $9, $10, $11, 'platform', 5, $12, now() - interval '30 days', now() - interval '30 days')`,
      [id, org, ws, target, account, user, `key-${id}`, status, attempt, run, code, `corr-upgrade-${id}`]);
      ids.set(status, id);
    }
    expect((await snapshot()).map((row) => row.status).sort()).toEqual([...STATUSES].sort());
  });

  it("before 0033 the database accepts a resurrection and a skipped EXECUTING (shown inside a rolled-back transaction)", async () => {
    await client.query("begin");
    try {
      expect((await move("BLOCKED", "PENDING")).rowCount).toBe(1);
      expect((await move("PENDING", "CONFIRMED")).rowCount).toBe(1);
    } finally {
      await client.query("rollback");
    }
  });

  it("applies exactly 0033: every row keeps its values; one trigger; a re-run is a no-op", async () => {
    const before = await snapshot();
    expect(await applyMigrations(client, readMigrations())).toEqual([M0033]);
    expect((await migrationStatus(client, readMigrations())).applied).toHaveLength(33);
    expect(await snapshot()).toEqual(before);
    expect(await triggers()).toEqual([{ n: 1 }]);
    expect(await applyMigrations(client, readMigrations())).toEqual([]);
    expect(await triggers()).toEqual([{ n: 1 }]);
  });

  it("after: legacy terminal intents can't be resurrected or moved; legacy open intents finish through legal transitions only", async () => {
    for (const terminal of ["CONFIRMED", "FAILED", "BLOCKED"] as const) {
      for (const to of STATUSES.filter((status) => status !== terminal)) expect(await failure(move(terminal, to)), `${terminal} → ${to}`).toBe("42501");
    }
    expect(await failure(move("PENDING", "CONFIRMED"))).toBe("42501");
    expect(await failure(move("OUTCOME_UNKNOWN", "PENDING"))).toBe("42501");
    expect(await failure(move("EXECUTING", "PENDING"))).toBe("42501");
    expect((await move("PENDING", "BLOCKED")).rowCount).toBe(1);
    expect((await move("EXECUTING", "CONFIRMED")).rowCount).toBe(1);
    expect((await move("OUTCOME_UNKNOWN", "CONFIRMED")).rowCount).toBe(1);
    const statuses = Object.fromEntries((await rows<{ id: string; status: string }>("select id, status from mutations.mutation_intents")).map((row) => [row.id, row.status]));
    expect(STATUSES.map((status) => statuses[ids.get(status) ?? ""])).toEqual(["BLOCKED", "CONFIRMED", "CONFIRMED", "CONFIRMED", "FAILED", "BLOCKED"]);
  });
});
