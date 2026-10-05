/**
 * Web runtime composition: the pool is created lazily from DATABASE_WEB_URL (web_login through the
 * transaction pooler) the first time a command needs it, never at build time. The migration credential
 * and the Supabase service-role key are never read here.
 */
import { createRuntimeDatabaseFromEnv, type RuntimeDatabase } from "@/platform/db";
import type { UnitOfWork } from "@/server/pipeline";
import { createPostgresUnitOfWork } from "./postgres-unit-of-work";

let webDatabase: RuntimeDatabase<"web"> | undefined;

export function webUnitOfWork(): UnitOfWork {
  webDatabase ??= createRuntimeDatabaseFromEnv("web");
  return createPostgresUnitOfWork(webDatabase);
}
