/**
 * Hosted web health (TA-11A): proves the WEB runtime reaches its database through the normal web composition —
 * DATABASE_WEB_URL, the forbidden-configuration guard, the web_login role and transaction-pooler guards, and TLS
 * verification with the configured CA (DATABASE_SSL_ROOT_CERT_PEM when hosted). The response is fixed and generic
 * either way: no host, role, SQL, exception or configuration detail, and never cached.
 */
import { pingDatabase, type RuntimeDatabase } from "@/platform/db";
import { createLogger, stdoutSink } from "@/platform/observability";
import { webDatabase } from "@/server/persistence/runtime";

export const HEALTHY = Object.freeze({ status: "ok" });
export const UNHEALTHY = Object.freeze({ status: "unavailable" });

const log = createLogger({ sink: stdoutSink, base: { module: "server.http" } });

/** 200 {"status":"ok"} when one round trip succeeds; 503 {"status":"unavailable"} for ANY failure. */
export async function webHealth(open: () => RuntimeDatabase<"web">): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  try {
    await pingDatabase(open());
    return Response.json(HEALTHY, { status: 200, headers });
  } catch {
    log.warn("web.health.unavailable", { outcome: "error" });
    return Response.json(UNHEALTHY, { status: 503, headers });
  }
}

/** The route's handler: the process's real web pool. */
export function webHealthResponse(): Promise<Response> {
  return webHealth(webDatabase);
}
