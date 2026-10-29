/**
 * Step H7-C — static guards around the AI Gateway, the simulator and the task-A binding:
 *   - vendor-free: no model SDK, no vendor name outside provider adapters, no environment / credential reader;
 *   - the gateway is generic and isolated (no module, DB, Trigger, web, network or clock of its own);
 *   - the simulator is deterministic and offline, composed by tests only;
 *   - data minimization and the untrusted-text boundary are pinned; no chain-of-thought field exists;
 *   - nothing is wired to a runtime: no task, no plane, no Trigger config, no continuation from DETERMINISTIC_DONE, no
 *     migration after 0024.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { RELEASE_PLANES } from "@/tools/trigger/release-pair";
import { UNDERSTANDING_DATA_FIELDS } from "@/modules/classification/application/ai/understanding-task";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../support/source-scan";

const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
const importsOf = (file: string): string[] => [...codeOf(file).matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");
const GATEWAY = sourceFiles(["ai/gateway"]);
const SIMULATOR = sourceFiles(["ai/providers/simulator"]);
const BINDING = sourceFiles(["modules/classification/application/ai"]);
const PRODUCT = ["app", "ui", "server", "domain", "modules", "platform", "integrations", "jobs", "db", "mutations", "ai/gateway", "prompts"];
const RUNTIME = ["app", "ui", "server", "platform", "integrations", "jobs", "db", "mutations"];

describe("H7-C: vendor-free", () => {
  it("the only model SDKs are the two OFFICIAL ones (H7-D0), pinned exactly; no orchestration framework; imported only by their adapters (+ the adapters' contract test)", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(all).filter((name) => /anthropic|openai|langchain|@ai-sdk|^ai$|cohere|mistral|gemini|@google\/generative|ollama|huggingface|llamaindex/i.test(name)).sort()).toEqual(["@anthropic-ai/sdk", "openai"]);
    for (const name of ["@anthropic-ai/sdk", "openai"]) expect(all[name], name).toMatch(/^\d+\.\d+\.\d+$/);
    const importers = sourceFiles([...PRODUCT, "ai", "tests", "tools"]).filter((file) => importsOf(file).some((s) => /^(openai|@anthropic-ai\/sdk)(\/|$)/.test(s))).sort();
    expect(importers).toEqual(["ai/providers/anthropic/index.ts", "ai/providers/openai/index.ts", "tests/unit/ai/provider-adapters.test.ts"]);
  });

  it("no product code branches on a vendor name (only future ai/providers/<vendor> adapters and registry config may)", () => {
    // domain/secret-patterns.ts names vendor KEY formats to detect leaked secrets — detection, not product behavior.
    for (const file of sourceFiles(PRODUCT).filter((f) => f !== "domain/secret-patterns.ts")) expect(strip(codeOf(file)), file).not.toMatch(/["'`](openai|anthropic|claude|gpt-[0-9])/i);
  });

  it("no environment or credential reader in the gateway, the simulator, the binding or the prompt", () => {
    for (const file of [...GATEWAY, ...SIMULATOR, ...BINDING, "prompts/classification/understanding.v1.ts"]) {
      expect(strip(codeOf(file)), file).not.toMatch(/process\.env|import\.meta\.env|API_KEY|apiKey|SECRET|withCredential|loadEnvironment|readFileSync|\.env\b/);
    }
  });
});

describe("H7-C: the gateway is generic and isolated", () => {
  it("imports only its own files: no module, DB, Trigger, web, provider, network or node built-in", () => {
    for (const file of GATEWAY) for (const specifier of importsOf(file)) expect(specifier, `${file} → ${specifier}`).toMatch(/^\.\/[a-z-]+$/);
    for (const file of GATEWAY) expect(strip(codeOf(file)), file).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|Math\.random|new Date\(|Date\.now\(|setTimeout|tool_choice|function_call/);
  });

  it("routes by task id only: the route is resolved before (and without) the input", () => {
    const code = strip(codeOf("ai/gateway/gateway.ts"));
    expect(code).toMatch(/const route = deps\.routes\[task\.taskId\];/);
    expect(code.indexOf("deps.routes[task.taskId]")).toBeLessThan(code.indexOf("task.data(input)"));
    expect(code).not.toMatch(/routes\[[^\]]*input|routes\[[^\]]*data|models?\.find\([^)]*input/);
  });

  it("re-asks at most once and never retries a transport failure inside the call", () => {
    const code = strip(codeOf("ai/gateway/gateway.ts"));
    expect(code.match(/for \(const attemptNumber of \[1, 2\] as const\)/g)).toHaveLength(1);
    expect(code).not.toMatch(/while\s*\(|retry\(|attempt\s*<\s*3|maxRetries/);
  });

  it("carries no chain-of-thought: no reasoning / thinking field in any gateway or binding type", () => {
    for (const file of [...GATEWAY, ...BINDING]) expect(strip(codeOf(file)), file).not.toMatch(/reasoning|thinking|chainOfThought|chain_of_thought/i);
    const simulator = strip(codeOf("ai/providers/simulator/index.ts"));
    // The simulator names `reasoning` only in its scripted response type, to prove the adapter drops it.
    expect(simulator.match(/reasoning/g)).toHaveLength(1);
    expect(simulator).toMatch(/readonly reasoning\?: string/);
  });
});

describe("H7-C: the simulator is deterministic, offline and test-only", () => {
  it("imports only the gateway port and has no randomness, clock, I/O or network", () => {
    for (const file of SIMULATOR) {
      for (const specifier of importsOf(file)) expect(specifier, `${file} → ${specifier}`).toBe("@/ai/gateway");
      expect(strip(codeOf(file)), file).not.toMatch(/Math\.random|crypto|Date\.now|new Date\(|\bfetch\(|node:|readFile|process\./);
    }
  });

  it("never reads the request it answers (it is not a classifier)", () => {
    expect(strip(codeOf("ai/providers/simulator/index.ts"))).toMatch(/complete\(_request: ProviderRequest, call: ProviderCall\)/);
    expect(strip(codeOf("ai/providers/simulator/index.ts"))).not.toMatch(/_request\.|request\.(system|data)/);
  });

  it("only tests compose it: no product or runtime code imports ai/providers", () => {
    for (const file of sourceFiles([...PRODUCT, "tools"])) expect(importsOf(file).filter((s) => /@\/ai\/providers|ai\/providers\//.test(s)), file).toEqual([]);
  });
});

describe("H7-C: data minimization and the untrusted boundary", () => {
  it("the model receives exactly the allowlisted fields; none names an author, credential, webhook, history or watch term", () => {
    expect([...UNDERSTANDING_DATA_FIELDS]).toEqual(["contractVersion", "taxonomyVersion", "validatedLanguages", "interactionKind", "platform", "source", "brandName", "hints", "analyzedText", "parentExcerpt", "rootExcerpt", "captionExcerpt"]);
    const binding = strip(codeOf("modules/classification/application/ai/understanding-task.ts"));
    expect(binding).not.toMatch(/author|handle|profile|token|credential|webhook|history|watch|signal/i);
    for (const file of BINDING) for (const specifier of importsOf(file)) expect(specifier, file).not.toMatch(/watch-terms|signals|interactions|persistence/);
  });

  it("social text only ever enters the request through the escaped data block", () => {
    const gateway = strip(codeOf("ai/gateway/gateway.ts"));
    expect(gateway).toMatch(/const data = renderDataBlock\(task\.data\(input\)\);/);
    expect(gateway).toMatch(/system: task\.prompt\.system \+ renderCorrection\(validation\.issues\)/);
    expect(strip(codeOf("ai/gateway/task.ts"))).toMatch(/\.replace\(\/<\/g, "\\\\u003c"\)\.replace\(\/>\/g, "\\\\u003e"\)/);
  });
});

describe("H7-C: nothing is wired to a runtime", () => {
  it("no task, plane or Trigger config change: MAIN 11 / INTEGRATION 7, no intelligence plane, no AI task", () => {
    const planes = PRODUCTION_TASKS.tasks.reduce<Record<string, number>>((acc, task) => ({ ...acc, [task.executionPlane]: (acc[task.executionPlane] ?? 0) + 1 }), {});
    // Registry tenant/system tasks per plane (the deployed INTEGRATION 7 = these 4 + 3 diagnostic/validation tasks).
    expect(planes).toEqual({ main: 11, integration: 4 });
    expect(RELEASE_PLANES.map((plane) => [plane.plane, plane.expectedTasks])).toEqual([["integration", 7], ["main", 11]]);
    expect(PRODUCTION_TASKS.tasks.some((task) => /understand|intelligence|^ai\./.test(task.name))).toBe(false);
    const configs = ["trigger.config.ts", "trigger.integration.config.ts", "trigger.managed-test.config.ts"];
    expect(readdirSync(REPOSITORY_ROOT).filter((name) => /^trigger\..*config\.ts$/.test(name)).sort()).toEqual(configs);
    for (const config of configs) expect(strip(codeOf(config)), config).not.toMatch(/intelligence|@\/ai\/|ai\/gateway/i);
    expect(existsSync(path.join(REPOSITORY_ROOT, "jobs/trigger/intelligence"))).toBe(false);
  });

  it("no runtime imports the gateway, the binding or the prompt; the module index does not export the binding", () => {
    for (const file of sourceFiles(RUNTIME)) expect(codeOf(file), file).not.toMatch(/@\/ai\/|@\/prompts\/|application\/ai\//);
    expect(codeOf("modules/classification/index.ts")).not.toMatch(/application\/ai/);
  });

  it("no continuation from DETERMINISTIC_DONE: nothing transitions a request to AI_PENDING", () => {
    for (const file of sourceFiles(["modules", "jobs", "server", "platform", "ai"])) {
      const code = strip(codeOf(file));
      if (file === "modules/classification/application/ports.ts") continue; // the 0024 state vocabulary itself
      expect(code, file).not.toMatch(/"AI_PENDING"|"AI_RUNNING"/);
    }
    expect(strip(codeOf("modules/classification/application/understand-deterministic.ts"))).not.toMatch(/understandInteraction|gateway/i);
  });

  it("no migration after 0024", () => {
    const migrations = readdirSync(path.join(REPOSITORY_ROOT, "db/migrations")).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
    expect(migrations.at(-1)).toBe("0024_classification_persistence.sql");
  });
});

describe("H7-D0: real provider adapters and the live bake-off", () => {
  const ADAPTERS = ["ai/providers/openai/index.ts", "ai/providers/anthropic/index.ts"];
  const LIVE = sourceFiles(["tests/eval/classification/live"]).concat(["tests/eval/classification/live.eval.ts", "tools/eval/classification-live.ts"]);

  it("adapters import only their own SDK and the gateway port; read no environment; disable SDK retries; use no tools, fallback or middleware", () => {
    for (const file of ADAPTERS) {
      const code = strip(codeOf(file));
      for (const specifier of importsOf(file)) expect(specifier, `${file} → ${specifier}`).toMatch(/^(openai|openai\/resources\/responses\/responses|@anthropic-ai\/sdk|@anthropic-ai\/sdk\/resources\/messages\/messages|@\/ai\/gateway)$/);
      expect(code, file).not.toMatch(/process\.env|import\.meta\.env|readFileSync|tools\s*:|tool_choice|middleware|Fallback|background|previous_response_id|temperature|top_p|top_k|"priority"|"fast"|"flex"|"auto"|batch/i);
      expect(code, file).toMatch(/maxRetries: 0/);
      expect(code, file).toMatch(/return failed\("model_mismatch"\)/);
    }
    expect(strip(codeOf("ai/providers/openai/index.ts"))).toMatch(/strict: true/);
    expect(strip(codeOf("ai/providers/openai/index.ts"))).toMatch(/store: false/);
    expect(strip(codeOf("ai/providers/anthropic/index.ts"))).toMatch(/service_tier: "standard_only"/);
  });

  it("adapters return only text, reported model and usage: no raw response, id, header or reasoning crosses the port", () => {
    for (const file of ADAPTERS) {
      const code = strip(codeOf(file));
      expect(code, file).toMatch(/kind: "completed",\s+text,\s+modelVersion: (response|message)\.model,\s+usage:/);
      expect(code, file).not.toMatch(/_request_id|requestID|raw:|reasoning: (response|message)|thinking: (response|message)/);
      // Headers are read for exactly one value: the retry-after of a rate limit.
      expect([...code.matchAll(/\.headers\b/g)].length, file).toBe(1);
      expect(code, file).toMatch(/headers\?\.get\("retry-after"\)/);
    }
  });

  it("no product or runtime code composes a real provider; only the live bake-off does", () => {
    for (const file of sourceFiles([...PRODUCT, "tools"])) expect(importsOf(file).filter((s) => /ai\/providers\/(openai|anthropic)/.test(s)), file).toEqual([]);
    expect(sourceFiles(["tests"]).filter((file) => /candidateProvider\(/.test(strip(codeOf(file)))).sort()).toEqual(["tests/eval/classification/live.eval.ts", "tests/eval/classification/live/candidates.ts"]);
  });

  it("the live run is operator-only: never in a default / CI config, refuses CI and needs an explicit confirmation", () => {
    for (const config of ["vitest.config.ts", "vitest.db.config.ts", "vitest.db-managed.config.ts", "vitest.jobs-managed.config.ts", "vitest.eval.config.ts", "vitest.dev-fixture.config.ts"]) {
      expect(codeOf(config), config).not.toMatch(/live\.eval|eval-live/);
    }
    expect(codeOf("vitest.eval-live.config.ts")).toMatch(/include: \["tests\/eval\/classification\/live\.eval\.ts"\]/);
    const cli = strip(codeOf("tools/eval/classification-live.ts"));
    expect(cli.indexOf('"CI"')).toBeLessThan(cli.indexOf("spawnSync("));
    expect(cli).toMatch(/--confirm-real-model-calls/);
    const runner = strip(codeOf("tests/eval/classification/live.eval.ts"));
    expect(runner).toMatch(/process\.env\["CI"\] !== undefined \|\| process\.env\["GITHUB_ACTIONS"\] !== undefined/);
    expect(runner.indexOf("LIVE_EVAL_BUDGET_USD) fail(")).toBeLessThan(runner.indexOf("readCredential(c.credential)"));
    expect((JSON.parse(codeOf("package.json")) as { scripts: Record<string, string> }).scripts["test"]).toBe("vitest run");
  });

  it("the bake-off reads only the committed synthetic corpus: no database, dev-v2, ingestion or fixture-tool input", () => {
    for (const file of LIVE) expect(strip(codeOf(file)), file).not.toMatch(/@\/platform\/db|@\/tools\/db|from "pg"|DATABASE_|dev-fixture|dev-v2|@\/modules\/(ingestion|interactions)|@\/server\//);
    expect(strip(codeOf("tests/eval/classification/live.eval.ts"))).toMatch(/fixtures\/intelligence\/classification\/understanding-eval\.v1\.json/);
  });

  it("credentials are read only at the operator boundary and handed only to SDK clients; never printed", () => {
    expect(sourceFiles(["ai", "modules", "tests/eval", "tools"]).filter((file) => /OPENAI_API_KEY|ANTHROPIC_API_KEY/.test(strip(codeOf(file)))).sort())
      .toEqual(["tests/eval/classification/live-tools.test.ts", "tests/eval/classification/live/candidates.ts", "tests/eval/classification/live/credentials.ts"]);
    for (const file of LIVE) expect(strip(codeOf(file)), file).not.toMatch(/console\.log\([^)]*(key|credential)|stdout\.write\([^)]*readCredential/i);
  });
});
