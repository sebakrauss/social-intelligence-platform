/**
 * Schema classification and grant introspection (TA §11.1, §54, §64; R4). Compares the live catalog with
 * db/schema/classification.ts: every application table classified, RLS enabled AND forced, exactly the
 * expected policies, exactly the expected table/column privileges and function EXECUTE grants, schema
 * USAGE only where expected, no default privileges relied on, nothing for anon/service_role/PUBLIC or
 * the login roles themselves, and Drizzle mappings that match the real columns.
 */
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPLICATION_SCHEMAS, FUNCTION_EXECUTE, RESTRICTIVE_POLICIES, SCHEMA_USAGE, TABLE_CLASSIFICATION } from "@/db/schema/classification";
import { auditEvents } from "@/modules/audit/persistence";
import { invitations, organizationMemberships, organizations, workspaceMemberships, workspaces } from "@/modules/tenancy/persistence";
import { outbox } from "@/platform/db";
import { privilegedPool, type DbTarget } from "../support/target";

const COMMANDS: Readonly<Record<string, string>> = { r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE", "*": "ALL" };
const schemas = [...APPLICATION_SCHEMAS];

export function defineIntrospectionSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  const query = async <T extends pg.QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<T[]> =>
    (await privileged.query<T>(text, [...values])).rows;

  beforeAll(() => {
    privileged = privilegedPool(getTarget());
  });
  afterAll(async () => {
    await privileged.end();
  });

  describe("schema classification (R4)", () => {
    it("every table in an application schema is classified, and every classified table exists", async () => {
      const tables = await query<{ name: string }>(
        `select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname = any($1::text[]) order by 1`, [schemas]);
      expect(tables.map((table) => table.name)).toEqual(Object.keys(TABLE_CLASSIFICATION).sort());
    });

    it("the owner role owns no schema outside the registry, and no application table lives in public", async () => {
      const owned = await query<{ nspname: string }>(
        "select n.nspname from pg_namespace n join pg_roles r on r.oid = n.nspowner where r.rolname = 'app_owner' order by 1");
      for (const schema of owned) expect(schemas).toContain(schema.nspname);
      const publicTables = await query(
        "select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_roles r on r.oid = c.relowner where n.nspname = 'public' and r.rolname like 'app_%'");
      expect(publicTables).toEqual([]);
    });

    it("every application table has RLS enabled and forced", async () => {
      const rows = await query<{ name: string; enabled: boolean; forced: boolean }>(
        `select n.nspname || '.' || c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
           from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') and n.nspname = any($1::text[])`, [schemas]);
      for (const row of rows) expect(row, row.name).toMatchObject({ enabled: true, forced: true });
    });

    it("each table carries exactly the expected policies", async () => {
      const rows = await query<{ name: string; policy: string }>(
        `select n.nspname || '.' || c.relname as name,
                p.polname || ' ' || case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end
                || ' ' || coalesce((select string_agg(g, ',' order by g) from (select case when r = 0 then 'PUBLIC' else pg_get_userbyid(r)::text end as g from unnest(p.polroles) r) roles), '') as policy
           from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = any($1::text[])`, [schemas]);
      for (const [name, expected] of Object.entries(TABLE_CLASSIFICATION)) {
        const actual = rows.filter((row) => row.name === name).map((row) => row.policy).sort();
        expect(actual, name).toEqual([...expected.policies].sort());
      }
      expect(Object.values(COMMANDS)).toContain("ALL");
    });

    it("exactly the pinned policies are RESTRICTIVE; every other policy is permissive", async () => {
      const rows = await query<{ policy: string }>(
        `select n.nspname || '.' || c.relname || ' ' || p.polname as policy
           from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = any($1::text[]) and not p.polpermissive`, [schemas]);
      expect(rows.map((row) => row.policy).sort()).toEqual([...RESTRICTIVE_POLICIES].sort());
    });

    it("each table grants exactly the expected privileges, to runtime roles only", async () => {
      const tableGrants = await query<{ name: string; grantee: string; privilege: string }>(
        `select n.nspname || '.' || c.relname as name, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee, a.privilege_type as privilege
           from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) a
          where c.relkind in ('r', 'p') and n.nspname = any($1::text[]) and a.grantee <> c.relowner`, [schemas]);
      const columnGrants = await query<{ name: string; grantee: string; privilege: string }>(
        `select n.nspname || '.' || c.relname as name, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
                a.privilege_type || '(' || att.attname || ')' as privilege
           from pg_attribute att join pg_class c on c.oid = att.attrelid join pg_namespace n on n.oid = c.relnamespace, aclexplode(att.attacl) a
          where c.relkind in ('r', 'p') and n.nspname = any($1::text[]) and att.attacl is not null and a.grantee <> c.relowner`, [schemas]);
      for (const [name, expected] of Object.entries(TABLE_CLASSIFICATION)) {
        const actual: Record<string, string[]> = {};
        for (const grant of [...tableGrants, ...columnGrants].filter((row) => row.name === name)) {
          (actual[grant.grantee] ??= []).push(grant.privilege);
        }
        const normalized = Object.fromEntries(Object.entries(actual).map(([grantee, privileges]) => [grantee, [...privileges].sort()]));
        const wanted = Object.fromEntries(Object.entries(expected.privileges).map(([grantee, privileges]) => [grantee, [...privileges].sort()]));
        expect(normalized, name).toEqual(wanted);
      }
    });

    it("every function is listed, owned by the owner role, executable only where granted, and definers pin an empty search_path", async () => {
      const rows = await query<{ signature: string; owner: string; definer: boolean; config: string[] | null; grantees: string[] | null; public_default: boolean }>(
        `select replace(p.oid::regprocedure::text, ', ', ',') as signature, pg_get_userbyid(p.proowner)::text as owner, p.prosecdef as definer, p.proconfig::text[] as config,
                (select array_agg(case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end)
                   from aclexplode(p.proacl) a where a.grantee <> p.proowner) as grantees,
                p.proacl is null as public_default
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = any($1::text[])`, [schemas]);
      expect(rows.map((row) => row.signature).sort()).toEqual(Object.keys(FUNCTION_EXECUTE).sort());
      for (const row of rows) {
        expect(row.owner, row.signature).toBe("app_owner");
        expect(row.public_default, `${row.signature} relies on default EXECUTE for PUBLIC`).toBe(false);
        expect([...(row.grantees ?? [])].sort(), row.signature).toEqual([...(FUNCTION_EXECUTE[row.signature] ?? [])].sort());
        if (row.definer) expect(row.config ?? [], row.signature).toContain('search_path=""');
      }
    });

    it("schemas grant USAGE only to the expected runtime roles and CREATE to nobody", async () => {
      const rows = await query<{ schema: string; grantee: string; privilege: string }>(
        `select n.nspname as schema, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee, a.privilege_type as privilege
           from pg_namespace n, aclexplode(n.nspacl) a where n.nspname = any($1::text[]) and a.grantee <> n.nspowner`, [schemas]);
      for (const schema of schemas) {
        const grants = rows.filter((row) => row.schema === schema);
        expect(grants.every((row) => row.privilege === "USAGE"), schema).toBe(true);
        expect(grants.map((row) => row.grantee).sort(), schema).toEqual([...SCHEMA_USAGE[schema]].sort());
      }
    });

    it("no default privileges grant anything for objects the owner creates", async () => {
      const rows = await query<{ type: string; acl: string }>(
        `select d.defaclobjtype as type, d.defaclacl::text as acl from pg_default_acl d join pg_roles r on r.oid = d.defaclrole where r.rolname = 'app_owner'`);
      for (const row of rows) expect(row.acl, row.type).not.toMatch(/(^|[{,])=/);
    });

    it("the login roles hold no privileges of their own and anon/service_role reach nothing", async () => {
      const rows = await query<{ role: string; n: number }>(
        `select r.rolname as role, count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) a
           join pg_roles r on r.oid = a.grantee
          where n.nspname = any($1::text[]) and r.rolname in ('web_login', 'worker_login', 'system_login', 'anon', 'service_role', 'postgres')
          group by 1`, [schemas]);
      expect(rows).toEqual([]);
      const usable = await query<{ role: string; schema: string }>(
        `select r.rolname as role, n.nspname as schema from pg_namespace n cross join pg_roles r
          where n.nspname = any($1::text[]) and r.rolname in ('web_login', 'worker_login', 'system_login', 'anon')
            and has_schema_privilege(r.oid, n.oid, 'USAGE')`, [schemas]);
      expect(usable).toEqual([]);
    });
  });

  describe("Drizzle mappings match the migrated tables", () => {
    const mapped: readonly PgTable[] = [organizations, workspaces, organizationMemberships, workspaceMemberships, invitations, auditEvents, outbox];
    for (const table of mapped) {
      const config = getTableConfig(table);
      it(`${config.schema ?? "public"}.${config.name}`, async () => {
        const columns = await query<{ column_name: string }>(
          "select column_name from information_schema.columns where table_schema = $1 and table_name = $2", [config.schema, config.name]);
        expect(columns.map((column) => column.column_name).sort()).toEqual(config.columns.map((column) => column.name).sort());
      });
    }
  });
}
