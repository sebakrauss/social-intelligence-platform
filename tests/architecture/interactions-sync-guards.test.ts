/**
 * Step H6-C4 — static guards around the "Sync interactions" web producer:
 *   - the path is fixed: page form → requestInteractionsSyncAction → requestInteractionsSync → the registered command
 *     → requestMemberReconciliation → the web unit of work's request port → ingestion.request_reconciliation (0019);
 *   - the web holds no other reconciliation primitive: no insert, no store, no worker adapter, no planner topic, no
 *     outbox append — the boundary writes the run, its audit event and its planner row;
 *   - the browser supplies the account id only: no budget, time, scope or topic reaches the boundary from the web;
 *   - the pipeline appends no audit event for a boundary-audited command, and this is the only such command;
 *   - release order: the producer's planner topic is a registered MAIN task at this source, so the paired Trigger
 *     release (H6-C5) carries its consumer; a web deployment of this source before that release is unsafe (documented).
 */
import { describe, expect, it } from "vitest";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { RELEASE_PLANES } from "@/tools/trigger/release-pair";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../support/source-scan";
import { COMMAND_BOUND_ELSEWHERE } from "../db/suites/audit-provenance";
import { readFileSync } from "node:fs";
import path from "node:path";

const PAGE = "app/workspaces/[workspaceId]/settings/connections/page.tsx";
const ACTIONS = "server/connections/actions.ts";
const SETTINGS = "server/connections/settings.ts";
const COMMAND = "server/commands/reconciliation.ts";
const ADAPTER = "modules/ingestion/application/member-request.ts";
const UOW = "server/persistence/postgres-unit-of-work.ts";
const PIPELINE = "server/pipeline/pipeline.ts";
const importsOf = (file: string): string[] => [...codeOf(file).matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");
const section = (code: string, start: string, end?: string): string => {
  const from = code.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const to = end === undefined ? -1 : code.indexOf(end, from + start.length);
  return to === -1 ? code.slice(from) : code.slice(from, to);
};
/** Web-reachable code: the pages, the UI, and every server module except the job runtime's persistence composition. */
const WEB = sourceFiles(["app", "ui", "server"]).filter((file) => file !== "server/persistence/ingestion.ts");

describe("H6-C4: the web path to the request boundary is fixed", () => {
  it("the page posts the sync form to its action with ONLY the workspace and account ids", () => {
    const page = codeOf(PAGE);
    const sync = section(page, "function InteractionsSync(");
    expect([...sync.matchAll(/<form action=\{(\w+)\}>/g)].map((m) => m[1])).toEqual(["requestInteractionsSyncAction"]);
    expect([...sync.matchAll(/<input name="([^"]+)"/g)].map((m) => m[1])).toEqual(["workspaceId", "connectedAccountId"]);
    expect(sync).toMatch(/<PendingSubmitButton label=\{t\("connections\.sync\.submit"\)\} pendingLabel=\{t\("connections\.sync\.submitting"\)\} \/>/);
    expect(sync).toMatch(/assets\.filter\(\(asset\) => asset\.managed && asset\.connectedAccountId !== null\)/);
  });

  it("the action reads two fields and runs the surface once; the surface runs the registered command exactly once with only the account", () => {
    const action = section(codeOf(ACTIONS), "export async function requestInteractionsSyncAction");
    expect([...action.matchAll(/form\.get\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1])).toEqual(["workspaceId", "connectedAccountId"]);
    expect(action).not.toMatch(/form\.(getAll|entries|keys|values|has)\(/);
    expect(action).toMatch(/requestInteractionsSync\(connectionSettingsPipeline\(auth\), \{ workspaceId, connectedAccountId \}\)/);
    const surface = section(codeOf(SETTINGS), "export async function requestInteractionsSync(");
    expect([...surface.matchAll(/pipeline\.run\(/g)]).toHaveLength(1);
    expect(surface).toMatch(/pipeline\.run\(requestInteractionsSyncCommand, \{ workspaceId: input\.workspaceId, input: \{ connectedAccountId: input\.connectedAccountId \} \}\)/);
    expect(surface).not.toMatch(/for \(|while \(|setTimeout|setInterval|retry/i);
  });

  it("the command validates the account id ONLY, runs the member adapter on the request port, and appends nothing itself", () => {
    const command = codeOf(COMMAND);
    expect(command).toMatch(/validate: object\(\{ connectedAccountId: uuid \}\),/);
    expect([...command.matchAll(/validate:/g)]).toHaveLength(1);
    expect(command).toMatch(/requestMemberReconciliation\(tx\.reconciliation, \{ connectedAccountId: input\.connectedAccountId, correlationId: env\.correlationId \}\)/);
    expect(command).toMatch(/if \(output\.kind === "requested"\) tx\.outbox\.routed\(\{ id: output\.outboxId, correlationId: env\.correlationId \}\);/);
    expect(command).not.toMatch(/outbox\.append|tx\.audit|recordAuditEvent|tx\.connections|requestRun|sql`/);
    expect(command).toMatch(/permission: "connections\.manage",/);
    expect(command).toMatch(/requiresStandardMode: false,/);
  });

  it("the member adapter sends no time and no budget: the boundary's defaults (40 operations) always apply to the web", () => {
    const adapter = codeOf(ADAPTER);
    expect([...adapter.matchAll(/port\.requestRun\(/g)]).toHaveLength(1);
    expect(adapter).toMatch(/port\.requestRun\(\{ connectedAccountId: input\.connectedAccountId, correlationId: input\.correlationId, requestedAt: null, budget: null \}\)/);
    expect(adapter).not.toMatch(/defaultBudgetSnapshot|maxOperations|LIVE_ACCEPTANCE|new Date|clock/);
  });

  it("the web unit of work exposes the request boundary ONLY (requestRun), never the reconciliation store", () => {
    const uow = codeOf(UOW);
    expect(uow).toMatch(/reconciliation: requestOnly\(createPostgresReconciliationStore\(tx, \(\) => undefined\)\),/);
    expect(uow).toMatch(/const requestOnly = \(store: ReconciliationStore\): ReconciliationRequestPort => \(\{ requestRun: \(input\) => store\.requestRun\(input\) \}\);/);
    expect(codeOf("modules/ingestion/application/reconciliation-ports.ts")).toMatch(/export type ReconciliationRequestPort = Pick<ReconciliationStore, "requestRun">;/);
    expect(codeOf("server/pipeline/unit-of-work.ts")).toMatch(/readonly reconciliation: ReconciliationRequestPort;/);
  });
});

describe("H6-C4: the web holds no other reconciliation primitive", () => {
  it("pages and UI import no persistence, database, outbox, job or ingestion module at all", () => {
    for (const file of sourceFiles(["app", "ui"])) {
      for (const specifier of importsOf(file)) expect(specifier, file).not.toMatch(/^@\/(modules|platform\/(db|outbox|jobs)|jobs|integrations|mutations|ai)\b/);
      expect(codeOf(file), file).not.toMatch(/reconciliation_runs|request_reconciliation|reconcile_account|system\.outbox|audit_events/);
    }
  });

  it("no web-reachable module names the planner topic, the worker adapter, the job scope or a raw reconciliation table", () => {
    for (const file of WEB) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(/RECONCILE_ACCOUNT_TOPIC|RECONCILE_SLICE_TOPIC|"ingestion\.reconcile_(account|slice)"|\brequestReconciliation\(|reconciliationScope|planReconciliation|runReconciliationSlice/);
      expect(code, file).not.toMatch(/insert into ingestion\.|reconciliationRuns|reconciliationSlices|ingestion\.request_reconciliation\(/);
    }
    // Only the web unit of work composes the store, for its request port.
    expect(WEB.filter((file) => /createPostgresReconciliationStore/.test(codeOf(file)))).toEqual([UOW]);
  });

  it("exactly one command is audited by a database boundary — this one — and its actions are command-bound elsewhere", () => {
    const declarations = sourceFiles(["server"]).filter((file) => /auditedBy:/.test(codeOf(file)));
    expect(declarations).toEqual([COMMAND]);
    expect(codeOf(COMMAND)).toMatch(/auditedBy: RECONCILIATION_REQUEST_AUDIT,/);
    expect(COMMAND_BOUND_ELSEWHERE as readonly string[]).toContain("connected_account.reconciliation_requested");
    // The pipeline appends nothing for it, and refuses (fails closed) if it ever drafts one.
    const pipeline = codeOf(PIPELINE);
    expect(pipeline).toMatch(/if \(command\.auditedBy !== undefined && audited !== undefined\) throw new Error\("boundary_audited_command_returned_a_draft"\);/);
    expect(pipeline).toMatch(/const drafts: readonly AuditDraft\[\] = audited === undefined \|\| command\.auditedBy !== undefined \? \[\] : \[audited\]\.flat\(\);/);
  });
});

describe("H6-C4: release order (Trigger before web)", () => {
  it("the producer's planner topic is a registered MAIN task at this source, and the paired release expects MAIN's full inventory", () => {
    const task = PRODUCTION_TASKS.get("ingestion.reconcile_account");
    expect(task?.executionPlane).toBe("main");
    expect(task?.scope).toBe("workspace");
    // The deployed MAIN (@332046e) has 6 tasks and no consumer for it; this source's paired release expects 8
    // (registry parity is execution-plane-guards' job): MAIN must report them before this web producer ships.
    // Step H6-F3 adds the two provider-event system tasks to MAIN (10); H6-F4 the signal consumer (11).
    expect(RELEASE_PLANES.find((plane) => plane.plane === "main")?.expectedTasks).toBe(11);
  });

  it("the design records the H6-C5 order: the paired Trigger release first, verified, then the web deployment of this source", () => {
    const design = readFileSync(path.join(REPOSITORY_ROOT, "design/h6-ingestion/README.md"), "utf8");
    const c4 = design.slice(design.indexOf("## H6-C4"));
    expect(c4).toMatch(/Release order \(H6-C5\)/);
    expect(c4).toMatch(/paired Trigger\s+release FIRST/);
    expect(c4).toMatch(/never\s+the\s+web\s+producer\s+first/);
  });
});
