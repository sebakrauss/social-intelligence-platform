/**
 * Step 7B-15H (audit 7B-15G P2-3, M07) — the reply-draft scope the Inbox page reads for the composer. It exists ONLY for
 * a person the auth server verified; every other case is "no scope" (the composer keeps no draft) — never a shared,
 * anonymous or constant bucket that two people could both write into.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { replyDraftScope } from "@/server/inbox/draft-scope";

const env = vi.hoisted((): { auth: unknown } => ({ auth: undefined }));
// Step 7B-17K: the Inbox reads take the rendering request's identity (requestIdentity) — the same port shape.
vi.mock("@/server/auth/request-auth", () => ({ requestIdentity: () => (env.auth instanceof Error ? Promise.reject(env.auth) : Promise.resolve(env.auth)) }));

const { currentReplyDraftScope } = await import("@/server/inbox/runtime");

const PERSON_A = "5b8f2c7e-1d2a-4e3b-9c4d-6a7b8c9d0e1f";
const PERSON_B = "6c9f3d8f-2e3b-4f4c-8d5e-7b8c9d0e1f2a";
const verified = (id: string) => ({ getVerifiedUser: () => Promise.resolve({ id, emailVerified: true }) });

describe("currentReplyDraftScope", () => {
  beforeEach(() => {
    env.auth = undefined;
  });

  it("is undefined without auth configuration, without a verified person, when verification fails, and when the auth composition throws", async () => {
    env.auth = undefined;
    expect(await currentReplyDraftScope()).toBeUndefined();
    env.auth = { getVerifiedUser: () => Promise.resolve(undefined) };
    expect(await currentReplyDraftScope()).toBeUndefined();
    env.auth = { getVerifiedUser: () => Promise.reject(new Error("auth server unreachable")) };
    expect(await currentReplyDraftScope()).toBeUndefined();
    env.auth = new Error("cookies unavailable");
    expect(await currentReplyDraftScope()).toBeUndefined();
  });

  it("is the person's own digest when verified — different people never share one", async () => {
    env.auth = verified(PERSON_A);
    const a = await currentReplyDraftScope();
    env.auth = verified(PERSON_B);
    const b = await currentReplyDraftScope();
    expect(a).toBe(replyDraftScope(PERSON_A));
    expect(b).toBe(replyDraftScope(PERSON_B));
    expect(a).not.toBe(b);
    expect(a).not.toContain(PERSON_A.slice(0, 8));
  });
});
