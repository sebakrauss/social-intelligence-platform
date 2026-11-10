/**
 * Web runtime composition: the pool is created lazily from DATABASE_WEB_URL (web_login through the
 * transaction pooler) the first time a command or the health check needs it, never at build time. The migration
 * credential and the Supabase service-role key are never read here, and a hosted runtime holding any forbidden
 * configuration refuses to build the pool at all (server/http/web-environment.ts).
 *
 * Pool size (TA-11A, revised in Step 7B-8B): a hosted (production-built) web instance keeps a SMALL pool — four
 * connections — because one page fans out several commands at once (a conversation page runs the conversation view,
 * the list and the shell's membership read in parallel) and the host serves several requests per instance. With a
 * single connection those commands serialized behind each other and behind the neighbouring requests until the 10 s
 * acquisition timeout rendered the Inbox "unavailable" (DEV, 2026-11-10). Many instances still share the Supavisor
 * transaction pooler; local development/test keep the same 4.
 */
import { createRuntimeDatabaseFromEnv, type RuntimeDatabase } from "@/platform/db";
import { assertWebEnvironment } from "@/server/http/web-environment";
import { assertServiceIdentity } from "@/server/http/service-identity";
import type { UnitOfWork } from "@/server/pipeline";
import { createPostgresUnitOfWork } from "./postgres-unit-of-work";

type Environment = Readonly<Record<string, string | undefined>>;

export const WEB_POOL_MAX = { hosted: 4, local: 4 } as const;

export function webPoolMax(environment: Environment): number {
  const nodeEnv = environment["NODE_ENV"];
  return nodeEnv === "development" || nodeEnv === "test" ? WEB_POOL_MAX.local : WEB_POOL_MAX.hosted;
}

/**
 * A new web pool for this environment: boundary guard first, then the database/auth identity coherence guard
 * (server/http/service-identity.ts), then the web login-role/pooler/TLS guards.
 */
export function createWebDatabase(environment: Environment = process.env): RuntimeDatabase<"web"> {
  assertWebEnvironment(environment);
  assertServiceIdentity(environment);
  return createRuntimeDatabaseFromEnv("web", environment, { max: webPoolMax(environment) });
}

let webDatabaseInstance: RuntimeDatabase<"web"> | undefined;

/** The process's web pool (lazy; a failed creation is retried by the next caller). */
export function webDatabase(): RuntimeDatabase<"web"> {
  webDatabaseInstance ??= createWebDatabase(process.env);
  return webDatabaseInstance;
}

export function webUnitOfWork(): UnitOfWork {
  return createPostgresUnitOfWork(webDatabase());
}
