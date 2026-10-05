/**
 * Runtime login role provisioning (R1, R8). Separate from schema migrations so passwords never appear in
 * SQL files: each password is turned into a SCRAM-SHA-256 verifier client-side, so neither the server
 * nor any statement log sees it in plaintext.
 *
 * R8 — roles are long-lived. This tool:
 *   - creates a login role only if it is absent;
 *   - otherwise validates its attributes and memberships (and changes its password only with `rotate`);
 *   - grants only the single approved target role;
 *   - NEVER drops, renames or recreates a role, and never revokes or terminates anything.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import type pg from "pg";
import { RUNTIME_KINDS, RUNTIME_LOGIN_ROLES, RUNTIME_TARGET_ROLES, type RuntimeKind } from "../../platform/db/connection.ts";

/** SCRAM-SHA-256 verifier (RFC 7677), the format PostgreSQL stores for `password_encryption = scram-sha-256`. */
export function scramVerifier(password: string, iterations = 4096): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  return `SCRAM-SHA-256$${String(iterations)}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

export interface LoginRoleState {
  readonly kind: RuntimeKind;
  readonly login: string;
  readonly target: string;
  readonly action: "created" | "validated" | "password_rotated" | "target_granted";
  readonly problems: readonly string[];
}

interface RoleRow {
  readonly oid: number;
  readonly rolcanlogin: boolean;
  readonly rolinherit: boolean;
  readonly rolsuper: boolean;
  readonly rolbypassrls: boolean;
  readonly rolcreaterole: boolean;
  readonly rolcreatedb: boolean;
  readonly rolreplication: boolean;
}

/** Attribute and membership problems of an existing login role (empty = valid). */
export async function loginRoleProblems(client: pg.Client, kind: RuntimeKind): Promise<readonly string[]> {
  const login = RUNTIME_LOGIN_ROLES[kind];
  const role = (await client.query<RoleRow>(
    `select oid::int as oid, rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
       from pg_catalog.pg_roles where rolname = $1`,
    [login],
  )).rows[0];
  if (role === undefined) return ["missing"];
  const problems: string[] = [];
  if (!role.rolcanlogin) problems.push("not LOGIN");
  if (role.rolinherit) problems.push("INHERIT (must be NOINHERIT)");
  if (role.rolsuper) problems.push("SUPERUSER");
  if (role.rolbypassrls) problems.push("BYPASSRLS");
  if (role.rolcreaterole) problems.push("CREATEROLE");
  if (role.rolcreatedb) problems.push("CREATEDB");
  if (role.rolreplication) problems.push("REPLICATION");
  const memberships = (await client.query<{ rolname: string; set_option: boolean }>(
    `select r.rolname, m.set_option from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid = m.roleid where m.member = $1`,
    [role.oid],
  )).rows;
  const target = RUNTIME_TARGET_ROLES[kind];
  for (const membership of memberships) {
    if (membership.rolname !== target) problems.push(`unexpected membership in ${membership.rolname}`);
  }
  if (!memberships.some((membership) => membership.rolname === target && membership.set_option)) problems.push(`not a member of ${target}`);
  return problems;
}

/**
 * Ensures the three runtime login roles exist with the approved shape. `passwords` supplies a password
 * per kind (required only to create a role or to rotate it). Nothing is ever dropped.
 */
export async function provisionLoginRoles(
  client: pg.Client,
  passwords: Readonly<Partial<Record<RuntimeKind, string>>>,
  options: { readonly rotate?: boolean; readonly kinds?: readonly RuntimeKind[] } = {},
): Promise<readonly LoginRoleState[]> {
  const database = (await client.query<{ name: string }>("select current_database() as name")).rows[0]?.name ?? "";
  const states: LoginRoleState[] = [];
  for (const kind of options.kinds ?? RUNTIME_KINDS) {
    const login = RUNTIME_LOGIN_ROLES[kind];
    const target = RUNTIME_TARGET_ROLES[kind];
    const ident = client.escapeIdentifier(login);
    const password = passwords[kind];
    let action: LoginRoleState["action"] = "validated";

    const exists = (await client.query("select 1 from pg_catalog.pg_roles where rolname = $1", [login])).rowCount === 1;
    if (!exists) {
      if (password === undefined || password.length < 24) throw new Error(`${login}: a password of at least 24 characters is required to create it`);
      await client.query(
        `create role ${ident} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password ${client.escapeLiteral(scramVerifier(password))}`,
      );
      action = "created";
    } else if (options.rotate === true) {
      if (password === undefined || password.length < 24) throw new Error(`${login}: a password of at least 24 characters is required to rotate it`);
      // R8: in-place password rotation of the existing role; the role itself is never dropped or recreated.
      await client.query(`alter role ${ident} password ${client.escapeLiteral(scramVerifier(password))}`);
      action = "password_rotated";
    }

    const member = (await client.query(
      `select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid = m.roleid join pg_catalog.pg_roles u on u.oid = m.member
        where r.rolname = $1 and u.rolname = $2`,
      [target, login],
    )).rowCount === 1;
    if (!member) {
      await client.query(`grant ${client.escapeIdentifier(target)} to ${ident} with inherit false, set true`);
      if (action === "validated") action = "target_granted";
    }
    await client.query(`grant connect on database ${client.escapeIdentifier(database)} to ${ident}`);

    states.push({ kind, login, target, action, problems: await loginRoleProblems(client, kind) });
  }
  return states;
}
