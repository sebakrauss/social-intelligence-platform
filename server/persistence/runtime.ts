/**
 * Web runtime composition: the pool is created lazily from DATABASE_WEB_URL (web_login through the
 * transaction pooler) the first time a command or the health check needs it, never at build time. The migration
 * credential and the Supabase service-role key are never read here, and a hosted runtime holding any forbidden
 * configuration refuses to build the pool at all (server/http/web-environment.ts).
 *
 * Pool size (TA-11A): a hosted (production-built, serverless) web instance keeps ONE connection; many instances
 * share the Supavisor transaction pooler. Local development/test keep the previous default of 4.
 */
import { createRuntimeDatabaseFromEnv, type RuntimeDatabase } from "@/platform/db";
import { assertWebEnvironment } from "@/server/http/web-environment";
import type { UnitOfWork } from "@/server/pipeline";
import { createPostgresUnitOfWork } from "./postgres-unit-of-work";

type Environment = Readonly<Record<string, string | undefined>>;

export const WEB_POOL_MAX = { hosted: 1, local: 4 } as const;

export function webPoolMax(environment: Environment): number {
  const nodeEnv = environment["NODE_ENV"];
  return nodeEnv === "development" || nodeEnv === "test" ? WEB_POOL_MAX.local : WEB_POOL_MAX.hosted;
}

/** A new web pool for this environment: boundary guard first, then the web login-role/pooler/TLS guards. */
export function createWebDatabase(environment: Environment = process.env): RuntimeDatabase<"web"> {
  assertWebEnvironment(environment);
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
