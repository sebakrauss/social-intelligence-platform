/**
 * Onboarding surface guards (Step 7G-F3): tenancy is created only through the pipeline commands, by a server-only
 * action, with no database, provider, credential or job dependency and no hidden route.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../support/source-scan";

const SURFACE = ["app/onboarding/page.tsx", "server/tenancy/onboarding.ts", "server/tenancy/actions.ts", "server/tenancy/runtime.ts"];
const importsOf = (file: string): string[] => [...codeOf(file).matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");

describe("onboarding surface (Step 7G-F3)", () => {
  it("imports no database client, module persistence, provider, connection, credential, KMS or job code", () => {
    for (const file of SURFACE) {
      for (const specifier of importsOf(file)) {
        expect(specifier, `${file} → ${specifier}`).not.toMatch(/platform\/db|modules\/[^/]+\/persistence|integrations\/|server\/connections|modules\/connections|platform\/crypto|platform\/aws|platform\/jobs|jobs\/|@trigger\.dev|@aws-sdk|^pg$|drizzle/);
      }
    }
    // The only persistence it reaches is the web unit of work the pipeline runs on.
    expect(importsOf("server/tenancy/runtime.ts")).toContain("@/server/persistence/runtime");
  });

  it("writes nothing itself: no SQL, no store calls; mutations are the two pipeline commands", () => {
    for (const file of SURFACE) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(/\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b|sql`|\.insert\(|\.update\(|\.delete\(|tx\.tenancy/i);
    }
    const onboarding = codeOf("server/tenancy/onboarding.ts");
    expect([...onboarding.matchAll(/tenancyOnboardingCommands\.(\w+)/g)].map((match) => match[1]).sort()).toEqual(["createOrganization", "createWorkspace", "listOwnTenancy"]);
    expect(onboarding).toMatch(/mode: "STANDARD"/);
  });

  it("server-only mutation path: the actions file is a server-action module; the page renders and reads only", () => {
    expect(readFileSync(path.join(REPOSITORY_ROOT, "server/tenancy/actions.ts"), "utf8").startsWith('"use server";')).toBe(true);
    const page = codeOf("app/onboarding/page.tsx");
    expect(page).not.toMatch(/submitOrganization|submitWorkspace|onboardingPipeline|"use client"/);
    expect(page).toMatch(/action=\{createOrganizationAction\}/);
    expect(page).toMatch(/action=\{createWorkspaceAction\}/);
  });

  it("reads no environment and no privileged secret", () => {
    for (const file of SURFACE) expect(codeOf(file), file).not.toMatch(/process\.env|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|DATABASE_MIGRATION_URL|DATABASE_SYSTEM_URL/);
  });

  it("no hidden seed, admin or operator route: the app's routes are exactly the reviewed ones", () => {
    expect(sourceFiles(["app"])).toEqual([
      "app/api/health/route.ts",
      "app/api/oauth/[provider]/callback/route.ts",
      // Step H6-F3: the Meta webhook receiver (public; trusted by the provider signature, never a session).
      "app/api/webhooks/meta/route.ts",
      "app/auth/callback/route.ts",
      // UI-2: the component reference sheet; a 404 in every build that is not `next dev` (brand-guards proves it).
      // Step 7B-17V: the Comments experience redesign prototype (synthetic fixtures, local React state only; no action,
      // no read, no storage), also a 404 outside `next dev` (brand-guards proves it).
      "app/dev/ui-reference/comments-redesign/fixtures.ts",
      "app/dev/ui-reference/comments-redesign/model.ts",
      "app/dev/ui-reference/comments-redesign/page.tsx",
      "app/dev/ui-reference/comments-redesign/prototype.tsx",
      // COMMENTS-UX-07A: the scroll comparison (three scroll models over the redesign's synthetic fixtures, read-only;
      // local React state only; no action, no read, no storage), also a 404 outside `next dev` (brand-guards proves it).
      "app/dev/ui-reference/comments-scroll/comparison.tsx",
      "app/dev/ui-reference/comments-scroll/data.ts",
      "app/dev/ui-reference/comments-scroll/page.tsx",
      // Step 7B-15N: the Inbox › Comments product prototype (synthetic fixtures; its only action is the reply harness's
      // development-only simulation), also a 404 outside `next dev` (brand-guards proves it).
      "app/dev/ui-reference/comments/fixtures.ts",
      "app/dev/ui-reference/comments/page.tsx",
      "app/dev/ui-reference/comments/prototype.tsx",
      // UI-4: the Inbox reference (synthetic view models), also development-only.
      "app/dev/ui-reference/inbox/page.tsx",
      "app/dev/ui-reference/page.tsx",
      // Step 7B-3: the reply harness (synthetic conversation + a development-only simulated action; never a database).
      "app/dev/ui-reference/reply/actions.ts",
      "app/dev/ui-reference/reply/page.tsx",
      // UI-3: the app-shell reference (synthetic data), also development-only.
      "app/dev/ui-reference/shell/page.tsx",
      "app/layout.tsx",
      "app/onboarding/page.tsx",
      "app/page.tsx",
      "app/sign-in/page.tsx",
      "app/sign-up/page.tsx",
      // COMMENTS-INT-03A: Workspace › Comments, the redesigned list piloted beside the Inbox. Read only (the Inbox's own
      // queries); offered only to workspaces on the server-side allowlist, 404 otherwise (comments-route tests prove it).
      "app/workspaces/[workspaceId]/comments/[conversationId]/page.tsx",
      "app/workspaces/[workspaceId]/comments/layout.tsx",
      "app/workspaces/[workspaceId]/comments/page.tsx",
      "app/workspaces/[workspaceId]/comments/views.tsx",
      // Step 7A: Workspace › Inbox, conversation list and one conversation (Step 7B-3: the reply composer posts to
      // server/inbox/actions.ts, the one Inbox server action; the pages themselves still only read).
      "app/workspaces/[workspaceId]/inbox/[conversationId]/page.tsx",
      // UI-3: section layouts draw the app shell around the existing pages; the composition reads only (brand-guards).
      "app/workspaces/[workspaceId]/inbox/layout.tsx",
      "app/workspaces/[workspaceId]/inbox/page.tsx",
      // COMMENTS-INT-03A-FIX: the Inbox's read-only pieces (times, closed states, "what has been read"), split from
      // views.tsx so a read-only page can draw them without the reply composer's action (no read, no action here).
      "app/workspaces/[workspaceId]/inbox/read-views.tsx",
      // UI-4: views.tsx draws the Step 7A view models (no read, no action). No loading.tsx: a Suspense boundary would
      // turn the sign-in redirect into a streamed 200, and the redirect stays a 307.
      "app/workspaces/[workspaceId]/inbox/views.tsx",
      // Step 7G-F4: Workspace Settings › Connections (read + one Connect Meta server action).
      "app/workspaces/[workspaceId]/settings/connections/page.tsx",
      "app/workspaces/[workspaceId]/settings/layout.tsx",
      "app/workspaces/[workspaceId]/workspace-shell.tsx",
    ]);
  });
});
