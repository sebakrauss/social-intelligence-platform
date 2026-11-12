/**
 * Step 7B-14P1 — the 0028 → 0029 → 0030 → 0031 upgrade (TA §11 R4a), on its own disposable cluster migrated through 0028
 * only (the development project's ledger today). Synthetic tenants, fictitious envelopes; nothing sensitive is read back
 * (counts and booleans only).
 *
 *   before   the privileged name-resolution class reproduced: a web, worker or system session that arms its temporary
 *            schema runs its own code as app_owner through the functions it may execute — which turns FORCE RLS off on
 *            the credential envelopes and sees BOTH tenants' rows (inside a transaction that is rolled back) — and the
 *            privileged context resolves armed objects in definers, policy helpers and definer triggers
 *   upgrade  0029, 0030 and 0031 apply one by one with the real runner, with no operator login in the window; 0031
 *            refuses (changing nothing) on an unexpected function configuration and on an application function it does
 *            not pin; it changes NOTHING but function search_path pins (catalog snapshot); a re-run is a no-op
 *   after    the same probes find nothing; the legitimate paths still work
 */
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRIVILEGED_SEARCH_PATH_CONFIG } from "@/db/schema/classification";
import { parseDatabaseUrl } from "@/platform/db";
import { applyMigrations, migrationStatus, readMigrations } from "@/tools/db/migrations";
import { probePrivilegedContext, probeRuntimeSession, type ProbeResult } from "../support/name-resolution-probe";
import { spawnLocalCluster, type SpawnedCluster } from "../support/spawn-cluster";

const THROUGH = "0028_mutation_validation_authorizations.sql";
const M0029 = "0029_validation_operator_path.sql";
const M0030 = "0030_validation_operator_hardening.sql";
const M0031 = "0031_privileged_name_resolution_hardening.sql";
const upTo = (name: string) => readMigrations().filter((migration) => migration.name <= name);

interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly owner: string;
  readonly credential: string;
}

describe("0028 → 0031 upgrade: privileged name resolution (R4a)", () => {
  let cluster: SpawnedCluster;
  let client: pg.Client;
  let A: Tenant;
  let B: Tenant;
  const rows = async <T extends pg.QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<T[]> => (await client.query<T>(text, [...values])).rows;
  const connect = async (url: string): Promise<pg.Client> => {
    const parsed = parseDatabaseUrl(url, "runtime URL");
    const runtime = new pg.Client({ host: parsed.host, port: parsed.port, database: parsed.database, user: parsed.user, password: parsed.password, application_name: "p1-upgrade" });
    runtime.on("error", () => undefined);
    await runtime.connect();
    return runtime;
  };
  const claims = (user: string): string =>
    `select pg_catalog.set_config('request.jwt.claims', '${JSON.stringify({ sub: user, role: "authenticated" })}', true), pg_catalog.set_config('request.jwt.claim.sub', '${user}', true), pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true)`;
  const sessions = (): [string, string, string[]][] => [
    ["authenticated", cluster.target.runtimeUrls.web, ["set local role authenticated", claims(A.owner), `select app.bind_workspace('${A.workspaceId}'::pg_catalog.uuid)`]],
    ["app_worker", cluster.target.runtimeUrls.worker, ["set local role app_worker", `select app.bind_workspace('${A.workspaceId}'::pg_catalog.uuid)`]],
    ["app_system", cluster.target.runtimeUrls.system, ["set local role app_system"]],
  ];
  const probeAll = async (): Promise<Record<string, ProbeResult>> => {
    const results: Record<string, ProbeResult> = {};
    for (const [role, url, setup] of sessions()) {
      const runtime = await connect(url);
      try {
        // Disposable local cluster only: the payload tries to turn FORCE RLS off on the envelopes and COUNTS the rows.
        results[role] = await probeRuntimeSession(runtime, { setup, uuid: A.workspaceId, payload: "demonstrate" });
      } finally {
        await runtime.end();
      }
    }
    return results;
  };
  const forcedRls = async (): Promise<boolean | undefined> =>
    (await rows<{ forced: boolean }>("select relforcerowsecurity as forced from pg_class where oid = 'credentials.provider_credentials'::regclass"))[0]?.forced;
  const configs = () => rows<{ signature: string; config: string[] | null }>(
    "select p.oid::regprocedure::text as signature, p.proconfig::text[] as config from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspowner = 'app_owner'::regrole order by 1");
  /** Everything 0031 must NOT change: functions (all but their configuration), relations, schemas, policies, triggers, roles, memberships, the database ACL. */
  const catalog = () => rows<{ fact: string }>(`
    select 'f ' || p.oid::regprocedure::text || ' ' || pg_get_userbyid(p.proowner) || ' ' || p.prosecdef::text || ' ' || p.provolatile::text || p.proleakproof::text || p.proisstrict::text || p.proparallel::text || p.prokind::text || ' '
           || p.prorettype::regtype::text || ' ' || coalesce(p.proacl::text, '-') || ' ' || md5(p.prosrc) as fact
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspowner = 'app_owner'::regrole or p.proowner = 'app_owner'::regrole
    union all select 'r ' || c.oid::regclass::text || ' ' || pg_get_userbyid(c.relowner) || ' ' || c.relrowsecurity::text || ' ' || c.relforcerowsecurity::text || ' ' || coalesce(c.relacl::text, '-')
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspowner = 'app_owner'::regrole
    union all select 'n ' || n.nspname || ' ' || pg_get_userbyid(n.nspowner) || ' ' || coalesce(n.nspacl::text, '-') from pg_namespace n where n.nspname !~ '^pg_(toast_)?temp_'
    union all select 'p ' || pol.polrelid::regclass::text || ' ' || pol.polname || ' ' || pol.polcmd::text || pol.polpermissive::text || ' ' || pol.polroles::text || ' '
           || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-') || ' ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-') from pg_policy pol
    union all select 't ' || t.tgrelid::regclass::text || ' ' || t.tgname || ' ' || t.tgfoid::regprocedure::text || ' ' || t.tgenabled::text from pg_trigger t where not t.tgisinternal
    union all select 'a ' || r.rolname || ' ' || r.rolsuper::text || r.rolinherit::text || r.rolcreaterole::text || r.rolcreatedb::text || r.rolcanlogin::text || r.rolreplication::text || r.rolbypassrls::text from pg_roles r
    union all select 'm ' || pg_get_userbyid(m.roleid) || ' ' || pg_get_userbyid(m.member) || ' ' || m.admin_option::text || m.inherit_option::text || m.set_option::text from pg_auth_members m
    union all select 'd ' || coalesce(d.datacl::text, '-') from pg_database d where d.datname = current_database()
    order by 1`);
  const operatorHolders = () => rows<{ role: string }>(
    "select r.rolname::text as role from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles r on r.oid = m.member where g.rolname = 'app_validation_operator' and r.rolname <> 'postgres'");

  const tenant = async (): Promise<Tenant> => {
    const t = { organizationId: randomUUID(), workspaceId: randomUUID(), owner: randomUUID(), credential: randomUUID() };
    const connection = randomUUID();
    await client.query("insert into tenancy.organizations (id, name, created_at) values ($1, '7B14P1', now())", [t.organizationId]);
    await client.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'STANDARD', now())", [t.workspaceId, t.organizationId]);
    await client.query("insert into tenancy.organization_memberships values ($1, $2, 'OWNER', now())", [t.organizationId, t.owner]);
    await client.query("insert into tenancy.workspace_memberships values ($1, $2, $3, 'OWNER', '{}', now())", [t.organizationId, t.workspaceId, t.owner]);
    await client.query(`insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
      values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`, [connection, t.organizationId, t.workspaceId, t.owner]);
    // A fictitious envelope (format prefix + random bytes): never decrypted, never read back.
    await client.query("insert into credentials.provider_credentials (id, organization_id, workspace_id, connection_id, credential_version, envelope, created_at) values ($1, $2, $3, $4, 1, $5, now())",
      [t.credential, t.organizationId, t.workspaceId, connection, Buffer.concat([Buffer.from("5349504501", "hex"), randomBytes(64)])]);
    await client.query("update connections.connections set active_credential_id = $1 where id = $2", [t.credential, connection]);
    return t;
  };

  beforeAll(async () => {
    cluster = await spawnLocalCluster({ migrateThrough: THROUGH });
    const url = parseDatabaseUrl(cluster.target.privilegedUrl, "privileged URL");
    client = new pg.Client({ host: url.host, port: url.port, database: url.database, user: url.user, password: url.password });
    await client.connect();
    A = await tenant();
    B = await tenant();
  });
  afterAll(async () => {
    await client.end();
    await cluster.stop();
  });

  it("starts at 28 applied migrations with 0029, 0030 and 0031 pending, no operator login, and every pre-0030 function pinned to the empty search_path", async () => {
    const status = await migrationStatus(client, readMigrations());
    expect(status.applied).toHaveLength(28);
    expect(status.pending.map((m) => m.name)).toEqual([M0029, M0030, M0031]);
    expect(await operatorHolders()).toEqual([]);
    expect((await configs()).every((row) => JSON.stringify(row.config) === JSON.stringify(['search_path=""']))).toBe(true);
  });

  it("BEFORE: armed web, worker and system sessions run their code as app_owner, turn FORCE RLS off on the envelopes and see BOTH tenants' rows (rolled back)", async () => {
    const results = await probeAll();
    for (const [role, result] of Object.entries(results)) {
      expect(result.armed, role).toBe(true);
      expect(Object.keys(result.escalated).length, role).toBeGreaterThan(0);
      expect(Object.values(result.escalated).flat().every((identity) => identity === "app_owner"), role).toBe(true);
      expect(result.forcedRlsTurnedOff, role).toBe(true);
      // The session is bound to (or, for the system role, owns no) workspace A, which holds ONE envelope: two is B's too.
      expect(result.maxEnvelopesVisible, role).toBe(2);
    }
    const escalated = new Set(Object.values(results).flatMap((result) => Object.keys(result.escalated)));
    for (const signature of ["credentials.load_envelope(uuid)", "credentials.store_envelope(uuid,uuid,integer,bytea,timestamp with time zone)", "app.my_workspace_role(uuid)",
      "connections.route_move_step(uuid,text,text,timestamp with time zone)", "ingestion.request_reconciliation(uuid,text,timestamp with time zone,jsonb)", "system.purge_provider_events(integer)"]) {
      expect([...escalated].map((s) => s.replaceAll("pg_catalog.", "")), signature).toContain(signature);
    }
    // Every transaction was rolled back: nothing persisted.
    expect(await forcedRls()).toBe(true);
  });

  it("BEFORE: in the privileged context, definers, policy helpers and definer triggers resolve the session's temporary objects", async () => {
    const privileged = await connect(cluster.target.privilegedUrl);
    try {
      const result = await probePrivilegedContext(privileged, { uuid: A.workspaceId });
      expect(result.armed).toBe(true);
      const escalated = Object.keys(result.escalated).map((s) => s.replaceAll("pg_catalog.", ""));
      for (const signature of ["app_private.claimed_user()", "app.current_workspace()", "mutations.intent_mode_guard()", "system.record_switch_change()", "credentials.load_envelope(uuid)"]) {
        expect(escalated, signature).toContain(signature);
      }
    } finally {
      await privileged.end();
    }
  });

  it("applies 0029 then 0030 one at a time with the real runner; no operator login exists in the window", async () => {
    expect(await applyMigrations(client, upTo(M0029))).toEqual([M0029]);
    expect(await operatorHolders()).toEqual([]);
    expect(await applyMigrations(client, upTo(M0030))).toEqual([M0030]);
    expect(await operatorHolders()).toEqual([]);
    expect((await migrationStatus(client, readMigrations())).pending.map((m) => m.name)).toEqual([M0031]);
  });

  it("0031 refuses (changing nothing) when an application function carries an unexpected configuration", async () => {
    const before = { configs: await configs(), catalog: await catalog() };
    await client.query("begin; set local role app_owner; alter function app.my_workspace_role(uuid) set work_mem = '64kB'; commit");
    await expect(applyMigrations(client, readMigrations())).rejects.toThrow(/unexpected configuration \(refusing\): app\.my_workspace_role/);
    await client.query("begin; set local role app_owner; alter function app.my_workspace_role(uuid) reset work_mem; commit");
    expect((await migrationStatus(client, readMigrations())).pending.map((m) => m.name)).toEqual([M0031]);
    expect(await configs()).toEqual(before.configs);
    expect(await catalog()).toEqual(before.catalog);
  });

  it("0031 refuses (rolling every pin back) when an application function exists that it does not pin", async () => {
    const before = await configs();
    await client.query("begin; set local role app_owner; create function app.r4a_unlisted() returns integer language sql stable security definer set search_path = '' as 'select 1'; commit");
    await expect(applyMigrations(client, readMigrations())).rejects.toThrow(/left without the safe search_path \(refusing\): app\.r4a_unlisted\(\)/);
    await client.query("begin; set local role app_owner; drop function app.r4a_unlisted(); commit");
    expect((await migrationStatus(client, readMigrations())).pending.map((m) => m.name)).toEqual([M0031]);
    expect(await configs()).toEqual(before);
  });

  it("applies exactly 0031: every application function pins pg_catalog, pg_temp; NOTHING else in the catalog moved; a re-run is a no-op", async () => {
    const before = { configs: await configs(), catalog: await catalog() };
    expect(before.configs.filter((row) => JSON.stringify(row.config) === JSON.stringify(['search_path=""']))).toHaveLength(52);
    expect(await applyMigrations(client, readMigrations())).toEqual([M0031]);
    const after = await configs();
    expect(after.map((row) => row.signature)).toEqual(before.configs.map((row) => row.signature));
    expect(after.filter((row) => JSON.stringify(row.config) !== JSON.stringify([PRIVILEGED_SEARCH_PATH_CONFIG]))).toEqual([]);
    expect(await catalog()).toEqual(before.catalog);
    expect(await applyMigrations(client, readMigrations())).toEqual([]);
    expect((await migrationStatus(client, readMigrations())).applied).toHaveLength(31);
    expect(await operatorHolders()).toEqual([]);
  });

  it("AFTER: the same armed sessions and the privileged context run NOTHING as app_owner; FORCE RLS stays on", async () => {
    for (const [role, result] of Object.entries(await probeAll())) {
      expect(result.armed, role).toBe(true);
      expect(result.escalated, role).toEqual({});
      expect(result.forcedRlsTurnedOff, role).toBe(false);
      expect(result.maxEnvelopesVisible, role).toBe(0);
    }
    const privileged = await connect(cluster.target.privilegedUrl);
    try {
      const result = await probePrivilegedContext(privileged, { uuid: A.workspaceId });
      expect(result.armed).toBe(true);
      expect(result.escalated).toEqual({});
    } finally {
      await privileged.end();
    }
    expect(await forcedRls()).toBe(true);
  });

  it("the probe also catches an UNQUALIFIED reference under the safe path (R4a's second half): a pinned decoy definer reading `workspaces` is flagged", async () => {
    // Disposable cluster only: a decoy that pins the right path but names an application table without its schema —
    // pg_catalog has no `workspaces`, so pg_temp (last) supplies the caller's look-alike view.
    await client.query(`begin; set local role app_owner; set local check_function_bodies = off;
      create function app.r4a_decoy() returns integer language sql stable security definer set search_path = pg_catalog, pg_temp as 'select count(*)::integer from workspaces';
      revoke all on function app.r4a_decoy() from public; grant execute on function app.r4a_decoy() to app_worker; commit`);
    try {
      const worker = await connect(cluster.target.runtimeUrls.worker);
      try {
        const result = await probeRuntimeSession(worker, { setup: ["set local role app_worker", `select app.bind_workspace('${A.workspaceId}'::pg_catalog.uuid)`], uuid: A.workspaceId });
        expect(Object.keys(result.escalated)).toEqual(["app.r4a_decoy()"]);
      } finally {
        await worker.end();
      }
    } finally {
      await client.query("begin; set local role app_owner; drop function app.r4a_decoy(); commit");
    }
  });

  it("AFTER: the legitimate paths still work — the bound worker loads only its own envelope, the web resolves its own role", async () => {
    const worker = await connect(cluster.target.runtimeUrls.worker);
    try {
      await worker.query("begin");
      await worker.query("set local role app_worker");
      await worker.query("select app.bind_workspace($1::uuid)", [A.workspaceId]);
      const own = await worker.query<{ n: number }>("select count(*)::int as n from credentials.load_envelope($1::uuid) e where pg_catalog.octet_length(e.envelope) > 0", [A.credential]);
      const foreign = await worker.query<{ n: number }>("select count(*)::int as n from credentials.load_envelope($1::uuid)", [B.credential]);
      await worker.query("rollback");
      expect([own.rows[0]?.n, foreign.rows[0]?.n]).toEqual([1, 0]);
    } finally {
      await worker.end();
    }
    const web = await connect(cluster.target.runtimeUrls.web);
    try {
      await web.query("begin");
      await web.query("set local role authenticated");
      await web.query(claims(A.owner));
      await web.query("select app.bind_workspace($1::uuid)", [A.workspaceId]);
      const role = await web.query<{ own: string | null; foreign: string | null }>("select app.my_workspace_role($1::uuid) as own, app.my_workspace_role($2::uuid) as foreign", [A.workspaceId, B.workspaceId]);
      await web.query("rollback");
      expect(role.rows).toEqual([{ own: "OWNER", foreign: null }]);
    } finally {
      await web.end();
    }
  });
});
