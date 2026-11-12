/**
 * Step 7B-14I2 — validation operator logins for the LOCAL disposable cluster only (R8: per-run roles are acceptable only
 * in isolated, disposable, non-Supavisor databases; never on the managed project). A login is created once per name with
 * a random in-memory password and the exact shape the 0029 identity check expects — or a deliberately wrong shape, to
 * prove the check refuses it. Passwords never leave memory.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { parseDatabaseUrl } from "@/platform/db";
import { scramVerifier } from "../../../tools/db/provision.ts";
import type { DbTarget } from "./target";

export type OperatorLoginShape =
  /** The correct shape: LOGIN NOINHERIT, member of app_validation_operator only (SET, no ADMIN). */
  | "operator"
  /** INHERIT login (refused). */
  | "inherit"
  /** A second membership (also `app_worker`) — refused. */
  | "extra_membership"
  /** A login named outside validation_operator_<handle>, otherwise correct — refused. */
  | "misnamed";

const passwords = new Map<string, string>();

/** Creates (once) a login of the given shape; returns a client factory connecting as it. */
export async function operatorLogin(privileged: pg.Pool, target: DbTarget, name: string, shape: OperatorLoginShape = "operator"): Promise<() => Promise<pg.Client>> {
  if (target.name !== "local") throw new Error("validation operator logins are created only in the local disposable cluster (R8)");
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(name)) throw new Error("login name");
  let password = passwords.get(name);
  if (password === undefined) {
    password = randomBytes(24).toString("hex");
    passwords.set(name, password);
    const inherit = shape === "inherit" ? "inherit" : "noinherit";
    await privileged.query(`create role ${name} login ${inherit} nosuperuser nocreatedb nocreaterole noreplication nobypassrls password '${scramVerifier(password).replaceAll("'", "''")}'`);
    await privileged.query(`grant connect on database "${parseDatabaseUrl(target.privilegedUrl, "privileged URL").database}" to ${name}`);
    await privileged.query(`grant app_validation_operator to ${name} with inherit false, set true`);
    if (shape === "extra_membership") await privileged.query(`grant app_worker to ${name} with inherit false, set true`);
  }
  const parsed = parseDatabaseUrl(target.privilegedUrl, "privileged URL");
  const secret = password;
  return async () => {
    const client = new pg.Client({ host: parsed.host, port: parsed.port, database: parsed.database, user: name, password: secret, ssl: false, application_name: "validation-operator-test" });
    client.on("error", () => undefined);
    await client.connect();
    return client;
  };
}
