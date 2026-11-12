/**
 * Step 7B-14I2 — the operator path for one-time validation authorizations (migration 0029), on the real database.
 * Synthetic tenants only; local disposable cluster only (operator logins are created per run: R8). No provider, no
 * network, no executor run here (the end-to-end request → executor → reconciliation path is in validation-integration).
 *
 *   privileges   app_validation_operator: NOLOGIN, NOINHERIT, NOBYPASSRLS; USAGE on `mutations` and EXECUTE on three
 *                functions — nothing else (no table, credential, switch, intent, audit); no SET ROLE escalation
 *   identity     the session login, never a declared value: forged app.operator_id is ignored; the migration role, an
 *                INHERIT login, a login with a second membership and a misnamed login are all refused
 *   evidence     only the bound worker records it; the database derives `passed` and the time; it re-checks the examined
 *                credential; it is used once; it never changes
 *   issuance     needs a passed, fresh (≤ 30 min), unused preflight of THIS workspace, explicit token-type acceptance,
 *                unchanged account / connection / credential / target, a replying initiator, ≤ 60 minutes; atomic with
 *                its operator log row and its audit event; races leave exactly one
 *   revocation   atomic with log + audit; refused twice and after consumption
 *   status       identifiers, enums and times; operator sessions only
 */
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordValidationPreflight, type ValidationPreflightEvidence } from "@/mutations/persistence/validation-preflights";
import { withWorkspaceJobScope, withUserScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { operatorLogin } from "../support/validation-operator";
import { cleanupWorld } from "../support/world";

const ROLES = ["OWNER", "RESPONDER", "ANALYST_VIEWER"] as const;
type Role = (typeof ROLES)[number];
const OPERATOR = "validation_operator_suite";

interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly users: Readonly<Record<Role, string>>;
  readonly connection: string;
  readonly credential: string;
  readonly account: string;
  readonly comment: string;
  readonly otherComment: string;
}

const PASSING: Omit<ValidationPreflightEvidence, "id" | "connectedAccountId" | "targetInteractionId" | "credentialId" | "runReference"> = {
  status: "VERIFIED", checksVerified: 10, requiredPermissionsGranted: true, repliesComplete: true, repliesByManagedAccount: 0, repliesUnattributed: 0, stoppedEarly: false,
};

export function defineValidationOperatorSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let worker: RuntimeDatabase<"worker">;
  let web: RuntimeDatabase<"web">;
  let asOperator: () => Promise<pg.Client>;
  const organizations: string[] = [];
  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;

  const tenant = async (): Promise<Tenant> => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    organizations.push(organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Validation operator', now())", [organizationId]);
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'STANDARD', now())", [workspaceId, organizationId]);
    const users = {} as Record<Role, string>;
    for (const role of ROLES) {
      const user = randomUUID();
      users[role] = user;
      await privileged.query("insert into tenancy.organization_memberships values ($1, $2, $3, now())", [organizationId, user, role === "OWNER" ? "OWNER" : "MEMBER"]);
      await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, $4, '{}', now())", [organizationId, workspaceId, user, role]);
    }
    const connection = randomUUID();
    const credential = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`, [connection, organizationId, workspaceId, users.OWNER]);
    await privileged.query(
      "insert into credentials.provider_credentials (id, organization_id, workspace_id, connection_id, credential_version, envelope, created_at) values ($1, $2, $3, $4, 1, $5, now())",
      [credential, organizationId, workspaceId, connection, Buffer.concat([Buffer.from("5349504501", "hex"), randomBytes(64)])]);
    await privileged.query("update connections.connections set active_credential_id = $1 where id = $2", [credential, connection]);
    const asset = `ig_7b14i2_${randomUUID().slice(0, 8)}`;
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
    const comment = async (): Promise<string> => {
      const id = randomUUID();
      await privileged.query(
        `insert into interactions.interactions (id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id, provider_content_id, observed, kind, author_id, author_role,
           current_visibility, current_availability, provider_created_at, state_observed_at, first_observed_at, latest_observed_at, created_at, updated_at)
         values ($1, $2, $3, 'instagram', $4, $5, $6, $7, $8, true, 'comment', $9, 'user', 'visible', 'available', now() - interval '1 hour', now(), now(), now(), now(), now())`,
        [id, organizationId, workspaceId, `${asset}_c_${randomUUID().slice(0, 8)}`, account, asset, content, `${asset}_post`, author]);
      return id;
    };
    return { organizationId, workspaceId, users, connection, credential, account, comment: await comment(), otherComment: await comment() };
  };

  /** The bound worker records ONE preflight's evidence (as the INTEGRATION preflight run does). */
  const preflight = async (t: Tenant, overrides: Partial<ValidationPreflightEvidence> = {}): Promise<string> => {
    const id = randomUUID();
    await withWorkspaceJobScope(worker, t.workspaceId, (tx: DatabaseTransaction) =>
      recordValidationPreflight(tx, { id, connectedAccountId: t.account, targetInteractionId: t.comment, credentialId: t.credential, runReference: `run_7b14i2_${randomUUID().slice(0, 8)}`, ...PASSING, ...overrides }));
    return id;
  };

  interface IssueOptions { readonly workspaceId?: string; readonly preflightId: string; readonly initiator?: string; readonly reason?: string; readonly lifetime?: number; readonly accept?: boolean; readonly before?: (client: pg.Client) => Promise<void> }
  /** One operator transaction (READ COMMITTED, SET LOCAL ROLE app_validation_operator) issuing; committed. */
  const issueWith = async (connect: () => Promise<pg.Client>, t: Tenant, options: IssueOptions): Promise<{ readonly authorization_id: string; readonly expires_at: Date }> => {
    const client = await connect();
    try {
      await client.query("begin transaction isolation level read committed");
      await client.query("set local role app_validation_operator");
      await options.before?.(client);
      const row = (await client.query<{ authorization_id: string; expires_at: Date }>(
        "select authorization_id, expires_at from mutations.issue_validation_authorization($1, $2, $3, $4, $5, $6)",
        [options.workspaceId ?? t.workspaceId, options.preflightId, options.initiator ?? t.users.RESPONDER, options.reason ?? "live_validation", options.lifetime ?? 60, options.accept ?? true])).rows[0];
      await client.query("commit");
      if (row === undefined) throw new Error("no row");
      return row;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  };
  const issue = (t: Tenant, options: IssueOptions) => issueWith(asOperator, t, options);
  /** Any statement(s) in one operator transaction; rolled back. Returns the last result. */
  const operatorRun = async (connect: () => Promise<pg.Client>, statements: readonly (readonly [string, readonly unknown[]])[], role = true): Promise<pg.QueryResult> => {
    const client = await connect();
    try {
      await client.query("begin");
      if (role) await client.query("set local role app_validation_operator");
      let last: pg.QueryResult | undefined;
      for (const [text, values] of statements) last = await client.query(text, [...values]);
      if (last === undefined) throw new Error("nothing ran");
      return last;
    } finally {
      await client.query("rollback").catch(() => undefined);
      await client.end();
    }
  };
  const commitRun = async (connect: () => Promise<pg.Client>, text: string, values: readonly unknown[]): Promise<pg.QueryResult> => {
    const client = await connect();
    try {
      await client.query("begin");
      await client.query("set local role app_validation_operator");
      const result = await client.query(text, [...values]);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  };
  const sqlstate = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      const code = (error as { code?: unknown }).code ?? ((error as { cause?: { code?: unknown } }).cause?.code);
      return typeof code === "string" ? code : error instanceof Error ? error.message : "error";
    }
    return "ok";
  };
  const authorization = async (t: Tenant, id: string) =>
    (await oracle<{ issued_by: string; issue_reason: string; target_interaction_id: string; connected_account_id: string; initiator_user_id: string; preflight_run_reference: string; lifetime_minutes: number; revoked: boolean; revoked_by: string | null }>(
      `select issued_by, issue_reason, target_interaction_id, connected_account_id, initiator_user_id, preflight_run_reference,
              extract(epoch from expires_at - issued_at)::int / 60 as lifetime_minutes, revoked_at is not null as revoked, revoked_by
         from mutations.validation_authorizations where workspace_id = $1 and id = $2`, [t.workspaceId, id]))[0];
  const counts = async (t: Tenant) =>
    (await oracle<{ authorizations: number; events: number; audits: number }>(
      `select (select count(*)::int from mutations.validation_authorizations where workspace_id = $1) as authorizations,
              (select count(*)::int from mutations.validation_operator_events where workspace_id = $1) as events,
              (select count(*)::int from audit.audit_events where workspace_id = $1 and target_type = 'validation_authorization') as audits`, [t.workspaceId]))[0];

  beforeAll(async () => {
    privileged = privilegedPool(getTarget(), 4);
    worker = runtimeDatabase(getTarget(), "worker", 2);
    web = runtimeDatabase(getTarget(), "web", 1);
    asOperator = await operatorLogin(privileged, getTarget(), OPERATOR);
  });
  afterAll(async () => {
    await cleanupWorld(privileged, organizations);
    await Promise.all([privileged.end(), worker.end(), web.end()]);
  });

  describe("1 · the operator role holds nothing but three functions", () => {
    it("app_validation_operator is NOLOGIN NOINHERIT NOBYPASSRLS, with no table, schema-object or function privilege beyond the three", async () => {
      expect(await oracle("select rolcanlogin, rolinherit, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb, rolreplication from pg_roles where rolname = 'app_validation_operator'"))
        .toEqual([{ rolcanlogin: false, rolinherit: false, rolbypassrls: false, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false }]);
      const tables = await oracle<{ name: string }>(
        `select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p', 'v') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_%'
            and (has_table_privilege('app_validation_operator', c.oid, 'SELECT') or has_table_privilege('app_validation_operator', c.oid, 'INSERT')
              or has_table_privilege('app_validation_operator', c.oid, 'UPDATE') or has_table_privilege('app_validation_operator', c.oid, 'DELETE'))`);
      expect(tables).toEqual([]);
      const functions = await oracle<{ signature: string }>(
        `select p.oid::regprocedure::text as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('mutations', 'app', 'app_private', 'credentials', 'connections', 'system', 'audit', 'tenancy') and has_function_privilege('app_validation_operator', p.oid, 'EXECUTE') order by 1`);
      expect(functions.map((row) => row.signature)).toEqual([
        "mutations.issue_validation_authorization(uuid,uuid,uuid,text,integer,boolean)",
        "mutations.revoke_validation_authorization(uuid,uuid,text)",
        "mutations.validation_authorization_status(uuid,uuid)",
      ]);
      const schemas = await oracle<{ nspname: string }>("select nspname from pg_namespace where has_schema_privilege('app_validation_operator', oid, 'USAGE') and nspname not in ('pg_catalog', 'information_schema', 'public') and nspname not like 'pg_%' order by 1");
      expect(schemas.map((row) => row.nspname)).toEqual(["mutations"]);
    });

    it("direct SQL from an operator session is refused everywhere: authorizations, evidence, log, intents, credentials, switches, audit", async () => {
      const t = await tenant();
      for (const statement of [
        "select * from mutations.validation_authorizations",
        "insert into mutations.validation_authorizations (id) values (gen_random_uuid())",
        "update mutations.validation_authorizations set revoked_at = now()",
        "delete from mutations.validation_authorizations",
        "select * from mutations.validation_preflights",
        "update mutations.validation_preflights set checks_verified = 10",
        "insert into mutations.validation_operator_events (id) values (gen_random_uuid())",
        "select * from mutations.mutation_intents",
        "update mutations.mutation_intents set status = 'EXECUTING'",
        "select * from credentials.provider_credentials",
        "update system.operational_switches set value = '{}'",
        "insert into audit.audit_events (id) values (gen_random_uuid())",
        "select mutations.record_validation_preflight(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'r', 'VERIFIED', 10, true, true, 0, 0, false)",
        "select app.bind_workspace(gen_random_uuid())",
      ]) expect(await sqlstate(operatorRun(asOperator, [[statement, []]])), statement).toBe("42501");
      expect(await counts(t)).toEqual({ authorizations: 0, events: 0, audits: 0 });
    });

    it("no SET ROLE escalation: the operator login can become app_validation_operator and nothing else", async () => {
      for (const role of ["app_owner", "app_worker", "app_system", "authenticated", "postgres", "service_role"]) {
        expect(await sqlstate(operatorRun(asOperator, [[`set local role ${role}`, []]], false)), role).toMatch(/^(42501|22023|42704)$/);
      }
      expect(await sqlstate(operatorRun(asOperator, [["set session authorization postgres", []]], false))).toBe("42501");
      expect((await operatorRun(asOperator, [["select current_user::text as role", []]])).rows).toEqual([{ role: "app_validation_operator" }]);
    });
  });

  describe("2 · identity is the session login, never a declared value", () => {
    it("a forged app.operator_id / app.change_reason is ignored: issued_by is the session login, the reason the argument", async () => {
      const t = await tenant();
      const issued = await issue(t, { preflightId: await preflight(t), before: (client) => client.query("select set_config('app.operator_id', 'forged.operator', true), set_config('app.change_reason', 'test', true)").then(() => undefined) });
      expect(await authorization(t, issued.authorization_id)).toMatchObject({ issued_by: OPERATOR, issue_reason: "live_validation" });
      expect(await oracle("select operator_login, event, reason from mutations.validation_operator_events where workspace_id = $1", [t.workspaceId])).toEqual([{ operator_login: OPERATOR, event: "issued", reason: "live_validation" }]);
    });

    it("the migration role (postgres), an INHERIT login, a login with a second membership and a misnamed login are refused (42501), and nothing is written", async () => {
      const t = await tenant();
      const preflightId = await preflight(t);
      const args = [t.workspaceId, preflightId, t.users.RESPONDER, "live_validation", 60, true];
      // postgres reaches the function through the owner membership; the identity check refuses the session login.
      expect(await sqlstate(privileged.query("select * from mutations.issue_validation_authorization($1, $2, $3, $4, $5, $6)", args))).toBe("42501");
      expect(await sqlstate(privileged.query("select * from mutations.validation_authorization_status($1, $2)", [t.workspaceId, randomUUID()]))).toBe("42501");
      for (const [name, shape] of [["validation_operator_inherit", "inherit"], ["validation_operator_extra", "extra_membership"], ["rogue_operator_login", "misnamed"]] as const) {
        const connect = await operatorLogin(privileged, getTarget(), name, shape);
        expect(await sqlstate(issueWith(connect, t, { preflightId })), name).toBe("42501");
        expect(await sqlstate(operatorRun(connect, [["select * from mutations.validation_authorization_status($1, $2)", [t.workspaceId, randomUUID()]]])), name).toBe("42501");
      }
      expect(await counts(t)).toEqual({ authorizations: 0, events: 0, audits: 0 });
      expect(await oracle("select authorization_id from mutations.validation_preflights where workspace_id = $1 and id = $2", [t.workspaceId, preflightId])).toEqual([{ authorization_id: null }]);
    });
  });

  describe("3 · PREFLIGHT evidence: recorded by the bound worker only, derived and re-checked by the database", () => {
    it("the worker records it with the database clock and a derived `passed`; any failing count makes passed false", async () => {
      const t = await tenant();
      const ok = await preflight(t);
      expect(await oracle("select passed, token_type, abs(extract(epoch from clock_timestamp() - recorded_at)) < 60 as fresh, connection_id = $3 as same_connection from mutations.validation_preflights where workspace_id = $1 and id = $2", [t.workspaceId, ok, t.connection]))
        .toEqual([{ passed: true, token_type: "NOT_VERIFIED", fresh: true, same_connection: true }]);
      for (const change of [{ status: "NOT_VERIFIED" }, { checksVerified: 9 }, { requiredPermissionsGranted: false }, { repliesComplete: false }, { repliesByManagedAccount: 1 }, { repliesByManagedAccount: null }, { repliesUnattributed: 1 }, { stoppedEarly: true }] as const) {
        const id = await preflight(t, change);
        expect(await oracle("select passed from mutations.validation_preflights where workspace_id = $1 and id = $2", [t.workspaceId, id]), JSON.stringify(change)).toEqual([{ passed: false }]);
      }
    });

    it("refused for a credential that is not the active one, an account of another workspace, a web member, or an unbound worker", async () => {
      const t = await tenant();
      const other = await tenant();
      expect(await sqlstate(preflight(t, { credentialId: randomUUID() }))).toBe("42501");
      expect(await sqlstate(preflight(t, { connectedAccountId: other.account }))).toBe("42501");
      const call = sql`select mutations.record_validation_preflight(${randomUUID()}::uuid, ${t.account}::uuid, ${t.comment}::uuid, ${t.credential}::uuid, 'run_x', 'VERIFIED', 10, true, true, 0, 0, false)`;
      expect(await sqlstate(withUserScope(web, { sub: t.users.OWNER, role: "authenticated" }, t.workspaceId, (tx) => tx.execute(call)))).toBe("42501");
      expect(await oracle("select count(*)::int as n from mutations.validation_preflights where workspace_id = $1", [t.workspaceId])).toEqual([{ n: 0 }]);
    });

    it("the evidence never changes (even for the migration role) and is deleted only with its workspace", async () => {
      const t = await tenant();
      const id = await preflight(t, { checksVerified: 9 });
      for (const statement of ["update mutations.validation_preflights set checks_verified = 10 where id = $1", "update mutations.validation_preflights set recorded_at = now() where id = $1", "delete from mutations.validation_preflights where id = $1"]) {
        expect(await sqlstate(privileged.query(statement, [id])), statement).toBe("42501");
      }
      expect(await oracle("select passed from mutations.validation_preflights where id = $1", [id])).toEqual([{ passed: false }]);
    });
  });

  describe("4 · issuance", () => {
    it("issues exactly one authorization for the evidence's account and target, ≤ 60 minutes, atomically with its log row and audit event; the evidence is used", async () => {
      const t = await tenant();
      const preflightId = await preflight(t);
      const issued = await issue(t, { preflightId, lifetime: 45 });
      expect(await authorization(t, issued.authorization_id)).toMatchObject({ target_interaction_id: t.comment, connected_account_id: t.account, initiator_user_id: t.users.RESPONDER, lifetime_minutes: 45, revoked: false });
      expect(await counts(t)).toEqual({ authorizations: 1, events: 1, audits: 1 });
      expect(await oracle("select action, actor_type, actor_user_id, target_id, outcome from audit.audit_events where workspace_id = $1 and target_type = 'validation_authorization'", [t.workspaceId]))
        .toEqual([{ action: "validation_authorization.issued", actor_type: "system", actor_user_id: null, target_id: issued.authorization_id, outcome: "succeeded" }]);
      expect(await oracle("select authorization_id, token_type_not_verified_accepted from mutations.validation_preflights p join mutations.validation_operator_events e using (workspace_id, authorization_id) where p.workspace_id = $1", [t.workspaceId]))
        .toEqual([{ authorization_id: issued.authorization_id, token_type_not_verified_accepted: true }]);
    });

    it.each([
      ["a lifetime over 60 minutes", { lifetime: 61 }, "22023"],
      ["a zero lifetime", { lifetime: 0 }, "22023"],
      ["a revocation reason as issue reason", { reason: "incident" }, "22023"],
      ["no explicit acceptance of the NOT_VERIFIED token type", { accept: false }, "42501"],
    ] as const)("refuses %s (%s), writing nothing", async (_name, change, code) => {
      const t = await tenant();
      expect(await sqlstate(issue(t, { preflightId: await preflight(t), ...change }))).toBe(code);
      expect(await counts(t)).toEqual({ authorizations: 0, events: 0, audits: 0 });
    });

    it("refuses missing, foreign, failed, used and stale evidence — absence of evidence never becomes an authorization", async () => {
      const t = await tenant();
      const other = await tenant();
      expect(await sqlstate(issue(t, { preflightId: randomUUID() }))).toBe("P0002");
      expect(await sqlstate(issue(t, { preflightId: await preflight(other) }))).toBe("P0002");
      expect(await sqlstate(issue(t, { workspaceId: other.workspaceId, preflightId: await preflight(t) }))).toBe("P0002");
      expect(await sqlstate(issue(t, { preflightId: await preflight(t, { repliesByManagedAccount: 1 }) }))).toBe("42501");
      // Stale: evidence recorded 31 minutes ago (inserted by the bootstrap role exactly as the definer would, but older).
      const stale = randomUUID();
      await privileged.query(
        `insert into mutations.validation_preflights (id, organization_id, workspace_id, connected_account_id, target_interaction_id, connection_id, credential_id, run_reference, status, checks_verified,
           required_permissions_granted, replies_complete, replies_by_managed_account, replies_unattributed, stopped_early, token_type, recorded_at)
         values ($1, $2, $3, $4, $5, $6, $7, 'run_stale', 'VERIFIED', 10, true, true, 0, 0, false, 'NOT_VERIFIED', clock_timestamp() - interval '31 minutes')`,
        [stale, t.organizationId, t.workspaceId, t.account, t.comment, t.connection, t.credential]);
      expect(await sqlstate(issue(t, { preflightId: stale }))).toBe("42501");
      expect(await counts(t)).toEqual({ authorizations: 0, events: 0, audits: 0 });
      // Used: the first issuance consumes the evidence; the second (even after revoking the first) is refused.
      const once = await preflight(t);
      const first = await issue(t, { preflightId: once });
      await commitRun(asOperator, "select mutations.revoke_validation_authorization($1, $2, $3)", [t.workspaceId, first.authorization_id, "superseded"]);
      expect(await sqlstate(issue(t, { preflightId: once }))).toBe("23505");
    });

    it("refuses when anything material changed since the preflight: credential rotated, account inactive, comment hidden or removed", async () => {
      const rotate = await tenant();
      const p1 = await preflight(rotate);
      const fresh = randomUUID();
      await privileged.query("insert into credentials.provider_credentials (id, organization_id, workspace_id, connection_id, credential_version, envelope, created_at) values ($1, $2, $3, $4, 2, $5, now())",
        [fresh, rotate.organizationId, rotate.workspaceId, rotate.connection, Buffer.concat([Buffer.from("5349504501", "hex"), randomBytes(64)])]);
      await privileged.query("update connections.connections set active_credential_id = $1 where id = $2", [fresh, rotate.connection]);
      expect(await sqlstate(issue(rotate, { preflightId: p1 }))).toBe("42501");

      const hidden = await tenant();
      const p2 = await preflight(hidden);
      await privileged.query("update interactions.interactions set current_visibility = 'hidden' where workspace_id = $1 and id = $2", [hidden.workspaceId, hidden.comment]);
      expect(await sqlstate(issue(hidden, { preflightId: p2 }))).toBe("42501");

      const removed = await tenant();
      const p3 = await preflight(removed);
      await privileged.query("update interactions.interactions set current_availability = 'removed_at_source', current_removal_basis = 'explicit_provider_signal' where workspace_id = $1 and id = $2", [removed.workspaceId, removed.comment]);
      expect(await sqlstate(issue(removed, { preflightId: p3 }))).toBe("42501");

      const inactive = await tenant();
      const p4 = await preflight(inactive);
      await privileged.query("update connections.connections set status = 'DEGRADED' where id = $1", [inactive.connection]);
      expect(await sqlstate(issue(inactive, { preflightId: p4 }))).toBe("42501");
      for (const t of [rotate, hidden, removed, inactive]) expect(await counts(t)).toEqual({ authorizations: 0, events: 0, audits: 0 });
    });

    it("the 0028 guard still decides the rest: a non-replying initiator or a member of another workspace is refused", async () => {
      const t = await tenant();
      const other = await tenant();
      expect(await sqlstate(issue(t, { preflightId: await preflight(t), initiator: t.users.ANALYST_VIEWER }))).toBe("42501");
      expect(await sqlstate(issue(t, { preflightId: await preflight(t), initiator: other.users.RESPONDER }))).toBe("42501");
      expect(await counts(t)).toEqual({ authorizations: 0, events: 0, audits: 0 });
    });

    it("races: two issuances for the same comment (two evidence rows) or from the same evidence leave exactly ONE authorization", async () => {
      const t = await tenant();
      const [a, b] = [await preflight(t), await preflight(t)];
      const outcomes = await Promise.allSettled([issue(t, { preflightId: a }), issue(t, { preflightId: b })]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      expect(await counts(t)).toEqual({ authorizations: 1, events: 1, audits: 1 });
      const u = await tenant();
      const same = await preflight(u);
      const twice = await Promise.allSettled([issue(u, { preflightId: same }), issue(u, { preflightId: same })]);
      expect(twice.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      expect(await counts(u)).toEqual({ authorizations: 1, events: 1, audits: 1 });
    });

    it("an operator transaction bound to one workspace cannot act on another", async () => {
      const t = await tenant();
      const other = await tenant();
      const issued = await issue(t, { preflightId: await preflight(t) });
      expect(await sqlstate(operatorRun(asOperator, [
        ["select * from mutations.validation_authorization_status($1, $2)", [t.workspaceId, issued.authorization_id]],
        ["select * from mutations.validation_authorization_status($1, $2)", [other.workspaceId, issued.authorization_id]],
      ]))).toBe("42501");
    });
  });

  describe("5 · revocation, status and the append-only log", () => {
    const consume = async (t: Tenant, authorizationId: string): Promise<string> => {
      const intent = randomUUID();
      await withUserScope(web, { sub: t.users.RESPONDER, role: "authenticated" }, t.workspaceId, (tx) => tx.execute(sql`insert into mutations.mutation_intents (id, organization_id, workspace_id, kind, request_type, target_interaction_id, connected_account_id, initiator_user_id, idempotency_key, status, attempt,
          capability_catalog_id, capability_catalog_revision, correlation_id, created_at, updated_at, validation_authorization_id)
        values (${intent}, ${t.organizationId}, ${t.workspaceId}, 'reply_public', 'human', ${t.comment}, ${t.account}, ${t.users.RESPONDER}, ${`key-${randomUUID()}`}, 'PENDING', 0, 'platform', 5, ${`corr-7b14i2-${randomUUID()}`}, now(), now(), ${authorizationId})`));
      await withWorkspaceJobScope(worker, t.workspaceId, (tx: DatabaseTransaction) => tx.execute(sql`update mutations.mutation_intents set status = 'EXECUTING', attempt = 1, run_reference = 'run_7b14i2', updated_at = now() where workspace_id = ${t.workspaceId} and id = ${intent} and status = 'PENDING'`));
      return intent;
    };
    const status = async (t: Tenant, id: string) => (await operatorRun(asOperator, [["select * from mutations.validation_authorization_status($1, $2)", [t.workspaceId, id]]])).rows[0] as Record<string, unknown>;

    it("revokes atomically with its log row and audit event; a second revocation is refused; status reports each state", async () => {
      const t = await tenant();
      const issued = await issue(t, { preflightId: await preflight(t) });
      expect(await status(t, issued.authorization_id)).toMatchObject({ state: "ISSUED", issued_by: OPERATOR, intent_id: null, operator_events: 1 });
      await commitRun(asOperator, "select mutations.revoke_validation_authorization($1, $2, $3)", [t.workspaceId, issued.authorization_id, "incident"]);
      expect(await authorization(t, issued.authorization_id)).toMatchObject({ revoked: true, revoked_by: OPERATOR });
      expect(await counts(t)).toEqual({ authorizations: 1, events: 2, audits: 2 });
      expect(await status(t, issued.authorization_id)).toMatchObject({ state: "REVOKED", revocation_reason: "incident", operator_events: 2 });
      expect(await sqlstate(commitRun(asOperator, "select mutations.revoke_validation_authorization($1, $2, $3)", [t.workspaceId, issued.authorization_id, "incident"]))).toBe("42501");
      expect(await sqlstate(commitRun(asOperator, "select mutations.revoke_validation_authorization($1, $2, $3)", [t.workspaceId, randomUUID(), "incident"]))).toBe("P0002");
      expect(await sqlstate(commitRun(asOperator, "select mutations.revoke_validation_authorization($1, $2, $3)", [t.workspaceId, issued.authorization_id, "live_validation"]))).toBe("22023");
      expect(await counts(t)).toEqual({ authorizations: 1, events: 2, audits: 2 });
    });

    it("after consumption: revocation is refused (never recalls a call), status shows CONSUMED and the intent; re-issuing for that comment is refused", async () => {
      const t = await tenant();
      const issued = await issue(t, { preflightId: await preflight(t) });
      const intent = await consume(t, issued.authorization_id);
      expect(await status(t, issued.authorization_id)).toMatchObject({ state: "CONSUMED", intent_id: intent, intent_status: "EXECUTING", intent_attempt: 1, reply_provider_identity: false });
      expect(await sqlstate(commitRun(asOperator, "select mutations.revoke_validation_authorization($1, $2, $3)", [t.workspaceId, issued.authorization_id, "incident"]))).toBe("42501");
      expect(await sqlstate(issue(t, { preflightId: await preflight(t) }))).toBe("23505");
      expect(await counts(t)).toEqual({ authorizations: 1, events: 1, audits: 1 });
    });

    it("the operator log and its audit rows are append-only, even for the migration role", async () => {
      const t = await tenant();
      await issue(t, { preflightId: await preflight(t) });
      expect(await sqlstate(privileged.query("update mutations.validation_operator_events set operator_login = 'validation_operator_other' where workspace_id = $1", [t.workspaceId]))).toBe("42501");
      expect(await sqlstate(privileged.query("delete from mutations.validation_operator_events where workspace_id = $1", [t.workspaceId]))).toBe("42501");
      expect(await counts(t)).toEqual({ authorizations: 1, events: 1, audits: 1 });
    });

    it("the owner's audit policy admits only the operator's two events, alongside their own log rows", async () => {
      const policy = (await oracle<{ check: string }>("select pg_get_expr(polwithcheck, polrelid) as check from pg_policy where polname = 'owner_validation_audit'"))[0]?.check ?? "";
      expect(policy).toMatch(/validation_authorization\.issued/);
      expect(policy).toMatch(/validation_operator_events/);
      expect(policy).toMatch(/app_validation_operator/);
    });
  });
}
