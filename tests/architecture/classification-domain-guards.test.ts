/**
 * Step H7-A1 — static guards around the pure classification domain (H7-A0; D-H7-1 … D-H7-6):
 *   - the domain is pure: imports only the shared kernel and its own files; no DB, server, jobs, Next, Trigger, provider,
 *     Meta, model SDK, network, environment or Node built-in;
 *   - no model/provider credential, AI dependency, task or outbox topic was introduced (H7-A2 adds only migration 0024);
 *   - watch terms can't become meaning: no semantic file imports the matcher or signals, no rule origin exists for them,
 *     and the AI input contract has no field for them;
 *   - the domain has no path to a platform mutation or moderation action.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { RULE_ESTABLISHES } from "@/modules/classification";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../support/source-scan";

const MODULE = "modules/classification";
const DOMAIN_FILES = sourceFiles([`${MODULE}/domain`]);
const MODULE_FILES = sourceFiles([MODULE]);
/** H7-B: the runtime service layer (no infrastructure) and the persistence adapter (the only DB code). */
const APPLICATION_FILES = sourceFiles([`${MODULE}/application`]);
/** H7-C: the task-A gateway binding (the only classification code that may name the AI gateway and the prompt). */
const AI_APPLICATION_FILES = APPLICATION_FILES.filter((file) => file.startsWith(`${MODULE}/application/ai/`));
const DETERMINISTIC_APPLICATION_FILES = APPLICATION_FILES.filter((file) => !AI_APPLICATION_FILES.includes(file));
const PURE_FILES = [...DOMAIN_FILES, ...DETERMINISTIC_APPLICATION_FILES, `${MODULE}/index.ts`];
const importsOf = (file: string): string[] => [...codeOf(file).matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");

describe("H7-A1: the classification domain is pure", () => {
  it("has exactly the domain files of the A1 scope; H7-B adds the deterministic service + persistence, H7-C the task-A gateway binding", () => {
    expect(DOMAIN_FILES.map((f) => path.basename(f))).toEqual([
      "assessment.ts",
      "confidence.ts",
      "human-correction.ts",
      "intelligence-routing.ts",
      "language.ts",
      "needs-review.ts",
      "precedence.ts",
      "protection.ts",
      "signals.ts",
      "taxonomy.ts",
      "text-segments.ts",
      "understanding-eligibility.ts",
      "understanding-input.ts",
      "understanding-outcome.ts",
      "understanding-output.ts",
      "value-inputs.ts",
      "versions.ts",
      "watch-terms.ts",
    ]);
    // H7-D1d: the MAIN dispatch / recovery, the INTELLIGENCE runner + its separate entry, and the intelligence writers.
    expect(MODULE_FILES.filter((f) => !f.startsWith(`${MODULE}/domain/`))).toEqual([
      `${MODULE}/application/ai/run-understanding.ts`,
      `${MODULE}/application/ai/understand-ai-contract.ts`,
      `${MODULE}/application/ai/understand-interaction.ts`,
      `${MODULE}/application/ai/understanding-output-schema.ts`,
      `${MODULE}/application/ai/understanding-task.ts`,
      `${MODULE}/application/intelligence-dispatch.ts`,
      `${MODULE}/application/ports.ts`,
      `${MODULE}/application/understand-deterministic.ts`,
      `${MODULE}/index.ts`,
      `${MODULE}/intelligence-runtime.ts`,
      `${MODULE}/persistence/index.ts`,
      `${MODULE}/persistence/intelligence-store.ts`,
      // Step 7A: the Inbox's read-only signal reader (kinds only; no spans, no assessment, no write).
      `${MODULE}/persistence/signal-reader.ts`,
      `${MODULE}/persistence/store.ts`,
    ]);
  });

  it("imports only the shared kernel (@/domain/*) and its own domain files", () => {
    for (const file of DOMAIN_FILES) {
      for (const specifier of importsOf(file)) expect(specifier, `${file} → ${specifier}`).toMatch(/^(\.\/[a-z-]+|@\/domain\/[a-z-]+)$/);
    }
    for (const specifier of importsOf(`${MODULE}/index.ts`)) expect(specifier).toMatch(/^\.\/(domain|application)\/[a-z-]+$/);
    // H7-D1d: the INTELLIGENCE entry re-exports the gateway binding only (never the persistence).
    for (const specifier of importsOf(`${MODULE}/intelligence-runtime.ts`)) expect(specifier).toMatch(/^\.\/application\/ai\/[a-z-]+$/);
    for (const file of DETERMINISTIC_APPLICATION_FILES) {
      for (const specifier of importsOf(file)) expect(specifier, `${file} → ${specifier}`).toMatch(/^(\.\/[a-z-]+|\.\.\/domain\/[a-z-]+|@\/modules\/interactions)$/);
    }
    // H7-C: the gateway binding sees its own files, the pure domain, the gateway PORT and the versioned prompt only
    // (H7-D0k: prompt v2). H7-D1b: the runtime contract also uses the shared kernel's id / correlation parsers.
    for (const file of AI_APPLICATION_FILES) {
      // H7-D1d: the runner also reaches the MAIN dispatch's route decision, the ports and the shared kernel's instants.
      for (const specifier of importsOf(file)) expect(specifier, `${file} → ${specifier}`).toMatch(/^(\.\/[a-z-]+|\.\.\/\.\.\/domain\/[a-z-]+|\.\.\/(intelligence-dispatch|ports)|@\/ai\/gateway|@\/prompts\/classification\/understanding\.v2|@\/domain\/(ids|correlation|instant))$/);
    }
  });

  it("names no infrastructure, provider, model SDK, network or environment access (domain + application)", () => {
    const forbidden = /@\/(platform|server|jobs|db|integrations|ai|mutations|app|ui)\b|from ["'](next|@trigger\.dev|pg|postgres|drizzle-orm|openai|@anthropic-ai|node:)|process\.env|\bfetch\(|XMLHttpRequest|WebSocket|require\(|\bimport\(|graph\.facebook|instagram\.com|ANTHROPIC|OPENAI|API_KEY/;
    for (const file of PURE_FILES) expect(codeOf(file), file).not.toMatch(forbidden);
    for (const file of AI_APPLICATION_FILES) expect(codeOf(file), file).not.toMatch(/@\/(platform|server|jobs|db|integrations|mutations|app|ui)\b|@\/ai\/providers|from ["'](next|@trigger\.dev|pg|postgres|drizzle-orm|openai|@anthropic-ai|node:)|process\.env|\bfetch\(|ANTHROPIC|OPENAI|API_KEY/);
    // The persistence adapter is the only DB code: drizzle + platform/db, nothing else.
    for (const file of sourceFiles([`${MODULE}/persistence`])) {
      // H7-D1d: the intelligence writers also append the outbox row (platform/db), report it (platform/outbox type),
      // and read the domain identity / assessment shapes.
      for (const specifier of importsOf(file)) expect(specifier, `${file} → ${specifier}`).toMatch(/^(drizzle-orm|@\/platform\/(db|outbox)|@\/domain\/instant|\.\/[a-z-]+|\.\.\/(application|domain)\/[a-z-]+)$/);
    }
  });

  it("has no path to a platform mutation or moderation action", () => {
    for (const file of MODULE_FILES) expect(codeOf(file), file).not.toMatch(/mutations\/|MutationRequest|hideComment|deleteComment|blockAuthor|moderation\/|executor/i);
  });
});

describe("H7-A1: nothing outside the pure scope was introduced", () => {
  it("adds no AI/model dependency", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    // H7-D0 added exactly the two official provider SDKs (used only by ai/providers adapters); nothing else.
    expect(names.filter((name) => /anthropic|openai|langchain|@ai-sdk|^ai$|cohere|mistral|gemini|@google\/generative|ollama|huggingface|franc|cld|langdetect/i.test(name)).sort()).toEqual(["@anthropic-ai/sdk", "openai"]);
  });

  it("the only migrations after 0023 are H7-A2's classification persistence (0024), H7-D1c's intelligence persistence (0025), H7-D1e2b's provider-call intents (0026), 7B-1's mutation intents (0027), 7B-14F1's validation authorizations (0028) and 7B-14I2's operator path (0029)", () => {
    const migrations = readdirSync(path.join(REPOSITORY_ROOT, "db/migrations")).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
    expect(migrations.filter((name) => name > "0023")).toEqual(["0023_resumable_signal_progress.sql", "0024_classification_persistence.sql", "0025_intelligence_persistence.sql", "0026_ai_call_intents.sql", "0027_mutation_intents.sql", "0028_mutation_validation_authorizations.sql", "0029_validation_operator_path.sql"]);
  });

  it("registers exactly one classification task (H7-D1d, intelligence plane); `ai/` is unchanged and reached only by the INTELLIGENCE composition; the module is used by the two planes' compositions only", () => {
    expect(PRODUCTION_TASKS.tasks.filter((task) => /^(classification|intelligence|ai)\./.test(task.name)).map((task) => [task.name, task.executionPlane])).toEqual([["classification.understand_ai", "intelligence"]]);
    expect(sourceFiles(["ai"])).toEqual(["ai/gateway/attempt.ts", "ai/gateway/failures.ts", "ai/gateway/gateway.ts", "ai/gateway/index.ts", "ai/gateway/provider-port.ts", "ai/gateway/registry.ts", "ai/gateway/task.ts",
      "ai/providers/anthropic/index.ts", "ai/providers/anthropic/qualified.ts", "ai/providers/anthropic/runtime-client.ts", "ai/providers/anthropic/schema-projection.ts", "ai/providers/diagnostics.ts", "ai/providers/openai/index.ts", "ai/providers/simulator/index.ts"]);
    expect(sourceFiles(["app", "ui", "server", "jobs", "platform", "integrations", "mutations", "db"]).filter((file) => /@\/ai\/|@\/prompts\/|application\/ai\//.test(codeOf(file)))).toEqual(["jobs/intelligence.ts"]);
    // Step 7A adds the Inbox read side: the pipeline's read-source type, its Postgres composition and the two read queries
    // (signal KINDS only, through the module's read port; no assessment, protection or write reaches the web).
    expect(sourceFiles(["app", "ui", "server", "jobs", "platform", "integrations", "mutations"]).filter((file) => /@\/modules\/classification/.test(codeOf(file)))).toEqual([
      "jobs/intelligence-policy.ts", "jobs/intelligence.ts", "jobs/reconciliation.ts", "server/persistence/classification.ts", "server/persistence/inbox.ts", "server/pipeline/unit-of-work.ts", "server/queries/inbox.ts",
    ]);
  });
});

describe("H7-A1: watch terms can never become meaning (D-H7-3, S19)", () => {
  const SEMANTIC = ["assessment.ts", "precedence.ts", "protection.ts", "needs-review.ts", "value-inputs.ts", "understanding-input.ts", "understanding-output.ts", "human-correction.ts", "taxonomy.ts"];

  it("H7-D1d: pre-model eligibility uses the deterministic text detectors only — never the watch-term matcher", () => {
    expect(importsOf(`${MODULE}/domain/understanding-eligibility.ts`).filter((s) => /watch-terms/.test(s))).toEqual([]);
    for (const file of [`${MODULE}/domain/understanding-eligibility.ts`, `${MODULE}/application/intelligence-dispatch.ts`, `${MODULE}/application/ai/run-understanding.ts`]) {
      expect(codeOf(file).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ""), file).not.toMatch(/watch|matchWatchTerms|WatchTerm/i);
    }
  });

  it("no semantic file imports the matcher or the signals", () => {
    for (const name of SEMANTIC) {
      for (const specifier of importsOf(`${MODULE}/domain/${name}`)) expect(specifier, `${name} → ${specifier}`).not.toMatch(/watch-terms|signals/);
    }
  });

  it("the only rule origin is the narrow malicious-link fact; there is no watch-term rule", () => {
    expect(Object.keys(RULE_ESTABLISHES)).toEqual(["link_reputation_malicious"]);
    expect(codeOf(`${MODULE}/domain/assessment.ts`)).not.toMatch(/watch/i);
  });

  it("the AI input and output contracts have no field for watch terms, authors or credentials", () => {
    for (const name of ["understanding-input.ts", "understanding-output.ts"]) {
      expect(codeOf(`${MODULE}/domain/${name}`), name).not.toMatch(/watch|author|handle|profile|username|token|credential|rawBody|webhook/i);
    }
  });

  it("the value inputs read no sentiment, watch term or author attribute", () => {
    expect(codeOf(`${MODULE}/domain/value-inputs.ts`)).not.toMatch(/sentiment|watch|author|follower|influence|score|weight/i);
  });
});
