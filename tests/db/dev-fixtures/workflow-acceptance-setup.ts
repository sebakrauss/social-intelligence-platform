/**
 * W12-PREP-01 — global setup of the shared-dev Workflow acceptance run (vitest.workflow-acceptance.config.ts).
 * Re-proves, independently of the CLI: the operation (the CLI's argument vector, parsed AGAIN by the same guard), that
 * the target is exactly social-intelligence-dev-v2, that every repository migration is applied with a matching checksum
 * (nothing pending, nothing unknown) and that the worker login role validates. Seeds nothing; roles are never created,
 * dropped or recreated (R8).
 */
import type { TestProject } from "vitest/node";
import { RUNTIME_URL_VARIABLES } from "@/platform/db";
import { devFixtureTargetProblems } from "@/tools/db/dev-fixture-guard";
import { checkTarget, loadEnvironment, privilegedClient, readCa, VARIABLES } from "@/tools/db/environment";
import { migrationStatus, readMigrations } from "@/tools/db/migrations";
import { loginRoleProblems } from "@/tools/db/provision";
import { workflowAcceptanceOperationFromEnvironment, type WorkflowAcceptanceOperation } from "@/tools/db/workflow-acceptance-guard";
import type { DbTarget } from "../support/target";

declare module "vitest" {
  export interface ProvidedContext {
    dbTarget: DbTarget;
    workflowAcceptanceOperation: WorkflowAcceptanceOperation;
  }
}

export default async function setup(project: TestProject): Promise<void> {
  const parsed = workflowAcceptanceOperationFromEnvironment(process.env);
  if ("error" in parsed) throw new Error(`workflow acceptance refused: ${parsed.error}`);
  const env = loadEnvironment();
  const report = checkTarget(env, { migration: true, runtime: ["worker"] });
  const problems = devFixtureTargetProblems(env, report);
  if (problems.length > 0 || report.migration === undefined) throw new Error(`workflow acceptance refused: ${problems.join("; ")}`);
  const ca = readCa(env);
  const client = privilegedClient(report.migration, ca);
  await client.connect();
  try {
    // migrationStatus throws on an unknown or modified applied migration; pending ones are refused here.
    const status = await migrationStatus(client, readMigrations());
    if (status.pending.length > 0) throw new Error("workflow acceptance refused: migrations pending");
    const roleProblems = await loginRoleProblems(client, "worker");
    if (roleProblems.length > 0) throw new Error(`workflow acceptance refused: worker login role: ${roleProblems.join("; ")}`);
    // Every negative check (foreign memberships, squatters, foreign assets, credentials, extra rows) reads through forced
    // RLS: it must see ALL rows, or it would fail open (count 0). Refuse a role that does not bypass RLS.
    const visibility = await client.query<{ sees_all: boolean }>("select (rolsuper or rolbypassrls) as sees_all from pg_catalog.pg_roles where rolname = current_user");
    if (visibility.rows[0]?.sees_all !== true) throw new Error("workflow acceptance refused: the migration role does not bypass RLS, so negative checks could fail open");
  } finally {
    await client.end();
  }
  project.provide("workflowAcceptanceOperation", parsed.operation);
  project.provide("dbTarget", {
    name: "managed",
    privilegedUrl: env[VARIABLES.migration] ?? "",
    // Only the worker runtime is used (canonical ingestion); the web and system URLs are never handed over.
    runtimeUrls: { web: "", worker: env[RUNTIME_URL_VARIABLES.worker] ?? "", system: "" },
    sslRootCert: ca,
  });
}
