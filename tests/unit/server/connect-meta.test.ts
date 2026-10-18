/**
 * Connect Meta (Step 7G-F4), offline: the destination rule, the closed outcome mapping, the orchestration's order
 * (commit first, then the adapter's URL, then the destination check) and the fresh-connection domain policy. The
 * pipeline here is an in-process double; the real start/lock/re-check is proven on PostgreSQL
 * (tests/db/suites/meta-fresh-connection.ts).
 */
import { describe, expect, it } from "vitest";
import { AppError } from "@/domain/errors";
import { META_DIALOG_URL } from "@/integrations/providers/meta/endpoints";
import type { ProviderAuthorizationPort } from "@/integrations/providers/contract";
import {
  ATTEMPT_STATUSES,
  EXCHANGE_STALE_AFTER_MS,
  SINGLE_CONNECTION_PROVIDERS,
  blocksFreshConnection,
  isSingleConnectionProvider,
  type ConnectAttempt,
  type Connection,
  type StartOutcome,
} from "@/modules/connections";
import { isLiveFreshAttempt } from "@/modules/connections/domain/model";
import { createLogger } from "@/platform/observability";
import { WORKSPACE_ROLE_PERMISSIONS, isGrantable } from "@/platform/permissions/catalog";
import { connectionSettingsViewCommand, createConnectionCommands } from "@/server/commands/connections";
import { isAuthorizationDestination, startConnectionAuthorization, type ConnectionAuthorizationDependencies, type StartResult } from "@/server/connections/authorization";
import { authorizationProviders } from "@/server/connections/runtime";
import { CONNECT_STATUSES, connectMeta, connectOutcome, parseConnectStatus, resolveConnectionSettings } from "@/server/connections/settings";
import type { ActionPipeline, PipelineResult } from "@/server/pipeline";
import { workspaceConnectionsPath } from "@/server/routes";

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const STATE = `v1.${WS}.${"A".repeat(43)}`;
const DIALOG = `${META_DIALOG_URL}?client_id=synthetic-app&config_id=synthetic-config&redirect_uri=x&state=y&response_type=code`;

describe("authorization destination: https, exact Meta dialog origin and path, no userinfo or fragment", () => {
  it("the frozen dialog URL is accepted, whatever query the adapter built (never interpreted)", () => {
    expect(new URL(META_DIALOG_URL).origin).toBe("https://www.facebook.com");
    expect(new URL(META_DIALOG_URL).pathname).toBe("/v25.0/dialog/oauth");
    expect(isAuthorizationDestination(META_DIALOG_URL, META_DIALOG_URL)).toBe(true);
    expect(isAuthorizationDestination(DIALOG, META_DIALOG_URL)).toBe(true);
    expect(isAuthorizationDestination(`${META_DIALOG_URL}?anything=at-all&state=`, META_DIALOG_URL)).toBe(true);
  });

  it("refuses http, another origin, another path, userinfo, a fragment and non-URLs", () => {
    for (const url of [
      DIALOG.replace("https:", "http:"),
      DIALOG.replace("www.facebook.com", "facebook.com"),
      DIALOG.replace("www.facebook.com", "www.facebook.com.evil.example"),
      DIALOG.replace("www.facebook.com", "www.facebook.com:8443"),
      DIALOG.replace("https://", "https://evil.example/"),
      DIALOG.replace("/v25.0/dialog/oauth", "/l.php"),
      DIALOG.replace("/v25.0/dialog/oauth", "/v24.0/dialog/oauth"),
      DIALOG.replace("/v25.0/dialog/oauth", "/v25.0/dialog/oauth/"),
      DIALOG.replace("https://", "https://user:pass@"),
      DIALOG.replace("https://", "https://user@"),
      `${DIALOG}#fragment`,
      `${DIALOG}#`,
      "not a url",
      "",
      "javascript:alert(1)",
    ]) {
      expect(isAuthorizationDestination(url, META_DIALOG_URL), url).toBe(false);
    }
  });

  it("the endpoint comes from composition: Meta's frozen dialog; the simulator stays unconstrained", () => {
    const providers = authorizationProviders({}, "https://app.example.test");
    expect(providers.authorizationEndpoint("meta")).toBe(META_DIALOG_URL);
    expect(providers.authorizationEndpoint("simulator")).toBeUndefined();
  });
});

describe("closed outcomes", () => {
  it("maps every start result to a closed outcome; only ok carries a URL; a lock wait past its bound (CONFLICT) is unavailable", () => {
    const cases: [StartResult, ReturnType<typeof connectOutcome>][] = [
      [{ status: "ok", authorizationUrl: DIALOG }, { kind: "authorize", url: DIALOG }],
      [{ status: "existing_connection" }, { kind: "status", status: "existing_connection" }],
      [{ status: "authorization_in_progress" }, { kind: "status", status: "authorization_in_progress" }],
      [{ status: "unauthenticated" }, { kind: "signed_out" }],
      [{ status: "verification_required" }, { kind: "verification_required" }],
      [{ status: "error", code: "NOT_FOUND" }, { kind: "status", status: "workspace_not_found" }],
      [{ status: "error", code: "PERMISSION_DENIED" }, { kind: "status", status: "not_allowed" }],
      [{ status: "error", code: "INVALID_INPUT" }, { kind: "status", status: "provider_unavailable" }],
      [{ status: "error", code: "PROVIDER_PERMANENT" }, { kind: "status", status: "authorization_start_failed" }],
      [{ status: "error", code: "CONFLICT" }, { kind: "status", status: "unavailable" }],
      [{ status: "error", code: "anything else" }, { kind: "status", status: "unavailable" }],
    ];
    for (const [result, outcome] of cases) expect(connectOutcome(result)).toEqual(outcome);
  });

  it("status query values are a closed vocabulary", () => {
    for (const status of CONNECT_STATUSES) expect(parseConnectStatus(status)).toBe(status);
    for (const bad of ["", "ok", "55P03", "https://evil.example", ["existing_connection"], undefined]) expect(parseConnectStatus(bad)).toBeUndefined();
  });

  it("the Settings path is built only from a canonical workspace UUID", () => {
    expect(workspaceConnectionsPath(WS)).toBe(`/workspaces/${WS}/settings/connections`);
    for (const bad of ["", "../x", `${WS}/../../admin`, WS.toUpperCase(), "//evil.example", undefined, null]) expect(workspaceConnectionsPath(bad)).toBeUndefined();
  });
});

/** An in-process pipeline double: records the start request, answers with a fixed result. */
function fakeDeps(answer: PipelineResult<StartOutcome>, url = DIALOG) {
  const events: string[] = [];
  const requests: unknown[] = [];
  const port = {
    provider: "meta",
    pkce: "not_supported",
    authorizationRequest: () => {
      events.push("authorization_request");
      return Promise.resolve({ url });
    },
    parseCallback: () => ({ kind: "malformed", reason: "missing_state" }),
    exchangeCode: () => Promise.reject(new Error("never")),
  } as unknown as ProviderAuthorizationPort;
  const providers = { ...authorizationProviders({ meta: port }, "https://app.example.test") };
  const pipeline: ActionPipeline = {
    run: (command, request) => {
      events.push(`run:${command.name}`);
      requests.push(request);
      events.push("committed");
      return Promise.resolve(answer as never);
    },
  };
  const deps = {
    pipeline,
    commands: createConnectionCommands({ secrets: { newState: () => STATE, stateDigest: () => "d", pkceVerifier: () => "v", pkceChallenge: () => "c" }, providers }),
    providers,
    logger: createLogger({ sink: () => undefined }),
  } as unknown as ConnectionAuthorizationDependencies;
  return { deps, events, requests };
}

const started = (): PipelineResult<StartOutcome> => ({
  status: "ok",
  correlationId: "c" as never,
  value: { kind: "started", authorization: { attemptId: "a", state: STATE, pkce: null, redirectUri: "https://app.example.test/api/oauth/meta/callback" as never, provider: "meta" } },
});

describe("orchestration order and refusals", () => {
  it("the start commits BEFORE the adapter builds the URL; the provider is fixed to meta", async () => {
    const { deps, events, requests } = fakeDeps(started());
    expect(await connectMeta(deps, WS)).toEqual({ kind: "authorize", url: DIALOG });
    expect(events).toEqual(["run:connections.authorization.start", "committed", "authorization_request"]);
    expect(requests).toEqual([{ workspaceId: WS, correlationId: undefined, input: { provider: "meta" } }]);
  });

  it("existing_connection / authorization_in_progress: no URL is ever built", async () => {
    for (const kind of ["existing_connection", "authorization_in_progress"] as const) {
      const { deps, events } = fakeDeps({ status: "ok", correlationId: "c" as never, value: { kind } });
      expect(await connectMeta(deps, WS)).toEqual({ kind: "status", status: kind });
      expect(events).not.toContain("authorization_request");
    }
  });

  it("an adapter URL off the frozen endpoint → authorization_start_failed, with no URL anywhere in the outcome", async () => {
    for (const bad of [DIALOG.replace("https:", "http:"), "https://evil.example/v25.0/dialog/oauth?state=y", `${DIALOG}#x`, "https://www.facebook.com/l.php?u=https://evil.example"]) {
      const { deps } = fakeDeps(started(), bad);
      const outcome = await connectMeta(deps, WS);
      expect(outcome).toEqual({ kind: "status", status: "authorization_start_failed" });
      expect(JSON.stringify(outcome)).not.toContain("evil");
    }
  });

  it("a pipeline refusal maps to a closed status and builds nothing", async () => {
    const { deps, events } = fakeDeps({ status: "error", correlationId: "c" as never, error: new AppError("CONFLICT", {}) });
    expect(await connectMeta(deps, WS)).toEqual({ kind: "status", status: "unavailable" });
    expect(events).not.toContain("authorization_request");
    const unauthenticated = fakeDeps({ status: "unauthenticated", correlationId: "c" as never });
    expect(await startConnectionAuthorization(unauthenticated.deps, { workspaceId: WS, provider: "meta" })).toEqual({ status: "unauthenticated" });
  });
});

describe("connections.settings.view", () => {
  it("requires connections.manage (Owner/Admin only, never grantable), runs in any mode, and audits nothing", () => {
    expect(connectionSettingsViewCommand).toMatchObject({ scope: "workspace", name: "connections.settings.view", permission: "connections.manage", requiresStandardMode: false });
    expect(connectionSettingsViewCommand.audit({ connections: [], metaConnect: "available" })).toBeUndefined();
    expect(WORKSPACE_ROLE_PERMISSIONS.OWNER.has("connections.manage")).toBe(true);
    expect(WORKSPACE_ROLE_PERMISSIONS.ADMIN.has("connections.manage")).toBe(true);
    for (const role of ["MANAGER", "RESPONDER", "ANALYST_VIEWER", "CLIENT_GUEST"] as const) {
      expect(WORKSPACE_ROLE_PERMISSIONS[role].has("connections.manage"), role).toBe(false);
      expect(isGrantable(role, "connections.manage"), role).toBe(false);
    }
  });

  it("maps the read's results to page states without detail", async () => {
    const answer = (result: PipelineResult<unknown>): ActionPipeline => ({ run: () => Promise.resolve(result as never) });
    expect(await resolveConnectionSettings(answer({ status: "unauthenticated", correlationId: "c" as never }), WS)).toEqual({ kind: "signed_out" });
    expect(await resolveConnectionSettings(answer({ status: "verification_required", correlationId: "c" as never }), WS)).toEqual({ kind: "verification_required" });
    expect(await resolveConnectionSettings(answer({ status: "error", correlationId: "c" as never, error: new AppError("NOT_FOUND", {}) }), WS)).toEqual({ kind: "workspace_not_found" });
    expect(await resolveConnectionSettings(answer({ status: "error", correlationId: "c" as never, error: new AppError("PERMISSION_DENIED", {}) }), WS)).toEqual({ kind: "not_allowed" });
    expect(await resolveConnectionSettings(answer({ status: "error", correlationId: "c" as never, error: new AppError("CONFLICT", {}) }), WS)).toEqual({ kind: "unavailable" });
    expect(await resolveConnectionSettings(answer({ status: "ok", correlationId: "c" as never, value: { connections: [], metaConnect: "available" } }), WS)).toEqual({
      kind: "ready",
      workspaceId: WS,
      connections: [],
      metaConnect: "available",
    });
  });
});

describe("fresh-connection domain policy (Meta only; temporary product policy)", () => {
  const NOW = new Date(1_000_000_000);
  const connection = (patch: Partial<Connection>): Connection => ({ provider: "meta", status: "ACTIVE", ...patch }) as Connection;
  const attempt = (patch: Partial<ConnectAttempt>): ConnectAttempt =>
    ({ provider: "meta", reconnectConnectionId: null, status: "PENDING", expiresAt: new Date(NOW.getTime() + 1), exchangeStartedAt: null, ...patch }) as ConnectAttempt;

  it("applies to Meta only", () => {
    expect(SINGLE_CONNECTION_PROVIDERS).toEqual(["meta"]);
    expect(isSingleConnectionProvider("meta")).toBe(true);
    expect(isSingleConnectionProvider("simulator")).toBe(false);
    expect(isSingleConnectionProvider("tiktok")).toBe(false);
  });

  it("every status but REMOVED blocks a fresh connect, for the same provider only", () => {
    for (const status of ["CONNECTING", "ACTIVE", "DEGRADED", "FAILED", "DISCONNECTED"] as const) expect(blocksFreshConnection(connection({ status }), "meta"), status).toBe(true);
    expect(blocksFreshConnection(connection({ status: "REMOVED" }), "meta")).toBe(false);
    expect(blocksFreshConnection(connection({ provider: "simulator" }), "meta")).toBe(false);
    expect(blocksFreshConnection(connection({ provider: "tiktok" }), "meta")).toBe(false);
  });

  it("live = fresh PENDING inside its lifetime, or fresh EXCHANGING younger than the stale threshold; nothing else", () => {
    expect(isLiveFreshAttempt(attempt({}), "meta", NOW)).toBe(true);
    expect(isLiveFreshAttempt(attempt({ expiresAt: NOW }), "meta", NOW)).toBe(false);
    const exchangingSince = (ms: number) => attempt({ status: "EXCHANGING", exchangeStartedAt: new Date(NOW.getTime() - ms) });
    expect(isLiveFreshAttempt(exchangingSince(EXCHANGE_STALE_AFTER_MS - 1), "meta", NOW)).toBe(true);
    expect(isLiveFreshAttempt(exchangingSince(EXCHANGE_STALE_AFTER_MS), "meta", NOW)).toBe(false);
    for (const status of ATTEMPT_STATUSES.filter((s) => s !== "PENDING" && s !== "EXCHANGING")) {
      expect(isLiveFreshAttempt(attempt({ status, exchangeStartedAt: NOW }), "meta", NOW), status).toBe(false);
    }
    expect(isLiveFreshAttempt(attempt({ reconnectConnectionId: WS }), "meta", NOW)).toBe(false);
    expect(isLiveFreshAttempt(attempt({ provider: "simulator" }), "meta", NOW)).toBe(false);
  });
});
