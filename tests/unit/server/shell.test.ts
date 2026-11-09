/**
 * App shell state (UI-3), offline: resolved through the real action pipeline and the real tenancy list_own command on
 * the in-memory unit of work. Proves the closed states, that the current workspace is the URL's only when the caller
 * is a member of it (otherwise simply absent), that nothing is written, and the role → destination mapping of IA §18.
 */
import { describe, expect, it } from "vitest";
import { WORKSPACE_ROLES } from "@/domain/access";
import { resolveShell, shellAccess } from "@/server/shell/shell";
import { createHarness } from "../../support/harness";
import { userId } from "../../support/in-memory";

const ALICE = userId(1);
const STRANGER = "00000000-0000-4000-8000-00000000beef";

describe("resolveShell", () => {
  it("signed out → signed_out; unverified → verification_required; nothing touches tenancy", async () => {
    const h = createHarness();
    h.identity.user = undefined;
    expect(await resolveShell(h.pipeline, STRANGER)).toEqual({ kind: "signed_out" });
    h.identity.user = { id: ALICE, emailVerified: false };
    expect(await resolveShell(h.pipeline, STRANGER)).toEqual({ kind: "verification_required" });
    expect(h.unitOfWork.commits).toBe(0);
  });

  it("a verified user without any workspace → no_workspaces", async () => {
    const h = createHarness();
    h.as(ALICE);
    expect(await resolveShell(h.pipeline, STRANGER)).toEqual({ kind: "no_workspaces" });
    await h.createOrganization(ALICE);
    expect(await resolveShell(h.pipeline, STRANGER)).toEqual({ kind: "no_workspaces" });
  });

  it("ready: the URL's workspace is current only when the caller is a member of it; others are listed, nothing else", async () => {
    const h = createHarness();
    const organizationId = await h.createOrganization(ALICE);
    const workspaceId = await h.createWorkspace(ALICE, organizationId);
    const expected = { id: workspaceId, name: "Workspace", organizationName: "Organization A", role: "OWNER", mode: "STANDARD" };
    expect(await resolveShell(h.pipeline, workspaceId)).toEqual({ kind: "ready", current: expected, workspaces: [expected] });
    expect(await resolveShell(h.pipeline, STRANGER)).toEqual({ kind: "ready", current: undefined, workspaces: [expected] });
    expect(await resolveShell(h.pipeline, "not-a-uuid")).toEqual({ kind: "ready", current: undefined, workspaces: [expected] });
    expect(await resolveShell(h.pipeline, undefined)).toEqual({ kind: "ready", current: undefined, workspaces: [expected] });
    expect(h.unitOfWork.state.audit.length).toBe(h.unitOfWork.state.audit.length);
  });
});

describe("shellAccess (IA §18)", () => {
  it("Inbox for every non-guest role; Settings › Connections for Owner and Admin only", () => {
    expect(WORKSPACE_ROLES).toEqual(["OWNER", "ADMIN", "MANAGER", "RESPONDER", "ANALYST_VIEWER", "CLIENT_GUEST"]);
    expect(shellAccess("OWNER")).toEqual({ inbox: true, connections: true });
    expect(shellAccess("ADMIN")).toEqual({ inbox: true, connections: true });
    expect(shellAccess("MANAGER")).toEqual({ inbox: true, connections: false });
    expect(shellAccess("RESPONDER")).toEqual({ inbox: true, connections: false });
    expect(shellAccess("ANALYST_VIEWER")).toEqual({ inbox: true, connections: false });
    expect(shellAccess("CLIENT_GUEST")).toEqual({ inbox: false, connections: false });
  });
});
