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
      "app/auth/callback/route.ts",
      "app/layout.tsx",
      "app/onboarding/page.tsx",
      "app/page.tsx",
      "app/sign-in/page.tsx",
      "app/sign-up/page.tsx",
    ]);
  });
});
