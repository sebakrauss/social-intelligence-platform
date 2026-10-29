/**
 * Step H7-B1b-0 — global setup of the shared-dev acceptance fixture run (vitest.dev-fixture.config.ts). Re-proves,
 * independently of the CLI, that the target is exactly social-intelligence-dev-v2, that the mode is the CLI's, that
 * every migration in the repository is applied with a matching checksum (nothing pending, nothing unknown) and that
 * the worker login role validates. Seeds nothing (unlike the managed suites, no T-26 fixture); roles are never created,
 * dropped or recreated (R8).
 */
import type { TestProject } from "vitest/node";
import { RUNTIME_URL_VARIABLES } from "@/platform/db";
import { devFixtureModeFromEnvironment, devFixtureTargetProblems, type DevFixtureMode } from "@/tools/db/dev-fixture-guard";
import { checkTarget, loadEnvironment, privilegedClient, readCa, VARIABLES } from "@/tools/db/environment";
import { migrationStatus, readMigrations } from "@/tools/db/migrations";
import { loginRoleProblems } from "@/tools/db/provision";
import type { DbTarget } from "../support/target";

declare module "vitest" {
  export interface ProvidedContext {
    dbTarget: DbTarget;
    devFixtureMode: DevFixtureMode;
  }
}

export default async function setup(project: TestProject): Promise<void> {
  const mode = devFixtureModeFromEnvironment(process.env);
  if ("error" in mode) throw new Error(`dev fixture refused: ${mode.error}`);
  const env = loadEnvironment();
  const report = checkTarget(env, { migration: true, runtime: ["worker"] });
  const problems = devFixtureTargetProblems(env, report);
  if (problems.length > 0 || report.migration === undefined) throw new Error(`dev fixture refused: ${problems.join("; ")}`);
  const ca = readCa(env);
  const client = privilegedClient(report.migration, ca);
  await client.connect();
  try {
    // migrationStatus throws on an unknown or modified applied migration; pending ones are refused here.
    const status = await migrationStatus(client, readMigrations());
    if (status.pending.length > 0) throw new Error("dev fixture refused: migrations pending");
    const roleProblems = await loginRoleProblems(client, "worker");
    if (roleProblems.length > 0) throw new Error(`dev fixture refused: worker login role: ${roleProblems.join("; ")}`);
  } finally {
    await client.end();
  }
  project.provide("devFixtureMode", mode.mode);
  project.provide("dbTarget", {
    name: "managed",
    privilegedUrl: env[VARIABLES.migration] ?? "",
    // Only the worker runtime is used (canonical ingestion); the web and system URLs are never handed over.
    runtimeUrls: { web: "", worker: env[RUNTIME_URL_VARIABLES.worker] ?? "", system: "" },
    sslRootCert: ca,
  });
}
