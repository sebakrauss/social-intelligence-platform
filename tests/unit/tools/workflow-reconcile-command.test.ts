/**
 * WORKFLOW-WF-2C — the reconciliation CLI's arguments and target fence (pure): DRY RUN unless --apply; the database URL
 * comes from a NAMED environment variable; in this gate only a loopback host passes; nothing unexpected is accepted;
 * a refusal never echoes the URL.
 */
import { describe, expect, it } from "vitest";
import { parseReconcileCommand, reconcileTargetProblems } from "@/tools/ops/workflow-reconcile-command";

const WS = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";

describe("workflow reconciliation CLI", () => {
  it("defaults: a dry run, batches of 100, from the start, until the end", () => {
    expect(parseReconcileCommand(["--database-url-env", "LOCAL_WORKER_URL", "--workspace", WS])).toEqual({
      ok: true,
      command: { databaseUrlEnv: "LOCAL_WORKER_URL", workspaceId: WS, apply: false, batchSize: 100, after: null, maxBatches: undefined, runCorrelationId: undefined },
    });
    const resumed = parseReconcileCommand(["--database-url-env", "LOCAL_WORKER_URL", "--workspace", WS, "--batch", "25", "--after", WS, "--max-batches", "3", "--run", "workflow-reconcile.abc-123", "--apply"]);
    expect(resumed.ok && resumed.command).toMatchObject({ apply: true, batchSize: 25, after: WS, maxBatches: 3, runCorrelationId: "workflow-reconcile.abc-123" });
  });

  it("refuses anything unexpected before connecting", () => {
    for (const args of [
      [],
      ["--workspace", WS],
      ["--database-url-env", "local_url", "--workspace", WS],
      ["--database-url-env", "LOCAL_URL", "--workspace", "WS"],
      ["--database-url-env", "LOCAL_URL", "--workspace", WS.toUpperCase()],
      ["--database-url-env", "LOCAL_URL", "--workspace", WS, "--batch", "0"],
      ["--database-url-env", "LOCAL_URL", "--workspace", WS, "--batch", "501"],
      ["--database-url-env", "LOCAL_URL", "--workspace", WS, "--after", "x"],
      ["--database-url-env", "LOCAL_URL", "--workspace", WS, "--max-batches", "0"],
      ["--database-url-env", "LOCAL_URL", "--workspace", WS, "--run", "other.123456"],
      ["--database-url-env", "LOCAL_URL", "--workspace", WS, "--apply", "--apply"],
      ["--database-url-env", "LOCAL_URL", "--workspace", WS, "--target", "production"],
      ["--database-url-env", "LOCAL_URL", "--workspace", WS, "--force"],
      ["--database-url-env", "--workspace", WS],
    ]) expect(parseReconcileCommand(args).ok, args.join(" ")).toBe(false);
  });

  it("in this gate, only a loopback database passes the fence; the refusal never contains the URL", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) expect(reconcileTargetProblems(`postgres://worker:secret@${host}:5432/app`), host).toEqual([]);
    for (const url of [
      "postgres://worker:secret@aws-0-sa-east-1.pooler.supabase.com:6543/postgres",
      "postgres://worker:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres",
      "postgres://worker:secret@10.0.0.5:5432/app",
      "postgres://worker:secret@127.0.0.1.example.com:5432/app",
    ]) {
      const problems = reconcileTargetProblems(url);
      expect(problems.length, url).toBe(1);
      expect(problems.join(" ")).not.toMatch(/secret|supabase|10\.0\.0\.5|example/);
    }
    expect(reconcileTargetProblems(undefined)).toEqual(["the named environment variable is not set"]);
    expect(reconcileTargetProblems("not a url")).toEqual(["the named environment variable is not a PostgreSQL URL"]);
  });
});
