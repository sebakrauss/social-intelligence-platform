/**
 * Step 7B-17K — the rendering request's identity is verified with the Auth server ONCE per render, never shared beyond
 * it. `verifyOnce` is the port wrapper; `requestIdentity` scopes one such port to one server request through React's
 * `cache` (in a server-component render). Outside a server-component render React's cache memoizes nothing, so each
 * call builds and verifies afresh — never one person's identity for another request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ ports: 0, calls: 0, user: undefined as { id: string; emailVerified: boolean } | undefined, fail: false }));
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ getAll: () => [], set: () => undefined }) }));
vi.mock("@/server/http/service-identity", () => ({ serviceIdentityCoherent: () => true }));
vi.mock("@/platform/auth", () => ({
  readSupabaseAuthConfig: () => ({ url: "https://example.invalid", publishableKey: "synthetic", secureCookies: true }),
  createSupabaseAuth: () => {
    env.ports += 1;
    return {
      getVerifiedUser: () => {
        env.calls += 1;
        return env.fail ? Promise.reject(new Error("auth server unreachable")) : Promise.resolve(env.user);
      },
    };
  },
}));

const { requestIdentity, verifyOnce } = await import("@/server/auth/request-auth");

describe("verifyOnce", () => {
  it("asks the Auth server once however many reads use the port, and gives every read the same answer", async () => {
    let calls = 0;
    const port = verifyOnce({ getVerifiedUser: () => (calls += 1, Promise.resolve({ id: "u", emailVerified: true } as never)) });
    const answers = await Promise.all([port.getVerifiedUser(), port.getVerifiedUser(), port.getVerifiedUser(), port.getVerifiedUser()]);
    expect(calls).toBe(1);
    expect(new Set(answers).size).toBe(1);
  });

  it("a failed verification fails every read of that port (no read silently proceeds) and is not retried within it", async () => {
    let calls = 0;
    const port = verifyOnce({ getVerifiedUser: () => (calls += 1, Promise.reject(new Error("down"))) });
    await expect(port.getVerifiedUser()).rejects.toThrow("down");
    await expect(port.getVerifiedUser()).rejects.toThrow("down");
    expect(calls).toBe(1);
  });

  it("two ports never share an answer: each verifies for itself", async () => {
    const people = ["person-a", "person-b"];
    const ports = people.map((id) => verifyOnce({ getVerifiedUser: () => Promise.resolve({ id, emailVerified: true } as never) }));
    expect((await ports[0]?.getVerifiedUser())?.id).toBe("person-a");
    expect((await ports[1]?.getVerifiedUser())?.id).toBe("person-b");
  });
});

describe("requestIdentity outside a server-component render", () => {
  beforeEach(() => {
    env.ports = 0;
    env.calls = 0;
    env.fail = false;
    env.user = { id: "5b8f2c7e-1d2a-4e3b-9c4d-6a7b8c9d0e1f", emailVerified: true };
  });

  it("memoizes nothing across calls: each call builds its own port and verifies afresh (no cross-request identity)", async () => {
    const first = await requestIdentity();
    const second = await requestIdentity();
    expect(first).not.toBe(second);
    expect((await first?.getVerifiedUser())?.id).toBe(env.user?.id);
    env.user = { id: "6c9f3d8f-2e3b-4f4c-8d5e-7b8c9d0e1f2a", emailVerified: true };
    expect((await second?.getVerifiedUser())?.id).toBe("6c9f3d8f-2e3b-4f4c-8d5e-7b8c9d0e1f2a");
    expect(env.ports).toBe(2);
    expect(env.calls).toBe(2);
  });

  it("a signed-out request is still signed out, and a failure is still a failure", async () => {
    env.user = undefined;
    expect(await (await requestIdentity())?.getVerifiedUser()).toBeUndefined();
    env.fail = true;
    await expect((await requestIdentity())?.getVerifiedUser()).rejects.toThrow("auth server unreachable");
  });
});
