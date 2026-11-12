/**
 * Step 7B-14I3H — targeted PRE-LIVE hardening of the validation operator path (migration 0030), on the real database.
 * Synthetic tenants only; local disposable cluster only (operator logins and scratch objects are created per run: R8).
 *
 *   H2  name resolution: an operator session (and a worker session) that fills its temporary schema with a malicious
 *       domain over EVERY builtin base type name, a composite named `record`, look-alike relations, functions and an
 *       operator still issues, reads and revokes exactly as before — and NOTHING of it ever runs as app_owner
 *   J   the privileged functions refuse every role but their grantee (web, worker, the bare login, helpers)
 *   H4  a mis-provisioned login is refused by the database (and by the CLI's precheck, on the same real catalog): direct
 *       grants, CREATE, an INHERIT membership, a role acting through it, per-role settings, owned objects; and an
 *       operator role holding anything beyond its three functions refuses EVERY login
 */
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordValidationPreflight } from "@/mutations/persistence/validation-preflights";
import { parseDatabaseUrl, withUserScope, withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { operatorSessionProblems } from "../../../tools/ops/validation-authorizations";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { operatorLogin } from "../support/validation-operator";
import { cleanupWorld } from "../support/world";

interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly owner: string;
  readonly responder: string;
  readonly credential: string;
  readonly account: string;
  readonly comment: string;
}

/** A domain CHECK / function body that announces where it runs (a notice survives the rollback of its transaction). */
const EVIL = `create function pg_temp.evil(v pg_catalog.text) returns pg_catalog.bool language plpgsql as $$
begin
  raise notice 'PWNED as % via %', current_user, v;
  if current_user::pg_catalog.text = 'app_owner' then
    perform pg_catalog.set_config('pwn.owner', 'yes', false);
  end if;
  perform pg_catalog.set_config('pwn.seen', 'yes', true);
  return true;
end $$`;

/** Look-alikes the privileged code must never resolve: relations, functions and an operator in pg_temp. */
const RELATIONS = ["pg_roles", "pg_auth_members", "pg_shdepend", "pg_database", "pg_namespace", "pg_proc", "pg_class", "pg_type", "pg_db_role_setting", "workspaces", "validation_preflights", "validation_authorizations", "validation_operator_events", "interactions", "connections", "connected_accounts", "audit_events", "context_secret"];
const FUNCTIONS: readonly (readonly [string, string, string])[] = [
  ["now", "", "pg_catalog.timestamptz"], ["clock_timestamp", "", "pg_catalog.timestamptz"], ["count", "pg_catalog.int8", "pg_catalog.int8"], ["gen_random_uuid", "", "pg_catalog.uuid"],
  ["set_config", "pg_catalog.text, pg_catalog.text, pg_catalog.bool", "pg_catalog.text"], ["current_setting", "pg_catalog.text, pg_catalog.bool", "pg_catalog.text"],
  ["pg_has_role", "pg_catalog.name, pg_catalog.text, pg_catalog.text", "pg_catalog.bool"], ["make_interval", "pg_catalog.int4", "pg_catalog.interval"],
  ["split_part", "pg_catalog.text, pg_catalog.text, pg_catalog.int4", "pg_catalog.text"], ["current_database", "", "pg_catalog.name"], ["pg_my_temp_schema", "", "pg_catalog.oid"],
];

export function defineValidationOperatorHardeningSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let worker: RuntimeDatabase<"worker">;
  let web: RuntimeDatabase<"web">;
  let asOperator: () => Promise<pg.Client>;
  const organizations: string[] = [];
  const scratch: string[] = [];
  const oracle = async <T extends pg.QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(text, [...values])).rows;

  const tenant = async (): Promise<Tenant> => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    organizations.push(organizationId);
    const owner = randomUUID();
    const responder = randomUUID();
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Operator hardening', now())", [organizationId]);
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'STANDARD', now())", [workspaceId, organizationId]);
    for (const [user, role] of [[owner, "OWNER"], [responder, "RESPONDER"]] as const) {
      await privileged.query("insert into tenancy.organization_memberships values ($1, $2, $3, now())", [organizationId, user, role === "OWNER" ? "OWNER" : "MEMBER"]);
      await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, $4, '{}', now())", [organizationId, workspaceId, user, role]);
    }
    const connection = randomUUID();
    const credential = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`, [connection, organizationId, workspaceId, owner]);
    await privileged.query("insert into credentials.provider_credentials (id, organization_id, workspace_id, connection_id, credential_version, envelope, created_at) values ($1, $2, $3, $4, 1, $5, now())",
      [credential, organizationId, workspaceId, connection, Buffer.concat([Buffer.from("5349504501", "hex"), randomBytes(64)])]);
    await privileged.query("update connections.connections set active_credential_id = $1 where id = $2", [credential, connection]);
    const asset = `ig_7b14i3h_${randomUUID().slice(0, 8)}`;
    const discovered = randomUUID();
    await privileged.query(
      `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'instagram', $5, 'content_bearing', 'Synthetic', now(), now(), now())`, [discovered, organizationId, workspaceId, connection, asset]);
    const account = randomUUID();
    await privileged.query(
      `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
       select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`, [account, discovered]);
    const content = randomUUID();
    await privileged.query(
      `insert into content.content_items (id, organization_id, workspace_id, platform, connected_account_id, provider_asset_id, provider_content_id, content_kind, reported_source, source_state, first_observed_at, latest_observed_at, created_at, updated_at)
       values ($1, $2, $3, 'instagram', $4, $5, $6, 'post', 'organic', 'available', now(), now(), now(), now())`, [content, organizationId, workspaceId, account, asset, `${asset}_post`]);
    const author = randomUUID();
    await privileged.query("insert into interactions.authors (id, organization_id, workspace_id, platform, provider_author_id, role, label, created_at, updated_at) values ($1, $2, $3, 'instagram', $4, 'user', null, now(), now())",
      [author, organizationId, workspaceId, `${asset}_audience`]);
    const comment = randomUUID();
    await privileged.query(
      `insert into interactions.interactions (id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id, provider_content_id, observed, kind, author_id, author_role,
         current_visibility, current_availability, provider_created_at, state_observed_at, first_observed_at, latest_observed_at, created_at, updated_at)
       values ($1, $2, $3, 'instagram', $4, $5, $6, $7, $8, true, 'comment', $9, 'user', 'visible', 'available', now() - interval '1 hour', now(), now(), now(), now(), now())`,
      [comment, organizationId, workspaceId, `${asset}_c`, account, asset, content, `${asset}_post`, author]);
    return { organizationId, workspaceId, owner, responder, credential, account, comment };
  };

  const preflight = async (t: Tenant, db: RuntimeDatabase<"worker"> = worker, before?: (tx: DatabaseTransaction) => Promise<void>): Promise<string> => {
    const id = randomUUID();
    await withWorkspaceJobScope(db, t.workspaceId, async (tx: DatabaseTransaction) => {
      await before?.(tx);
      await recordValidationPreflight(tx, { id, connectedAccountId: t.account, targetInteractionId: t.comment, credentialId: t.credential, runReference: `run_7b14i3h_${randomUUID().slice(0, 8)}`,
        status: "VERIFIED", checksVerified: 10, requiredPermissionsGranted: true, repliesComplete: true, repliesByManagedAccount: 0, repliesUnattributed: 0, stoppedEarly: false });
    });
    return id;
  };

  /** One operator transaction (READ COMMITTED, SET LOCAL ROLE app_validation_operator); committed. */
  const call = async (client: pg.Client, text: string, values: readonly unknown[]): Promise<pg.QueryResult> => {
    await client.query("begin transaction isolation level read committed");
    try {
      await client.query("set local role app_validation_operator");
      const result = await client.query(text, [...values]);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  };
  const ISSUE = "select authorization_id, expires_at from mutations.issue_validation_authorization($1, $2, $3, $4, $5, $6)";
  const issueArgs = (t: Tenant, preflightId: string) => [t.workspaceId, preflightId, t.responder, "test", 30, true];
  const sqlstate = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      const code = (error as { code?: unknown }).code ?? (error as { cause?: { code?: unknown } }).cause?.code;
      return typeof code === "string" ? code : error instanceof Error ? error.message : "error";
    }
    return "ok";
  };
  const counts = async (t: Tenant) =>
    (await oracle<{ authorizations: number; events: number; audits: number }>(
      `select (select count(*)::int from mutations.validation_authorizations where workspace_id = $1) as authorizations,
              (select count(*)::int from mutations.validation_operator_events where workspace_id = $1) as events,
              (select count(*)::int from audit.audit_events where workspace_id = $1 and target_type = 'validation_authorization') as audits`, [t.workspaceId]))[0];

  beforeAll(async () => {
    privileged = privilegedPool(getTarget(), 4);
    worker = runtimeDatabase(getTarget(), "worker", 2);
    web = runtimeDatabase(getTarget(), "web", 1);
    asOperator = await operatorLogin(privileged, getTarget(), "validation_operator_hardening");
  });
  afterAll(async () => {
    for (const statement of scratch.reverse()) await privileged.query(statement).catch(() => undefined);
    await cleanupWorld(privileged, organizations);
    await Promise.all([privileged.end(), worker.end(), web.end()]);
  });

  describe("H2 · privileged code never resolves the caller's temporary objects", () => {
    it("(H, I) an operator session armed with a malicious domain over EVERY builtin base type, a `record` composite, look-alike relations, functions and an operator: issue, status and revoke succeed, and nothing ever runs as app_owner", async () => {
      const t = await tenant();
      const preflightId = await preflight(t);
      const client = await asOperator();
      const notices: string[] = [];
      client.on("notice", (notice) => notices.push(String(notice.message)));
      try {
        await client.query(EVIL);
        const types = (await client.query<{ name: string }>(
          "select t.typname::pg_catalog.text as name from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid = t.typnamespace where n.nspname = 'pg_catalog' and t.typtype = 'b' and t.typname !~ '^_' and t.typisdefined order by 1")).rows.map((r) => r.name);
        let domains = 0;
        for (const name of types) {
          // Some base types cannot carry a domain (the caller could not shadow them either): skip those only.
          const made = await client.query(`create domain pg_temp."${name}" as pg_catalog."${name}" check (pg_temp.evil('${name}'))`).then(() => true, () => false);
          if (made) domains += 1;
        }
        expect(domains).toBeGreaterThanOrEqual(60);
        await client.query("create type pg_temp.record as (a pg_catalog.int4)");
        for (const relation of RELATIONS) await client.query(`create temporary table "${relation}" (oid pg_catalog.oid, rolname pg_catalog.name, id pg_catalog.uuid)`);
        for (const [name, args, returns] of FUNCTIONS) {
          await client.query(`create function pg_temp."${name}"(${args}) returns ${returns} language plpgsql as $$ begin perform pg_temp.evil('fn:${name}'); return null; end $$`);
        }
        await client.query("create function pg_temp.evil_eq(pg_catalog.uuid, pg_catalog.uuid) returns pg_catalog.bool language plpgsql as $$ begin return pg_temp.evil('op:='); end $$");
        await client.query("create operator pg_temp.= (leftarg = pg_catalog.uuid, rightarg = pg_catalog.uuid, function = pg_temp.evil_eq)");
        // The fixture is live: in the login's OWN context an unqualified cast resolves the malicious domain.
        await client.query("select 'x'::text");
        expect(notices.some((n) => n.startsWith("PWNED as validation_operator_hardening via text"))).toBe(true);
        notices.length = 0;

        const issued = (await call(client, ISSUE, issueArgs(t, preflightId))).rows[0] as { authorization_id: string };
        const status: unknown = (await call(client, "select state, operator_events from mutations.validation_authorization_status($1, $2)", [t.workspaceId, issued.authorization_id])).rows[0];
        expect(status).toEqual({ state: "ISSUED", operator_events: 1 });
        await call(client, "select mutations.revoke_validation_authorization($1, $2, $3)", [t.workspaceId, issued.authorization_id, "test"]);
        // Refusal paths compile and run the same code: still nothing.
        expect(await sqlstate(call(client, ISSUE, issueArgs(t, preflightId)))).toBe("23505");
        expect(await sqlstate(call(client, "select * from mutations.validation_authorization_status($1, $2)", [t.workspaceId, randomUUID()]))).toBe("P0002");

        expect(notices).toEqual([]);
        expect((await client.query<{ owner: string | null }>("select current_setting('pwn.owner', true) as owner")).rows).toEqual([{ owner: null }]);
        expect(await counts(t)).toEqual({ authorizations: 1, events: 2, audits: 2 });
      } finally {
        await client.end();
      }
    });

    it("(H) a worker session armed the same way records PREFLIGHT evidence; the 0028/0029 definers never run its objects as app_owner", async () => {
      const t = await tenant();
      // A dedicated pool: its connections carry the temporary objects and are closed right after.
      const armed = runtimeDatabase(getTarget(), "worker", 1);
      try {
        const id = await preflight(t, armed, async (tx) => {
          await tx.execute(sql.raw(EVIL));
          for (const name of ["text", "uuid", "timestamptz", "int4", "int2", "bool", "oid", "name"]) await tx.execute(sql.raw(`create domain pg_temp."${name}" as pg_catalog."${name}" check (pg_temp.evil('${name}'))`));
          await tx.execute(sql.raw("create type pg_temp.record as (a pg_catalog.int4)"));
          await tx.execute(sql.raw("select 'x'::text"));
          expect((await tx.execute<{ seen: string | null }>(sql.raw("select current_setting('pwn.seen', true) as seen"))).rows).toEqual([{ seen: "yes" }]);
          await tx.execute(sql.raw("select set_config('pwn.seen', '', true)"));
        });
        expect(await oracle("select passed from mutations.validation_preflights where workspace_id = $1 and id = $2", [t.workspaceId, id])).toEqual([{ passed: true }]);
      } finally {
        await armed.end();
      }
    });
  });

  describe("J · the privileged functions refuse every role but their grantee", () => {
    it("web, worker, the bare login (without SET ROLE) and direct calls to the helpers are refused (42501); nothing is written", async () => {
      const t = await tenant();
      const preflightId = await preflight(t);
      const issueSql = sql`select * from mutations.issue_validation_authorization(${t.workspaceId}::uuid, ${preflightId}::uuid, ${t.responder}::uuid, 'test', 30, true)`;
      expect(await sqlstate(withUserScope(web, { sub: t.owner, role: "authenticated" }, t.workspaceId, (tx) => tx.execute(issueSql)))).toBe("42501");
      expect(await sqlstate(withWorkspaceJobScope(worker, t.workspaceId, (tx: DatabaseTransaction) => tx.execute(issueSql)))).toBe("42501");
      expect(await sqlstate(withWorkspaceJobScope(worker, t.workspaceId, (tx: DatabaseTransaction) => tx.execute(sql`select * from mutations.validation_authorization_status(${t.workspaceId}::uuid, ${randomUUID()}::uuid)`)))).toBe("42501");
      const client = await asOperator();
      try {
        expect(await sqlstate(client.query(ISSUE, issueArgs(t, preflightId)))).toBe("42501");
        for (const helper of ["select mutations.validation_operator_login()", `select mutations.validation_operator_bind('${t.workspaceId}')`]) {
          expect(await sqlstate(call(client, helper, [])), helper).toBe("42501");
        }
      } finally {
        await client.end();
      }
      expect(await counts(t)).toEqual({ authorizations: 0, events: 0, audits: 0 });
    });
  });

  describe("H4 · a mis-provisioned login is refused by the database and by the CLI precheck", () => {
    const database = () => parseDatabaseUrl(getTarget().privilegedUrl, "privileged URL").database;
    /** Each case: a fresh login, one change by the migration role, then every operator call refused and nothing written. */
    const cases: readonly (readonly [string, (login: string) => readonly string[], (login: string) => readonly string[]])[] = [
      ["(K) a direct table grant", (l) => [`grant select on tenancy.workspaces to ${l}`], (l) => [`revoke select on tenancy.workspaces from ${l}`]],
      ["(K) a direct function grant", (l) => [`grant execute on function mutations.record_validation_preflight(uuid, uuid, uuid, uuid, text, text, integer, boolean, boolean, integer, integer, boolean) to ${l}`],
        (l) => [`revoke execute on function mutations.record_validation_preflight(uuid, uuid, uuid, uuid, text, text, integer, boolean, boolean, integer, integer, boolean) from ${l}`]],
      ["(K) CREATE on the database", (l) => [`grant create on database "${database()}" to ${l}`], (l) => [`revoke create on database "${database()}" from ${l}`]],
      ["(K) CREATE on a schema", (l) => [`create schema ${l}_s`, `grant create on schema ${l}_s to ${l}`], (l) => [`drop schema ${l}_s cascade`]],
      ["(K) an INHERIT membership", (l) => [`grant app_validation_operator to ${l} with inherit true`], () => []],
      ["(K) a membership without SET", (l) => [`grant app_validation_operator to ${l} with set false`], () => []],
      ["(K) another role acting through the login", (l) => [`create role ${l}_x nologin`, `grant ${l} to ${l}_x`], (l) => [`revoke ${l} from ${l}_x`]],
      ["(K) per-role settings", (l) => [`alter role ${l} set work_mem = '8MB'`], (l) => [`alter role ${l} reset all`]],
      // The migration role needs SET on the login to hand it an object (PostgreSQL 16+); that membership is the one the
      // check allows (the migration role's), so only the ownership itself is what is refused.
      ["(L) an owned table", (l) => [`grant ${l} to current_user with set true`, `create schema ${l}_o`, `create table ${l}_o.t (a int)`, `grant create on schema ${l}_o to ${l}`, `alter table ${l}_o.t owner to ${l}`, `revoke create on schema ${l}_o from ${l}`], (l) => [`drop schema ${l}_o cascade`]],
      ["(L) an owned function", (l) => [`grant ${l} to current_user with set true`, `create schema ${l}_f`, `create function ${l}_f.f() returns int language sql as 'select 1'`, `grant create on schema ${l}_f to ${l}`, `alter function ${l}_f.f() owner to ${l}`, `revoke create on schema ${l}_f from ${l}`], (l) => [`drop schema ${l}_f cascade`]],
    ];

    it.each(cases.map((c, i) => [c[0], i] as const))("%s → issue, status and revoke refused (42501), the precheck names it, nothing written", async (_name, index) => {
      const [, apply, undo] = cases[index] as (typeof cases)[number];
      const login = `validation_operator_h4_${String(index)}`;
      const connect = await operatorLogin(privileged, getTarget(), login);
      for (const statement of apply(login)) await privileged.query(statement);
      for (const statement of undo(login)) scratch.push(statement);
      const t = await tenant();
      const preflightId = await preflight(t);
      const client = await connect();
      try {
        expect((await operatorSessionProblems(client)).length).toBeGreaterThan(0);
        expect(await sqlstate(call(client, ISSUE, issueArgs(t, preflightId)))).toBe("42501");
        expect(await sqlstate(call(client, "select * from mutations.validation_authorization_status($1, $2)", [t.workspaceId, randomUUID()]))).toBe("42501");
        expect(await sqlstate(call(client, "select mutations.revoke_validation_authorization($1, $2, $3)", [t.workspaceId, randomUUID(), "test"]))).toBe("42501");
      } finally {
        await client.end();
      }
      expect(await counts(t)).toEqual({ authorizations: 0, events: 0, audits: 0 });
    });

    it("the correctly provisioned login passes the precheck on the real catalog, its own temporary objects aside", async () => {
      const client = await asOperator();
      try {
        expect(await operatorSessionProblems(client)).toEqual([]);
        await client.query("create temporary table own_scratch (a int)");
        expect(await operatorSessionProblems(client)).toEqual([]);
      } finally {
        await client.end();
      }
    });

    it.each([
      ["a table privilege", "grant select on mutations.validation_preflights to app_validation_operator", "revoke select on mutations.validation_preflights from app_validation_operator"],
      ["a fourth function", "grant execute on function mutations.validation_operator_login() to app_validation_operator", "revoke execute on function mutations.validation_operator_login() from app_validation_operator"],
      ["a membership of its own", "grant app_worker to app_validation_operator", "revoke app_worker from app_validation_operator"],
      ["USAGE on another schema", "grant usage on schema credentials to app_validation_operator", "revoke usage on schema credentials from app_validation_operator"],
    ] as const)("(K) the operator role holding %s refuses EVERY login (42501)", async (_name, widen, restore) => {
      const t = await tenant();
      const preflightId = await preflight(t);
      await privileged.query(widen);
      try {
        const client = await asOperator();
        try {
          expect(await sqlstate(call(client, ISSUE, issueArgs(t, preflightId)))).toBe("42501");
        } finally {
          await client.end();
        }
      } finally {
        await privileged.query(restore);
      }
      expect(await counts(t)).toEqual({ authorizations: 0, events: 0, audits: 0 });
      // Restored: the same login issues again.
      const client = await asOperator();
      try {
        expect((await call(client, ISSUE, issueArgs(t, preflightId))).rows).toHaveLength(1);
      } finally {
        await client.end();
      }
    });
  });
}
