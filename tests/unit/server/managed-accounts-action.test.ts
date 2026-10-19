/**
 * The Managed accounts server action (Step 7G-H5), offline: the Next.js redirect, the request's auth and the settings
 * pipeline are replaced in-process; the action and the closed outcome mapping are real. Proves: the provider is fixed
 * server side, the browser contributes only the routed ids and the checked asset ids, malformed input runs nothing,
 * every redirect is a fixed internal path, a refusal never reads as success, and nothing internal leaks. The save itself
 * is proven on PostgreSQL (tests/db/suites/managed-accounts.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/domain/errors";
import type { ActionPipeline, PipelineResult } from "@/server/pipeline";

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const CONNECTION = "6f1c2e0a-8b3d-4c5e-9f70-112233445566";
const FACEBOOK = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const INSTAGRAM = "1b2c3d4e-5f6a-4b7c-9d8e-9fa0b1c2d3e4";
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
    if (env.throws) throw new Error("connect ECONNREFUSED db.internal:6543 web_login synthetic-password-marker 40P01 deadlock");
    return {
      run: (command, request) => {
        env.requests.push({ command: command.name, request });
        return Promise.resolve(env.answer as never);
      },
    };
  },
}));

const { saveManagedAccountsAction } = await import("@/server/connections/actions");

const form = (fields: Readonly<Record<string, string>>, assets: readonly string[] = []): FormData => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  for (const asset of assets) data.append("discoveredAssetId", asset);
  return data;
};
const valid = (assets: readonly string[] = [FACEBOOK, INSTAGRAM], extra: Readonly<Record<string, string>> = {}) => form({ workspaceId: WS, connectionId: CONNECTION, ...extra }, assets);
const request = (discoveredAssetIds: readonly string[]) => ({
  command: "connections.account.save_selection",
  request: { workspaceId: WS, input: { connectionId: CONNECTION, expectedProvider: "meta", discoveredAssetIds } },
});

async function locationOf(action: Promise<void>): Promise<string> {
  try {
    await action;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.location;
    throw error;
  }
  throw new Error("the action must redirect");
}

const ok = (): PipelineResult<{ activated: number; deactivated: number; managed: number }> => ({ status: "ok", correlationId: "c" as never, value: { activated: 1, deactivated: 0, managed: 2 } });
const failed = (code: "NOT_FOUND" | "PERMISSION_DENIED" | "INVALID_INPUT" | "CONFLICT" | "STALE_STATE" | "JOB_FAILED"): PipelineResult<never> => ({
  status: "error",
  correlationId: "c" as never,
  error: code === "INVALID_INPUT" ? new AppError("INVALID_INPUT", { field: "discoveredAssetIds" }) : new AppError(code, {}),
});

beforeEach(() => {
  env.auth = true;
  env.throws = false;
  env.answer = ok();
  env.requests = [];
});

describe("saveManagedAccountsAction", () => {
  it("runs connections.account.save_selection once with the provider fixed to meta and the checked ids; then → accounts_saved", async () => {
    expect(await locationOf(saveManagedAccountsAction(valid()))).toBe(`${SETTINGS}?status=accounts_saved`);
    expect(env.requests).toEqual([request([FACEBOOK, INSTAGRAM])]);
  });

  it("nothing checked is a valid desired set (manage none); a repeated checkbox value is one choice", async () => {
    expect(await locationOf(saveManagedAccountsAction(valid([])))).toBe(`${SETTINGS}?status=accounts_saved`);
    expect(await locationOf(saveManagedAccountsAction(valid([FACEBOOK, FACEBOOK])))).toBe(`${SETTINGS}?status=accounts_saved`);
    expect(env.requests).toEqual([request([]), request([FACEBOOK])]);
  });

  it("browser-supplied provider, user, role, platform, provider asset ids, redirect targets and secrets are ignored", async () => {
    const hostile = valid([INSTAGRAM], {
      provider: "simulator",
      expectedProvider: "simulator",
      userId: "00000000-0000-4000-8000-000000000000",
      role: "OWNER",
      platform: "tiktok",
      providerAssetId: "page-1234567890",
      assetClass: "ad_account",
      redirect: "https://evil.example",
      returnTo: "//evil.example",
      client_secret: "synthetic-secret-marker",
    });
    expect(await locationOf(saveManagedAccountsAction(hostile))).toBe(`${SETTINGS}?status=accounts_saved`);
    expect(env.requests).toEqual([request([INSTAGRAM])]);
  });

  it("a malformed connection or asset id runs nothing; an invalid workspace → /onboarding", async () => {
    for (const connectionId of ["", "not-a-uuid", CONNECTION.toUpperCase(), "../x"]) {
      expect(await locationOf(saveManagedAccountsAction(form({ workspaceId: WS, connectionId }, [FACEBOOK])))).toBe(`${SETTINGS}?status=connection_not_found`);
    }
    for (const asset of ["", "not-a-uuid", FACEBOOK.toUpperCase(), "page-1234567890"]) {
      expect(await locationOf(saveManagedAccountsAction(valid([FACEBOOK, asset])))).toBe(`${SETTINGS}?status=accounts_not_found`);
    }
    const tooMany = Array.from({ length: 1001 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    expect(await locationOf(saveManagedAccountsAction(valid(tooMany)))).toBe(`${SETTINGS}?status=accounts_not_found`);
    const file = form({ workspaceId: WS, connectionId: CONNECTION });
    file.append("discoveredAssetId", new Blob([FACEBOOK]), "asset.txt");
    expect(await locationOf(saveManagedAccountsAction(file))).toBe(`${SETTINGS}?status=accounts_not_found`);
    for (const workspaceId of ["", "not-a-uuid", "https://evil.example", WS.toUpperCase()]) {
      expect(await locationOf(saveManagedAccountsAction(form({ workspaceId, connectionId: CONNECTION }, [FACEBOOK])))).toBe("/onboarding");
    }
    expect(env.requests).toEqual([]);
  });

  it("maps every refusal to a closed, non-success status on the fixed Settings path", async () => {
    const cases: [unknown, string][] = [
      [{ status: "unauthenticated", correlationId: "c" }, "/sign-in"],
      [{ status: "verification_required", correlationId: "c" }, "/sign-in?status=verification_required"],
      [failed("NOT_FOUND"), `${SETTINGS}?status=accounts_not_found`],
      [failed("INVALID_INPUT"), `${SETTINGS}?status=accounts_not_found`],
      [failed("PERMISSION_DENIED"), `${SETTINGS}?status=not_allowed`],
      [failed("STALE_STATE"), `${SETTINGS}?status=connection_not_ready`],
      [{ status: "error", correlationId: "c", error: new AppError("CONNECTION_PROBLEM", { platform: "facebook" }) }, `${SETTINGS}?status=connection_not_ready`],
      [failed("CONFLICT"), `${SETTINGS}?status=accounts_conflict`],
      [failed("JOB_FAILED"), `${SETTINGS}?status=unavailable`],
    ];
    for (const [answer, location] of cases) {
      env.answer = answer;
      expect(await locationOf(saveManagedAccountsAction(valid()))).toBe(location);
    }
  });

  it("no auth configuration, or a failing composition/database → unavailable, with nothing internal in the URL", async () => {
    env.auth = false;
    expect(await locationOf(saveManagedAccountsAction(valid()))).toBe(`${SETTINGS}?status=unavailable`);
    env.auth = true;
    env.throws = true;
    const location = await locationOf(saveManagedAccountsAction(valid()));
    expect(location).toBe(`${SETTINGS}?status=unavailable`);
    expect(location).not.toMatch(/ECONNREFUSED|web_login|synthetic-password-marker|db\.internal|40P01|deadlock/);
  });
});
