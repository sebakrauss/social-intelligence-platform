/**
 * Connect Meta surface guards (Step 7G-F4): the permanent Settings › Connections page and its server action stay thin
 * and server-only; the provider is fixed; Meta's endpoint expectation comes from server composition; the fresh-connection
 * lock exists only in the connections persistence boundary, transaction-scoped and bounded; and there is no reconnect
 * and no remove surface yet (F4-C adds removal deliberately, updating these guards).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../support/source-scan";

const PAGE = "app/workspaces/[workspaceId]/settings/connections/page.tsx";
const ACTIONS = "server/connections/actions.ts";
const SETTINGS = "server/connections/settings.ts";
const SETTINGS_RUNTIME = "server/connections/settings-runtime.ts";
const SURFACE = [PAGE, ACTIONS, SETTINGS, SETTINGS_RUNTIME, "server/routes.ts"];
const STORE = "modules/connections/persistence/store.ts";
const importsOf = (file: string): string[] => [...codeOf(file).matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");
const PRODUCTION_ROOTS = ["app", "server", "modules", "domain", "platform", "integrations", "jobs", "mutations", "ai", "ui"];

describe("Connect Meta surface (Step 7G-F4)", () => {
  it("the page imports only server-side surface modules: no adapter, persistence, database, provider or job code", () => {
    for (const specifier of importsOf(PAGE)) {
      expect(specifier, specifier).toMatch(/^(next\/navigation|@\/server\/connections\/(actions|settings|settings-runtime)|@\/server\/i18n)$/);
    }
    for (const file of SURFACE) {
      for (const specifier of importsOf(file)) {
        expect(specifier, `${file} → ${specifier}`).not.toMatch(/platform\/db|modules\/[^/]+\/persistence|integrations\/|platform\/crypto|platform\/aws|platform\/jobs|^@\/jobs\/|@trigger\.dev|@aws-sdk|^pg$|drizzle|meta-app-config/);
      }
    }
  });

  it("reads no environment, holds no provider secret and issues no SQL", () => {
    for (const file of SURFACE) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(/process\.env|PROVIDER_META_|client_secret|clientSecret|config_id|configId|SUPABASE_SERVICE_ROLE_KEY|DATABASE_\w*URL/);
      expect(code, file).not.toMatch(/\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b|sql`|\.insert\(|\.update\(|\.delete\(|pg_advisory|lock_timeout/i);
    }
  });

  it("the action is a server-action module that reads ONE form field (workspaceId) and fixes the provider to meta", () => {
    expect(readFileSync(path.join(REPOSITORY_ROOT, ACTIONS), "utf8").startsWith('"use server";')).toBe(true);
    const actions = codeOf(ACTIONS);
    expect([...actions.matchAll(/form\.get\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1])).toEqual(["workspaceId"]);
    expect(actions).not.toMatch(/form\.(getAll|entries|keys|values|has)\(|Object\.fromEntries/);
    expect(codeOf(SETTINGS)).toMatch(/startConnectionAuthorization\(deps, \{ workspaceId, provider: "meta" \}\)/);
    for (const file of SURFACE) expect(codeOf(file), file).not.toMatch(/reconnectConnectionId|provider: "simulator"/);
  });

  it("the page renders and reads only; its one form posts to the action", () => {
    const page = codeOf(PAGE);
    expect(page).not.toMatch(/"use client"|connectMeta|startConnectionAuthorization|connectionAuthorizationRuntime|recoverStale|\.start\b/);
    expect(page).toMatch(/action=\{startMetaConnectionAction\}/);
    expect(page).toMatch(/export const dynamic = "force-dynamic"/);
    expect([...page.matchAll(/<form\b/g)]).toHaveLength(1);
  });

  it("no reconnect and no remove surface in this step", () => {
    for (const file of SURFACE) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(/removeConnection|commands\.remove|connections\.connection\.remove|reconnect/i);
    }
  });

  it("the onboarding ready state links each workspace through the validated Settings path helper only", () => {
    const onboarding = codeOf("app/onboarding/page.tsx");
    expect(onboarding).toMatch(/workspaceConnectionsPath\(workspace\.id\)/);
    expect(onboarding).not.toMatch(/\/settings\/connections/);
    expect(codeOf("server/routes.ts")).toMatch(/`\/workspaces\/\$\{id\}\/settings\/connections`/);
  });
});

describe("Meta endpoint expectation and fresh-connection lock boundaries", () => {
  it("META_DIALOG_URL is referenced in product code only by the Meta adapter and the web composition root", () => {
    const users = sourceFiles(PRODUCTION_ROOTS).filter((file) => /META_DIALOG_URL/.test(codeOf(file)));
    expect(users.sort()).toEqual(["integrations/providers/meta/authorization.ts", "integrations/providers/meta/endpoints.ts", "server/connections/runtime.ts"]);
  });

  it("advisory locks and lock_timeout appear only in the connections store (beyond the reviewed 0002 owner triggers); never session-level or try-locks", () => {
    const advisory = sourceFiles(PRODUCTION_ROOTS).filter((file) => /pg_advisory|lock_timeout/.test(codeOf(file)));
    expect(advisory).toEqual([STORE]);
    for (const file of sourceFiles(PRODUCTION_ROOTS)) {
      expect(codeOf(file), file).not.toMatch(/pg_advisory_lock\b|pg_advisory_lock_shared|pg_try_advisory|pg_advisory_unlock|set\s+lock_timeout|set_config\(\s*'lock_timeout'[^)]*false/i);
    }
    const store = codeOf(STORE);
    expect(store).toMatch(/pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(\$\{FRESH_CONNECTION_LOCK_NAMESPACE\}::text \|\| \$\{workspace\}::uuid::text \|\| ':' \|\| \$\{provider\}::text, 0\)\)/);
    expect(store).toMatch(/FRESH_CONNECTION_LOCK_NAMESPACE = "connections\.fresh_connection:"/);
    expect(store).toMatch(/FRESH_CONNECTION_LOCK_TIMEOUT_MS = 5_000;\nconst FRESH_CONNECTION_LOCK_TIMEOUT = `\$\{String\(FRESH_CONNECTION_LOCK_TIMEOUT_MS\)\}ms`;/);
    // Transaction-local only (set_config(…, true)), and the previous value is what gets restored.
    expect([...store.matchAll(/set_config\('lock_timeout', [^)]*\)/g)].map((match) => match[0])).toEqual([
      "set_config('lock_timeout', ${FRESH_CONNECTION_LOCK_TIMEOUT}::text, true)",
      "set_config('lock_timeout', ${previous}::text, true)",
    ]);
  });

  it("the fresh-connection policy is Meta-only and applied at exactly the fresh start and the fresh completion", () => {
    expect(codeOf("modules/connections/domain/model.ts")).toMatch(/SINGLE_CONNECTION_PROVIDERS = \["meta"\] as const/);
    const application = codeOf("modules/connections/application/authorization.ts");
    expect([...application.matchAll(/\.serializeFresh\(/g)]).toHaveLength(2);
    // Call sites: only the application layer (the store defines it; the port declares it).
    const callers = sourceFiles(PRODUCTION_ROOTS).filter((file) => /\.serializeFresh\(/.test(codeOf(file)));
    expect(callers).toEqual(["modules/connections/application/authorization.ts"]);
  });
});
