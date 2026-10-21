/**
 * The capability re-check server action (Step 7G-H5.5-P2-B2), offline: the Next.js redirect, the request's auth and the
 * settings pipeline are replaced in-process; the action and the closed outcome mapping are real. Proves: exactly one run
 * of connections.account.request_capability_reevaluation with ONLY the routed account id as input, malformed input runs
 * nothing, every typed refusal maps to its own non-success status (REEVALUATION_TOO_SOON is shown, never retried), every
 * redirect is a fixed internal path, and nothing internal leaks. The command itself is proven on PostgreSQL
 * (tests/db/suites/capability-reevaluation.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/domain/errors";
import type { ActionPipeline, PipelineResult } from "@/server/pipeline";

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const ACCOUNT = "2c3d4e5f-6a7b-4c8d-9e0f-a0b1c2d3e4f5";
const SETTINGS = `/workspaces/${WS}/settings/connections`;

interface ActionTestState {
  auth: boolean;
  throws: boolean;
  answer: unknown;
  requests: { readonly command: string; readonly permission: string; readonly request: unknown }[];
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
    if (env.throws) throw new Error("connect ECONNREFUSED db.internal:6543 web_login synthetic-password-marker 40P01 deadlock");
    return {
      run: (command, request) => {
        env.requests.push({ command: command.name, permission: command.scope === "workspace" ? command.permission : "-", request });
        return Promise.resolve(env.answer as never);
      },
    };
  },
}));

const { requestCapabilityRecheckAction } = await import("@/server/connections/actions");

const form = (fields: Readonly<Record<string, string>>): FormData => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};
const valid = (extra: Readonly<Record<string, string>> = {}) => form({ workspaceId: WS, connectedAccountId: ACCOUNT, ...extra });
const expected = { command: "connections.account.request_capability_reevaluation", permission: "connections.manage", request: { workspaceId: WS, input: { connectedAccountId: ACCOUNT } } };

async function locationOf(action: Promise<void>): Promise<string> {
  try {
    await action;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.location;
    throw error;
  }
  throw new Error("the action must redirect");
}

const answer = (value: unknown): PipelineResult<unknown> => ({ status: "ok", correlationId: "c" as never, value });
const failed = (code: "NOT_FOUND" | "PERMISSION_DENIED" | "INVALID_INPUT" | "CONFLICT" | "JOB_FAILED"): PipelineResult<never> => ({
  status: "error",
  correlationId: "c" as never,
  error: code === "INVALID_INPUT" ? new AppError("INVALID_INPUT", { field: "connectedAccountId" }) : new AppError(code, {}),
});

beforeEach(() => {
  env.auth = true;
  env.throws = false;
  env.answer = answer({ requested: true });
  env.requests = [];
});

describe("requestCapabilityRecheckAction", () => {
  it("runs exactly the registered command once, with only the account id; then → capability_recheck_requested", async () => {
    expect(await locationOf(requestCapabilityRecheckAction(valid()))).toBe(`${SETTINGS}?status=capability_recheck_requested`);
    expect(env.requests).toEqual([expected]);
  });

  it("browser-supplied provider, eligibility, cooldown, keys, event ids, users, roles and redirect targets are ignored", async () => {
    const hostile = valid({
      provider: "meta",
      expectedProvider: "simulator",
      eligible: "true",
      reason: "PROFILE_STALE",
      cooldown: "0",
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
      dispatchKey: "capability.evaluate_account:x:initial",
      eventId: "00000000-0000-4000-8000-000000000002",
      userId: "00000000-0000-4000-8000-000000000000",
      role: "OWNER",
      redirect: "https://evil.example",
      returnTo: "//evil.example",
    });
    expect(await locationOf(requestCapabilityRecheckAction(hostile))).toBe(`${SETTINGS}?status=capability_recheck_requested`);
    expect(env.requests).toEqual([expected]);
  });

  it("a malformed account id runs nothing; an invalid workspace → /onboarding", async () => {
    for (const connectedAccountId of ["", "not-a-uuid", ACCOUNT.toUpperCase(), "../x", `${ACCOUNT} `]) {
      expect(await locationOf(requestCapabilityRecheckAction(form({ workspaceId: WS, connectedAccountId })))).toBe(`${SETTINGS}?status=capability_recheck_not_found`);
    }
    expect(await locationOf(requestCapabilityRecheckAction(form({ workspaceId: WS })))).toBe(`${SETTINGS}?status=capability_recheck_not_found`);
    const file = form({ workspaceId: WS });
    file.append("connectedAccountId", new Blob([ACCOUNT]), "account.txt");
    expect(await locationOf(requestCapabilityRecheckAction(file))).toBe(`${SETTINGS}?status=capability_recheck_not_found`);
    for (const workspaceId of ["", "not-a-uuid", "https://evil.example", WS.toUpperCase()]) {
      expect(await locationOf(requestCapabilityRecheckAction(form({ workspaceId, connectedAccountId: ACCOUNT })))).toBe("/onboarding");
    }
    expect(env.requests).toEqual([]);
  });

  it("maps each typed refusal to its own non-success status; REEVALUATION_TOO_SOON is shown once, never retried", async () => {
    const cases: [string, string][] = [
      ["REEVALUATION_TOO_SOON", "capability_recheck_too_soon"],
      ["PROFILE_CURRENT", "capability_recheck_not_needed"],
      ["PROFILE_NEWER_THAN_CODE", "capability_recheck_newer_version"],
      ["ACCOUNT_INACTIVE", "capability_recheck_account_inactive"],
      ["CONNECTION_NOT_ACTIVE", "capability_recheck_connection_not_active"],
    ];
    for (const [reason, status] of cases) {
      env.requests = [];
      env.answer = answer({ requested: false, reason });
      expect(await locationOf(requestCapabilityRecheckAction(valid()))).toBe(`${SETTINGS}?status=${status}`);
      expect(env.requests, reason).toEqual([expected]); // exactly one run: no automatic retry
    }
  });

  it("maps pipeline outcomes to closed statuses on the fixed Settings path (permission denied, not found, invalid id, others)", async () => {
    const cases: [unknown, string][] = [
      [{ status: "unauthenticated", correlationId: "c" }, "/sign-in"],
      [{ status: "verification_required", correlationId: "c" }, "/sign-in?status=verification_required"],
      [failed("PERMISSION_DENIED"), `${SETTINGS}?status=not_allowed`],
      [failed("NOT_FOUND"), `${SETTINGS}?status=capability_recheck_not_found`],
      [failed("INVALID_INPUT"), `${SETTINGS}?status=capability_recheck_not_found`],
      [failed("CONFLICT"), `${SETTINGS}?status=unavailable`],
      [failed("JOB_FAILED"), `${SETTINGS}?status=unavailable`],
    ];
    for (const [result, location] of cases) {
      env.answer = result;
      expect(await locationOf(requestCapabilityRecheckAction(valid()))).toBe(location);
    }
  });

  it("no auth configuration, or a failing composition/database → unavailable, with nothing internal in the URL", async () => {
    env.auth = false;
    expect(await locationOf(requestCapabilityRecheckAction(valid()))).toBe(`${SETTINGS}?status=unavailable`);
    env.auth = true;
    env.throws = true;
    const location = await locationOf(requestCapabilityRecheckAction(valid()));
    expect(location).toBe(`${SETTINGS}?status=unavailable`);
    expect(location).not.toMatch(/ECONNREFUSED|web_login|synthetic-password-marker|db\.internal|40P01|deadlock/);
  });
});
