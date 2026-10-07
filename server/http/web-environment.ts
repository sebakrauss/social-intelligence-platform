/**
 * The hosted WEB runtime's environment boundary (TA-11A; TA §11.5, R1, §39). A deployed web process must never be
 * handed credentials that belong to another runtime or to operators. The list is CLOSED and derived from the
 * repository's own configuration contract (.env.example, the jobs/tooling runtimes, the Supabase and AWS SDK
 * credential names) — it is not a wildcard scan of arbitrary variables:
 *
 *   DATABASE_WORKER_URL, DATABASE_SYSTEM_URL       job-runtime database credentials
 *   DATABASE_MIGRATION_URL                         tooling-only privileged credential
 *   SUPABASE_SERVICE_ROLE_KEY, SUPABASE_SECRET_KEY never used by the application at all
 *   TRIGGER_PREVIEW_SECRET_KEY                     the TA-Q-31 validation-only key name
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,      AWS/KMS credentials; the current web surface needs none
 *   AWS_SESSION_TOKEN                              (credential sealing in a deployed web arrives with KMS, 5I)
 *   SUPABASE_PROJECT_REF                           tooling/CLI configuration; never part of the web contract
 *   TRIGGER_PROJECT_REF                            Trigger.dev deploy/CLI configuration (trigger.config.ts)
 *   APP_DEPLOYMENT_ENV, CAPABILITY_PROVIDER_MODE   job-runtime provider composition (server/connections/provider-mode)
 *
 * The repository's contract holds no provider (Meta/Instagram/TikTok) credential variable: none exists to forbid.
 * Development and test runtimes are exempt (local .env.local legitimately holds tooling credentials). The mere
 * presence of a forbidden variable makes the hosted web refuse every request; the error names it, never its value.
 * LOCAL_KEYRING_KEY and OAUTH_PKCE_DERIVATION_KEY keep their existing rules (refused outside development/test where
 * they are used).
 */
import { NextResponse } from "next/server";
import { createLogger, stdoutSink } from "@/platform/observability";

export const FORBIDDEN_WEB_VARIABLES = [
  "DATABASE_WORKER_URL",
  "DATABASE_SYSTEM_URL",
  "DATABASE_MIGRATION_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SECRET_KEY",
  "TRIGGER_PREVIEW_SECRET_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "SUPABASE_PROJECT_REF",
  "TRIGGER_PROJECT_REF",
  "APP_DEPLOYMENT_ENV",
  "CAPABILITY_PROVIDER_MODE",
] as const;

const LOCAL_NODE_ENVS: readonly string[] = ["development", "test"];

type Environment = Readonly<Record<string, string | undefined>>;

export class WebEnvironmentError extends Error {
  override readonly name = "WebEnvironmentError";
  readonly variables: readonly string[];
  constructor(variables: readonly string[]) {
    super(`web runtime refuses forbidden configuration: ${variables.join(", ")}`);
    this.variables = variables;
  }
}

/**
 * Names of the forbidden variables PRESENT in a hosted runtime ([] in development/test). Presence alone counts —
 * even an empty value — so no value is ever inspected.
 */
export function forbiddenWebVariables(environment: Environment): readonly string[] {
  if (LOCAL_NODE_ENVS.includes(environment["NODE_ENV"] ?? "")) return [];
  return FORBIDDEN_WEB_VARIABLES.filter((name) => Object.hasOwn(environment, name));
}

export function assertWebEnvironment(environment: Environment): void {
  const present = forbiddenWebVariables(environment);
  if (present.length > 0) throw new WebEnvironmentError(present);
}

const log = createLogger({ sink: stdoutSink, base: { module: "server.http" } });

/**
 * For the proxy: a generic 503 (no detail) when the hosted environment carries forbidden configuration, before any
 * page, action or route runs; undefined otherwise. The variable NAMES are logged, never values.
 */
export function rejectForbiddenWebEnvironment(environment: Environment = process.env): NextResponse | undefined {
  const present = forbiddenWebVariables(environment);
  if (present.length === 0) return undefined;
  log.error("web.environment.rejected", { operation: present.join(":"), count: present.length, outcome: "error" });
  return new NextResponse(null, { status: 503, headers: { "Cache-Control": "no-store" } });
}
