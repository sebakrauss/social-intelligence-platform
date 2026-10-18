/**
 * The onboarding server actions (Step 7G-F3), offline: the Next.js redirect, the request's auth and the web pipeline
 * composition are replaced in-process; the commands and the pipeline are the real ones on the in-memory unit of work.
 * Proves each action runs once, redirects to a fixed internal path (post/redirect/get), and leaks nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionPipeline } from "@/server/pipeline";
import { createHarness } from "../../support/harness";
import { userId } from "../../support/in-memory";

const env = vi.hoisted(() => ({
  pipeline: undefined as ActionPipeline | undefined,
  auth: true,
  throws: false,
}));

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
vi.mock("@/server/tenancy/runtime", () => ({
  onboardingPipeline: () => {
    if (env.throws) throw new Error("connect ECONNREFUSED db.internal:6543 web_login synthetic-password-marker");
    if (env.pipeline === undefined) throw new Error("test pipeline not set");
    return env.pipeline;
  },
}));

const { createOrganizationAction, createWorkspaceAction } = await import("@/server/tenancy/actions");

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

const ALICE = userId(1);
const BOB = userId(2);
let h: ReturnType<typeof createHarness>;

beforeEach(() => {
  h = createHarness();
  env.pipeline = h.pipeline;
  env.auth = true;
  env.throws = false;
});

describe("onboarding actions", () => {
  it("create organization → one organization, then back to /onboarding (a refresh resubmits nothing)", async () => {
    h.as(ALICE);
    expect(await locationOf(createOrganizationAction(form({ name: "Acme" })))).toBe("/onboarding");
    expect(h.unitOfWork.state.organizations.size).toBe(1);
  });

  it("create workspace → one STANDARD workspace in the caller's organization, then back to /onboarding", async () => {
    const organizationId = await h.createOrganization(ALICE);
    expect(await locationOf(createWorkspaceAction(form({ organizationId, name: "Brand", mode: "MONITOR_ONLY" })))).toBe("/onboarding");
    expect([...h.unitOfWork.state.workspaces.values()].map((w) => w.mode)).toEqual(["STANDARD"]);
  });

  it("closed statuses only: invalid input, a foreign organization, a signed-out or unverified session", async () => {
    h.as(ALICE);
    expect(await locationOf(createOrganizationAction(form({ name: "" })))).toBe("/onboarding?status=invalid_input");
    const foreign = await h.createOrganization(ALICE);
    h.as(BOB);
    expect(await locationOf(createWorkspaceAction(form({ organizationId: foreign, name: "Hijack" })))).toBe("/onboarding?status=not_allowed");
    h.identity.user = undefined;
    expect(await locationOf(createOrganizationAction(form({ name: "Acme" })))).toBe("/sign-in");
    h.identity.user = { id: BOB, emailVerified: false };
    expect(await locationOf(createWorkspaceAction(form({ organizationId: foreign, name: "Brand" })))).toBe("/sign-in?status=verification_required");
    expect(h.unitOfWork.state.workspaces.size).toBe(0);
  });

  it("no auth configuration, or a failing composition/database → unavailable, with nothing internal in the URL", async () => {
    env.auth = false;
    expect(await locationOf(createOrganizationAction(form({ name: "Acme" })))).toBe("/onboarding?status=unavailable");
    env.auth = true;
    env.throws = true;
    const location = await locationOf(createOrganizationAction(form({ name: "Acme" })));
    expect(location).toBe("/onboarding?status=unavailable");
    expect(location).not.toMatch(/ECONNREFUSED|web_login|synthetic-password-marker|db\.internal/);
    expect(h.unitOfWork.state.organizations.size).toBe(0);
  });

  it("redirect targets are fixed internal paths: no form field chooses the destination", async () => {
    h.as(ALICE);
    expect(await locationOf(createOrganizationAction(form({ name: "Acme", redirect: "https://evil.example", next: "//evil.example", returnTo: "/x" })))).toBe("/onboarding");
  });
});
