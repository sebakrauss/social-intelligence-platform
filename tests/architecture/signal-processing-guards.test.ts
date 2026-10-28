/**
 * Step H6-F4 — static guards around webhook-signal processing (design H6-F0 §9–§15; D-F3, D-F5):
 *   - `ingestion.process_signals` is DB planning only: no provider, credential, raw body or inbox read;
 *   - no TypeScript code produces its topic (the 0022 system definers are the only producers);
 *   - a run closes in exactly one place, which always runs the close hook in the same transaction;
 *   - signal attribution (`sig.`), the relist plan and `webhook_relist` provenance have exactly one origin each;
 *   - a signal never writes a removal basis, coverage, a watermark, a conversation or canonical text itself.
 * Step H6-F4d (0023 in runtime):
 *   - a parked cursor is adopted or retired only by the one traversal helper, which both planners use; a sequence-0
 *     interactions slice has no other creator; cursors never reach an outbox payload or a job file;
 *   - confirm marks never enter the account/relist review, the relist planner or the run close hook;
 *   - confirm-mark files are provider-free and decide nothing from the outbox; claims, read starts and completion go
 *     only through the 0023 definers (read_started_at round-trips as text); global expiry only through the system
 *     definer, from the MAIN purge task, before the inbox purge; no migration after 0023.
 */
import { readdirSync } from "node:fs";
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
  "modules/ingestion/application/confirm-marks.ts",
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
    // H6-F4d: both planners create interactions traversals through the ONE helper (continuation adoption included).
    expect(planner).toMatch(/await insertContentTraversal\(scope, clock, \{ run, contentItemId: content\.id, startedAt, base: startedAt, order: created \}\);/);
    const traversal = strip(codeOf("modules/ingestion/application/traversal.ts"));
    expect(traversal).toMatch(/unit: "content_interactions" as const/);
    expect(traversal).not.toMatch(/content_listing/);
  });

  it("a signal writes no removal basis, coverage, watermark, conversation or text — only marks and requests", () => {
    for (const file of SIGNAL_FILES) {
      const code = strip(codeOf(file));
      expect(code, file).not.toMatch(/explicit_provider_signal|direct_fetch_confirmed|removed_at_source|removalBasis|recordSlice|coverage\.record|recordCompleteTraversal|recordTraversalFailure|conversations\.|ingestInteractionFact|source_text|insertPlaceholder/);
    }
    // The mark store writes only the six columns 0022 grants the worker UPDATE on.
    const store = strip(codeOf("modules/ingestion/persistence/signal-store.ts"));
    // Every SET clause (multi-line ones included, up to its WHERE) names granted columns only.
    const updated = [...store.matchAll(/update ingestion\.signal_marks\s+set ([\s\S]*?)\swhere\s/g)].flatMap((m) => [...(m[1] ?? "").matchAll(/(?:^|,)\s*([a-z_]+)\s*=(?!=)/g)].map((c) => c[1]));
    expect(updated.length).toBeGreaterThan(5);
    const upserted = [...store.matchAll(/^\s+(?:set )?(\w+) = (?:greatest|least)\(ingestion\.signal_marks\./gm)].map((m) => m[1]);
    for (const column of [...updated, ...upserted]) expect(["last_signal_at", "signal_count", "deferred_until", "requested_run_id", "expires_at", "updated_at"], column).toContain(column);
    expect(updated).not.toContain("first_signal_at");
    expect(updated).not.toContain("dispatch_generation");
    expect(updated).not.toContain("read_started_at");
    expect(updated).not.toContain("confirmed_through_at");
    // The claim counter and the confirmation times move only through the 0023 definers.
    expect(store).toMatch(/from ingestion\.claim_signal_confirmation\(/);
    expect(store).toMatch(/from ingestion\.begin_signal_confirmation_read\(/);
    expect(store).toMatch(/from ingestion\.complete_signal_confirmation_read\(\$\{connectedAccountId\}::uuid, \$\{interactionId\}::uuid, \$\{startedAt\}::timestamptz\)/);
  });
});

describe("H6-F4d: cross-run continuation", () => {
  const users = (pattern: RegExp) => sourceFiles(PRODUCTION).filter((file) => pattern.test(strip(codeOf(file))) && !file.endsWith("/index.ts")).sort();

  it("a parked cursor is adopted or retired only by the traversal helper, which both planners call", () => {
    expect(users(/\.parkedContinuation\(/)).toEqual(["modules/ingestion/application/traversal.ts"]);
    expect(users(/\.retireParkedCursor\(/)).toEqual(["modules/ingestion/application/traversal.ts"]);
    expect(users(/insertContentTraversal\(/)).toEqual(["modules/ingestion/application/reconciliation.ts", "modules/ingestion/application/signal-marks.ts", "modules/ingestion/application/traversal.ts"]);
    expect(strip(codeOf("modules/ingestion/application/reconciliation.ts"))).toMatch(/await insertContentTraversal\(scope, clock, \{ run, contentItemId, startedAt: run\.startedAt \?\? now, base: now, order: created \}\);/);
  });

  it("an adopted continuation keeps its ORIGINAL window; reconciliation creates only listings and in-run continuations", () => {
    const traversal = strip(codeOf("modules/ingestion/application/traversal.ts"));
    expect(traversal).toMatch(/cursor: parked\.cursor,\s+cursorIssuedAt: parked\.cursorIssuedAt,\s+windowStart: parked\.windowStart,\s+windowEnd: parked\.windowEnd,/);
    expect(traversal).toMatch(/if \(parked\.locallyEligible && !superseded\)/);
    const code = strip(codeOf("modules/ingestion/application/reconciliation.ts"));
    const creations = [...code.matchAll(/scope\.reconciliation\.insertSlice\(\{([\s\S]*?)\}\);/g)].map((m) => m[1] ?? "");
    expect(creations).toHaveLength(2);
    expect(creations[0]).toMatch(/unit: "content_listing"/);
    expect(creations[1]).toMatch(/unit: "content_interactions",[\s\S]*sequence: slice\.sequence \+ 1,[\s\S]*windowStart: slice\.windowStart,\s+windowEnd: slice\.windowEnd,/);
  });

  it("parking is only a budget abandonment of an interactions slice; the local TTL is the one 90-minute constant", () => {
    const code = strip(codeOf("modules/ingestion/application/reconciliation.ts"));
    expect(code).toMatch(/slice\.sequence === 0 && slice\.cursor !== null \? RECONCILIATION_RUNTIME\.parkedCursorLocalTtlMs : SLICE_CURSOR_MAX_AGE_MS/);
    const store = strip(codeOf("modules/ingestion/persistence/reconciliation-store.ts"));
    expect(store).toMatch(/s\.cursor_parked_at >= pg_catalog\.statement_timestamp\(\) - \$\{RECONCILIATION_RUNTIME\.parkedCursorLocalTtlMs\} \* interval '1 millisecond'/);
    // cursor_parked_at is stamped by the 0023 trigger (DB time) — TypeScript never writes it.
    expect(store).not.toMatch(/cursor_parked_at\s*=/);
    expect(users(/parkedCursorLocalTtlMs/)).toEqual(["modules/ingestion/application/reconciliation.ts", "modules/ingestion/domain/reconciliation-state.ts", "modules/ingestion/persistence/reconciliation-store.ts"]);
  });

  it("a cursor never reaches an outbox payload or a job file", () => {
    const store = strip(codeOf("modules/ingestion/persistence/reconciliation-store.ts"));
    for (const m of store.matchAll(/subjectIds: \{([^}]*)\}/g)) expect(m[1]).not.toMatch(/cursor/i);
    for (const file of ["jobs/reconciliation.ts", "jobs/reconciliation-slice.ts", "jobs/process-signals.ts", "jobs/provider-events.ts", "jobs/confirm-interaction.ts"]) {
      expect(strip(codeOf(file)), file).not.toMatch(/cursor/i);
    }
  });
});

describe("H6-F4d: confirm marks", () => {
  it("confirm marks never enter the account/relist review, the relist planner or the close hook", () => {
    expect(strip(codeOf("modules/ingestion/application/signal-marks.ts"))).not.toMatch(/confirm/i);
    const store = strip(codeOf("modules/ingestion/persistence/signal-store.ts"));
    // The summary count and deferAll are restricted to the two traversal kinds; relist queries name 'relist'.
    expect([...store.matchAll(/kind in \('account', 'relist'\)/g)]).toHaveLength(2);
    expect(store).not.toMatch(/kind in \([^)]*'confirm'/);
  });

  it("claim → H6-E request in the same scope; the dispatch key is per mark lifetime and generation", () => {
    const code = strip(codeOf("modules/ingestion/application/confirm-marks.ts"));
    expect(code).toMatch(/const claim = await scope\.signals\.claimConfirmation\(account\.id, interactionId\);/);
    expect(code).toMatch(/dispatchKey: signalConfirmationDispatchKey\(claim\.markId, claim\.generation\),/);
    expect(code).not.toMatch(/outbox|platform\.|select |sql`/i);
    const users = sourceFiles(PRODUCTION).filter((file) => /signalConfirmationDispatchKey\(/.test(strip(codeOf(file))) && !file.endsWith("/index.ts")).sort();
    expect(users).toEqual(["modules/ingestion/application/confirm-marks.ts", "modules/ingestion/domain/signals.ts"]);
  });

  it("only an authoritative success completes; read_started_at round-trips losslessly as text", () => {
    const code = strip(codeOf("modules/ingestion/application/confirm-interaction.ts"));
    expect(code).toMatch(/completesConfirmation\(/);
    expect([...code.matchAll(/\.completeConfirmationRead\(/g)]).toHaveLength(1);
    expect(strip(codeOf("modules/ingestion/domain/confirmation.ts"))).toMatch(/CONFIRMATION_COMPLETING_OUTCOMES = \["FOUND", "AUTHORITATIVE_NOT_FOUND"\] as const/);
    const store = strip(codeOf("modules/ingestion/persistence/signal-store.ts"));
    expect(store).toMatch(/select outcome, started_at::text as started_at from ingestion\.begin_signal_confirmation_read\(/);
    expect(strip(codeOf("modules/ingestion/application/reconciliation-ports.ts"))).toMatch(/completeConfirmationRead\(connectedAccountId: string, interactionId: string, startedAt: string\)/);
  });

  it("global expiry only through the system definer, from the MAIN purge task, before the inbox purge", () => {
    // The schema classification grants it to the system runtime only; the provider-events store is its one caller.
    const users = sourceFiles(PRODUCTION).filter((file) => /expire_signal_marks/.test(strip(codeOf(file)))).sort();
    expect(users).toEqual(["db/schema/classification.ts", "modules/ingestion/persistence/provider-events-store.ts"]);
    expect(strip(codeOf("db/schema/classification.ts"))).toMatch(/"system\.expire_signal_marks\(integer\)": \["app_system"\],/);
    const job = strip(codeOf("jobs/provider-events.ts"));
    expect(job).toMatch(/const marks = await expireSignalMarksSweep\(dependencies\(context\)\);\s+const summary = await purgeExpiredProviderEvents\(dependencies\(context\)\);/);
    expect(PRODUCTION_TASKS.tasks.find((task) => task.name === "ingestion.purge_provider_events")?.executionPlane).toBe("main");
  });

  it("no migration after 0023", () => {
    const migrations = readdirSync("db/migrations").filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
    expect(migrations.at(-1)).toMatch(/^0023_resumable_signal_progress\.sql$/);
  });
});
