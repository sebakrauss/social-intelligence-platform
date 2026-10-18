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

const { startMetaConnectionAction } = await import("@/server/connections/actions");

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
