/**
 * Capability re-check surface guards (Step 7G-H5.5-P2-B2). The Settings surface only REQUESTS a re-evaluation through
 * the registered command: no provider, integration, Meta, Trigger, job or AWS code; no outbox write of its own; no
 * eligibility, catalog or cooldown rule in the page or the browser (the server read model offers, the command decides).
 * The read-model offer is composed from the recovery core's exported functions and restates none of its rules.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../support/source-scan";

const PAGE = "app/workspaces/[workspaceId]/settings/connections/page.tsx";
const ACTIONS = "server/connections/actions.ts";
const SETTINGS = "server/connections/settings.ts";
const VIEW = "modules/connections/application/capability-reevaluation-view.ts";
const MANAGEMENT = "modules/connections/application/management.ts";
const SURFACE = [PAGE, ACTIONS, SETTINGS];
const PRODUCTION_ROOTS = ["app", "server", "modules", "domain", "platform", "integrations", "jobs", "mutations", "ai", "ui"];

const importsOf = (file: string): string[] => [...codeOf(file).matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");
const section = (code: string, start: string, end?: string): string => {
  const from = code.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  return end === undefined ? code.slice(from) : code.slice(from, code.indexOf(end, from));
};

describe("no provider, Meta, integration, Trigger, job or AWS code on the re-check path", () => {
  it("the surface and the read-model offer import none of it", () => {
    for (const file of [...SURFACE, VIEW]) {
      for (const specifier of importsOf(file)) {
        expect(specifier, `${file} → ${specifier}`).not.toMatch(/integrations\/|providers\/meta|\/meta\b|tiktok|^@\/jobs\/|platform\/jobs|platform\/outbox|platform\/aws|platform\/crypto|@aws-sdk|@trigger\.dev|^pg$|drizzle/);
      }
    }
  });

  it("the re-check code calls no provider, task, Trigger or outbox, and names no provider", () => {
    const recheck = [
      section(codeOf(ACTIONS), "export async function requestCapabilityRecheckAction"),
      section(codeOf(SETTINGS), "const { requestCapabilityReevaluation } = createConnectedAccountCommands();"),
      section(codeOf(PAGE), "function CapabilityRecheck("),
      codeOf(VIEW),
    ];
    for (const code of recheck) {
      expect(code).not.toMatch(/tasks\.trigger|triggerTask|runEvaluateAccountCapabilities|refreshAccountCapabilities|describeAccount|withCredential|evaluateAndStore/);
      expect(code).not.toMatch(/outbox|capabilityEvaluationRequest|dispatchKey|dispatch_key|\.append\(|system\./i);
      expect(code).not.toMatch(/["'`](meta|tiktok|facebook|instagram|simulator)["'`]/);
    }
  });
});

describe("the surface requests; it never decides", () => {
  it("the action reads only the routed workspace id and one account id, and runs the registered command with only that id", () => {
    const action = section(codeOf(ACTIONS), "export async function requestCapabilityRecheckAction", "export async function requestInteractionsSyncAction");
    expect([...action.matchAll(/form\.get\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1])).toEqual(["workspaceId", "connectedAccountId"]);
    expect(action).not.toMatch(/form\.(getAll|entries|keys|values|has)\(/);
    const settings = section(codeOf(SETTINGS), "export async function requestCapabilityRecheck(", "export async function requestInteractionsSync(");
    expect(settings).toMatch(/pipeline\.run\(requestCapabilityReevaluation, \{ workspaceId: input\.workspaceId, input: \{ connectedAccountId: input\.connectedAccountId \} \}\)/);
    expect([...settings.matchAll(/pipeline\.run\(/g)]).toHaveLength(1); // exactly one run: no automatic retry
    expect(settings).not.toMatch(/for \(|while \(|setTimeout|setInterval|retry/i);
  });

  it("the page carries no eligibility, catalog or cooldown rule: it renders the server offer only", () => {
    const page = codeOf(PAGE);
    for (const specifier of importsOf(PAGE)) expect(specifier).not.toMatch(/^@\/modules\//);
    expect(page).not.toMatch(/profileEligibility|withinReevaluationCooldown|isCurrentProfile|catalogRevision|CATALOGS|COOLDOWN|Date\.now|new Date|30 \* 60/);
    expect(page).toMatch(/offer\.allowed/);
    // The only client component is still the pending-state button (no client-side request logic).
    const clients = sourceFiles(PRODUCTION_ROOTS).filter((file) => readFileSync(path.join(REPOSITORY_ROOT, file), "utf8").startsWith('"use client";'));
    expect(clients).toEqual(["ui/connections/pending-submit-button.tsx"]);
  });

  it("the read-model offer reuses the recovery core's functions and restates none of its rules; it locks and writes nothing", () => {
    const view = codeOf(VIEW);
    expect(importsOf(VIEW)).toContain("./capability-reevaluation");
    expect(view).toMatch(/profileEligibility\(/);
    expect(view).toMatch(/withinReevaluationCooldown\(/);
    expect(view).toMatch(/REEVALUATION_COOLDOWN_EVENTS/);
    expect(view).not.toMatch(/isCurrentProfile|catalogIdFor|CATALOGS|catalogRevision|COOLDOWN_MS|60 \* 1000|\.lock\(|getForShare|\.append\(|\.insert\(|\.update\(/);
    // The settings read model reaches it read-only (no lock, no write) and only for managed accounts.
    const management = section(codeOf(MANAGEMENT), "export async function viewConnectionSettings(", "export async function getConnection(");
    expect(management).toMatch(/account === undefined\s*\?\s*null\s*:\s*await capabilityReevaluationView\(/);
    expect(management).not.toMatch(/\.lock\(|lockForUpdate|\.append\(|\.insert\(|\.update\(|outbox/);
  });
});
