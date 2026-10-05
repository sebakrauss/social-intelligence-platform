/**
 * Disposable local PostgreSQL 17 cluster for database tests (CI and developers; no Docker needed).
 * Lifecycle: initdb → Supabase emulation → migrations (as the non-superuser `postgres` migration role)
 * → login role provisioning → T-26 fixture. Passwords are random per run, held in memory only, and the
 * cluster directory is deleted on stop. Being isolated and disposable, it is the only place where
 * per-run roles are acceptable (R8); nothing here runs against a shared Supavisor project.
 *
 * Runs ONLY inside the cluster child process (cluster-process.ts): embedded-postgres installs an exit
 * hook that calls process.exit(0) on `beforeExit`, which would mask a failing test run's exit code if it
 * were loaded into the Vitest process. Relative imports only, so plain Node can run it.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { RUNTIME_KINDS, type RuntimeKind } from "../../../platform/db/connection.ts";
import { applyMigrations, readMigrations } from "../../../tools/db/migrations.ts";
import { provisionLoginRoles, scramVerifier } from "../../../tools/db/provision.ts";
import { applyT26Fixture } from "./t26-fixture.ts";
import type { DbTarget } from "./target.ts";

const DATABASE = "app";
const password = (): string => randomBytes(24).toString("base64url");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address !== null) resolve(address.port);
        else reject(new Error("no port"));
      });
    });
  });
}

const url = (user: string, secret: string, port: number): string =>
  `postgres://${encodeURIComponent(user)}:${encodeURIComponent(secret)}@127.0.0.1:${String(port)}/${DATABASE}`;

export interface LocalCluster {
  readonly target: DbTarget;
  stop(): Promise<void>;
}

export async function startLocalCluster(): Promise<LocalCluster> {
  const port = await freePort();
  const directory = await mkdtemp(path.join(os.tmpdir(), "sip-pg-"));
  const superPassword = password();
  const migrationPassword = password();
  const cluster = new EmbeddedPostgres({
    databaseDir: path.join(directory, "data"),
    port,
    user: "supabase_admin",
    password: superPassword,
    authMethod: "scram-sha-256",
    persistent: false,
    postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
    onLog: () => undefined,
    onError: () => undefined,
  });
  await cluster.initialise();
  await cluster.start();
  try {
    const admin = new pg.Client({ host: "127.0.0.1", port, user: "supabase_admin", password: superPassword, database: "postgres" });
    await admin.connect();
    await admin.query(`create role postgres login createrole bypassrls nosuperuser password ${admin.escapeLiteral(scramVerifier(migrationPassword))}`);
    await admin.query(`create database ${DATABASE} owner postgres`);
    await admin.query(`revoke connect on database ${DATABASE} from public`);
    await admin.end();

    const emulation = new pg.Client({ host: "127.0.0.1", port, user: "supabase_admin", password: superPassword, database: DATABASE });
    await emulation.connect();
    await emulation.query(readFileSync(path.join(import.meta.dirname, "supabase-emulation.sql"), "utf8"));
    await emulation.end();

    const passwords = Object.fromEntries(RUNTIME_KINDS.map((kind) => [kind, password()])) as Record<RuntimeKind, string>;
    const migrator = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: migrationPassword, database: DATABASE });
    await migrator.connect();
    try {
      await applyMigrations(migrator, readMigrations());
      const states = await provisionLoginRoles(migrator, passwords);
      const problems = states.flatMap((state) => state.problems.map((problem) => `${state.login}: ${problem}`));
      if (problems.length > 0) throw new Error(`login role provisioning: ${problems.join("; ")}`);
      await migrator.query("begin");
      await applyT26Fixture(migrator);
      await migrator.query("commit");
    } finally {
      await migrator.end();
    }

    return {
      target: {
        name: "local",
        privilegedUrl: url("postgres", migrationPassword, port),
        runtimeUrls: {
          web: url("web_login", passwords.web, port),
          worker: url("worker_login", passwords.worker, port),
          system: url("system_login", passwords.system, port),
        },
      },
      async stop() {
        await cluster.stop();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await cluster.stop();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
