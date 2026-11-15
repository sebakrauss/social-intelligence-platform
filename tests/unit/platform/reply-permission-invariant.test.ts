/**
 * The CURRENT approved permission catalog (IA §18: "reply publicly, reply privately, hide/unhide" is one row), pinned
 * as an invariant the Inbox presentation relies on (Step 7B-15D; audit 7B-15C, P3-4): the conversation view lists the
 * secondary actions "Reply privately" and "Hide comment" (as unavailable, with a reason) to exactly the members the
 * server gave the public-reply affordance to. That is only IA §18-correct while every role that may reply publicly may
 * also reply privately and hide/unhide. This test grants nothing and decides nothing: if the catalog ever separates
 * these permissions, it fails, and the view must then read each permission on its own.
 */
import { describe, expect, it } from "vitest";
import { GRANT_POLICY, WORKSPACE_ROLE_PERMISSIONS, effectivePermissions } from "@/platform/permissions";

const TOGETHER = ["reply.public", "reply.private", "moderate.hide_unhide"] as const;
type Role = keyof typeof WORKSPACE_ROLE_PERMISSIONS;
const roles = Object.keys(WORKSPACE_ROLE_PERMISSIONS) as Role[];

describe("reply.public, reply.private and moderate.hide_unhide travel together in the approved catalog", () => {
  it("every workspace role has all three or none of them", () => {
    for (const role of roles) {
      const held = TOGETHER.filter((permission) => WORKSPACE_ROLE_PERMISSIONS[role].has(permission));
      expect([0, TOGETHER.length], `${role}: ${held.join(", ")}`).toContain(held.length);
    }
    // The roles that have them are IA §18's replying roles; the read-only roles have none.
    expect(roles.filter((role) => WORKSPACE_ROLE_PERMISSIONS[role].has("reply.public")).sort()).toEqual(["ADMIN", "MANAGER", "OWNER", "RESPONDER"]);
  });

  it("no individual grant can split them: none of the three is grantable to any role, so effective permissions keep them together", () => {
    for (const role of roles) {
      for (const permission of TOGETHER) expect(GRANT_POLICY[role].has(permission), `${role} / ${permission}`).toBe(false);
      const effective = effectivePermissions(role, [...TOGETHER, ...GRANT_POLICY[role]]);
      const held = TOGETHER.filter((permission) => effective.has(permission));
      expect([0, TOGETHER.length], role).toContain(held.length);
      expect(effective.has("reply.public")).toBe(WORKSPACE_ROLE_PERMISSIONS[role].has("reply.public"));
    }
  });
});
