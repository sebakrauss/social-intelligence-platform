/**
 * WORKFLOW-WF-2C — arguments and target fence of the workflow reconciliation CLI (tools/ops/workflow-reconcile.ts and its
 * vitest operator file both call it; neither connects anywhere before it passes). Pure: no I/O.
 *
 *   npm run ops:workflow-reconcile -- --database-url-env <VAR> --workspace <uuid> [--batch <1..500>] [--after <uuid>]
 *                                     [--max-batches <n>] [--run <workflow-reconcile.…>] [--apply]
 *
 * DRY RUN unless `--apply`. The worker login URL is read from the environment variable NAMED by `--database-url-env`
 * (never from a file; the CLI loads no .env file) and, in this gate, it must point at a LOOPBACK host — a disposable
 * local cluster. Every other host (a managed project, Supavisor, a LAN address) is refused before anything connects.
 * Widening the fence to the development project is a separate, explicitly authorized gate (see WF-2C-REPORT.md §4).
 */
import { parseDatabaseUrl } from "../../platform/db/connection.ts";

export const RECONCILE_PARAMETERS_VARIABLE = "WRENKIND_WORKFLOW_RECONCILE";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VARIABLE = /^[A-Z][A-Z0-9_]{2,63}$/;
const RUN = /^workflow-reconcile\.[A-Za-z0-9._:-]{4,100}$/;
const LOOPBACK: readonly string[] = ["127.0.0.1", "localhost", "::1", "[::1]"];

export interface ReconcileCommand {
  readonly databaseUrlEnv: string;
  readonly workspaceId: string;
  readonly apply: boolean;
  readonly batchSize: number;
  readonly after: string | null;
  readonly maxBatches: number | undefined;
  readonly runCorrelationId: string | undefined;
}

export function parseReconcileCommand(args: readonly string[]): { readonly ok: true; readonly command: ReconcileCommand } | { readonly ok: false; readonly problem: string } {
  const seen = new Set<string>();
  const values: Record<string, string> = {};
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] ?? "";
    if (seen.has(flag)) return { ok: false, problem: `repeated argument: ${flag}` };
    seen.add(flag);
    if (flag === "--apply") {
      apply = true;
      continue;
    }
    if (!["--database-url-env", "--workspace", "--batch", "--after", "--max-batches", "--run"].includes(flag)) return { ok: false, problem: `unknown argument: ${flag}` };
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) return { ok: false, problem: `${flag} needs a value` };
    values[flag] = value;
    index += 1;
  }
  const databaseUrlEnv = values["--database-url-env"];
  const workspaceId = values["--workspace"];
  if (databaseUrlEnv === undefined || !VARIABLE.test(databaseUrlEnv)) return { ok: false, problem: "--database-url-env must name an environment variable (UPPER_SNAKE_CASE)" };
  if (workspaceId === undefined || !UUID.test(workspaceId)) return { ok: false, problem: "--workspace must be a lower-case UUID" };
  const batchSize = values["--batch"] === undefined ? 100 : Number(values["--batch"]);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) return { ok: false, problem: "--batch must be an integer from 1 to 500" };
  const after = values["--after"] ?? null;
  if (after !== null && !UUID.test(after)) return { ok: false, problem: "--after must be a lower-case UUID (a previous report's `next`)" };
  const maxBatches = values["--max-batches"] === undefined ? undefined : Number(values["--max-batches"]);
  if (maxBatches !== undefined && (!Number.isInteger(maxBatches) || maxBatches < 1)) return { ok: false, problem: "--max-batches must be a positive integer" };
  const runCorrelationId = values["--run"];
  if (runCorrelationId !== undefined && !RUN.test(runCorrelationId)) return { ok: false, problem: "--run must be a previous report's runCorrelationId" };
  return { ok: true, command: { databaseUrlEnv, workspaceId, apply, batchSize, after, maxBatches, runCorrelationId } };
}

/** Problems with the target (empty = acceptable). Never echoes the URL or any part of a credential. */
export function reconcileTargetProblems(url: string | undefined): string[] {
  if (url === undefined || url.trim() === "") return ["the named environment variable is not set"];
  let host: string;
  try {
    host = parseDatabaseUrl(url, "reconciliation database URL").host;
  } catch {
    return ["the named environment variable is not a PostgreSQL URL"];
  }
  return LOOPBACK.includes(host.toLowerCase()) ? [] : ["only a loopback (local, disposable) database is allowed in this gate; the target was refused"];
}
