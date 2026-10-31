/**
 * Starts a disposable local cluster in its own child process (cluster-process.ts) and returns its target. Credentials
 * travel through the pipe only: never disk or console. `migrateThrough` (Step H7-D1c) stops the migrations at one
 * repository migration, so an upgrade test can seed an older schema and then apply the rest with the real runner.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import type { DbTarget } from "./target";

export const MIGRATE_THROUGH_ENV = "SIP_LOCAL_CLUSTER_MIGRATE_THROUGH";

export interface SpawnedCluster {
  readonly target: DbTarget;
  stop(): Promise<void>;
}

export async function spawnLocalCluster(options: { readonly migrateThrough?: string } = {}): Promise<SpawnedCluster> {
  const env = options.migrateThrough === undefined ? process.env : { ...process.env, [MIGRATE_THROUGH_ENV]: options.migrateThrough };
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "cluster-process.ts")], { stdio: ["pipe", "pipe", "inherit"], env });
  const exited = new Promise<void>((resolve) => child.once("exit", () => { resolve(); }));
  const lines = createInterface({ input: child.stdout });
  const first = await new Promise<string>((resolve, reject) => {
    lines.once("line", resolve);
    child.once("exit", (code) => { reject(new Error(`local cluster process exited early (${String(code)})`)); });
  });
  const message = JSON.parse(first) as { readonly target?: DbTarget; readonly error?: string };
  if (message.target === undefined) throw new Error(`local cluster failed: ${message.error ?? "unknown"}`);
  return {
    target: message.target,
    async stop() {
      child.stdin.end();
      await exited;
    },
  };
}
