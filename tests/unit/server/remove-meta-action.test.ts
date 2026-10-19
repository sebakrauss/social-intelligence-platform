/**
 * The Remove Meta server action (Step 7G-F4C), offline: the Next.js redirect, the request's auth and the settings
 * pipeline are replaced in-process; the action and the closed outcome mapping are real. Proves: the acknowledgement gates
 * the command, the provider is fixed server side, the browser contributes only the routed ids, every redirect is a fixed
 * internal path, and nothing internal leaks. The removal itself is proven on PostgreSQL (tests/db/suites/meta-remove.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/domain/errors";
import type { ActionPipeline, PipelineResult } from "@/server/pipeline";

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const CONNECTION = "6f1c2e0a-8b3d-4c5e-9f70-112233445566";
const SETTINGS = `/workspaces/${WS}/settings/connections`;

interface ActionTestState {
  auth: boolean;
  throws: boolean;
  answer: unknown;
  requests: { readonly command: string; readonly request: unknown }[];
}

const env = vi.hoisted((): ActionTestState => ({ auth: true, throws: false, answer: undefined, requests: [] }));

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
vi.mock("@/server/connections/settings-runtime", () => ({
  connectionSettingsPipeline: (): ActionPipeline => {
    if (env.throws) throw new Error("connect ECONNREFUSED db.internal:6543 web_login synthetic-password-marker 55P03 lock_timeout");
    return {
      run: (command, request) => {
        env.requests.push({ command: command.name, request });
        return Promise.resolve(env.answer as never);
      },
    };
  },
}));

const { removeMetaConnectionAction } = await import("@/server/connections/actions");
const { REMOVE_ACKNOWLEDGEMENT } = await import("@/server/connections/settings");

const form = (fields: Readonly<Record<string, string>>): FormData => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};
const valid = (extra: Readonly<Record<string, string>> = {}) => form({ workspaceId: WS, connectionId: CONNECTION, acknowledgement: REMOVE_ACKNOWLEDGEMENT, ...extra });

async function locationOf(action: Promise<void>): Promise<string> {
  try {
    await action;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.location;
    throw error;
  }
  throw new Error("the action must redirect");
}

const ok = (changed: boolean): PipelineResult<{ changed: boolean }> => ({ status: "ok", correlationId: "c" as never, value: { changed } });
const failed = (code: "NOT_FOUND" | "PERMISSION_DENIED" | "INVALID_INPUT" | "CONFLICT"): PipelineResult<never> => ({
  status: "error",
  correlationId: "c" as never,
  error: code === "INVALID_INPUT" ? new AppError("INVALID_INPUT", { field: "connectionId" }) : new AppError(code, {}),
});

beforeEach(() => {
  env.auth = true;
  env.throws = false;
  env.answer = ok(true);
  env.requests = [];
});

describe("removeMetaConnectionAction", () => {
  it("runs connections.connection.remove once, with the provider fixed to meta and only the routed ids; then → removed", async () => {
    expect(await locationOf(removeMetaConnectionAction(valid()))).toBe(`${SETTINGS}?status=removed`);
    expect(env.requests).toEqual([{ command: "connections.connection.remove", request: { workspaceId: WS, input: { connectionId: CONNECTION, expectedProvider: "meta" } } }]);
  });

  it("an already removed connection is still `removed` (idempotent)", async () => {
    env.answer = ok(false);
    expect(await locationOf(removeMetaConnectionAction(valid()))).toBe(`${SETTINGS}?status=removed`);
  });

  it("browser-supplied provider, user, role, redirect targets and secrets are ignored", async () => {
    const hostile = valid({
      provider: "simulator",
      expectedProvider: "simulator",
      userId: "00000000-0000-4000-8000-000000000000",
      role: "OWNER",
      redirect: "https://evil.example",
      returnTo: "//evil.example",
      next: "/x",
      client_secret: "synthetic-secret-marker",
    });
    expect(await locationOf(removeMetaConnectionAction(hostile))).toBe(`${SETTINGS}?status=removed`);
    expect(env.requests).toEqual([{ command: "connections.connection.remove", request: { workspaceId: WS, input: { connectionId: CONNECTION, expectedProvider: "meta" } } }]);
  });

  it("without the exact acknowledgement nothing runs: remove_not_confirmed", async () => {
    for (const acknowledgement of [undefined, "", "on", "true", "remove", `${REMOVE_ACKNOWLEDGEMENT}x`]) {
      const fields = acknowledgement === undefined ? form({ workspaceId: WS, connectionId: CONNECTION }) : form({ workspaceId: WS, connectionId: CONNECTION, acknowledgement });
      expect(await locationOf(removeMetaConnectionAction(fields))).toBe(`${SETTINGS}?status=remove_not_confirmed`);
    }
    expect(env.requests).toEqual([]);
  });

  it("a malformed connection id is connection_not_found without running anything; an invalid workspace → /onboarding", async () => {
    for (const connectionId of ["", "not-a-uuid", CONNECTION.toUpperCase(), "../x"]) {
      expect(await locationOf(removeMetaConnectionAction(form({ workspaceId: WS, connectionId, acknowledgement: REMOVE_ACKNOWLEDGEMENT })))).toBe(`${SETTINGS}?status=connection_not_found`);
    }
    for (const workspaceId of ["", "not-a-uuid", "https://evil.example", WS.toUpperCase()]) {
      expect(await locationOf(removeMetaConnectionAction(form({ workspaceId, connectionId: CONNECTION, acknowledgement: REMOVE_ACKNOWLEDGEMENT })))).toBe("/onboarding");
    }
    expect(env.requests).toEqual([]);
  });

  it("maps every refusal to a closed status on the fixed Settings path", async () => {
    const cases: [unknown, string][] = [
      [{ status: "unauthenticated", correlationId: "c" }, "/sign-in"],
      [{ status: "verification_required", correlationId: "c" }, "/sign-in?status=verification_required"],
      [failed("NOT_FOUND"), `${SETTINGS}?status=connection_not_found`],
      [failed("INVALID_INPUT"), `${SETTINGS}?status=connection_not_found`],
      [failed("PERMISSION_DENIED"), `${SETTINGS}?status=not_allowed`],
      [failed("CONFLICT"), `${SETTINGS}?status=unavailable`],
    ];
    for (const [answer, location] of cases) {
      env.answer = answer;
      expect(await locationOf(removeMetaConnectionAction(valid()))).toBe(location);
    }
  });

  it("no auth configuration, or a failing composition/database → unavailable, with nothing internal in the URL", async () => {
    env.auth = false;
    expect(await locationOf(removeMetaConnectionAction(valid()))).toBe(`${SETTINGS}?status=unavailable`);
    env.auth = true;
    env.throws = true;
    const location = await locationOf(removeMetaConnectionAction(valid()));
    expect(location).toBe(`${SETTINGS}?status=unavailable`);
    expect(location).not.toMatch(/ECONNREFUSED|web_login|synthetic-password-marker|db\.internal|55P03|lock_timeout/);
  });
});
