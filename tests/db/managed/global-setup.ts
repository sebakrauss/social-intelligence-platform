/**
 * Managed run against the Supabase development project (social-intelligence-dev-v2), through the
 * Supavisor transaction pooler for every runtime connection. Refuses to start unless the configuration
 * points at the expected project (never the frozen validation project), migrations are fully applied and
 * the long-lived login roles validate. Test bootstrap applies the T-26 fixture once (idempotent, long-lived)
 * and the suites delete only their own rows. Roles are never created, dropped or recreated here (R8).
 */
import type { TestProject } from "vitest/node";
import { RUNTIME_KINDS, RUNTIME_URL_VARIABLES } from "@/platform/db";
import { checkTarget, loadEnvironment, privilegedClient, readCa, VARIABLES } from "@/tools/db/environment";
import { migrationStatus, readMigrations } from "@/tools/db/migrations";
import { loginRoleProblems } from "@/tools/db/provision";
import { applyT26Fixture } from "../support/t26-fixture";
import type { DbTarget } from "../support/target";

declare module "vitest" {
  export interface ProvidedContext {
    dbTarget: DbTarget;
  }
}

export default async function setup(project: TestProject): Promise<void> {
  const env = loadEnvironment();
  const report = checkTarget(env, { migration: true, runtime: [...RUNTIME_KINDS] });
  if (!report.ok || report.migration === undefined) {
    throw new Error(`managed suite refused: configuration incomplete or unsafe\n${report.lines.join("\n")}`);
  }
  for (const kind of RUNTIME_KINDS) {
    if (report.runtime[kind]?.endpoint !== "transaction_pooler") throw new Error(`${RUNTIME_URL_VARIABLES[kind]} must use the transaction pooler`);
  }
  const ca = readCa(env);
  const client = privilegedClient(report.migration, ca);
  await client.connect();
  try {
    const status = await migrationStatus(client, readMigrations());
    if (status.pending.length > 0) throw new Error("managed suite refused: migrations pending (run npm run db:migrate -- --apply)");
    for (const kind of RUNTIME_KINDS) {
      const problems = await loginRoleProblems(client, kind);
      if (problems.length > 0) throw new Error(`managed suite refused: ${kind} login role: ${problems.join("; ")}`);
    }
    await client.query("begin");
    await applyT26Fixture(client);
    await client.query("commit");
  } finally {
    await client.end();
  }
  project.provide("dbTarget", {
    name: "managed",
    privilegedUrl: env[VARIABLES.migration] ?? "",
    runtimeUrls: {
      web: env[RUNTIME_URL_VARIABLES.web] ?? "",
      worker: env[RUNTIME_URL_VARIABLES.worker] ?? "",
      system: env[RUNTIME_URL_VARIABLES.system] ?? "",
    },
    sslRootCert: ca,
  });
}
