/**
 * Step H6-F4 — static guards around webhook-signal processing (design H6-F0 §9–§15; D-F3, D-F5):
 *   - `ingestion.process_signals` is DB planning only: no provider, credential, raw body or inbox read;
 *   - no TypeScript code produces its topic (the 0022 system definers are the only producers);
 *   - a run closes in exactly one place, which always runs the close hook in the same transaction;
 *   - signal attribution (`sig.`), the relist plan and `webhook_relist` provenance have exactly one origin each;
 *   - a signal never writes a removal basis, coverage, a watermark, a conversation or canonical text itself.
 */
import { describe, expect, it } from "vitest";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { codeOf, sourceFiles } from "../support/source-scan";

const PRODUCTION = ["app", "ui", "server", "domain", "modules", "platform", "integrations", "jobs", "db", "tools"];
const SIGNAL_FILES = [
  "jobs/process-signals.ts",
  "modules/ingestion/application/process-signals.ts",
  "modules/ingestion/application/signal-marks.ts",
  "modules/ingestion/domain/signals.ts",
  "modules/ingestion/persistence/signal-store.ts",
];
const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
const importsOf = (file: string): string[] => [...codeOf(file).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");

describe("H6-F4: process_signals is DB planning only", () => {
  it("registered once, MAIN, workspace scope, lane 2, serial per account, the two 0022 subject shapes", () => {
    expect(PRODUCTION_TASKS.tenant("ingestion.process_signals")).toMatchObject({
      scope: "workspace", executionPlane: "main", lane: 2, concurrency: { by: "subject", subject: "connected_account_id" }, subjects: ["connected_account_id", "provider_event_hint_id"],
    });
    expect(strip(codeOf("jobs/trigger/main/ingestion.ts"))).toMatch(/defineTenantTask\(PRODUCTION_TASKS, "ingestion\.process_signals", \(context\) => runProcessSignals\(context, jobLogger\)\)/);
  });

  it("no signal file reaches a provider, a credential, a raw body or the receipt inbox", () => {
    for (const file of SIGNAL_FILES) {
      const code = strip(codeOf(file));
      expect(code, file).not.toMatch(/integrations\/providers\/(meta|tiktok|simulator)|withCredential|openCredential|credential-access|jobs\/connections|composeJobProviders|provider_event_inbox|rawBody|\bbody\b|getInteraction\(|listInteractions\(|listContent\(/);
      for (const specifier of importsOf(file)) expect(specifier, `${file} → ${specifier}`).not.toMatch(/^@\/(integrations|ai|mutations)\b|\/connections$/);
    }
  });

  it("the payload is validated as exactly one of the two 0022 shapes; the workspace is never a subject", () => {
    const code = strip(codeOf("jobs/process-signals.ts"));
    expect(code).toMatch(/const HINT_SUBJECTS = \["connected_account_id", "provider_event_hint_id"\] as const;/);
    expect(code).toMatch(/const DUE_SUBJECTS = \["connected_account_id"\] as const;/);
    expect(code).toMatch(/if \(\(!routed && !due\) \|\| connectedAccountId === undefined \|\| correlationId === undefined\) throw new NonRetryableJobError\("invalid_payload"\);/);
    expect([...code.matchAll(/subjects\["([a-z_]+)"\]/g)].map((m) => m[1]).sort()).toEqual(["connected_account_id", "provider_event_hint_id"]);
    expect(code).not.toMatch(/provider_content|provider_interaction|workspace_id|organization_id/);
  });

  it("no TypeScript code produces the internal topic: only the 0022 system definers write it", () => {
    const naming = sourceFiles(PRODUCTION).filter((file) => /ingestion\.process_signals/.test(strip(codeOf(file)))).sort();
    expect(naming).toEqual(["jobs/registry.ts", "jobs/trigger/main/ingestion.ts", "modules/ingestion/domain/signals.ts"]);
    expect(sourceFiles(PRODUCTION).filter((file) => /PROCESS_SIGNALS_TASK/.test(strip(codeOf(file))) && !file.endsWith("/index.ts")).sort()).toEqual(["modules/ingestion/domain/signals.ts"]);
  });
});

describe("H6-F4: runs, attribution and provenance", () => {
  it("a run closes in exactly one place, and that place always runs the close hook after a successful finish", () => {
    const code = strip(codeOf("modules/ingestion/application/reconciliation.ts"));
    expect([...code.matchAll(/scope\.reconciliation\.finishRun\(/g)]).toHaveLength(1);
    expect(code).toMatch(/if \(!\(await scope\.reconciliation\.finishRun\(run\.id, state, failureClass, now\)\)\) return;\s+await closeRunSignals\(scope, clock, run, state, now\);/);
    for (const file of sourceFiles(PRODUCTION).filter((f) => f !== "modules/ingestion/application/reconciliation.ts" && f !== "modules/ingestion/persistence/reconciliation-store.ts")) {
      expect(strip(codeOf(file)), file).not.toMatch(/\.finishRun\(/);
    }
  });

  it("signal attribution, the relist plan and signal budgets have one origin (the shared review)", () => {
    const users = (pattern: RegExp) => sourceFiles(PRODUCTION).filter((file) => pattern.test(strip(codeOf(file))) && !file.endsWith("/index.ts")).sort();
    expect(users(/signalRunCorrelation\b/)).toEqual(["modules/ingestion/application/signal-marks.ts", "modules/ingestion/domain/signals.ts"]);
    expect(users(/signalRunBudget\(/)).toEqual(["modules/ingestion/application/signal-marks.ts", "modules/ingestion/domain/signals.ts"]);
    expect(users(/plan: decision\.plan/)).toEqual(["modules/ingestion/application/signal-marks.ts"]);
    expect(users(/SIGNAL_RUN_CORRELATION_PREFIX/)).toEqual(["modules/ingestion/domain/signals.ts", "modules/ingestion/persistence/signal-store.ts"]);
  });

  it("webhook_relist provenance and realtime arrival exist only for relist runs; the planner of a relist lists no content", () => {
    const code = strip(codeOf("modules/ingestion/application/reconciliation.ts"));
    expect(code).toMatch(/mechanism: run\.plan === "relist" \? "webhook_relist" : "reconciliation",/);
    expect(code).toMatch(/arrival: \(run\.plan === "relist" \? relistArrival : reconciliationArrival\)\(/);
    const planner = strip(codeOf("modules/ingestion/application/signal-marks.ts"));
    expect(planner).not.toMatch(/content_listing/);
    expect(planner).toMatch(/const unit: SliceUnit = "content_interactions";/);
  });

  it("a signal writes no removal basis, coverage, watermark, conversation or text — only marks and requests", () => {
    for (const file of SIGNAL_FILES) {
      const code = strip(codeOf(file));
      expect(code, file).not.toMatch(/explicit_provider_signal|direct_fetch_confirmed|removed_at_source|removalBasis|recordSlice|coverage\.record|recordCompleteTraversal|recordTraversalFailure|conversations\.|ingestInteractionFact|source_text|insertPlaceholder/);
    }
    // The mark store writes only the six columns 0022 grants the worker UPDATE on.
    const store = strip(codeOf("modules/ingestion/persistence/signal-store.ts"));
    const updated = [...store.matchAll(/update ingestion\.signal_marks set ([^\n]+)/g)].flatMap((m) => [...(m[1] ?? "").matchAll(/(\w+) =/g)].map((c) => c[1]));
    const upserted = [...store.matchAll(/^\s+(?:set )?(\w+) = (?:greatest|least)\(ingestion\.signal_marks\./gm)].map((m) => m[1]);
    for (const column of [...updated, ...upserted]) expect(["last_signal_at", "signal_count", "deferred_until", "requested_run_id", "expires_at", "updated_at"], column).toContain(column);
    expect(store).not.toMatch(/first_signal_at =|dispatch_generation =|kind =\s*\$|content_item_id =\s*\$\{/);
  });
});
