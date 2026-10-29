/**
 * Step H7-A1 — static guards around the pure classification domain (H7-A0; D-H7-1 … D-H7-6):
 *   - the domain is pure: imports only the shared kernel and its own files; no DB, server, jobs, Next, Trigger, provider,
 *     Meta, model SDK, network, environment or Node built-in;
 *   - no model/provider credential, AI dependency, migration 0024, task or outbox topic was introduced;
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
const importsOf = (file: string): string[] => [...codeOf(file).matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");

describe("H7-A1: the classification domain is pure", () => {
  it("has exactly the domain files of the A1 scope, and the module has no application, persistence or task layer yet", () => {
    expect(DOMAIN_FILES.map((f) => path.basename(f))).toEqual([
      "assessment.ts",
      "confidence.ts",
      "human-correction.ts",
      "language.ts",
      "needs-review.ts",
      "precedence.ts",
      "protection.ts",
      "signals.ts",
      "taxonomy.ts",
      "text-segments.ts",
      "understanding-input.ts",
      "understanding-output.ts",
      "value-inputs.ts",
      "versions.ts",
      "watch-terms.ts",
    ]);
    expect(MODULE_FILES.filter((f) => !f.startsWith(`${MODULE}/domain/`))).toEqual([`${MODULE}/index.ts`]);
  });

  it("imports only the shared kernel (@/domain/*) and its own domain files", () => {
    for (const file of DOMAIN_FILES) {
      for (const specifier of importsOf(file)) expect(specifier, `${file} → ${specifier}`).toMatch(/^(\.\/[a-z-]+|@\/domain\/[a-z-]+)$/);
    }
    for (const specifier of importsOf(`${MODULE}/index.ts`)) expect(specifier).toMatch(/^\.\/domain\/[a-z-]+$/);
  });

  it("names no infrastructure, provider, model SDK, network or environment access", () => {
    const forbidden = /@\/(platform|server|jobs|db|integrations|ai|mutations|app|ui)\b|from ["'](next|@trigger\.dev|pg|postgres|drizzle-orm|openai|@anthropic-ai|node:)|process\.env|\bfetch\(|XMLHttpRequest|WebSocket|require\(|\bimport\(|graph\.facebook|instagram\.com|ANTHROPIC|OPENAI|API_KEY/;
    for (const file of MODULE_FILES) expect(codeOf(file), file).not.toMatch(forbidden);
  });

  it("has no path to a platform mutation or moderation action", () => {
    for (const file of MODULE_FILES) expect(codeOf(file), file).not.toMatch(/mutations\/|MutationRequest|hideComment|deleteComment|blockAuthor|moderation\/|executor/i);
  });
});

describe("H7-A1: nothing outside the pure scope was introduced", () => {
  it("adds no AI/model dependency", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(names.filter((name) => /anthropic|openai|langchain|@ai-sdk|^ai$|cohere|mistral|gemini|@google\/generative|ollama|huggingface|franc|cld|langdetect/i.test(name))).toEqual([]);
  });

  it("creates no migration after 0023", () => {
    const migrations = readdirSync(path.join(REPOSITORY_ROOT, "db/migrations")).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
    expect(migrations.at(-1)).toMatch(/^0023_/);
  });

  it("registers no classification / intelligence task and no `ai/` layer", () => {
    expect(PRODUCTION_TASKS.tasks.map((task) => task.name).filter((name) => /^(classification|intelligence|ai)\./.test(name))).toEqual([]);
    expect(sourceFiles(["ai"])).toEqual([]);
    expect(sourceFiles(["app", "ui", "server", "jobs", "platform", "integrations", "mutations"]).filter((file) => /@\/modules\/classification/.test(codeOf(file)))).toEqual([]);
  });
});

describe("H7-A1: watch terms can never become meaning (D-H7-3, S19)", () => {
  const SEMANTIC = ["assessment.ts", "precedence.ts", "protection.ts", "needs-review.ts", "value-inputs.ts", "understanding-input.ts", "understanding-output.ts", "human-correction.ts", "taxonomy.ts"];

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
