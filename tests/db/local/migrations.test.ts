/**
 * Migrations and role provisioning on a fresh database (TA §64–§65; R8). The global setup already applied
 * every migration to a brand-new cluster; these tests prove the runner is idempotent and tamper-evident and
 * that provisioning validates long-lived roles in place — never dropping or recreating them.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { parseDatabaseUrl, RUNTIME_KINDS } from "@/platform/db";
import { applyMigrations, migrationStatus, readMigrations } from "@/tools/db/migrations";
import { loginRoleProblems, provisionLoginRoles } from "@/tools/db/provision";
import { runtimeDatabase } from "../support/target";

describe("migrations and provisioning on a fresh database", () => {
  let client: pg.Client;

  beforeAll(async () => {
    const target = parseDatabaseUrl(inject("dbTarget").privilegedUrl, "privileged URL");
    client = new pg.Client({ host: target.host, port: target.port, database: target.database, user: target.user, password: target.password });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  it("applied every repository migration, in order, on a fresh database", async () => {
    const status = await migrationStatus(client, readMigrations());
    expect(status.pending).toEqual([]);
    expect(status.applied).toEqual(readMigrations().map((migration) => migration.name));
  });

  it("is idempotent: a second run applies nothing", async () => {
    expect(await applyMigrations(client, readMigrations())).toEqual([]);
  });

  it("refuses to run when an applied migration was modified", async () => {
    const [first, ...rest] = readMigrations();
    if (first === undefined) throw new Error("no migrations");
    await expect(migrationStatus(client, [{ ...first, checksum: "0".repeat(64) }, ...rest])).rejects.toThrow("applied migration was modified");
    await expect(migrationStatus(client, rest)).rejects.toThrow("missing from the repository");
  });

  it("provisioning validates existing login roles in place: same OIDs, no problems, nothing dropped", async () => {
    const oids = async () => (await client.query<{ rolname: string; oid: number }>(
      "select rolname, oid::int as oid from pg_roles where rolname in ('web_login', 'worker_login', 'system_login') order by 1")).rows;
    const before = await oids();
    const states = await provisionLoginRoles(client, {});
    expect(states.map((state) => [state.login, state.action, state.problems])).toEqual([
      ["web_login", "validated", []],
      ["worker_login", "validated", []],
      ["system_login", "validated", []],
    ]);
    expect(await oids()).toEqual(before);
    for (const kind of RUNTIME_KINDS) expect(await loginRoleProblems(client, kind)).toEqual([]);
  });

  it("rotates a password in place (R8): the role keeps its OID and the runtime keeps working", async () => {
    const target = inject("dbTarget");
    const before = (await client.query<{ oid: number }>("select oid::int as oid from pg_roles where rolname = 'web_login'")).rows[0]?.oid;
    const password = parseDatabaseUrl(target.runtimeUrls.web, "web URL").password;
    const [state] = await provisionLoginRoles(client, { web: password }, { rotate: true, kinds: ["web"] });
    expect(state?.action).toBe("password_rotated");
    expect((await client.query<{ oid: number }>("select oid::int as oid from pg_roles where rolname = 'web_login'")).rows[0]?.oid).toBe(before);
    const web = runtimeDatabase(target, "web", 1);
    try {
      const result = await web.pool.query<{ role: string }>("select session_user::text as role");
      expect(result.rows[0]?.role).toBe("web_login");
    } finally {
      await web.end();
    }
  });

  it("refuses to create a login role without a strong password", async () => {
    await expect(provisionLoginRoles(client, { web: "short" }, { rotate: true, kinds: ["web"] })).rejects.toThrow("at least 24 characters");
  });
});
