/**
 * TA-11A — the hosted web health check against a real database, through the REAL web composition
 * (createWebDatabase: forbidden-configuration guard → DATABASE_WEB_URL → web_login role and transaction-pooler
 * guards → TLS with the CA as PEM content on managed targets), exactly as a production-built web instance does it.
 */
import { afterAll, describe, expect, it } from "vitest";
import type { RuntimeDatabase } from "@/platform/db";
import { webHealth } from "@/server/http/health";
import { createWebDatabase } from "@/server/persistence/runtime";
import type { DbTarget } from "../support/target";

export function defineHostedWebSuite(getTarget: () => DbTarget): void {
  const opened: RuntimeDatabase<"web">[] = [];
  /** A production-built web runtime's environment for this target (the CA as PEM content, never a path). */
  const hostedEnvironment = (webUrl: string): Record<string, string> => {
    const target = getTarget();
    return {
      NODE_ENV: "production",
      DATABASE_WEB_URL: webUrl,
      ...(target.sslRootCert === undefined ? {} : { DATABASE_SSL_ROOT_CERT_PEM: target.sslRootCert }),
    };
  };
  const open = (webUrl: string) => () => {
    const database = createWebDatabase(hostedEnvironment(webUrl));
    opened.push(database);
    return database;
  };

  afterAll(async () => {
    await Promise.all(opened.map((database) => database.end()));
  });

  describe("hosted web health (TA-11A)", () => {
    it("200 through the real web composition: one connection, web_login, nothing readable", async () => {
      const response = await webHealth(open(getTarget().runtimeUrls.web));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok" });
      const database = opened.at(-1);
      if (database === undefined) throw new Error("no pool");
      expect((database.pool as unknown as { options: { max: number } }).options.max).toBe(1);
      const identity = await database.pool.query<{ current_user: string; session_user: string }>("select current_user, session_user");
      expect(identity.rows[0]).toEqual({ current_user: "web_login", session_user: "web_login" });
      // The probe's role holds no table privileges of its own: it reads nothing and bypasses no RLS.
      await expect(database.pool.query("select count(*) from tenancy.workspaces")).rejects.toMatchObject({ code: "42501" });
    });

    it("another runtime's credential as DATABASE_WEB_URL is refused: generic 503", async () => {
      for (const url of [getTarget().runtimeUrls.worker, getTarget().runtimeUrls.system, getTarget().privilegedUrl]) {
        const response = await webHealth(open(url));
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ status: "unavailable" });
      }
    });
  });
}
