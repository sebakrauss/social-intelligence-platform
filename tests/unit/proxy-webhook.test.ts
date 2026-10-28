/**
 * Step H6-F3 — the proxy's sessionless webhook exception: exactly /api/webhooks/meta skips the session refresh (no
 * cookie read or written, no redirect); the forbidden-environment refusal still runs; every other path is unchanged.
 */
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn((): Promise<NextResponse> => {
  const response = NextResponse.next();
  response.cookies.set("sb-session", "refreshed");
  return Promise.resolve(response);
});
const forbidden = vi.fn((): NextResponse | undefined => undefined);
vi.mock("@/server/auth/proxy", () => ({ refreshSessionCookies: () => refresh() }));
vi.mock("@/server/http/web-environment", () => ({ rejectForbiddenWebEnvironment: () => forbidden() }));

const { proxy, SESSIONLESS_PATHS } = await import("@/proxy");
const request = (pathname: string) => new NextRequest(new URL(`https://wrenkind.example.test${pathname}`), { headers: { cookie: "sb-session=old" } });

beforeEach(() => {
  refresh.mockClear();
  forbidden.mockReset();
  forbidden.mockReturnValue(undefined);
});

describe("proxy: sessionless webhook path", () => {
  it("25–26. /api/webhooks/meta skips the session refresh: no cookie, no redirect", async () => {
    const response = await proxy(request("/api/webhooks/meta"));
    expect(refresh).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toBeNull();
    expect(SESSIONLESS_PATHS).toEqual(["/api/webhooks/meta"]);
  });
  it("the forbidden-environment refusal still runs first on the webhook path", async () => {
    forbidden.mockReturnValue(new NextResponse(null, { status: 503 }));
    expect((await proxy(request("/api/webhooks/meta"))).status).toBe(503);
    expect(refresh).not.toHaveBeenCalled();
  });
  it("27–29. every other path still refreshes — the OAuth callback, the app, and look-alike or prefix paths", async () => {
    for (const pathname of ["/", "/onboarding", "/api/oauth/meta/callback", "/api/health", "/api/webhooks/meta/x", "/api/webhooks/metax", "/api/webhooks", "/api/webhooks/tiktok"]) {
      refresh.mockClear();
      const response = await proxy(request(pathname));
      expect(refresh, pathname).toHaveBeenCalledTimes(1);
      expect(response.cookies.get("sb-session")?.value, pathname).toBe("refreshed");
    }
  });
});
