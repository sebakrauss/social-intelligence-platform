/**
 * The Sync interactions server action (Step H6-C4), offline: the Next.js redirect, the request's auth and the settings
 * pipeline are replaced in-process; the action and the closed outcome mapping are real. Proves: exactly one run of
 * ingestion.account.request_reconciliation with ONLY the routed account id as input (a browser-supplied budget, time,
 * scope, role, topic or subject is never read), malformed input runs nothing, every answer maps to its own status
 * (already running is not an error; an unknown answer is plain unavailable), every redirect is a fixed internal path,
 * and nothing internal leaks. The command and its boundary are proven on PostgreSQL (tests/db/suites/interactions-sync.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/domain/errors";
import type { ActionPipeline, PipelineResult } from "@/server/pipeline";

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const ACCOUNT = "2c3d4e5f-6a7b-4c8d-9e0f-a0b1c2d3e4f5";
const RUN = "4e5f6a7b-8c9d-4e0f-9a1b-c2d3e4f5a6b7";
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
    if (env.throws) throw new Error("connect ECONNREFUSED db.internal:6543 web_login synthetic-password-marker reconciliation_request_incoherent");
    return {
      run: (command, request) => {
        env.requests.push({ command: command.name, permission: command.scope === "workspace" ? command.permission : "-", request });
        return Promise.resolve(env.answer as never);
      },
    };
  },
}));

const { requestInteractionsSyncAction } = await import("@/server/connections/actions");

const form = (fields: Readonly<Record<string, string>>): FormData => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};
const valid = (extra: Readonly<Record<string, string>> = {}) => form({ workspaceId: WS, connectedAccountId: ACCOUNT, ...extra });
const expected = { command: "ingestion.account.request_reconciliation", permission: "connections.manage", request: { workspaceId: WS, input: { connectedAccountId: ACCOUNT } } };

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
  env.answer = answer({ kind: "requested", runId: RUN });
  env.requests = [];
});

describe("requestInteractionsSyncAction", () => {
  it("runs exactly the registered command once, with only the account id; then → sync_started", async () => {
    expect(await locationOf(requestInteractionsSyncAction(valid()))).toBe(`${SETTINGS}?status=sync_started`);
    expect(env.requests).toEqual([expected]);
  });

  it("a browser-supplied budget, time, scope, user, role, topic, subjects, state or redirect target is never read", async () => {
    const hostile = valid({
      maxOperations: "8",
      max_operations: "40",
      budget: '{"max_operations":1}',
      requestedAt: "2000-01-01T00:00:00Z",
      organizationId: "00000000-0000-4000-8000-000000000003",
      userId: "00000000-0000-4000-8000-000000000000",
      role: "OWNER",
      topic: "ingestion.reconcile_slice",
      subjectIds: '{"connected_account_id":"x"}',
      state: "RUNNING",
      dispatchKey: "ingestion.reconcile_account:x",
      redirect: "https://evil.example",
      returnTo: "//evil.example",
    });
    expect(await locationOf(requestInteractionsSyncAction(hostile))).toBe(`${SETTINGS}?status=sync_started`);
    expect(env.requests).toEqual([expected]);
  });

  it("a malformed account id runs nothing; an invalid workspace → /onboarding", async () => {
    for (const connectedAccountId of ["", "not-a-uuid", ACCOUNT.toUpperCase(), "../x", `${ACCOUNT} `]) {
      expect(await locationOf(requestInteractionsSyncAction(form({ workspaceId: WS, connectedAccountId })))).toBe(`${SETTINGS}?status=sync_not_found`);
    }
    expect(await locationOf(requestInteractionsSyncAction(form({ workspaceId: WS })))).toBe(`${SETTINGS}?status=sync_not_found`);
    for (const workspaceId of ["", "not-a-uuid", "https://evil.example", WS.toUpperCase()]) {
      expect(await locationOf(requestInteractionsSyncAction(form({ workspaceId, connectedAccountId: ACCOUNT })))).toBe("/onboarding");
    }
    expect(env.requests).toEqual([]);
  });

  it("already running is a product state (its own status, never retried); not found is the same for any account it can't see", async () => {
    env.answer = answer({ kind: "already_running", runId: RUN });
    expect(await locationOf(requestInteractionsSyncAction(valid()))).toBe(`${SETTINGS}?status=sync_already_running`);
    expect(env.requests).toEqual([expected]);
    env.answer = answer({ kind: "not_found" });
    expect(await locationOf(requestInteractionsSyncAction(valid()))).toBe(`${SETTINGS}?status=sync_not_found`);
  });

  it("an answer the surface doesn't know fails closed → unavailable", async () => {
    for (const value of [{ kind: "completed" }, { kind: "requested_twice" }, {}, null]) {
      env.answer = answer(value);
      expect(await locationOf(requestInteractionsSyncAction(valid())), JSON.stringify(value)).toBe(`${SETTINGS}?status=unavailable`);
    }
  });

  it("maps pipeline outcomes to closed statuses on the fixed Settings path", async () => {
    const cases: [unknown, string][] = [
      [{ status: "unauthenticated", correlationId: "c" }, "/sign-in"],
      [{ status: "verification_required", correlationId: "c" }, "/sign-in?status=verification_required"],
      [failed("PERMISSION_DENIED"), `${SETTINGS}?status=not_allowed`],
      [failed("NOT_FOUND"), `${SETTINGS}?status=sync_not_found`],
      [failed("INVALID_INPUT"), `${SETTINGS}?status=sync_not_found`],
      [failed("CONFLICT"), `${SETTINGS}?status=unavailable`],
      [failed("JOB_FAILED"), `${SETTINGS}?status=unavailable`],
    ];
    for (const [result, location] of cases) {
      env.answer = result;
      expect(await locationOf(requestInteractionsSyncAction(valid()))).toBe(location);
    }
  });

  it("no auth configuration, or a failing composition/database → unavailable, with nothing internal in the URL", async () => {
    env.auth = false;
    expect(await locationOf(requestInteractionsSyncAction(valid()))).toBe(`${SETTINGS}?status=unavailable`);
    env.auth = true;
    env.throws = true;
    const location = await locationOf(requestInteractionsSyncAction(valid()));
    expect(location).toBe(`${SETTINGS}?status=unavailable`);
    expect(location).not.toMatch(/ECONNREFUSED|web_login|synthetic-password-marker|db\.internal|incoherent/);
  });
});
