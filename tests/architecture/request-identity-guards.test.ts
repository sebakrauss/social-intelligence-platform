/**
 * Step 7B-17K — where the per-render verified identity may be used. The rendering request's identity
 * (server/auth/request-auth.ts `requestIdentity`) is ONE server-side verification shared by the reads of one render,
 * scoped by React's `cache` to that server request. It is for server-component reads only: actions, route handlers and
 * the proxy keep building and verifying their own (the proxy is a separate execution and still refreshes the session
 * on every request). Nothing caches identity at module level, and authorization is never cached at all — every read
 * still resolves the workspace and the membership live in its own transaction.
 */
import { describe, expect, it } from "vitest";
import { codeOf, sourceFiles } from "../support/source-scan";

const REQUEST_AUTH = "server/auth/request-auth.ts";
const RENDER_READS = ["server/connections/settings-runtime.ts", "server/inbox/runtime.ts", "server/shell/runtime.ts"];

describe("the rendering request's identity", () => {
  it("is React's per-request cache around one verify-once port — no module-level identity, no other memo", () => {
    const code = codeOf(REQUEST_AUTH);
    expect(code).toMatch(/^import \{ cache \} from "react";$/m);
    expect(code).toMatch(/const renderIdentity = cache\(async \(\): Promise<IdentityPort \| undefined> => \{\s*const auth = await requestAuth\(\);\s*return auth === undefined \? undefined : verifyOnce\(auth\);\s*\}\);/);
    expect([...code.matchAll(/\bcache\(/g)]).toHaveLength(1);
    expect([...code.matchAll(/\bverifyOnce\(/g)]).toHaveLength(2); // its definition and the one use above
    // verifyOnce keeps its answer in a closure of the port it returns — never in a module variable.
    expect(code).toMatch(/export function verifyOnce\(auth: Pick<AuthPort, "getVerifiedUser">\): IdentityPort \{\s*let verified: Promise<AuthUser \| undefined> \| undefined;/);
    expect(code).not.toMatch(/^(let|var) /m);
    // It still asks the Auth server (getUser through the port) — nothing is decoded locally.
    expect(code).not.toMatch(/getClaims|getSession|jwt|decode/i);
  });

  it("is used by the server-component reads only; actions, routes and the proxy verify for themselves", () => {
    const users = sourceFiles(["app", "server", "ui", "platform"]).filter((file) => file !== REQUEST_AUTH && /\brequestIdentity\b/.test(codeOf(file)));
    expect(users.sort()).toEqual([...RENDER_READS].sort());
    for (const file of RENDER_READS) expect(codeOf(file), file).not.toMatch(/\brequestAuth\b/);
    for (const file of ["server/inbox/actions.ts", "server/auth/actions.ts", "server/connections/actions.ts", "server/tenancy/actions.ts", "server/connections/route.ts", "server/auth/callback.ts"]) {
      expect(codeOf(file), file).toMatch(/\brequestAuth\(\)/);
      expect(codeOf(file), file).not.toMatch(/\brequestIdentity\b/);
    }
    expect(codeOf("server/auth/proxy.ts")).toMatch(/await refreshSession\(config,/);
  });
});
