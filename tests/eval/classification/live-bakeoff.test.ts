/**
 * Step H7-D0a — the bake-off orchestration offline (simulator + mocked SDK client; no network): the consecutive
 * transport-failure breaker (K = 3) stops the WHOLE bake-off, only transport failures count, any provider response
 * resets it, an aborted or transport-touched run is INVALID_FOR_MODEL_COMPARISON, no recommendation is ever produced,
 * and the evidence carries only closed diagnostic codes.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { TRANSPORT_DIAGNOSTIC_CODES } from "@/ai/providers/diagnostics";
import { createOpenAIProvider } from "@/ai/providers/openai";
import { createSimulatorProvider, simulatorModel, type SimulatedResponse } from "@/ai/providers/simulator";
import { REPOSITORY_ROOT } from "../../support/source-scan";
import { parseEvalCorpus, type EvalCorpus } from "./corpus";
import type { CaseResult } from "./evaluate";
import { goldenScript, transformCase, values, withCase } from "./golden";
import { createDiagnosticLog, runBakeoff, type BakeoffCandidate } from "./live/bakeoff";
import { CONSECUTIVE_TRANSPORT_FAILURE_LIMIT, createTransportBreaker } from "./live/breaker";
import { CANDIDATES, LIVE_CALL_TIMEOUT_MS, MAX_OUTPUT_TOKENS, candidateModel } from "./live/candidates";
import { parsePriceDescriptor } from "./live/spend";

const CORPUS: EvalCorpus = parseEvalCorpus(JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "fixtures/intelligence/classification/understanding-eval.v1.json"), "utf8")));
const PRICES = parsePriceDescriptor(JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "fixtures/intelligence/evaluation/model-prices.eval-2026-10-29.json"), "utf8")));
const PRICE = PRICES.models["openai/gpt-6-luna"] ?? (() => { throw new Error("price"); })();
const GOLDEN = goldenScript(CORPUS);
const IDS = CORPUS.cases.map((c) => c.id);
const DOWN: SimulatedResponse = { kind: "unavailable" };

/** Golden answers, except the listed case ids are transport failures. */
const scriptWithOutages = (ids: readonly string[]) => ids.reduce((script, id) => withCase(script, id, [DOWN]), new Map(GOLDEN));
const simulated = (id: string, script: ReadonlyMap<string, readonly SimulatedResponse[]>): BakeoffCandidate => ({
  id, requestedModel: id, model: simulatorModel(id), price: PRICE, provider: createSimulatorProvider(script), diagnostics: createDiagnosticLog(),
});
const bakeoff = (candidates: readonly BakeoffCandidate[]) => runBakeoff({ corpus: CORPUS, candidates, capUsd: 15, maxOutputTokens: MAX_OUTPUT_TOKENS, now: () => new Date("2026-10-30T12:00:00.000Z") });

describe("breaker rules (unit)", () => {
  const result = (id: string, failureCause: string | null, outcomes: readonly string[]): CaseResult => ({ id, failureCause, attempts: outcomes.map((outcome) => ({ outcome })) } as unknown as CaseResult);

  it("K = 3; only retryable transport causes count; any provider response resets; no-call cases neither count nor reset", () => {
    expect(CONSECUTIVE_TRANSPORT_FAILURE_LIMIT).toBe(3);
    const breaker = createTransportBreaker();
    breaker.observe("c", result("a", "provider_unavailable", ["unavailable"]));
    breaker.observe("c", result("b", "timeout", ["unavailable"]));
    expect([breaker.consecutive(), breaker.tripped()]).toEqual([2, false]);
    breaker.observe("c", result("too-large", "input_limit", []));
    breaker.observe("c", result("budget", "budget_exhausted", []));
    expect(breaker.consecutive()).toBe(2);
    breaker.observe("c", result("ok", null, ["accepted"]));
    expect(breaker.consecutive()).toBe(0);
    for (const [cause, outcomes] of [["invalid_output", ["invalid_output", "invalid_output"]], ["refused", ["refused"]], [null, ["accepted"]]] as const) {
      breaker.observe("c", result("semantic", cause, outcomes));
      expect(breaker.consecutive(), String(cause)).toBe(0);
    }
    for (const id of ["x", "y", "z"]) breaker.observe("c", result(id, "rate_limited", ["unavailable"]));
    expect(breaker.tripped()).toBe(true);
    expect(breaker.streak()).toEqual([{ candidate: "c", caseId: "x" }, { candidate: "c", caseId: "y" }, { candidate: "c", caseId: "z" }]);
  });

  it("non-transport provider failures (auth, rejected, model mismatch) do not count toward the transport breaker", () => {
    const breaker = createTransportBreaker();
    for (const cause of ["provider_auth_failed", "provider_request_rejected", "model_mismatch"]) breaker.observe("c", result(cause, cause, ["unavailable"]));
    expect(breaker.consecutive()).toBe(0);
  });
});

describe("bake-off orchestration", () => {
  it("1 and 2 consecutive transport failures: the run continues to the end — but it is INVALID for comparison", async () => {
    for (const outages of [[IDS[0]], [IDS[0], IDS[1]]]) {
      const evidence = await bakeoff([simulated("a", scriptWithOutages(outages as string[]))]);
      expect(evidence).toMatchObject({ status: "COMPLETE", comparison: "INVALID_FOR_MODEL_COMPARISON", recommendation: null, breaker: { tripped: false } });
      expect(evidence.invalidReasons).toContain(`a:transport_failures:${String(outages.length)}`);
      expect(evidence.candidates[0]).toMatchObject({ casesEvaluated: CORPUS.cases.length });
    }
  });

  it("3 consecutive transport failures abort the WHOLE bake-off: no later case, no later candidate, no stability, no recommendation", async () => {
    const later = createSimulatorProvider(GOLDEN);
    const evidence = await bakeoff([simulated("a", scriptWithOutages([IDS[5], IDS[6], IDS[7]] as string[])), { ...simulated("b", GOLDEN), provider: later }]);
    expect(evidence).toMatchObject({ status: "LIVE_EVAL_ABORTED_CONSECUTIVE_TRANSPORT_FAILURES", comparison: "INVALID_FOR_MODEL_COMPARISON", recommendation: null,
      breaker: { limit: 3, tripped: true, consecutive: 3, streak: [{ candidate: "a", caseId: IDS[5] }, { candidate: "a", caseId: IDS[6] }, { candidate: "a", caseId: IDS[7] }] } });
    expect(evidence.candidates[0]).toMatchObject({ candidate: "a", casesEvaluated: 8, qualifiedForStability: false, stability: null });
    expect(evidence.candidates[1]).toEqual({ candidate: "b", status: "NOT_RUN" });
    expect(later.calls).toEqual([]);
    expect(evidence.invalidReasons).toEqual(expect.arrayContaining(["LIVE_EVAL_ABORTED_CONSECUTIVE_TRANSPORT_FAILURES", "a:incomplete", "b:not_run"]));
  });

  it("a success between failures resets the count (fail, fail, ok, fail, fail ⇒ no trip)", async () => {
    const evidence = await bakeoff([simulated("a", scriptWithOutages([IDS[0], IDS[1], IDS[3], IDS[4]] as string[]))]);
    expect(evidence.breaker.tripped).toBe(false);
    expect(evidence.status).toBe("COMPLETE");
  });

  it("semantic wrong answers, schema failures and refusals never trip it (a clean golden run is VALID)", async () => {
    let script = transformCase(GOLDEN, CORPUS, IDS[0] as string, (b) => { b.dimensions["intent"] = values(["neutral_conversation", "high"]); });
    script = withCase(script, IDS[1] as string, [{ kind: "raw", text: "{" }, { kind: "raw", text: "{" }]);
    script = withCase(script, IDS[2] as string, [{ kind: "refusal" }]);
    const bad = await bakeoff([simulated("a", script)]);
    expect(bad).toMatchObject({ status: "COMPLETE", breaker: { tripped: false, consecutive: 0 } });
    expect(bad.comparison).toBe("VALID_FOR_MODEL_COMPARISON");
    expect(bad.candidates[0]).toMatchObject({ schemaFailures: 1, refusals: 1, transientFailures: 0 });
    const golden = await bakeoff([simulated("a", GOLDEN), simulated("b", GOLDEN)]);
    expect(golden).toMatchObject({ status: "COMPLETE", comparison: "VALID_FOR_MODEL_COMPARISON", recommendation: null });
  });

  it("a real adapter behind a dead network: breaker trips after 3 calls, evidence holds only closed diagnostic codes, nothing leaks, no network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const cause = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET 10.9.8.7:443 api.example-vendor.com Bearer sk-test"), { code: "ECONNRESET" }) });
    const create = vi.fn(() => Promise.reject(new OpenAI.APIConnectionError({ cause })));
    const luna = CANDIDATES["gpt-6-luna"];
    if (luna.providerKey !== "openai") throw new Error("candidate");
    const diagnostics = createDiagnosticLog();
    const provider = createOpenAIProvider({ client: { responses: { create } }, models: { [luna.id]: luna.settings }, timeoutMs: LIVE_CALL_TIMEOUT_MS, onTransportDiagnostic: diagnostics.sink });
    const evidence = await bakeoff([{ id: luna.id, requestedModel: luna.settings.model, model: candidateModel(luna), price: PRICE, provider, diagnostics }]);
    expect(evidence.status).toBe("LIVE_EVAL_ABORTED_CONSECUTIVE_TRANSPORT_FAILURES");
    expect(create).toHaveBeenCalledTimes(3);
    const attempts = (evidence.cases[luna.id] ?? []).flatMap((c) => c.attempts);
    expect(attempts.map((a) => a.transportDiagnostic)).toEqual(["ECONNRESET", "ECONNRESET", "ECONNRESET"]);
    for (const a of attempts) expect(TRANSPORT_DIAGNOSTIC_CODES).toContain(a.transportDiagnostic);
    expect(JSON.stringify(evidence)).not.toMatch(/10\.9\.8\.7|example-vendor|Bearer|sk-test|fetch failed/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the live call timeout is 30 s and is injected only by the live runner", () => {
    expect(LIVE_CALL_TIMEOUT_MS).toBe(30_000);
  });
});
