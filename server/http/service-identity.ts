/**
 * The hosted WEB runtime's identity coherence guard (Step H7-ops-tooling-production-parity). The web talks to TWO
 * services of ONE Supabase project: PostgreSQL (DATABASE_WEB_URL, through the pooler) and Supabase Auth
 * (NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY). A mixed configuration — users authenticated by one
 * project, rows read from another — would silently cross dev-v2 and production, so it fails closed BEFORE any pool or
 * auth client exists:
 *
 *   - the database URL must satisfy the database-environment authority (platform/db/identity.ts): legacy development
 *     mode (pinned to dev-v2) or the explicit DATABASE_ENVIRONMENT_CLASS / DATABASE_EXPECTED_PROJECT_REF /
 *     DATABASE_EXPECTED_REGION
 *   - the public Supabase URL must name a project (`https://<ref>.supabase.co`) and that ref must equal the database
 *     URL's project ref (and therefore the expected one); a custom domain is refused — it carries no verifiable ref
 *   - a local database (no project identity) pairs only with a local Supabase URL, and only in legacy mode
 *   - coherence is judged whenever BOTH halves are configured; one half alone (auth-less tests, database-less UI work,
 *     the TA-11A hosted contract where auth may be "unavailable") has no cross-project to detect
 *
 * The publishable key is verifiable locally ONLY when it is a legacy JWT whose `ref` claim names the project; the
 * `sb_publishable_…` format is opaque, so its ownership can only be confirmed against Supabase at cutover
 * (publishableKeyVerification reports which case applies — never assume a key belongs to a project because the URL
 * matches). Messages name variables only — never a value, URL, key or project reference.
 */
import { databaseIdentityProblems, parseDatabaseUrl, resolveDatabaseAuthority, type ConnectionTarget, type DatabaseAuthority } from "@/platform/db";

type Environment = Readonly<Record<string, string | undefined>>;

export const SERVICE_IDENTITY_VARIABLES = {
  database: "DATABASE_WEB_URL",
  publicUrl: "NEXT_PUBLIC_SUPABASE_URL",
  publishableKey: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
} as const;

const PROJECT_HOST = /^([a-z0-9]{20})\.supabase\.(co|red|in)$/;
const PROJECT_REF = /^[a-z0-9]{20}$/;

export class ServiceIdentityError extends Error {
  override readonly name = "ServiceIdentityError";
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`web runtime refuses incoherent service identity: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

export type PublicProject = { readonly kind: "project"; readonly ref: string } | { readonly kind: "local" } | { readonly kind: "unknown_host" } | { readonly kind: "invalid" };

/** What the public Supabase URL names: a project (by ref), a local emulator, or something unverifiable. */
export function parsePublicSupabaseProject(raw: string | undefined): PublicProject {
  const value = raw?.trim();
  if (value === undefined || value === "") return { kind: "invalid" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "invalid" };
  }
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return { kind: "local" };
  if (url.protocol !== "https:") return { kind: "invalid" };
  const match = PROJECT_HOST.exec(url.hostname);
  return match?.[1] === undefined ? { kind: "unknown_host" } : { kind: "project", ref: match[1] };
}

export type PublishableKeyVerification = "absent" | "verified_by_claim" | "mismatch" | "unverifiable_locally" | "malformed";

/** The legacy anon JWT carries a `ref` claim (verifiable offline); `sb_publishable_…` keys are opaque. */
export function publishableKeyVerification(raw: string | undefined, projectRef: string | undefined): PublishableKeyVerification {
  const key = raw?.trim();
  if (key === undefined || key === "") return "absent";
  if (/^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(key)) return "unverifiable_locally";
  const parts = key.split(".");
  if (parts.length !== 3 || !key.startsWith("eyJ")) return "malformed";
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    const ref = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)["ref"] : undefined;
    if (typeof ref !== "string" || !PROJECT_REF.test(ref)) return "unverifiable_locally";
    return projectRef !== undefined && ref === projectRef ? "verified_by_claim" : "mismatch";
  } catch {
    return "malformed";
  }
}

/** Every reason the web's database and auth configuration do not name ONE coherent project (empty = coherent). */
export function serviceIdentityProblems(environment: Environment): readonly string[] {
  const names = SERVICE_IDENTITY_VARIABLES;
  const databaseRaw = environment[names.database]?.trim() ?? "";
  const publicRaw = environment[names.publicUrl]?.trim() ?? "";
  const problems: string[] = [];
  // Coherence is judged when BOTH services are configured (in every runtime, hosted or local). One half alone has no
  // cross-project to detect: the pool guard owns a missing database URL and auth reports "unavailable" without its URL
  // (the TA-11A hosted contract). Presence of both halves in production is a cutover acceptance check, not this guard's.
  if (databaseRaw === "" || publicRaw === "") return [];

  let authority: DatabaseAuthority;
  let database: ConnectionTarget;
  try {
    authority = resolveDatabaseAuthority(environment);
    database = parseDatabaseUrl(databaseRaw, names.database);
  } catch (error) {
    return [error instanceof Error ? error.message : `${names.database} is not a valid database URL`];
  }
  problems.push(...databaseIdentityProblems(authority, database, names.database));

  const project = parsePublicSupabaseProject(publicRaw);
  if (database.endpoint === "local") {
    if (project.kind !== "local") problems.push(`${names.publicUrl} must name a local Supabase instance when ${names.database} is a local database`);
  } else if (project.kind === "project") {
    if (database.projectRef !== undefined && project.ref !== database.projectRef) problems.push(`${names.publicUrl} names a different Supabase project than ${names.database}`);
    if (authority.mode === "explicit" && project.ref !== authority.expectedProjectRef) problems.push(`${names.publicUrl} names a different Supabase project than DATABASE_EXPECTED_PROJECT_REF`);
  } else if (project.kind === "local") {
    problems.push(`${names.publicUrl} names a local Supabase instance but ${names.database} is a managed database`);
  } else if (project.kind === "unknown_host") {
    problems.push(`${names.publicUrl} does not name a Supabase project by reference (custom domains are not verifiable here)`);
  } else {
    problems.push(`${names.publicUrl} is not a valid https Supabase URL`);
  }

  if (publishableKeyVerification(environment[names.publishableKey], database.projectRef) === "mismatch") {
    problems.push(`${names.publishableKey} belongs to a different Supabase project than ${names.database}`);
  }
  return problems;
}

export function assertServiceIdentity(environment: Environment): void {
  const problems = serviceIdentityProblems(environment);
  if (problems.length > 0) throw new ServiceIdentityError(problems);
}

/** True when the web may build auth clients and pools: coherent identity (or a legitimate local half-configuration). */
export function serviceIdentityCoherent(environment: Environment): boolean {
  return serviceIdentityProblems(environment).length === 0;
}
