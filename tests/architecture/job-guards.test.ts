/**
 * Static job-foundation guards (Step 3), run in every CI build without a database or vendor account.
 *
 *   supply chain   — the runtime SDK is pinned exactly; every resolved `ws` is ≥ 8.21.0 through the pinned
 *                    override; the Trigger.dev CLI is never part of the repository dependency tree
 *   credentials    — the jobs deployment never reads the web or migration credentials; the web never reads
 *                    the worker/system credentials; Trigger.dev configuration is names-only
 *   dispatch path  — only the outbox (relay, nudge) enqueues; only the adapter triggers; only the delivery
 *                    tasks run system jobs; schedules are declared in one place; tags carry outbox IDs only
 *
 * Dependency-direction rules (SDK/adapter/system scope/delivery imports) live in .dependency-cruiser.cjs.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WEB_ENVIRONMENT_GUARD, codeOf, codeWithoutForbiddenList, findReferences, sourceFiles } from "../support/source-scan";

const root = path.resolve(import.meta.dirname, "../..");
const json = (file: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(root, file), "utf8")) as Record<string, unknown>;

const PRODUCTION_ROOTS = ["app", "ui", "server", "domain", "modules", "platform", "integrations", "ai", "mutations", "jobs", "trigger.config.ts", "trigger.integration.config.ts"];
const WS_MINIMUM = [8, 21, 0] as const;

function atLeast(version: string, minimum: readonly [number, number, number]): boolean {
  const parts = version.split(/[.+-]/).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    const part = parts[index] ?? 0;
    if (part !== minimum[index]) return part > (minimum[index] ?? 0);
  }
  return true;
}

describe("job runtime supply chain", () => {
  const manifest = json("package.json") as { dependencies: Record<string, string>; devDependencies: Record<string, string>; overrides?: Record<string, string> };
  const lock = json("package-lock.json") as { packages: Record<string, { version?: string }> };

  it("pins the runtime SDK exactly", () => {
    expect(manifest.dependencies["@trigger.dev/sdk"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("pins the ws override and every resolved ws is at least 8.21.0", () => {
    expect(manifest.overrides?.["ws"]).toBe("8.21.0");
    const resolved = Object.entries(lock.packages).filter(([key]) => /(^|\/)node_modules\/ws$/.test(key));
    expect(resolved.length).toBeGreaterThan(0);
    for (const [key, entry] of resolved) expect(atLeast(entry.version ?? "0.0.0", WS_MINIMUM), `${key}@${entry.version ?? "?"}`).toBe(true);
  });

  it("never includes the Trigger.dev CLI in the repository dependency tree", () => {
    expect(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })).not.toContain("trigger.dev");
    expect(Object.keys(lock.packages).filter((key) => /(^|\/)node_modules\/trigger\.dev$/.test(key))).toEqual([]);
  });
});

describe("job runtime credentials", () => {
  it("the jobs deployment never reads the web or migration credential", () => {
    expect(findReferences(sourceFiles(["jobs", "trigger.config.ts", "trigger.integration.config.ts"]), [/DATABASE_WEB_URL/, /DATABASE_MIGRATION_URL/, /createRuntimeDatabaseFromEnv\(\s*"web"/])).toEqual([]);
  });

  it("the web never reads the worker or system credential", () => {
    const patterns = [/DATABASE_(WORKER|SYSTEM)_URL/, /createRuntimeDatabaseFromEnv\(\s*"(worker|system)"/];
    const web = sourceFiles(["app", "ui", "server", "proxy.ts"]).filter((file) => file !== WEB_ENVIRONMENT_GUARD);
    expect(findReferences(web, patterns)).toEqual([]);
    // The hosted-web guard names them only in its closed refusal list (TA-11A), never anywhere else.
    expect(patterns.filter((pattern) => pattern.test(codeWithoutForbiddenList(WEB_ENVIRONMENT_GUARD)))).toEqual([]);
  });

  it("Trigger.dev configuration comes from the environment, never from literals (one config per execution plane)", () => {
    const main = codeOf("trigger.config.ts");
    expect(main).toMatch(/process\.env\["TRIGGER_PROJECT_REF"\]/);
    expect(main).toMatch(/dirs:\s*\["\.\/jobs\/trigger\/main"\]/);
    const integration = codeOf("trigger.integration.config.ts");
    expect(integration).toMatch(/process\.env\["TRIGGER_INTEGRATION_PROJECT_REF"\]/);
    expect(integration).toMatch(/dirs:\s*\["\.\/jobs\/trigger\/integration"\]/);
    for (const config of [main, integration]) expect(config).not.toMatch(/proj_[A-Za-z0-9]/);
    expect(findReferences(sourceFiles(PRODUCTION_ROOTS), [/tr_(dev|prod|stg|preview)_[A-Za-z0-9]/])).toEqual([]);
    const example = readFileSync(path.join(root, ".env.example"), "utf8");
    for (const name of ["TRIGGER_SECRET_KEY", "TRIGGER_PROJECT_REF", "TRIGGER_INTEGRATION_PROJECT_REF", "TRIGGER_INTEGRATION_TASK_OPERATOR_KEY", "TRIGGER_MAIN_RELAY_TRIGGER_KEY"]) {
      expect(example, name).toMatch(new RegExp(`^${name}=$`, "m"));
    }
  });
});

describe("dispatch path", () => {
  const production = sourceFiles(PRODUCTION_ROOTS);
  const users = (pattern: RegExp): string[] => findReferences(production, [pattern]).map(([file]) => file);

  it("only the outbox relay and the post-commit nudge enqueue jobs", () => {
    // Step H6-F3: the webhook receiver's post-commit router nudge (a named MAIN system task, best effort).
    expect(users(/\.enqueue\(/)).toEqual(["platform/outbox/delivery.ts", "platform/outbox/nudge.ts", "server/webhooks/runtime.ts"]);
  });

  it("only the adapter triggers runs or reads run state through the SDK", () => {
    expect(users(/\btasks\.(trigger|batchTrigger|triggerAndWait)\b|\bruns\.(retrieve|replay|cancel)\b/)).toEqual(["platform/jobs/trigger-dev.ts"]);
  });

  it("system jobs run only from the named delivery tasks; tenant tasks only through the tenant wrapper", () => {
    // Step H6-F3: the MAIN system-task runner moved to one shared helper used by delivery.ts and provider-events.ts.
    expect(users(/\brunSystemJob\(/).filter((file) => !file.startsWith("platform/jobs/"))).toEqual(["jobs/trigger/main/system.ts"]);
    // Step 7E.7-B: the one direct task outside the wrappers is the integration-only KMS diagnostic (no registry entry,
    // no schedule — tests/unit/jobs/integration-kms-diagnostic.test.ts).
    expect(users(/\btask\(\{/)).toEqual(["jobs/trigger/define.ts", "jobs/trigger/integration/kms-worker-auth-diagnostic.ts", "jobs/trigger/integration/read-content-validation.ts", "jobs/trigger/integration/read-interactions-validation.ts", "jobs/trigger/main/delivery.ts", "jobs/trigger/main/provider-events.ts"]);
    // Step H6-F3: the provider-event router and purge are scheduled system tasks too (through the same runner).
    expect(users(/\bschedules\.task\(/)).toEqual(["jobs/trigger/main/delivery.ts", "jobs/trigger/main/provider-events.ts"]);
    expect(codeOf("jobs/trigger/define.ts")).toMatch(/runTenantJob\(/);
    expect(codeOf("jobs/trigger/define.ts")).toMatch(/runTenantStepJob\(/);
    // Tenant tasks are declared only through the wrappers (Step 5D: connections.discover_assets).
    expect(codeOf("jobs/trigger/integration/connections.ts")).toMatch(/defineTenantStepTask\(PRODUCTION_TASKS, "connections\.discover_assets"/);
  });

  it("run tags carry the outbox identifier only, and relay payloads pass the IDs-only validator", () => {
    const delivery = codeOf("platform/outbox/delivery.ts");
    expect(delivery.match(/tags:\s*\[[^\]]*\]/g)).toEqual(["tags: [`outbox_${row.id}`]"]);
    expect(delivery).toMatch(/parseTenantJobPayload\(/);
    expect(users(/\btags:/)).toEqual(["platform/jobs/trigger-dev.ts", "platform/outbox/delivery.ts"]);
  });
});

describe("read_content validation diagnostic: the selected getContent kind (Step 7G-H5.5-P5-C0)", () => {
  const MODULE = "jobs/integration-read-content-validation.ts";

  it("selectedContentKind is the canonical provider-contract ContentKind (never a string or a local vocabulary)", () => {
    const code = codeOf(MODULE);
    expect(code).toMatch(/readonly selectedContentKind: ContentKind \| null;/);
    expect(code).toMatch(/type ContentKind,[\s\S]*\} from "@\/integrations\/providers\/contract";/);
    expect(code).not.toMatch(/selectedContentKind: string|type \w*ContentKind\w* =|"post" \| "video"/);
  });

  it("the kind and the ref read back come from the SAME selected object; the match compares against that kind", () => {
    const code = codeOf(MODULE);
    expect(code.match(/const first = items\[0\];/g)).toHaveLength(1);
    expect(code).toMatch(/const selectedContentKind: ContentKind = first\.contentKind;/);
    expect(code).toMatch(/read\.getContent\(providerAccess, first\.ref\)/);
    expect(code).toMatch(/const contentKindMatchesListed = got === undefined \? null : got\.contentKind === selectedContentKind;/);
    // Never derived from the histogram or the getContent answer.
    expect(code).not.toMatch(/selectedContentKind[^;\n]*(histogram|contentKinds|got\.)/);
  });
});

describe("read_interactions validation diagnostic: evidence only from what both operations proved (Step 7G-H5.5-P12-B2)", () => {
  const MODULE = "jobs/integration-read-interactions-validation.ts";

  it("is its own task and module, never an extension of the read_content diagnostic", () => {
    const code = codeOf(MODULE);
    expect(code).toMatch(/export const READ_INTERACTIONS_VALIDATION_TASK_ID = "integration\.read_interactions_validation";/);
    expect(code).not.toMatch(/integration-read-content-validation|runReadContentValidation/);
    expect(codeOf("jobs/integration-read-content-validation.ts")).not.toMatch(/listInteractions|getInteraction|read_interactions/);
  });

  it("re-reads the FIRST listed interaction of each provable kind; Instagram can prove only comments", () => {
    const code = codeOf(MODULE);
    expect(code).toMatch(/const first = items\.find\(\(item\) => item\.interactionKind === kind\);/);
    // Step 7G-H5.5-P12-C9: the exact listed DTO instance, never a bare ref.
    expect(code).toMatch(/read\.getInteraction\(providerAccess, \{ kind: "listed", listed: first \}\)/);
    expect(code).not.toMatch(/getInteraction\([^)]*\.ref\)/);
    expect(code).toMatch(/facebook: Object\.freeze\(\["comment", "reply"\] as const\),\n {2}instagram: Object\.freeze\(\["comment"\] as const\),/);
    expect(code).toMatch(/const reply = provable\.includes\("reply"\) \? await reread\("reply", "get_reply"\)/);
  });

  it("correlates on identity only and offers evidence only from validated kinds that include comment", () => {
    const code = codeOf(MODULE);
    expect(code).toMatch(/const correlated = refCorrelated && contentCorrelated && kindCorrelated && authorCorrelated && parentCorrelated;/);
    expect(code).not.toMatch(/(got|first)\.(text|author\.displayName|author\.handle|visibility)\b/);
    expect(code).toMatch(/allObservedValidated && validated\.includes\("comment"\) \? validated : null/);
    expect(code).not.toMatch(/evidence[^\n]*(observed|provable|INTERACTION_KINDS)[^\n]*\? (observed|provable)/);
  });
});

