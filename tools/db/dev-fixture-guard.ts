/**
 * Step H7-B1b-0 — the target and argument guard of the shared-dev acceptance fixture (tools/db/dev-fixture.ts and its
 * vitest global setup both call it; neither connects anywhere before it passes). Pure apart from hashing: no I/O.
 *
 * Target identity is proven, not assumed: the generic tooling check (every URL on the SAME project as
 * SUPABASE_PROJECT_REF, never the frozen validation project, sa-east-1) AND the SHA-256 of that project reference
 * equal to the PINNED digest of social-intelligence-dev-v2. Any other project — production, preview, staging, an
 * unknown ref — and any local endpoint is refused. The digest pins the project without committing its reference.
 *
 * Mutation is never the default: plan (read-only) unless `--apply --confirm-dev-fixture <exact phrase>` is given; any
 * other argument, a typo or a missing phrase is refused with no connection made.
 */
import { createHash } from "node:crypto";
import { EXPECTED_REGION, VARIABLES, type Environment, type TargetReport } from "./environment.ts";

/** SHA-256 (UTF-8, lower-case hex) of the social-intelligence-dev-v2 project reference. */
export const DEV_V2_PROJECT_REF_SHA256 = "ac912c45edafd1e4e2d517996e8825cccfe588d6eeee83183b95625ad5d14351";
export const DEV_FIXTURE_CONFIRMATION = "create-h7-classification-acceptance-fixture-in-dev-v2";
/** Workspaces no fixture may ever touch: the protected P2-E recovery acceptance workspace (and its whole id range). */
export const PROTECTED_WORKSPACE_IDS: readonly string[] = Object.freeze(["5eed2e00-0000-4000-8000-000000000001"]);
const PROTECTED_PREFIX = "5eed2e00-";

/** Environment the CLI hands to the vitest run (re-validated there; never trusted on its own). */
export const DEV_FIXTURE_MODE_VARIABLE = "WRENKIND_DEV_FIXTURE_MODE";
export const DEV_FIXTURE_CONFIRMATION_VARIABLE = "WRENKIND_DEV_FIXTURE_CONFIRMATION";

export type DevFixtureMode = "plan" | "apply";

export function isProtectedWorkspace(id: string): boolean {
  const normalized = id.toLowerCase();
  return PROTECTED_WORKSPACE_IDS.includes(normalized) || normalized.startsWith(PROTECTED_PREFIX);
}

/** `[]` → plan; exactly `--apply --confirm-dev-fixture <phrase>` (either order of the two flags) → apply. */
export function parseDevFixtureArguments(args: readonly string[]): { readonly mode: DevFixtureMode } | { readonly error: string } {
  if (args.length === 0) return { mode: "plan" };
  let apply = false;
  let phrase: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--apply" && !apply) {
      apply = true;
    } else if (flag === "--confirm-dev-fixture" && phrase === undefined) {
      phrase = args[index + 1];
      if (phrase === undefined || phrase.startsWith("--")) return { error: "--confirm-dev-fixture needs the confirmation phrase" };
      index += 1;
    } else {
      return { error: `unknown or repeated argument: ${flag ?? ""}` };
    }
  }
  if (!apply) return { error: "--confirm-dev-fixture is only valid with --apply" };
  if (phrase !== DEV_FIXTURE_CONFIRMATION) return { error: "--apply needs --confirm-dev-fixture with the exact confirmation phrase" };
  return { mode: "apply" };
}

/** The mode the vitest run may use: apply only when BOTH variables carry exactly the CLI's values. */
export function devFixtureModeFromEnvironment(env: Environment): { readonly mode: DevFixtureMode } | { readonly error: string } {
  const mode = env[DEV_FIXTURE_MODE_VARIABLE] ?? "plan";
  if (mode === "plan") return { mode: "plan" };
  if (mode !== "apply") return { error: `${DEV_FIXTURE_MODE_VARIABLE} must be plan or apply` };
  if (env[DEV_FIXTURE_CONFIRMATION_VARIABLE] !== DEV_FIXTURE_CONFIRMATION) return { error: `apply needs ${DEV_FIXTURE_CONFIRMATION_VARIABLE} with the exact confirmation phrase` };
  return { mode: "apply" };
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/**
 * Every reason the configured target is NOT exactly social-intelligence-dev-v2 (empty = proven). `report` is
 * checkTarget(env, { migration: true, runtime: ["worker"] }).
 */
export function devFixtureTargetProblems(env: Environment, report: TargetReport): readonly string[] {
  const problems: string[] = [];
  if (!report.ok) problems.push("database configuration check failed");
  const ref = env[VARIABLES.projectRef] ?? "";
  if (sha256(ref) !== DEV_V2_PROJECT_REF_SHA256) problems.push(`${VARIABLES.projectRef} is not the pinned social-intelligence-dev-v2 project`);
  const migration = report.migration;
  if (migration === undefined) problems.push(`${VARIABLES.migration} is absent`);
  else {
    if (migration.endpoint !== "direct" && migration.endpoint !== "session_pooler") problems.push(`${VARIABLES.migration} must be the managed direct or session endpoint`);
    if (migration.projectRef !== ref) problems.push(`${VARIABLES.migration} is not on the pinned project`);
    if (migration.region !== EXPECTED_REGION) problems.push(`${VARIABLES.migration} is not in ${EXPECTED_REGION}`);
  }
  const worker = report.runtime.worker;
  if (worker === undefined) problems.push(`${VARIABLES.worker} is absent`);
  else {
    if (worker.endpoint !== "transaction_pooler") problems.push(`${VARIABLES.worker} must use the transaction pooler`);
    if (worker.projectRef !== ref) problems.push(`${VARIABLES.worker} is not on the pinned project`);
    if (worker.region !== EXPECTED_REGION) problems.push(`${VARIABLES.worker} is not in ${EXPECTED_REGION}`);
  }
  return problems;
}
