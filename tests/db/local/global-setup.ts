/**
 * Starts one disposable local cluster for the database test run (in a child process) and hands the target
 * to the suites. Credentials travel through a pipe and Vitest's provide/inject only: never disk or console.
 * The cluster lives in its own process so its exit hook can't override this run's exit code.
 */
import type { TestProject } from "vitest/node";
import { spawnLocalCluster } from "../support/spawn-cluster";
import type { DbTarget } from "../support/target";

declare module "vitest" {
  export interface ProvidedContext {
    dbTarget: DbTarget;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const cluster = await spawnLocalCluster();
  project.provide("dbTarget", cluster.target);
  return () => cluster.stop();
}
