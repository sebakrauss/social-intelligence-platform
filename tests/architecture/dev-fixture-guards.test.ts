/**
 * Step H7-B1b-0 — static guards around the shared-dev acceptance fixture tool:
 *   - operator tooling only: no deployed runtime (app, ui, server, modules, platform, integrations, jobs, db, domain,
 *     mutations, ai) imports it; the CLI and the vitest global setup both prove the exact dev-v2 target first;
 *   - canonical: interactions, versions, events and the outbox row come only from ingestInteractionFact (no
 *     hand-written canonical row, no hand-built outbox row); the hierarchy is the only SQL the tool writes;
 *   - isolated: no classification write, no provider SDK or real adapter, no model, no network, no credential;
 *     no migration after 0024 and no new platform key.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLATFORM_KEYS } from "@/domain/platforms";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../support/source-scan";

const RUNTIME = ["app", "ui", "server", "domain", "modules", "platform", "integrations", "jobs", "db", "mutations", "ai"];
const TOOL = ["tools/db/dev-fixture.ts", "tools/db/dev-fixture-guard.ts", "tests/db/dev-fixtures/classification-acceptance.ts", "tests/db/dev-fixtures/classification-acceptance.operator.ts",
  "tests/db/dev-fixtures/global-setup.ts", "vitest.dev-fixture.config.ts"];
const CORE = "tests/db/dev-fixtures/classification-acceptance.ts";
const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");

describe("H7-B1b-0: operator tooling, never runtime", () => {
  it("no deployed runtime source references the fixture tool, its guard, its config or its scenario", () => {
    for (const file of sourceFiles(RUNTIME)) {
      expect(strip(codeOf(file)), file).not.toMatch(/dev-fixture|dev-fixtures|h7-classification-acceptance|H7_CLASSIFICATION_ACCEPTANCE_FIXTURE|wrenkind_fixture_h7_b1b/);
    }
  });

  it("the CLI proves the target before it spawns anything; the global setup proves it again before connecting", () => {
    const cli = strip(codeOf("tools/db/dev-fixture.ts"));
    expect(cli.indexOf("parseDevFixtureArguments(")).toBeGreaterThan(-1);
    expect(cli.indexOf("devFixtureTargetProblems(")).toBeLessThan(cli.indexOf("spawnSync("));
    expect(cli.indexOf("process.exit(1)")).toBeLessThan(cli.indexOf("spawnSync("));
    expect(cli).toMatch(/"vitest\.dev-fixture\.config\.ts"/);
    const setup = strip(codeOf("tests/db/dev-fixtures/global-setup.ts"));
    expect(setup.indexOf("devFixtureTargetProblems(")).toBeLessThan(setup.indexOf(".connect()"));
    expect(setup.indexOf("devFixtureModeFromEnvironment(")).toBeLessThan(setup.indexOf(".connect()"));
    expect(setup).not.toMatch(/applyT26Fixture|provisionRoles|applyMigrations/);
  });

  it("the guard pins dev-v2 by digest and region, and the protected workspace", () => {
    const guard = strip(codeOf("tools/db/dev-fixture-guard.ts"));
    expect(guard).toMatch(/export const DEV_V2_PROJECT_REF_SHA256 = "[0-9a-f]{64}";/);
    expect(guard).toMatch(/PROTECTED_WORKSPACE_IDS: readonly string\[\] = Object\.freeze\(\["5eed2e00-0000-4000-8000-000000000001"\]\)/);
    expect(guard).toMatch(/migration\.region !== EXPECTED_REGION/);
    expect(guard).toMatch(/worker\.endpoint !== "transaction_pooler"/);
    expect(guard).not.toMatch(/[a-z0-9]{20}\.supabase|SUPABASE_PROJECT_REF\s*=\s*"/);
  });

  it("plan and apply both refuse the protected workspace first; there is no delete or reset path", () => {
    const core = strip(codeOf(CORE));
    for (const name of ["planAcceptanceFixture", "applyAcceptanceFixture"]) {
      const body = core.slice(core.indexOf(`export async function ${name}`));
      expect(body.slice(0, 400), name).toMatch(/if \(isProtectedWorkspace\(d\.workspace\.id\) \|\| isProtectedWorkspace\(d\.organization\.id\)\) return reportOf\("REFUSED_PROTECTED_WORKSPACE"/);
    }
    for (const file of TOOL) expect(strip(codeOf(file)).toLowerCase(), file).not.toMatch(/\bdelete from\b|\btruncate\b|--reset|--delete|\bdrop\b/);
  });
});

describe("H7-B1b-0: canonical rows only through ingestion", () => {
  it("the canonical chain is ingestInteractionFact over ingestionStores in a workspace job scope, from the simulator's listing", () => {
    const core = strip(codeOf(CORE));
    expect(core).toMatch(/withWorkspaceJobScope\(worker, workspaceId, \(tx\) => ingestInteractionFact\(ingestionStores\(\{ tx, noteOutbox: \(notice\) => notices\.push\(notice\) \}\), clock, \{/);
    expect(core).toMatch(/const fact = interactionSourceFactFromDto\(dto, \{/);
    expect(core).toMatch(/arrival: reconciliationArrival\(\{ epoch: null, providerCreatedAt: fact\.time\.providerCreatedAt \}\)/);
    expect(core).toMatch(/mechanism: "reconciliation",\s+operation: "listInteractions",\s+provenance: "listed",/);
  });

  it("the tool writes SQL only for the hierarchy; never a canonical, event, outbox, audit or credential row", () => {
    const core = strip(codeOf(CORE)).toLowerCase();
    const inserts = [...core.matchAll(/insert into ([a-z_]+\.[a-z_]+)/g)].map((match) => match[1]);
    expect(new Set(inserts)).toEqual(new Set(["tenancy.organizations", "tenancy.workspaces", "connections.connections", "connections.discovered_assets", "connections.connected_accounts"]));
    expect(core).not.toMatch(/\bupdate [a-z_]+\.[a-z_]+ set\b/);
    expect(core).not.toMatch(/interactionsobservedoutboxrow|appendoutbox|createpostgresingestioneventstore|noteoutbox: \(\) =>/);
  });

  it("the connection is the inert simulator provider with NO credential; the workspace is MONITOR_ONLY", () => {
    const core = strip(codeOf(CORE));
    expect(core).toMatch(/provider: "simulator" as const, status: "ACTIVE" as const/);
    expect(core).toMatch(/values \(\$1, \$2, \$3, \$4, \$5, null, \$6, now\(\), 1, now\(\), now\(\)\)/);
    expect(core).toMatch(/mode: "MONITOR_ONLY" as const/);
    expect(core).not.toMatch(/provider_credentials \(|envelope|withCredential|decrypt/i);
  });
});

describe("H7-B1b-0: isolation", () => {
  it("no classification write, no runtime classification service in the tool", () => {
    for (const file of TOOL) {
      const code = strip(codeOf(file));
      expect(code.toLowerCase(), file).not.toMatch(/(insert into|update|delete from) classification\./);
      expect(code, file).not.toMatch(/createPostgresClassificationStore|understandDeterministically|classificationScope|modules\/classification\/(persistence|application)/);
    }
  });

  it("no provider SDK, real adapter, model, network or environment secret use", () => {
    for (const file of TOOL) {
      const code = strip(codeOf(file));
      expect(code, file).not.toMatch(/@\/integrations\/providers\/(meta|tiktok)|@\/ai\b|openai|anthropic|\bfetch\(|https?:\/\/|graph\.facebook|withCredential/);
    }
  });

  it("the scenario is unmistakably synthetic: wrenkind_fixture ids, simulator marker, ONE scheme-less documentation-domain link", () => {
    const scenario = codeOf("fixtures/providers/simulator/h7-classification-acceptance.scenario.json");
    const parsed = JSON.parse(scenario) as { assets: { id: string }[]; contents: { id: string }[]; interactions: { id: string; text: string }[]; credentials: { secret: string }[]; apiVersion: string; simulated: boolean };
    expect(parsed.simulated).toBe(true);
    expect(parsed.apiVersion).toBe("simulator-v1");
    for (const item of [...parsed.assets, ...parsed.contents, ...parsed.interactions]) expect(item.id).toMatch(/^wrenkind_fixture_h7_b1b_/);
    for (const credential of parsed.credentials) expect(credential.secret).toMatch(/not-a-secret$/);
    expect(scenario).not.toMatch(/\b(?:https?|wss?):\/\//i);
    expect(parsed.interactions.map((interaction) => [...interaction.text.matchAll(/[a-z0-9.-]+\.[a-z]{2,}\/\S*/gi)].map((match) => match[0]))).toEqual([["example.com/h7-b1b"]]);
  });

  it("no migration after 0024 and no new platform key", () => {
    const migrations = readdirSync(path.join(REPOSITORY_ROOT, "db/migrations")).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
    expect(migrations.at(-1)).toBe("0024_classification_persistence.sql");
    expect([...PLATFORM_KEYS]).toEqual(["facebook", "instagram", "tiktok"]);
  });
});
