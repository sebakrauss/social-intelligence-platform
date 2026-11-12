/**
 * Step H7-B — static guards around the deterministic classification runtime:
 *   - EVENT CONTRACT: classification analyzes the immutable source text version an `interactions.observed` event NAMES
 *     (established in the ingestion transaction, verified against the persisted event) — never the current pointer;
 *   - MAIN only: the only runtime caller is the `interactions.observed` consumer; no web, integration or provider path;
 *   - deterministic only: no assessment, no watch-term evaluation, no reputation, no "understood" event, no new task or
 *     topic, no migration after 0024.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../support/source-scan";

const PRODUCTION = ["app", "ui", "server", "domain", "modules", "platform", "integrations", "jobs", "db", "tools", "mutations"];
// The DETERMINISTIC runtime (H7-B). The H7-C task-A gateway binding (application/ai) is guarded in ai-gateway-guards.
/** The DETERMINISTIC stage (H7-B). H7-D1d's intelligence runtime has its own guards (intelligence-boundary-guards). */
const RUNTIME = ["modules/classification/application/understand-deterministic.ts", "modules/classification/persistence/store.ts"];
/** H7-D1d: the code (not comments) that names the intelligence topic — its routing contract, the registry, the task file and its composition (a log field). */
const USERS_OF_UNDERSTAND_AI = ["jobs/intelligence.ts", "jobs/registry.ts", "jobs/trigger/intelligence/classification.ts", "modules/classification/domain/intelligence-routing.ts"];
const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
const users = (pattern: RegExp) => sourceFiles(PRODUCTION).filter((file) => pattern.test(strip(codeOf(file))));

describe("H7-B: the event contract classification relies on (immutable text version)", () => {
  it("ingestion names the version it ESTABLISHED in the same transaction, only for created / text_changed", () => {
    const ingest = strip(codeOf("modules/ingestion/application/ingest-interaction.ts"));
    expect(ingest).toMatch(/sourceTextVersionId: change === "created" \|\| change === "text_changed" \? textVersionId : null,/);
    expect(strip(codeOf("modules/ingestion/domain/events.ts"))).toMatch(/if \(record\.sourceTextVersionId !== null\) subjectIds\["source_text_version_id"\] = record\.sourceTextVersionId;/);
    expect(PRODUCTION_TASKS.tenant("interactions.observed")?.subjects).toContain("source_text_version_id");
  });

  it("the consumer verifies the payload's version against the persisted event, then analyzes exactly that id", () => {
    const job = strip(codeOf("jobs/reconciliation.ts"));
    expect(job).toMatch(/const sourceTextVersionId = subjects\["source_text_version_id"\] \?\? null;/);
    expect(job).toMatch(/acceptObservedInteraction\(ingestionStores\(context\), \{\s+eventId,\s+interactionId,\s+conversationId: subjects\["conversation_id"\] \?\? null,\s+sourceTextVersionId,\s+\}\);/);
    expect(job).toMatch(/if \(\(outcome\.change !== "created" && outcome\.change !== "text_changed"\) \|\| sourceTextVersionId === null\) return \{ \.\.\.outcome, classification: null, intelligence: null, recovery: await recover\(\) \};/);
    expect(job).toMatch(/understandDeterministically\(classificationScope\(context\), clock, \{ interactionId, sourceTextVersionId, arrival: outcome\.arrival as Arrival \}\)/);
    expect(strip(codeOf("modules/ingestion/application/reconciliation.ts"))).toMatch(/event\.sourceTextVersionId !== input\.sourceTextVersionId\) \{\s+return \{ kind: "rejected", reason: "observed_event_mismatch" \};/);
  });

  it("no classification runtime code reads the mutable current-text pointer; the reader joins version AND interaction", () => {
    for (const file of [...sourceFiles(RUNTIME), "jobs/reconciliation.ts"]) expect(strip(codeOf(file)), file).not.toMatch(/currentSourceTextVersionId|current_source_text_version_id/);
    const store = strip(codeOf("modules/interactions/persistence/store.ts"));
    const reader = store.slice(store.indexOf("export function createPostgresInteractionTextReader"));
    const analysisText = reader.slice(0, reader.indexOf("async understandingContext("));
    expect(analysisText).toMatch(/\.where\(and\(eq\(sourceTextVersions\.id, sourceTextVersionId\), eq\(sourceTextVersions\.interactionId, interactionId\)\)\)/);
    expect(analysisText).not.toMatch(/currentSourceTextVersionId|current_source_text_version_id|insert|update|delete/);
    // H7-D1d: the understanding context also targets the version by id AND interaction; it reads the current pointer only
    // to REPORT it (supersession is refused by the eligibility check, never followed) and for the context items' text.
    const context = reader.slice(reader.indexOf("async understandingContext("));
    expect(context).toMatch(/where v\.id = \$\{sourceTextVersionId\}::uuid and v\.interaction_id = \$\{interactionId\}::uuid/);
    expect(context).not.toMatch(/\binsert\b|\bupdate\b|\bdelete\b/i);
    expect(strip(codeOf("modules/classification/domain/understanding-eligibility.ts"))).toMatch(/if \(candidate\.currentSourceTextVersionId !== candidate\.sourceTextVersionId\) return \{ ok: false, reason: "version_superseded" \};/);
  });
});

describe("H7-B: MAIN only, no new task or topic", () => {
  it("the only runtime caller is the MAIN `interactions.observed` consumer", () => {
    expect(users(/understandDeterministically\(/).sort()).toEqual(["jobs/reconciliation.ts", "modules/classification/application/understand-deterministic.ts"]);
    expect(users(/classificationScope\(/).sort()).toEqual(["jobs/reconciliation.ts", "server/persistence/classification.ts"]);
    expect(PRODUCTION_TASKS.tenant("interactions.observed")?.executionPlane).toBe("main");
    expect(strip(codeOf("jobs/trigger/main/ingestion.ts"))).toMatch(/runInteractionsObserved/);
    for (const file of sourceFiles(["jobs/trigger/integration", "app", "ui", "integrations"])) expect(strip(codeOf(file)), file).not.toMatch(/classification|jobs\/reconciliation"/);
  });

  it("task topology: MAIN 11 unchanged; the ONE classification task is H7-D1d's intelligence task; no `understood` event", () => {
    const planes = PRODUCTION_TASKS.tasks.reduce<Record<string, number>>((acc, task) => ({ ...acc, [task.executionPlane]: (acc[task.executionPlane] ?? 0) + 1 }), {});
    expect(planes["main"]).toBe(11);
    expect(PRODUCTION_TASKS.tasks.filter((task) => task.name.startsWith("classification.")).map((task) => [task.name, task.executionPlane])).toEqual([["classification.understand_ai", "intelligence"]]);
    expect(users(/classification\.understood|classification\.understand["`]/)).toEqual([]);
    // H7-D1d: the intelligence topic is named by its routing contract, the registry and the intelligence task file only.
    expect(users(/classification\.understand_ai/).sort()).toEqual(USERS_OF_UNDERSTAND_AI);
  });

  it("no classification migration after 0026 (H7-D1c: intelligence persistence; H7-D1e2b: provider-call intents); 0027 is Step 7B-1's, 0028 Step 7B-14F1's, 0029 Step 7B-14I2's", () => {
    const migrations = readdirSync(path.join(REPOSITORY_ROOT, "db/migrations")).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
    expect(migrations.at(-1)).toBe("0029_validation_operator_path.sql");
    expect(codeOf("db/migrations/0029_validation_operator_path.sql").replace(/--[^\n]*/g, " ")).not.toMatch(/classification\./);
    expect(codeOf("db/migrations/0027_mutation_intents.sql").replace(/--[^\n]*/g, " ")).not.toMatch(/classification\./);
    expect(codeOf("db/migrations/0028_mutation_validation_authorizations.sql").replace(/--[^\n]*/g, " ")).not.toMatch(/classification\./);
  });
});

describe("H7-B: deterministic only", () => {
  it("writes only requests and signals: never an assessment, a watch term, a canonical row or an outbox row", () => {
    for (const file of sourceFiles(RUNTIME)) {
      const code = strip(codeOf(file)).toLowerCase();
      // No watch-term TABLE is read and no watch-term match is produced (the signals key's null watch-term columns are fine).
      expect(code, file).not.toMatch(/classification\.assessments|classification\.watch_term|watch_term_match|insert into (interactions|content|conversations|coverage|ingestion|system)\.|update (interactions|content|conversations|system)\./);
      expect(code, file).not.toMatch(/outbox|noteoutbox/);
    }
    expect(strip(codeOf("modules/classification/persistence/store.ts"))).toMatch(/insert into classification\.understanding_requests/);
    expect(strip(codeOf("modules/classification/persistence/store.ts"))).toMatch(/insert into classification\.signals/);
  });

  it("produces only the four text/author facts — no watch-term match, no reputation, no semantic value", () => {
    const service = strip(codeOf("modules/classification/application/understand-deterministic.ts"));
    expect(service).toMatch(/const facts: Signal\[\] = \[\.\.\.detectTextSignals\(target\.sourceText\)\];/);
    expect(service).toMatch(/const ownBrand = ownBrandSignal\(target\.authorRole\);/);
    expect(service).not.toMatch(/matchWatchTerms|compileWatchTerms|malicious_link|link_reputation|createAssessment|acceptInterpretation|evaluateProtection|deriveNeedsReview|deriveValueInputs|toAiAssessments/);
    expect(strip(codeOf("modules/classification/application/ports.ts"))).toMatch(/readonly kind: "link_present" \| "text_empty" \| "text_emoji_only" \| "author_own_brand";/);
  });

  it("no provider, model, network or credential reaches the runtime; logs carry no text", () => {
    for (const file of [...sourceFiles(RUNTIME), "jobs/reconciliation.ts"]) {
      const code = strip(codeOf(file));
      expect(code, file).not.toMatch(/@\/integrations|@\/ai\b|openai|anthropic|\bfetch\(|withCredential|jobs\/connections|process\.env/);
    }
    const job = strip(codeOf("jobs/reconciliation.ts"));
    for (const call of job.matchAll(/log\.(info|warn)\(([^;]*)\);/g)) expect(call[2], call[0]).not.toMatch(/sourceText|text\b|spans/);
  });

  it("the deterministic pipeline is an explicit, namespaced version", () => {
    expect(strip(codeOf("modules/classification/application/understand-deterministic.ts"))).toMatch(/export const DETERMINISTIC_PIPELINE_VERSION = "classification\.deterministic\.v1" as const;/);
  });
});
