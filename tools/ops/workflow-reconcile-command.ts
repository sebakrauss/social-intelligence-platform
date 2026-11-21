/**
 * WORKFLOW-WF-2C — arguments and target fence of the workflow reconciliation CLI (tools/ops/workflow-reconcile.ts and its
 * vitest operator file both call it; neither connects anywhere before it passes). Pure: no I/O (hashing only).
 *
 *   npm run ops:workflow-reconcile -- --database-url-env <VAR> --workspace <uuid> [--batch <1..500>] [--after <uuid>]
 *                                     [--max-batches <n>] [--run <workflow-reconcile.…>]
 *                                     [--target loopback|development] [--apply [--confirm-dev-reconcile <phrase>]]
 *
 * DRY RUN unless `--apply`. The worker login URL is read from the environment variable NAMED by `--database-url-env`
 * (never from a file; the CLI loads no .env file). Two targets, chosen explicitly, never inferred from the URL:
 *
 *   loopback     (the default, unchanged since WF-2C) a LOOPBACK host only — a disposable local cluster. Every other host
 *                (a managed project, Supavisor, a LAN address) is refused before anything connects.
 *   development  (RELEASE-TOOLING-01) EXACTLY social-intelligence-dev-v2, proven from the URL itself before anything
 *                connects: the Supavisor TRANSACTION pooler (port 6543) in sa-east-1, the `worker_login` runtime login
 *                (never a privileged or another runtime's login), database `postgres`, and a project reference whose
 *                SHA-256 is the pinned development digest (platform/db/identity.ts — the reference itself is never
 *                committed); a declared database identity must be the development one; and a CA must be configured
 *                (TLS is verified against it, rejectUnauthorized). Writing (`--apply`) additionally needs
 *                `--confirm-dev-reconcile <DEV_RECONCILE_CONFIRMATION>`.
 *
 * There is no production target and no generic remote mode: anything else is refused. The run itself is unchanged in
 * both targets — the worker's own scope and RLS, one workspace, bounded batches, a savepoint per item, resumable.
 */
import { parseDatabaseUrl, RUNTIME_LOGIN_ROLES } from "../../platform/db/connection.ts";
import { databaseIdentityProblems, DEVELOPMENT_PROJECT_REF_SHA256, DEVELOPMENT_REGION, projectRefSha256, resolveDatabaseAuthority } from "../../platform/db/identity.ts";
import { SSL_ROOT_CERT_VARIABLES } from "../../platform/db/tls.ts";

export const RECONCILE_PARAMETERS_VARIABLE = "WRENKIND_WORKFLOW_RECONCILE";
/** The two targets the CLI knows; `loopback` when `--target` is absent. */
export const RECONCILE_TARGETS = ["loopback", "development"] as const;
export type ReconcileTarget = (typeof RECONCILE_TARGETS)[number];
/** The exact phrase a development write needs (a typo, a missing phrase or a dry run carrying it is refused). */
export const DEV_RECONCILE_CONFIRMATION = "reconcile-workflow-work-items-in-dev-v2";
export const DEVELOPMENT_TARGET_LABEL = "social-intelligence-dev-v2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VARIABLE = /^[A-Z][A-Z0-9_]{2,63}$/;
const RUN = /^workflow-reconcile\.[A-Za-z0-9._:-]{4,100}$/;
const LOOPBACK: readonly string[] = ["127.0.0.1", "localhost", "::1", "[::1]"];
const VALUED = ["--database-url-env", "--workspace", "--batch", "--after", "--max-batches", "--run", "--target", "--confirm-dev-reconcile"];

type Environment = Readonly<Record<string, string | undefined>>;

export interface ReconcileCommand {
  readonly databaseUrlEnv: string;
  readonly workspaceId: string;
  readonly target: ReconcileTarget;
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
    if (!VALUED.includes(flag)) return { ok: false, problem: `unknown argument: ${flag}` };
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) return { ok: false, problem: `${flag} needs a value` };
    values[flag] = value;
    index += 1;
  }
  const databaseUrlEnv = values["--database-url-env"];
  const workspaceId = values["--workspace"];
  if (databaseUrlEnv === undefined || !VARIABLE.test(databaseUrlEnv)) return { ok: false, problem: "--database-url-env must name an environment variable (UPPER_SNAKE_CASE)" };
  if (workspaceId === undefined || !UUID.test(workspaceId)) return { ok: false, problem: "--workspace must be a lower-case UUID" };
  const rawTarget = values["--target"] ?? "loopback";
  if (!(RECONCILE_TARGETS as readonly string[]).includes(rawTarget)) {
    return { ok: false, problem: `--target must be ${RECONCILE_TARGETS.join(" or ")} (there is no production or other remote target)` };
  }
  const target = rawTarget as ReconcileTarget;
  const confirmation = values["--confirm-dev-reconcile"];
  if (confirmation !== undefined && target !== "development") return { ok: false, problem: "--confirm-dev-reconcile is only valid with --target development" };
  if (confirmation !== undefined && !apply) return { ok: false, problem: "--confirm-dev-reconcile is only valid with --apply" };
  if (target === "development" && apply && confirmation !== DEV_RECONCILE_CONFIRMATION) {
    return { ok: false, problem: "--apply against the development target needs --confirm-dev-reconcile with the exact confirmation phrase" };
  }
  const batchSize = values["--batch"] === undefined ? 100 : Number(values["--batch"]);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) return { ok: false, problem: "--batch must be an integer from 1 to 500" };
  const after = values["--after"] ?? null;
  if (after !== null && !UUID.test(after)) return { ok: false, problem: "--after must be a lower-case UUID (a previous report's `next`)" };
  const maxBatches = values["--max-batches"] === undefined ? undefined : Number(values["--max-batches"]);
  if (maxBatches !== undefined && (!Number.isInteger(maxBatches) || maxBatches < 1)) return { ok: false, problem: "--max-batches must be a positive integer" };
  const runCorrelationId = values["--run"];
  if (runCorrelationId !== undefined && !RUN.test(runCorrelationId)) return { ok: false, problem: "--run must be a previous report's runCorrelationId" };
  return { ok: true, command: { databaseUrlEnv, workspaceId, target, apply, batchSize, after, maxBatches, runCorrelationId } };
}

/**
 * Problems with the target (empty = acceptable). Never echoes the URL, a host, a project reference or any part of a
 * credential. `env` is where the CA and any declared database identity are read from (the process environment);
 * `developmentPin` is the committed digest — tests inject a synthetic project's digest.
 */
export function reconcileTargetProblems(
  url: string | undefined,
  target: ReconcileTarget = "loopback",
  env: Environment = {},
  developmentPin: string = DEVELOPMENT_PROJECT_REF_SHA256,
): string[] {
  if (url === undefined || url.trim() === "") return ["the named environment variable is not set"];
  let parsed: ReturnType<typeof parseDatabaseUrl>;
  try {
    parsed = parseDatabaseUrl(url, "reconciliation database URL");
  } catch {
    return ["the named environment variable is not a PostgreSQL URL"];
  }
  if (target === "loopback") {
    return LOOPBACK.includes(parsed.host.toLowerCase()) ? [] : ["only a loopback (local, disposable) database is allowed without --target development; the target was refused"];
  }

  const problems: string[] = [];
  if (parsed.endpoint === "local") return ["a local database is not the development target (run without --target for a loopback cluster)"];
  if (parsed.endpoint !== "transaction_pooler") problems.push("the development target must be reached through the Supavisor transaction pooler (port 6543)");
  if (parsed.role !== RUNTIME_LOGIN_ROLES.worker) problems.push(`the development target must use the ${RUNTIME_LOGIN_ROLES.worker} runtime login (never a privileged or another runtime's login)`);
  if (parsed.database !== "postgres") problems.push("the development target's database must be postgres");
  if (parsed.projectRef === undefined || projectRefSha256(parsed.projectRef) !== developmentPin) problems.push(`the URL does not belong to the pinned ${DEVELOPMENT_TARGET_LABEL} project`);
  if (parsed.region !== DEVELOPMENT_REGION) problems.push(`the URL is not in the development region ${DEVELOPMENT_REGION}`);
  try {
    const authority = resolveDatabaseAuthority(env, developmentPin);
    if (authority.environmentClass !== "development") problems.push("the environment declares a non-development database identity; refusing");
    else problems.push(...databaseIdentityProblems(authority, parsed, "the reconciliation database URL", developmentPin));
  } catch {
    problems.push("the declared database identity variables are incomplete or invalid");
  }
  const ca = [env[SSL_ROOT_CERT_VARIABLES.pem], env[SSL_ROOT_CERT_VARIABLES.path]].some((value) => value !== undefined && value.trim() !== "");
  if (!ca) problems.push(`${SSL_ROOT_CERT_VARIABLES.pem} or ${SSL_ROOT_CERT_VARIABLES.path} must provide the project's CA certificate (TLS is verified)`);
  return [...new Set(problems)];
}

/** The target as printed (no URL, host, reference or credential). */
export function describeReconcileTarget(command: ReconcileCommand): string {
  return command.target === "loopback"
    ? `loopback (from ${command.databaseUrlEnv})`
    : `development — ${DEVELOPMENT_TARGET_LABEL} via the transaction pooler as ${RUNTIME_LOGIN_ROLES.worker}, ${DEVELOPMENT_REGION} (from ${command.databaseUrlEnv})`;
}
