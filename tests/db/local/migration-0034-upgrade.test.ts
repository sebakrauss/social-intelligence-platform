/**
 * WORKFLOW-WF-2B — 0033 → 0034 upgrade with 0033-era conversations, on a disposable local cluster migrated through 0033
 * by the real runner (no managed database).
 *
 *   - a conversation that is not OPEN (no known writer before 0034) makes 0034 refuse: the runner rolls it back and
 *     NOTHING changes (no schema, no row);
 *   - over OPEN conversations, the runner applies exactly 0034: one work item per conversation — the same id, OPEN,
 *     version 1, attributed to the migration — with the list's own activity (ms-truncated max over the members, from the
 *     source rows), one `created` event each, no audit row; every canonical row keeps its values; a re-run is a no-op.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDatabaseUrl, postgresError } from "@/platform/db";
import { applyMigrations, migrationStatus, readMigrations } from "@/tools/db/migrations";
import { spawnLocalCluster, type SpawnedCluster } from "../support/spawn-cluster";

const THROUGH = "0033_mutation_intent_state_transition_guard.sql";
const M0034 = "0034_workflow_core.sql";

describe("0033 → 0034 upgrade: the workflow core over 0033-era conversations", () => {
  let cluster: SpawnedCluster;
  let client: pg.Client;
  const conversations: string[] = [];
  const rows = async <T extends pg.QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<T[]> => (await client.query<T>(text, [...values])).rows;
  const canonical = () => rows<{ id: string; conversation_id: string | null; updated_at: Date }>("select id, conversation_id, updated_at from interactions.interactions order by id");
  const workflowSchema = async () => (await rows<{ n: number }>("select count(*)::int as n from pg_namespace where nspname = 'workflow'"))[0]?.n;

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

  it("starts at exactly 33 applied migrations, 0034 pending, no workflow schema", async () => {
    const status = await migrationStatus(client, readMigrations());
    expect(status.applied.at(-1)).toBe(THROUGH);
    expect(status.applied).toHaveLength(33);
    expect(status.pending.map((m) => m.name)).toEqual([M0034]);
    expect(await workflowSchema()).toBe(0);
  });

  it("seeds 0033-era conversations: an audience root with replies (one of them the account's), a lone root, ties below the millisecond", async () => {
    const org = randomUUID();
    const ws = randomUUID();
    const user = randomUUID();
    await client.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'WF2B-upgrade', now())", [org]);
    await client.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'STANDARD', now())", [ws, org]);
    await client.query("insert into tenancy.organization_memberships values ($1, $2, 'OWNER', now())", [org, user]);
    await client.query("insert into tenancy.workspace_memberships values ($1, $2, $3, 'OWNER', '{}', now())", [org, ws, user]);
    const connection = randomUUID();
    await client.query(`insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
      values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`, [connection, org, ws, user]);
    const discovered = randomUUID();
    await client.query(`insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
      values ($1, $2, $3, $4, 'facebook', 'upgrade_fb_34', 'content_bearing', 'Synthetic', now(), now(), now())`, [discovered, org, ws, connection]);
    const account = randomUUID();
    await client.query(`insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
      select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`, [account, discovered]);
    const content = randomUUID();
    await client.query(`insert into content.content_items (id, organization_id, workspace_id, platform, connected_account_id, provider_asset_id, provider_content_id, content_kind, reported_source,
      source_state, first_observed_at, latest_observed_at, created_at, updated_at) values ($1, $2, $3, 'facebook', $4, 'upgrade_fb_34', 'upgrade_post_34', 'post', 'organic', 'available', now(), now(), now(), now())`,
    [content, org, ws, account]);
    const member = async (id: string, parent: string | null, role: "user" | "account_identity", at: string, conversation: string | null) => {
      await client.query(`insert into interactions.interactions (id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id, provider_content_id,
          observed, parent_interaction_id, kind, author_role, conversation_id, current_visibility, current_availability, provider_created_at, state_observed_at, first_observed_at, latest_observed_at, created_at, updated_at)
        values ($1, $2, $3, 'facebook', $4, $5, 'upgrade_fb_34', $6, 'upgrade_post_34', true, $7, $8, $9, $10, 'visible', 'available', $11, $11, $11, $11, $11, $11)`,
      [id, org, ws, `upg_${id.replaceAll("-", "")}`, account, content, parent, parent === null ? "comment" : "reply", role, conversation, at]);
    };
    for (const [root, replies] of [
      ["2026-10-01T10:00:00.000Z", [["2026-10-02T10:00:00.123456Z", "user"], ["2026-10-03T08:00:00.000Z", "account_identity"]]],
      ["2026-10-05T10:00:00.000Z", []],
    ] as const) {
      const anchor = randomUUID();
      const conversation = randomUUID();
      await member(anchor, null, "user", root, null);
      await client.query(`insert into conversations.conversations (id, organization_id, workspace_id, anchor_interaction_id, anchor_observed, workflow_state, created_by, created_at, updated_at)
        values ($1, $2, $3, $4, true, 'OPEN', 'system_ingestion', $5, $5)`, [conversation, org, ws, anchor, root]);
      await client.query("update interactions.interactions set conversation_id = $1 where id = $2", [conversation, anchor]);
      for (const [at, role] of replies) await member(randomUUID(), anchor, role, at, conversation);
      conversations.push(conversation);
    }
  });

  it("refuses while a conversation is not OPEN (no writer of that state is known): the runner rolls 0034 back and NOTHING changes", async () => {
    const before = await canonical();
    await client.query("update conversations.conversations set workflow_state = 'DONE' where id = $1", [conversations[1]]);
    const refused = await applyMigrations(client, readMigrations()).then(() => undefined, (error: unknown) => postgresError(error)?.code);
    expect(refused).toBe("55000");
    expect((await migrationStatus(client, readMigrations())).pending.map((m) => m.name)).toEqual([M0034]);
    expect(await workflowSchema()).toBe(0);
    expect(await canonical()).toEqual(before);
    await client.query("update conversations.conversations set workflow_state = 'OPEN' where id = $1", [conversations[1]]);
  });

  it("applies exactly 0034: one OPEN v1 work item per conversation with the list's own activity, one `created` event each; every row keeps its values; a re-run is a no-op", async () => {
    const before = await canonical();
    const audit = (await rows<{ n: number }>("select count(*)::int as n from audit.audit_events"))[0]?.n;
    expect(await applyMigrations(client, readMigrations())).toEqual([M0034]);
    expect((await migrationStatus(client, readMigrations())).applied).toHaveLength(34);
    const items = await rows<{ id: string; conversation_id: string; state: string; resolution: string | null; version: number; by: string; latest: Date }>(
      "select id, conversation_id, state, resolution, version, state_changed_by_kind as by, latest_activity_at as latest from workflow.work_items order by latest_activity_at desc");
    expect(items.map((item) => item.id).sort()).toEqual([...conversations].sort());
    for (const item of items) expect(item).toMatchObject({ conversation_id: item.id, state: "OPEN", resolution: null, version: 1, by: "migration" });
    // The list's own definition: ms-truncated, the account's reply included (an activity like any other member's).
    expect(items.map((item) => item.latest.toISOString())).toEqual(["2026-10-05T10:00:00.000Z", "2026-10-03T08:00:00.000Z"]);
    const oracle = await rows<{ id: string; at: Date }>(
      "select conversation_id as id, date_trunc('milliseconds', max(coalesce(provider_created_at, first_observed_at, created_at))) as at from interactions.interactions where conversation_id is not null group by 1");
    for (const row of oracle) expect(items.find((item) => item.id === row.id)?.latest.toISOString()).toBe(row.at.toISOString());
    const events = await rows<{ work_item_id: string; kind: string; to_state: string; initiator_kind: string; version_after: number; correlation_id: string }>(
      "select work_item_id, kind, to_state, initiator_kind, version_after, correlation_id from workflow.workflow_events order by work_item_id");
    expect(events).toEqual([...conversations].sort().map((id) => ({ work_item_id: id, kind: "created", to_state: "OPEN", initiator_kind: "migration", version_after: 1, correlation_id: "migration.0034_workflow_core" })));
    expect((await rows<{ n: number }>("select count(*)::int as n from audit.audit_events"))[0]?.n).toBe(audit);
    expect(await canonical()).toEqual(before);
    expect(await applyMigrations(client, readMigrations())).toEqual([]);
  });
});
