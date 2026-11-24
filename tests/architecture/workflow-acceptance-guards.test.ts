/**
 * W12-PREP-01 — static guards around the shared-dev Comments Workflow acceptance tooling:
 *   - operator tooling only: no deployed runtime imports it; the CLI and the vitest global setup both prove the exact
 *     dev-v2 target (the dev-fixture fence) and parse the operation before anything connects;
 *   - canonical: interactions, conversations, work items, workflow events and outbox rows come only from
 *     ingestInteractionFact; the tool's own SQL writes only the hierarchy, memberships, the U2 role and its audit event;
 *   - no delete, reset, truncate or repair path; no write to workflow, classification, credentials or mutations;
 *   - isolated: the simulator only — no provider SDK or real adapter, no AI, no network, no credential, no KMS;
 *   - identities: auth users are only READ (auth.users), never created or changed; no claims are forged.
 */
import { describe, expect, it } from "vitest";
import { codeOf, sourceFiles } from "../support/source-scan";

const RUNTIME = ["app", "ui", "server", "domain", "modules", "platform", "integrations", "jobs", "db", "mutations", "ai"];
const CORE = "tests/db/dev-fixtures/workflow-acceptance.ts";
const MEMBERS = "tests/db/dev-fixtures/workflow-acceptance-members.ts";
const TOOL = ["tools/db/workflow-acceptance.ts", "tools/db/workflow-acceptance-guard.ts", CORE, MEMBERS, "tests/db/dev-fixtures/workflow-acceptance.operator.ts",
  "tests/db/dev-fixtures/workflow-acceptance-setup.ts", "vitest.workflow-acceptance.config.ts"];
const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
const inserts = (code: string): string[] => [...code.matchAll(/insert into ([a-z_]+\.[a-z_]+)/gi)].map((m) => (m[1] ?? "").toLowerCase());
const updates = (code: string): string[] => [...code.matchAll(/\bupdate ([a-z_]+\.[a-z_]+) set\b/gi)].map((m) => (m[1] ?? "").toLowerCase());

describe("W12-PREP-01: operator tooling, never runtime", () => {
  it("no deployed runtime source references the acceptance tool, its guard, config or scenario", () => {
    for (const file of sourceFiles(RUNTIME)) {
      expect(strip(codeOf(file)), file).not.toMatch(/workflow-acceptance|W12_WORKFLOW_ACCEPTANCE_FIXTURE|wrenkind_fixture_w12|12acce00-/);
    }
  });

  it("the CLI parses, then proves the target, before it spawns; the global setup re-parses and re-proves before connecting", () => {
    const cli = strip(codeOf("tools/db/workflow-acceptance.ts"));
    expect(cli.indexOf("parseWorkflowAcceptanceArguments(")).toBeGreaterThan(-1);
    expect(cli.indexOf("process.exit(2)")).toBeLessThan(cli.indexOf("devFixtureTargetProblems("));
    expect(cli.indexOf("devFixtureTargetProblems(")).toBeLessThan(cli.indexOf("spawnSync("));
    expect(cli.indexOf("process.exit(1)")).toBeLessThan(cli.indexOf("spawnSync("));
    expect(cli).toMatch(/"vitest\.workflow-acceptance\.config\.ts"/);
    const setup = strip(codeOf("tests/db/dev-fixtures/workflow-acceptance-setup.ts"));
    expect(setup.indexOf("workflowAcceptanceOperationFromEnvironment(")).toBeLessThan(setup.indexOf(".connect()"));
    expect(setup.indexOf("devFixtureTargetProblems(")).toBeLessThan(setup.indexOf(".connect()"));
    expect(setup).toMatch(/status\.pending\.length > 0/);
    expect(setup).not.toMatch(/applyT26Fixture|provisionRoles|applyMigrations/);
    const config = strip(codeOf("vitest.workflow-acceptance.config.ts"));
    expect(config).toMatch(/include: \["tests\/db\/dev-fixtures\/workflow-acceptance\.operator\.ts"\]/);
  });

  it("an APPLY succeeds only with an applied status (a plan status returned by an apply is a failure); the setup refuses a role that does not bypass RLS", () => {
    const operator = strip(codeOf("tests/db/dev-fixtures/workflow-acceptance.operator.ts"));
    expect(operator).toMatch(/apply: new Set\(\["CREATED", "RESUMED", "ALREADY_PRESENT_MATCH", "INGESTED", "CHANGED"\]\)/);
    expect(operator).toContain("const ok = SUCCESS[operation.mode].has(status);");
    const setup = strip(codeOf("tests/db/dev-fixtures/workflow-acceptance-setup.ts"));
    expect(setup).toContain("select (rolsuper or rolbypassrls) as sees_all from pg_catalog.pg_roles where rolname = current_user");
  });

  it("each mutating command has its own confirmation phrase, naming dev-v2; verify has none", () => {
    const guard = strip(codeOf("tools/db/workflow-acceptance-guard.ts"));
    const phrases = [...guard.matchAll(/(fixture|reply|members|role): "([a-z0-9-]+-in-dev-v2)"/g)].map((m) => m[2]);
    expect(phrases).toHaveLength(4);
    expect(new Set(phrases).size).toBe(4);
    expect(guard).toMatch(/if \(cmd === "verify"\) return \{ error: "verify is read-only: --apply is refused" \}/);
    expect(guard).toMatch(/export const U2_ROLE_SEQUENCE = \["RESPONDER", "ANALYST_VIEWER", "CLIENT_GUEST"\] as const;/);
  });
});

describe("W12-PREP-01: writes", () => {
  it("there is no delete, reset, truncate, drop or repair path anywhere in the tool", () => {
    for (const file of TOOL) expect(strip(codeOf(file)).toLowerCase(), file).not.toMatch(/\bdelete from\b|\btruncate\b|--reset|--delete|--repair|\bdrop (table|schema|role)\b|\bon conflict\b/);
  });

  it("the fixture core writes SQL only for the hierarchy; canonical, Workflow and outbox rows come only from ingestInteractionFact in a workspace job scope", () => {
    const core = strip(codeOf(CORE));
    expect(new Set(inserts(core))).toEqual(new Set(["tenancy.organizations", "tenancy.workspaces", "connections.connections", "connections.discovered_assets", "connections.connected_accounts"]));
    expect(updates(core)).toEqual([]);
    expect(core).toMatch(/withWorkspaceJobScope\(worker, workspaceId, \(tx\) => ingestInteractionFact\(ingestionStores\(\{ tx, noteOutbox: \(notice\) => notices\.push\(notice\) \}\), clock, \{/);
    expect(core).toMatch(/mechanism: "reconciliation",\s+operation: "listInteractions",\s+provenance: "listed",/);
    expect(core).toMatch(/arrival: reconciliationArrival\(\{ epoch: null, providerCreatedAt: fact\.time\.providerCreatedAt \}\)/);
    expect(core).toMatch(/values \(\$1, \$2, \$3, 'simulator', 'ACTIVE', null, \$4, now\(\), 1, now\(\), now\(\)\)/);
    expect(core.toLowerCase()).not.toMatch(/workflow\.change_state|markdonecommand|reopencommand|insert into workflow\.|update workflow\.|appendoutbox|createpostgresingestioneventstore|noteoutbox: \(\) =>/);
  });

  it("the members module writes only memberships, the U2 role (compare-and-set) and its audit event — never a user, claim, grant, workflow or other row", () => {
    const members = strip(codeOf(MEMBERS));
    expect(new Set(inserts(members))).toEqual(new Set(["tenancy.organization_memberships", "tenancy.workspace_memberships", "audit.audit_events"]));
    expect(updates(members)).toEqual(["tenancy.workspace_memberships"]);
    expect(members).toMatch(/update tenancy\.workspace_memberships set role = \$4 where workspace_id = \$1 and user_id = \$2 and role = \$3 and grants = '\{\}'/);
    expect(members).toMatch(/'workspace_membership\.role_changed', 'system', null/);
    expect(members).toMatch(/"select email_confirmed_at is not null as confirmed from auth\.users where id = \$1"/);
    expect(members.toLowerCase()).not.toMatch(/insert into auth\.|update auth\.|request\.jwt|set_config\(|set local role|auth\.admin|service_role/);
    expect(members).toMatch(/export const ORGANIZATION_ROLE = "MEMBER";/);
    expect(members).toMatch(/'\{\}', now\(\)\)"/);
  });
});

describe("W12-PREP-01: provider, AI and credential isolation", () => {
  it("the tool imports only the simulator adapter and never a provider SDK, real adapter, mutation path, AI, KMS or credential access", () => {
    for (const file of TOOL) {
      const code = strip(codeOf(file));
      expect(code, file).not.toMatch(/@\/integrations\/providers\/(meta|tiktok)|@\/mutations|@\/ai\/|@aws-sdk|withCredential|decrypt|envelope|provider_credentials \(|fetch\(/);
    }
    expect(strip(codeOf(CORE))).toMatch(/from "@\/integrations\/providers\/simulator"/);
  });

  it("the scenario is synthetic: simulated, facebook pages under the fixture prefix, no link or URL", () => {
    const scenario = codeOf("fixtures/providers/simulator/w12-workflow-acceptance.scenario.json");
    const parsed = JSON.parse(scenario) as { simulated: boolean; assets: { id: string; platform: string }[]; interactions: { id: string; text: string }[] };
    expect(parsed.simulated).toBe(true);
    expect(parsed.assets.every((a) => a.id.startsWith("wrenkind_fixture_w12_") && a.platform === "facebook")).toBe(true);
    expect(parsed.interactions.every((i) => i.id.startsWith("wrenkind_fixture_w12_"))).toBe(true);
    expect(scenario).not.toMatch(/https?:|www\.|\.com\b/);
  });
});
