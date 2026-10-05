/**
 * Starts one disposable local cluster for the database test run (in a child process) and hands the target
 * to the suites. Credentials travel through a pipe and Vitest's provide/inject only: never disk or console.
 * The cluster lives in its own process so its exit hook can't override this run's exit code.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import type { TestProject } from "vitest/node";
import type { DbTarget } from "../support/target";

declare module "vitest" {
  export interface ProvidedContext {
    dbTarget: DbTarget;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "../support/cluster-process.ts")], { stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise<void>((resolve) => child.once("exit", () => { resolve(); }));
  const lines = createInterface({ input: child.stdout });
  const first = await new Promise<string>((resolve, reject) => {
    lines.once("line", resolve);
    child.once("exit", (code) => { reject(new Error(`local cluster process exited early (${String(code)})`)); });
  });
  const message = JSON.parse(first) as { readonly target?: DbTarget; readonly error?: string };
  if (message.target === undefined) throw new Error(`local cluster failed: ${message.error ?? "unknown"}`);
  project.provide("dbTarget", message.target);
  return async () => {
    child.stdin.end();
    await exited;
  };
}
