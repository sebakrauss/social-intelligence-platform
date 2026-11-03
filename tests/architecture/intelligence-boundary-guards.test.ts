/**
 * Step H7-D1b — static guards around the INTELLIGENCE runtime contracts:
 *   - no dependency path from the intelligence contracts (gateway, task binding, runtime contract, derived outcome,
 *     qualified registry entry) to the mutation executor, provider integrations, moderation / replies / automation, or a
 *     hide / delete / reply / block / webhook write;
 *   - nothing consumes them yet: no runtime, Trigger config or product code imports the contract, the qualified entry or
 *     the derived outcome; only the contract names `"accepting"` (H7-D1 is shadow-only);
 *   - the declared-only intelligence plane can't reach the delivery path: every delivery seam takes `DeliveryPlane`, the
 *     outbox plane list equals the 0011 database check;
 *   - the SDK-ambient refusal list is used only by the two refusal guards;
 *   - the frozen semantic artifacts are byte-identical to the H7-D0 closure (31d0b0a).
 * Step H7-D1d: the INTELLIGENCE runner and its composition are now the contract's only consumers (no product consumer);
 * the intelligence plane is a delivery plane (0025); every writer is shadow-only; no runtime file reaches an action.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OUTBOX_EXECUTION_PLANES } from "@/platform/db";
import { DELIVERY_PLANES } from "@/platform/jobs";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../support/source-scan";

const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
const importsOf = (file: string): string[] => [...codeOf(file).matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");

const CONTRACT = "modules/classification/application/ai/understand-ai-contract.ts";
const ROUTING = "modules/classification/domain/intelligence-routing.ts";
/** H7-D1d: the runtime around the model call — MAIN dispatch / recovery, the runner, its writers, its composition. */
const INTELLIGENCE_RUNTIME = [
  "modules/classification/application/intelligence-dispatch.ts",
  "modules/classification/application/ai/run-understanding.ts",
  "modules/classification/domain/understanding-eligibility.ts",
  "modules/classification/intelligence-runtime.ts",
  "modules/classification/persistence/intelligence-store.ts",
  "server/persistence/classification.ts",
  "jobs/intelligence.ts",
  "jobs/intelligence-policy.ts",
  "jobs/trigger/intelligence/classification.ts",
];
const OUTCOME = "modules/classification/domain/understanding-outcome.ts";
const QUALIFIED = "ai/providers/anthropic/qualified.ts";
const INTELLIGENCE_FILES = [...sourceFiles(["ai"]), ...sourceFiles(["modules/classification/application/ai"]), OUTCOME, "prompts/classification/understanding.v2.ts"];
const RUNTIME = ["app", "ui", "server", "platform", "integrations", "jobs", "db", "mutations", "tools"];

describe("H7-D1b: no path from intelligence to an action", () => {
  it("26 · intelligence code imports no executor, integration, moderation / replies / automation, persistence or job runtime", () => {
    for (const file of INTELLIGENCE_FILES) {
      for (const specifier of importsOf(file)) {
        expect(specifier, `${file} → ${specifier}`).not.toMatch(/(^|\/)(mutations|integrations|moderation|replies|automation|executor|persistence|outbox)(\/|$)|@\/(platform|server|jobs|db|app|ui)\b|trigger\.dev/);
      }
    }
  });

  it("26 · intelligence code names no platform action, mutation request or webhook write", () => {
    for (const file of INTELLIGENCE_FILES) {
      expect(strip(codeOf(file)), file).not.toMatch(/MutationRequest|mutationPort|hideComment|deleteComment|blockAuthor|sendReply|privateReply|webhook\w*\.(send|post)|executeMutation/);
    }
  });

  it("the derived outcome is pure: the shared kernel and its own domain files only", () => {
    for (const specifier of importsOf(OUTCOME)) expect(specifier, specifier).toMatch(/^(\.\/[a-z-]+|@\/domain\/[a-z-]+)$/);
  });
});

describe("H7-D1b: no consumer, no promotion, shadow only", () => {
  it("H7-D1d: only the INTELLIGENCE runner, its entry and its composition consume the contract, the qualified entry and the derived outcome", () => {
    const consumers = sourceFiles([...RUNTIME, "modules", "domain"]).filter((file) => /understand-ai-contract|anthropic\/qualified|understanding-outcome|deriveUnderstandingOutcome/.test(strip(codeOf(file))));
    expect(consumers.sort()).toEqual([
      "jobs/intelligence.ts",
      "modules/classification/application/ai/run-understanding.ts",
      "modules/classification/domain/understanding-outcome.ts",
      "modules/classification/index.ts",
      "modules/classification/intelligence-runtime.ts",
    ]);
    for (const config of ["trigger.config.ts", "trigger.integration.config.ts", "trigger.managed-test.config.ts"]) expect(strip(codeOf(config)), config).not.toMatch(/intelligence|understand_ai|@\/ai\//i);
  });

  it("only the routing contract names the `accepting` mode (its vocabulary), and its default and H7-D1 mode are `shadow`", () => {
    const namers = sourceFiles(["ai", "modules", "domain", ...RUNTIME]).filter((file) => /["']accepting["']/.test(strip(codeOf(file))));
    expect(namers).toEqual([ROUTING]);
    const code = strip(codeOf(ROUTING));
    expect(code).toMatch(/export const H7_D1_ACCEPTANCE_MODE = "shadow" as const satisfies AcceptanceMode;/);
    expect(code).toMatch(/readonly acceptanceMode: typeof H7_D1_ACCEPTANCE_MODE;/);
    expect(code).toMatch(/readonly realDataEligible: false;/);
  });

  it("H7-D1d: every writer is SHADOW-only — results and AI assessments are written `shadow`, nothing writes `accepting`", () => {
    const store = strip(codeOf("modules/classification/persistence/intelligence-store.ts"));
    expect(store).toMatch(/created_at, acceptance_mode, pipeline_version, language_policy_version, ai_result_id\)/);
    expect(store).toMatch(/\$\{row\.createdAt\}, 'shadow', \$\{row\.pipelineVersion\}/);
    expect(store).not.toMatch(/accepting/);
    expect(strip(codeOf("modules/classification/application/ports.ts"))).toMatch(/readonly acceptanceMode: "shadow";/);
    expect(strip(codeOf("modules/classification/application/ai/run-understanding.ts"))).toMatch(/acceptanceMode: "shadow",/);
    // No product reader of the shadow rows: only the intelligence store touches ai_results / AI assessments, and it reads
    // assessments back for RULE candidates only.
    const readers = sourceFiles(["app", "ui", "server", "modules", "platform", "integrations", "jobs"]).filter((file) => /classification\.ai_results|classification\.ai_attempts|classification\.assessments/.test(strip(codeOf(file))));
    expect(readers).toEqual(["modules/classification/persistence/intelligence-store.ts"]);
    expect(store).toMatch(/from classification\.assessments\s+where source_text_version_id = \$\{target\.sourceTextVersionId\}::uuid and interaction_id = \$\{target\.interactionId\}::uuid and origin = 'rule'/);
  });

  it("H7-D1d (25): no intelligence runtime file reaches an executor, a provider integration, moderation, replies, automation or alerts, or names an action", () => {
    for (const file of INTELLIGENCE_RUNTIME) {
      for (const specifier of importsOf(file)) expect(specifier, `${file} → ${specifier}`).not.toMatch(/(^|\/)(mutations|integrations|moderation|replies|automation|alerts|attention|executor|connections)(\/|$)/);
      expect(strip(codeOf(file)), file).not.toMatch(/MutationRequest|mutationPort|hideComment|deleteComment|blockAuthor|sendReply|privateReply|executeMutation|classification\.understood/);
    }
  });

  it("the qualified descriptor is executable but not production-selected, and nothing reads the environment or a credential in the new files", () => {
    // H7-D1f-prep: enabled only to run behind the bounded synthetic route (jobs/intelligence-policy.ts).
    expect(strip(codeOf(QUALIFIED))).toMatch(/enabled: true,/);
    expect(strip(codeOf(QUALIFIED))).toMatch(/productionModelSelected: false,/);
    for (const file of [CONTRACT, OUTCOME, QUALIFIED, "domain/model-provider-variables.ts"]) expect(strip(codeOf(file)), file).not.toMatch(/process\.env|import\.meta\.env|readFileSync|fetch\(|apiKey/);
  });
});

describe("H7-D1b: the declared-only plane can't reach the delivery path before 0025", () => {
  it("the outbox plane list equals DELIVERY_PLANES and the 0025 database check (H7-D1d: intelligence is a delivery plane)", () => {
    expect([...OUTBOX_EXECUTION_PLANES]).toEqual([...DELIVERY_PLANES]);
    expect([...DELIVERY_PLANES]).toEqual(["main", "integration", "intelligence"]);
    expect(codeOf("db/migrations/0011_outbox_execution_plane.sql")).toMatch(/execution_plane is null or execution_plane in \('main', 'integration'\)/);
    const sql = codeOf("db/migrations/0025_intelligence_persistence.sql");
    expect(sql).toMatch(/execution_plane is null or execution_plane in \('main', 'integration', 'intelligence'\)/);
    expect(sql).toMatch(/\(execution_plane = 'intelligence'\) = \(topic = 'classification\.understand_ai'\)/);
  });

  it("every delivery seam takes DeliveryPlane, never the declared ExecutionPlane", () => {
    for (const file of ["platform/jobs/registry.ts", "platform/jobs/port.ts", "platform/db/outbox.ts", "platform/db/outbox-delivery.ts", "platform/outbox/delivery.ts", "jobs/runtime.ts", "jobs/trigger/define.ts"]) {
      const code = strip(codeOf(file));
      expect(code, file).toMatch(/DeliveryPlane|DELIVERY_PLANES/);
      expect(code.replace(/isExecutionPlane/g, "").replace(/ExecutionPlaneRuntimes/g, ""), file).not.toMatch(/\bExecutionPlane\b|\bEXECUTION_PLANES\b/);
    }
    expect(strip(codeOf("platform/jobs/registry.ts"))).toMatch(/if \(!isDeliveryPlane\(plane\)\) throw new TaskRegistryError/);
  });

  it("the SDK-ambient refusal list is imported only by the two runtime refusal guards", () => {
    const importers = sourceFiles(["app", "ui", "server", "domain", "modules", "platform", "integrations", "jobs", "db", "mutations", "ai", "prompts", "tools"]).filter((file) => importsOf(file).includes("@/domain/model-provider-variables"));
    expect(importers.sort()).toEqual(["jobs/plane-environment.ts", "server/http/web-environment.ts"]);
  });
});

describe("H7-D1e2b: every provider call has a durable identity committed before egress", () => {
  const gateway = strip(codeOf("ai/gateway/gateway.ts"));

  it("only tests construct the unledgered (evaluation) gateway; the runtime composes the ledgered one only", () => {
    const builders = sourceFiles(["app", "ui", "server", "domain", "modules", "platform", "integrations", "jobs", "db", "mutations", "ai", "prompts", "tools"])
      .filter((file) => file !== "ai/gateway/gateway.ts" && /\bcreateAiGateway\(/.test(strip(codeOf(file))));
    expect(builders).toEqual([]);
    const ledgered = sourceFiles(["app", "ui", "server", "domain", "modules", "platform", "integrations", "jobs", "db", "mutations", "ai", "prompts", "tools"])
      .filter((file) => file !== "ai/gateway/gateway.ts" && /\bcreateLedgeredAiGateway\(/.test(strip(codeOf(file))));
    expect(ledgered).toEqual(["jobs/intelligence.ts"]);
    expect(strip(codeOf("jobs/intelligence.ts"))).toMatch(/gatewayFor: \(budget, egress\) => createLedgeredAiGateway\(\{ registry, routes, providers: composition\.providers\(\), budget, egress,/);
  });

  it("the gateway has ONE provider call, preceded in the same loop by the egress authorization, followed by the durable record", () => {
    expect(gateway.match(/provider\.complete\(/g)).toHaveLength(1);
    const authorize = gateway.indexOf("if (egress !== undefined && !(await authorizeEgress(egress, call))) return failed(\"egress_unrecorded\", attempts);");
    const call = gateway.indexOf("const response = await provider.complete(");
    expect(authorize).toBeGreaterThan(-1);
    expect(authorize).toBeLessThan(call);
    expect(gateway.slice(gateway.indexOf("for (const attemptNumber of [1, 2] as const) {"), call)).toContain("authorizeEgress(egress, call)");
    // Every outcome after a call is recorded durably before the gateway returns or re-asks.
    expect(gateway.match(/if \(!\(await durable\(\)\)\) return failed\("egress_unrecorded", attempts\);/g)).toHaveLength(4);
    expect(strip(codeOf("ai/gateway/failures.ts"))).toMatch(/egress_unrecorded: "AI_UNAVAILABLE",/);
    expect(strip(codeOf("ai/gateway/failures.ts"))).toMatch(/const RETRYABLE: readonly AiFailureCause\[\] = Object\.freeze\(\["provider_unavailable", "timeout", "rate_limited"\]\);/);
  });

  it("the runner's egress fence locks the request, re-checks AI_RUNNING at its generation, and authorizes only an inserted intent", () => {
    const runner = strip(codeOf("modules/classification/application/ai/run-understanding.ts"));
    const fence = runner.slice(runner.indexOf("authorize: async (call) => {"), runner.indexOf("recorded: async (attempt) => {"));
    expect(fence).toMatch(/const current = await scope\.intelligence\.lockRequest\(request\.id\);/);
    expect(fence).toMatch(/current\.state !== "AI_RUNNING" \|\| current\.aiGeneration !== generation\) return "denied" as const;/);
    expect(fence.indexOf("lockRequest(")).toBeLessThan(fence.indexOf("recordCallIntent("));
    expect(fence).toMatch(/return written === "inserted" \? \("authorized" as const\) : \("denied" as const\);/);
    expect(runner).toMatch(/recorded: async \(attempt\) => \{\s+await deps\.inScope\(\(scope\) => scope\.intelligence\.recordAttempts\(ledgerRows\(\[attempt\], clock\.now\(\)\)\)\);/);
  });

  it("no source updates or deletes a call intent or an attempt (append-only by grant AND by code)", () => {
    for (const file of sourceFiles(["modules", "server", "jobs", "platform", "tools", "ai"])) {
      expect(strip(codeOf(file)).toLowerCase(), file).not.toMatch(/update classification\.ai_(call_intents|attempts)|delete from classification\.ai_(call_intents|attempts)/);
    }
    const sql = codeOf("db/migrations/0026_ai_call_intents.sql").replace(/--[^\n]*/g, " ").toLowerCase();
    expect([...sql.matchAll(/grant [^;]*;/g)].map((m) => m[0].replace(/\s+/g, " "))).toEqual(["grant select, insert on classification.ai_call_intents to app_worker;"]);
    // No DML, no drop, no definer (the only "delete" is the workspace cascade of the composite foreign key).
    expect(sql.replace(/on delete cascade/g, "")).not.toMatch(/\b(update|delete|drop|truncate|insert into)\b|security definer/);
  });
});

describe("27 · the frozen semantic artifacts are unchanged (H7-D0 closure, 31d0b0a)", () => {
  const FROZEN: Readonly<Record<string, string>> = {
    "prompts/classification/understanding.v2.ts": "60e7eeef3002c8a68c7db49007012226e376a3a449fe0acc9f19f727648ae8af",
    "modules/classification/domain/taxonomy.ts": "ae91609d3aeee7d983bf2c9bebf5db6b8fdbf1bd8c776f085e8072626eb2f711",
    "modules/classification/domain/understanding-output.ts": "5a676718059df6168231c71d0ccb81fed6188163a328f7bd9a49e190982cf823",
    "modules/classification/domain/understanding-input.ts": "dcdcd904bb6a688adf8fff9685f947a2701a2732f55f67a8e362ff48a59879d4",
    "modules/classification/domain/precedence.ts": "0a76f738120ccc74e6ef29c571849e07cc2fbb996d7f46825004cfaf85fb6bbb",
    "modules/classification/domain/protection.ts": "8e2663fe7690fbd0d10d03b5bf12b9bbaae556e65e8571948aee5aeb116d4357",
    "modules/classification/domain/needs-review.ts": "4d0cc0d9cfbbebea1eece4162eff55c8d70bebe7f14d13f007eb584c329efc40",
    "modules/classification/domain/language.ts": "d0e34db25c604124d7e5a9457482f7fedef98404f4ef8d344adc6191ad69895f",
    "modules/classification/domain/confidence.ts": "9ed36935d6b60ab3b3f8aba2776b9bbe1e3dc818d77d53c6d9e59ddaf7cadadb",
    "modules/classification/domain/assessment.ts": "b83bfb66b48f632b262024dc8ae937ecf448a0b13b9887f3d3c44d8402e803d1",
    "modules/classification/application/ai/understanding-task.ts": "6c86ed010f86bca38702ce9f6f72062e68d7503540ff2425286df1ce6d67d505",
    "modules/classification/application/ai/understanding-output-schema.ts": "4dfd7178e093890ace0d63b15c1aeb8deee52cc24197f7892f0ebfb9cf5edd56",
    "ai/providers/anthropic/schema-projection.ts": "fe7e0f92b018eb984f5f710c9da1e8ad398546bf1cfdbe05bf5f6803c275eec1",
    "ai/providers/anthropic/index.ts": "385ed1f399ffbc37000f1266724463c5619dc1df797ef6a9f3f47619c42a65cc",
    "tests/eval/classification/live/candidates.ts": "e896fd18321cf7a90de300152c0d15bdedf64413235556f35d380835f2dfacbb",
    "tests/eval/classification/evaluate.ts": "6acfa44d92836227340dbdf55708fa6eba681bac72802aac7836d1acb35989a4",
    "tests/eval/classification/severity.ts": "dc5742f27dcc49c42959157882038f16134878dfd89dc7bee41147bb7f4b47dd",
    "tests/eval/classification/promotion.ts": "1f0b3af68594d7e54daac445e69661712710ff357fcbd88f6a63138930c44a1d",
    "tests/eval/classification/live/stability-policy.ts": "d2a5d8da83bcd050746dfded1f76aa0441e6e3c3989e004691047ce6ed2bf732",
    "fixtures/intelligence/classification/understanding-eval.v2.json": "8dc159ffb74c70acd90a30b00fe35dc9f290ae5502acefb0f0f2c59cd527c989",
  };
  it("prompt v2, taxonomy, A1, task binding, transport schema v2, adapter, candidates, evaluator v3, promotion v3, stability policy v2, corpus v2", () => {
    for (const [file, digest] of Object.entries(FROZEN)) expect(createHash("sha256").update(readFileSync(path.join(REPOSITORY_ROOT, file))).digest("hex"), file).toBe(digest);
  });
});
