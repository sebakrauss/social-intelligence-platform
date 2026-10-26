/**
 * The Connect Meta server action (Step 7G-F4), offline: the Next.js redirect, the request's auth and the connection
 * runtime are replaced in-process; the action, the outcome mapping and the real orchestration (with its destination
 * check) run on an in-process pipeline double. Proves: the provider is fixed, the browser contributes only the routed
 * workspace id, redirects are fixed internal paths (or the validated Meta dialog), and nothing internal leaks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/domain/errors";
import { META_DIALOG_URL } from "@/integrations/providers/meta/endpoints";
import type { ProviderAuthorizationPort } from "@/integrations/providers/contract";
import type { StartOutcome } from "@/modules/connections";
import { createLogger } from "@/platform/observability";
import type { ConnectionAuthorizationDependencies } from "@/server/connections/authorization";
import type * as ConnectionRuntime from "@/server/connections/runtime";
import type { ActionPipeline, PipelineResult } from "@/server/pipeline";

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const STATE = `v1.${WS}.${"A".repeat(43)}`;
const DIALOG = `${META_DIALOG_URL}?client_id=synthetic-app&state=synthetic`;
const SETTINGS = `/workspaces/${WS}/settings/connections`;
const CONNECTION = "6f1c2e0a-8b3d-4c5e-9f70-112233445566";

interface ActionTestState {
  auth: boolean;
  throws: boolean;
  answer: unknown;
  url: string;
  requests: unknown[];
  authorizationRequests: number;
}

const env = vi.hoisted((): ActionTestState => ({ auth: true, throws: false, answer: undefined, url: "", requests: [], authorizationRequests: 0 }));

class RedirectSignal extends Error {
  readonly location: string;
  constructor(location: string) {
    super("NEXT_REDIRECT");
    this.location = location;
  }
}

vi.mock("next/navigation", () => ({
  redirect: (location: string) => {
    throw new RedirectSignal(location);
  },
}));
vi.mock("@/server/auth/request-auth", () => ({
  requestAuth: () => Promise.resolve(env.auth ? { getVerifiedUser: () => Promise.resolve(undefined) } : undefined),
}));
vi.mock("@/server/connections/runtime", async (importOriginal) => {
  const original = await importOriginal<typeof ConnectionRuntime>();
  return {
    ...original,
    connectionAuthorizationRuntime: (): ConnectionAuthorizationDependencies => {
      if (env.throws) throw new Error("connect ECONNREFUSED db.internal:6543 web_login synthetic-password-marker 55P03");
      const port = {
        provider: "meta",
        pkce: "not_supported",
        authorizationRequest: () => {
          env.authorizationRequests += 1;
          return Promise.resolve({ url: env.url });
        },
      } as unknown as ProviderAuthorizationPort;
      const pipeline: ActionPipeline = {
        run: (_command, request) => {
          env.requests.push(request);
          return Promise.resolve(env.answer as never);
        },
      };
      return {
        pipeline,
        commands: { start: { name: "connections.authorization.start" } },
        providers: original.authorizationProviders({ meta: port }, "https://app.example.test"),
        logger: createLogger({ sink: () => undefined }),
      } as unknown as ConnectionAuthorizationDependencies;
    },
  };
});

const { reconnectMetaConnectionAction, startMetaConnectionAction } = await import("@/server/connections/actions");

const form = (fields: Readonly<Record<string, string>>): FormData => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

async function locationOf(action: Promise<void>): Promise<string> {
  try {
    await action;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.location;
    throw error;
  }
  throw new Error("the action must redirect");
}

const ok = (value: StartOutcome): PipelineResult<StartOutcome> => ({ status: "ok", correlationId: "c" as never, value });
const started = (): PipelineResult<StartOutcome> =>
  ok({ kind: "started", authorization: { attemptId: "a", state: STATE, pkce: null, redirectUri: "https://app.example.test/api/oauth/meta/callback" as never, provider: "meta" } });
const failed = (code: "NOT_FOUND" | "PERMISSION_DENIED" | "INVALID_INPUT" | "CONFLICT"): PipelineResult<StartOutcome> => ({
  status: "error",
  correlationId: "c" as never,
  error: code === "INVALID_INPUT" ? new AppError("INVALID_INPUT", { field: "provider" }) : new AppError(code, {}),
});

beforeEach(() => {
  env.auth = true;
  env.throws = false;
  env.answer = started();
  env.url = DIALOG;
  env.requests = [];
  env.authorizationRequests = 0;
});

describe("startMetaConnectionAction", () => {
  it("Owner/Admin start → redirect to the validated Meta dialog; the provider is fixed and only the workspace id is routed", async () => {
    expect(await locationOf(startMetaConnectionAction(form({ workspaceId: WS })))).toBe(DIALOG);
    expect(env.requests).toEqual([{ workspaceId: WS, correlationId: undefined, input: { provider: "meta" } }]);
  });

  it("browser-supplied provider, user, role, redirect targets and app identifiers are ignored", async () => {
    const hostile = form({
      workspaceId: WS,
      provider: "simulator",
      userId: "00000000-0000-4000-8000-000000000000",
      role: "OWNER",
      redirect: "https://evil.example",
      redirectUrl: "https://evil.example",
      returnTo: "//evil.example",
      next: "/x",
      callback: "https://evil.example/cb",
      client_id: "attacker-app",
      config_id: "attacker-config",
      reconnectConnectionId: WS,
    });
    expect(await locationOf(startMetaConnectionAction(hostile))).toBe(DIALOG);
    expect(env.requests).toEqual([{ workspaceId: WS, correlationId: undefined, input: { provider: "meta" } }]);
  });

  it("signed-out and unverified callers can't start", async () => {
    env.answer = { status: "unauthenticated", correlationId: "c" };
    expect(await locationOf(startMetaConnectionAction(form({ workspaceId: WS })))).toBe("/sign-in");
    env.answer = { status: "verification_required", correlationId: "c" };
    expect(await locationOf(startMetaConnectionAction(form({ workspaceId: WS })))).toBe("/sign-in?status=verification_required");
    expect(env.authorizationRequests).toBe(0);
  });

  it("every refusal returns to the fixed Settings path with a closed status, and never builds a URL", async () => {
    const cases: [PipelineResult<StartOutcome>, string][] = [
      [ok({ kind: "existing_connection" }), "existing_connection"],
      [ok({ kind: "authorization_in_progress" }), "authorization_in_progress"],
      [failed("NOT_FOUND"), "workspace_not_found"],
      [failed("PERMISSION_DENIED"), "not_allowed"],
      [failed("INVALID_INPUT"), "provider_unavailable"],
      [failed("CONFLICT"), "unavailable"],
    ];
    for (const [answer, status] of cases) {
      env.answer = answer;
      expect(await locationOf(startMetaConnectionAction(form({ workspaceId: WS })))).toBe(`${SETTINGS}?status=${status}`);
    }
    expect(env.authorizationRequests).toBe(0);
  });

  it("an adapter URL off Meta's exact dialog endpoint → authorization_start_failed, no external redirect", async () => {
    for (const url of ["https://evil.example/v25.0/dialog/oauth?state=x", DIALOG.replace("https:", "http:"), `${DIALOG}#x`, "https://www.facebook.com/l.php?u=https%3A%2F%2Fevil.example"]) {
      env.url = url;
      const location = await locationOf(startMetaConnectionAction(form({ workspaceId: WS })));
      expect(location).toBe(`${SETTINGS}?status=authorization_start_failed`);
      expect(location).not.toContain("evil");
    }
  });

  it("an invalid workspace value fails closed to /onboarding, unreflected and without a start", async () => {
    for (const workspaceId of ["", "not-a-uuid", "../../admin", "https://evil.example", WS.toUpperCase()]) {
      const location = await locationOf(startMetaConnectionAction(form({ workspaceId })));
      expect(location).toBe("/onboarding");
    }
    expect(await locationOf(startMetaConnectionAction(form({})))).toBe("/onboarding");
    expect(env.requests).toEqual([]);
  });

  it("no auth configuration, or a failing composition/database → unavailable, with nothing internal in the URL", async () => {
    env.auth = false;
    expect(await locationOf(startMetaConnectionAction(form({ workspaceId: WS })))).toBe(`${SETTINGS}?status=unavailable`);
    env.auth = true;
    env.throws = true;
    const location = await locationOf(startMetaConnectionAction(form({ workspaceId: WS })));
    expect(location).toBe(`${SETTINGS}?status=unavailable`);
    expect(location).not.toMatch(/ECONNREFUSED|web_login|synthetic-password-marker|db\.internal|55P03/);
    expect(env.authorizationRequests).toBe(0);
  });
});

describe("reconnectMetaConnectionAction (Step 7G-H5.5-P12-C0-R2)", () => {
  const reconnectStart = { workspaceId: WS, correlationId: undefined, input: { provider: "meta", reconnectConnectionId: CONNECTION } };

  it("targets the routed existing connection: the same start with it as the reconnect target, then the validated Meta dialog", async () => {
    expect(await locationOf(reconnectMetaConnectionAction(form({ workspaceId: WS, connectionId: CONNECTION })))).toBe(DIALOG);
    expect(env.requests).toEqual([reconnectStart]);
    expect(env.authorizationRequests).toBe(1);
  });

  it("browser-supplied provider, credential, refresh marker, evaluation and redirect fields are ignored", async () => {
    const hostile = form({
      workspaceId: WS,
      connectionId: CONNECTION,
      provider: "simulator",
      reconnectConnectionId: "00000000-0000-4000-8000-000000000000",
      credentialId: "00000000-0000-4000-8000-000000000001",
      credential_id: "00000000-0000-4000-8000-000000000001",
      capability_refresh_credential_id: "00000000-0000-4000-8000-000000000001",
      capabilityRefresh: "credential",
      kind: "reauthorized",
      redirect: "https://evil.example",
      returnTo: "//evil.example",
    });
    expect(await locationOf(reconnectMetaConnectionAction(hostile))).toBe(DIALOG);
    expect(env.requests).toEqual([reconnectStart]);
    expect(JSON.stringify(env.requests)).not.toMatch(/credential|refresh|reauthorized|evil|simulator|0000-4000/);
  });

  it("a connection that isn't a UUID is connection_not_found without any start", async () => {
    for (const connectionId of ["", "not-a-uuid", "../../admin", "https://evil.example"]) {
      expect(await locationOf(reconnectMetaConnectionAction(form({ workspaceId: WS, connectionId })))).toBe(`${SETTINGS}?status=connection_not_found`);
    }
    expect(await locationOf(reconnectMetaConnectionAction(form({ workspaceId: WS })))).toBe(`${SETTINGS}?status=connection_not_found`);
    expect([env.requests, env.authorizationRequests]).toEqual([[], 0]);
  });

  it("a foreign, missing, REMOVED or non-Meta connection (NOT_FOUND) reads as connection_not_found; other refusals are closed statuses; no URL is built", async () => {
    const cases: [PipelineResult<StartOutcome>, string][] = [
      [failed("NOT_FOUND"), "connection_not_found"],
      [failed("PERMISSION_DENIED"), "not_allowed"],
      [failed("INVALID_INPUT"), "provider_unavailable"],
      [failed("CONFLICT"), "unavailable"],
    ];
    for (const [answer, status] of cases) {
      env.answer = answer;
      expect(await locationOf(reconnectMetaConnectionAction(form({ workspaceId: WS, connectionId: CONNECTION })))).toBe(`${SETTINGS}?status=${status}`);
    }
    expect(env.authorizationRequests).toBe(0);
  });

  it("signed-out and unverified callers can't reconnect; an invalid workspace fails closed to /onboarding", async () => {
    env.answer = { status: "unauthenticated", correlationId: "c" };
    expect(await locationOf(reconnectMetaConnectionAction(form({ workspaceId: WS, connectionId: CONNECTION })))).toBe("/sign-in");
    env.answer = { status: "verification_required", correlationId: "c" };
    expect(await locationOf(reconnectMetaConnectionAction(form({ workspaceId: WS, connectionId: CONNECTION })))).toBe("/sign-in?status=verification_required");
    env.requests = [];
    expect(await locationOf(reconnectMetaConnectionAction(form({ workspaceId: "not-a-uuid", connectionId: CONNECTION })))).toBe("/onboarding");
    expect(env.requests).toEqual([]);
    expect(env.authorizationRequests).toBe(0);
  });

  it("an adapter URL off Meta's dialog, or a failing composition, never leaves the app and leaks nothing", async () => {
    env.url = "https://evil.example/v25.0/dialog/oauth?state=x";
    expect(await locationOf(reconnectMetaConnectionAction(form({ workspaceId: WS, connectionId: CONNECTION })))).toBe(`${SETTINGS}?status=authorization_start_failed`);
    env.throws = true;
    const location = await locationOf(reconnectMetaConnectionAction(form({ workspaceId: WS, connectionId: CONNECTION })));
    expect(location).toBe(`${SETTINGS}?status=unavailable`);
    expect(location).not.toMatch(/ECONNREFUSED|web_login|synthetic-password-marker|db\.internal|55P03/);
  });

  it("Connect Meta is unchanged: it never carries a reconnect target", async () => {
    expect(await locationOf(startMetaConnectionAction(form({ workspaceId: WS, connectionId: CONNECTION })))).toBe(DIALOG);
    expect(env.requests).toEqual([{ workspaceId: WS, correlationId: undefined, input: { provider: "meta" } }]);
  });
});
