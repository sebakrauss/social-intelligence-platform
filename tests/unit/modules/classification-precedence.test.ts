/** Step H7-A1 — assessment identity/provenance, M-05 precedence and human corrections (pure). */
import { describe, expect, it } from "vitest";
import {
  acceptInterpretation,
  assessmentIdentityKey,
  createAssessment,
  createHumanCorrection,
  parseAnalysisTarget,
  understandingRequestKey,
  RULE_ESTABLISHES,
  type HumanMethod,
  type RuleMethod,
} from "@/modules/classification";
import { AI_METHOD, EDITED_TARGET, OTHER_INTERACTION, TARGET, assessment, nextRef } from "../../support/classification-corpus";

const HUMAN: HumanMethod = { kind: "human", actor: { kind: "workspace_member", ref: "member-1" } };
const LINK_RULE: RuleMethod = { kind: "rule", rule: "link_reputation_malicious", ruleVersion: "link-reputation.v1" };
const HINT = { kind: "platform_hint" as const, hint: "platform_spam_flag", adapterVersion: "meta.v1" };

describe("assessment identity", () => {
  it("targets an immutable source text version: an edit is a different target and a different machine identity", () => {
    expect(parseAnalysisTarget({ workspaceId: TARGET.workspaceId, interactionId: TARGET.interactionId, sourceTextVersionId: "current" })).toBeUndefined();
    const a = assessment({ dimension: "intent", values: ["praise"], target: TARGET });
    const b = assessment({ dimension: "intent", values: ["praise"], target: EDITED_TARGET });
    expect(assessmentIdentityKey(a)).not.toBe(assessmentIdentityKey(b));
    expect(assessmentIdentityKey(a)).toBe(assessmentIdentityKey({ ...a, ref: "another-ref" }));
  });

  it("a machine identity is (text version, dimension, method); a human one is its own ref (appended, never collapsed)", () => {
    const a = assessment({ dimension: "intent", values: ["praise"] });
    expect(assessmentIdentityKey(a)).toBe(`${TARGET.sourceTextVersionId}|intent|ai:classification.understand:1:1:sha256:fixture:understanding-output.v1:taxonomy.v1:simulator:fixture-model:-`);
    const h1 = assessment({ dimension: "intent", values: ["praise"], method: HUMAN, ref: "h-1" });
    const h2 = assessment({ dimension: "intent", values: ["praise"], method: HUMAN, ref: "h-2" });
    expect(assessmentIdentityKey(h1)).toBe("human|h-1");
    expect(assessmentIdentityKey(h1)).not.toBe(assessmentIdentityKey(h2));
  });

  it("an understanding request is keyed by text version + pipeline version, from identities only", () => {
    expect(understandingRequestKey(TARGET, "pipeline.v1")).toBe(`${TARGET.sourceTextVersionId}|pipeline.v1`);
    expect(() => understandingRequestKey(TARGET, "")).toThrow("pipeline_version_invalid");
  });

  it("assessments are frozen (immutable) values", () => {
    const a = assessment({ dimension: "intent", values: ["praise"] });
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.content)).toBe(true);
  });
});

describe("validated construction (fail closed)", () => {
  const base = { ref: "r-1", target: TARGET, method: AI_METHOD, assessedAt: "2026-10-29T10:00:00.000Z" } as const;
  const values = (keys: readonly string[], level: "low" | "medium" | "high" = "high") => ({ kind: "values" as const, values: keys.map((key) => ({ key, confidence: { level, score: null } })), reasonCodes: [] });

  it("rejects unknown values, cardinality breaks, duplicates and an exclusive none combined", () => {
    expect(createAssessment({ ...base, dimension: "intent", content: values(["expensive_price"]) })).toEqual({ ok: false, violations: ["VALUE_UNKNOWN"] });
    expect(createAssessment({ ...base, dimension: "sentiment", content: values(["negative", "positive"]) })).toMatchObject({ ok: false, violations: ["CARDINALITY_VIOLATION"] });
    expect(createAssessment({ ...base, dimension: "intent", content: values(["praise", "praise"]) })).toMatchObject({ ok: false, violations: ["VALUE_DUPLICATE"] });
    expect(createAssessment({ ...base, dimension: "safety", content: values(["none", "obvious_spam"]) })).toMatchObject({ ok: false, violations: ["EXCLUSIVE_VALUE_COMBINED"] });
    expect(createAssessment({ ...base, dimension: "toxicity", content: values(["x"]) })).toMatchObject({ ok: false });
    expect(createAssessment({ ...base, dimension: "topics", content: values(["price"]) })).toMatchObject({ ok: false, violations: ["VALUE_UNKNOWN"] });
  });

  it("a rule asserts only the one value it establishes: link reputation → safety.malicious_link, nothing broader", () => {
    expect(RULE_ESTABLISHES).toEqual({ link_reputation_malicious: { dimension: "safety", value: "malicious_link" } });
    expect(createAssessment({ ...base, method: LINK_RULE, dimension: "safety", content: values(["malicious_link"]) }).ok).toBe(true);
    expect(createAssessment({ ...base, method: LINK_RULE, dimension: "safety", content: values(["obvious_spam"]) })).toMatchObject({ ok: false, violations: ["RULE_SCOPE_VIOLATION"] });
    expect(createAssessment({ ...base, method: LINK_RULE, dimension: "safety", content: values(["scam_fraud_content"]) })).toMatchObject({ ok: false, violations: ["RULE_SCOPE_VIOLATION"] });
    expect(createAssessment({ ...base, method: LINK_RULE, dimension: "intent", content: values(["fraud_accusation_against_brand"]) })).toMatchObject({ ok: false, violations: ["RULE_SCOPE_VIOLATION"] });
  });

  it("a watch term is not a rule origin: no rule kind exists for it in any dimension (D-H7-3, S19)", () => {
    const watchRule = { kind: "rule", rule: "watch_term_match", ruleVersion: "ws-rules.v1" } as unknown as RuleMethod;
    for (const dimension of ["safety", "intent", "sentiment", "risk"]) {
      const created = createAssessment({ ...base, method: watchRule, dimension, content: values(dimension === "safety" ? ["scam_fraud_content"] : dimension === "intent" ? ["fraud_accusation_against_brand"] : dimension === "sentiment" ? ["negative"] : ["high"]) });
      expect(created.ok).toBe(false);
      if (!created.ok) expect(created.violations).toContain("METHOD_INVALID");
    }
  });

  it("human values are authoritative (high) and a correction link exists only on human assessments", () => {
    expect(createAssessment({ ...base, method: HUMAN, dimension: "intent", content: values(["praise"], "medium") })).toMatchObject({ ok: false, violations: ["HUMAN_CONFIDENCE_NOT_HIGH"] });
    expect(createAssessment({ ...base, dimension: "intent", content: values(["praise"]), corrects: "x" })).toMatchObject({ ok: false, violations: ["CORRECTION_LINK_INVALID"] });
  });
});

describe("M-05 precedence", () => {
  it("missing ≠ default: no assessment yields `none`, not a negative or neutral value", () => {
    expect(acceptInterpretation("intent", [], TARGET)).toEqual({ status: "none", dimension: "intent", target: TARGET, precedenceVersion: "precedence.m05.v1" });
  });

  it("abstention stays explicit", () => {
    const accepted = acceptInterpretation("intent", [assessment({ dimension: "intent", abstain: "insufficient_evidence" })], TARGET);
    expect(accepted).toMatchObject({ status: "abstained", abstention: "insufficient_evidence", basis: "machine" });
  });

  it("a human correction wins without mutating the older assessment; the result changes by derivation", () => {
    const ai = assessment({ dimension: "intent", values: ["praise"], at: "2026-10-29T10:00:00.000Z" });
    const snapshot = JSON.stringify(ai);
    const before = acceptInterpretation("intent", [ai], TARGET);
    const correction = createHumanCorrection({ ref: "h-10", target: TARGET, dimension: "intent", actor: { kind: "workspace_member", ref: "member-1" }, correction: { kind: "values", keys: ["complaint"] }, assessedAt: "2026-10-29T11:00:00.000Z", corrects: ai.ref });
    expect(correction.ok).toBe(true);
    if (!correction.ok) return;
    const after = acceptInterpretation("intent", [ai, correction.assessment], TARGET);
    expect(before).toMatchObject({ status: "accepted", basis: "machine", values: [{ key: "praise" }] });
    expect(after).toMatchObject({ status: "accepted", basis: "human", values: [{ key: "complaint", provenance: "human" }] });
    expect(JSON.stringify(ai)).toBe(snapshot);
    expect(correction.assessment.corrects).toBe(ai.ref);
  });

  it("a newer model result does not beat human authority", () => {
    const human = assessment({ dimension: "intent", values: ["complaint"], method: HUMAN, at: "2026-10-29T10:00:00.000Z" });
    const newerAi = assessment({ dimension: "intent", values: ["praise"], at: "2026-10-30T10:00:00.000Z" });
    expect(acceptInterpretation("intent", [human, newerAi], TARGET)).toMatchObject({ basis: "human", values: [{ key: "complaint" }] });
  });

  it("a human correction made on an earlier text version still wins, and says so (M-09 stays OPEN)", () => {
    const human = assessment({ dimension: "intent", values: ["complaint"], method: HUMAN, target: TARGET });
    const aiOnEdit = assessment({ dimension: "intent", values: ["praise"], target: EDITED_TARGET, at: "2026-10-30T10:00:00.000Z" });
    expect(acceptInterpretation("intent", [human, aiOnEdit], EDITED_TARGET)).toMatchObject({ status: "accepted", basis: "human", humanOnEarlierVersion: true, values: [{ key: "complaint" }] });
  });

  it("the latest human assessment wins among humans (undo is a further human assessment)", () => {
    const first = assessment({ dimension: "intent", values: ["complaint"], method: HUMAN, at: "2026-10-29T10:00:00.000Z" });
    const undo = assessment({ dimension: "intent", values: ["praise"], method: HUMAN, at: "2026-10-29T12:00:00.000Z" });
    expect(acceptInterpretation("intent", [undo, first], TARGET)).toMatchObject({ basis: "human", values: [{ key: "praise" }] });
  });

  it("AI assessments of an earlier text version don't decide the current one", () => {
    const old = assessment({ dimension: "intent", values: ["praise"], target: TARGET });
    expect(acceptInterpretation("intent", [old], EDITED_TARGET).status).toBe("none");
  });

  it("the latest AI assessment of the current version wins over an older one", () => {
    const older = assessment({ dimension: "sentiment", values: ["positive"], at: "2026-10-29T10:00:00.000Z" });
    const newer = assessment({ dimension: "sentiment", values: ["negative"], at: "2026-10-29T11:00:00.000Z", method: { ...AI_METHOD, taskVersion: "2" } });
    expect(acceptInterpretation("sentiment", [older, newer], TARGET)).toMatchObject({ values: [{ key: "negative" }] });
  });

  it("a deterministic malicious-link fact wins only for that value; AI decides the rest of the dimension", () => {
    const rule = assessment({ dimension: "safety", values: ["malicious_link"], method: LINK_RULE });
    const ai = assessment({ dimension: "safety", values: ["obvious_spam"] });
    const accepted = acceptInterpretation("safety", [ai, rule], TARGET);
    expect(accepted).toMatchObject({ status: "accepted", basis: "machine", conflict: false });
    if (accepted.status === "accepted") expect(accepted.values.map((v) => `${v.key}:${v.provenance}`).sort()).toEqual(["malicious_link:deterministic_rule", "obvious_spam:ai_model"]);
  });

  it("a rule fact that contradicts an AI `none` is accepted with a conflict flag", () => {
    const rule = assessment({ dimension: "safety", values: ["malicious_link"], method: LINK_RULE });
    const ai = assessment({ dimension: "safety", values: ["none"] });
    const accepted = acceptInterpretation("safety", [ai, rule], TARGET);
    expect(accepted).toMatchObject({ status: "accepted", conflict: true });
    if (accepted.status === "accepted") expect(accepted.values.map((v) => v.key)).toEqual(["malicious_link"]);
  });

  it("a rule never decides another dimension: the link fact leaves intent to AI", () => {
    const intent = acceptInterpretation("intent", [assessment({ dimension: "intent", values: ["fraud_accusation_against_brand"] })], TARGET);
    expect(intent).toMatchObject({ basis: "machine", values: [{ key: "fraud_accusation_against_brand", provenance: "ai_model" }] });
  });

  it("a platform hint counts only when there is no AI assessment", () => {
    const hint = assessment({ dimension: "safety", values: ["obvious_spam"], method: HINT });
    expect(acceptInterpretation("safety", [hint], TARGET)).toMatchObject({ values: [{ key: "obvious_spam", provenance: "platform_hint" }] });
    const ai = assessment({ dimension: "safety", values: ["none"] });
    expect(acceptInterpretation("safety", [hint, ai], TARGET)).toMatchObject({ values: [{ key: "none", provenance: "ai_model" }] });
  });

  it("candidates of another interaction or dimension are a caller bug (throws)", () => {
    expect(() => acceptInterpretation("intent", [assessment({ dimension: "intent", values: ["praise"], target: OTHER_INTERACTION })], TARGET)).toThrow("precedence_candidate_out_of_scope");
    expect(() => acceptInterpretation("intent", [assessment({ dimension: "sentiment", values: ["neutral"] })], TARGET)).toThrow("precedence_candidate_out_of_scope");
  });

  it("is deterministic for equal timestamps (identity-key tie break)", () => {
    const a = assessment({ dimension: "sentiment", values: ["positive"], ref: nextRef(), method: { ...AI_METHOD, taskVersion: "a" } });
    const b = assessment({ dimension: "sentiment", values: ["negative"], ref: nextRef(), method: { ...AI_METHOD, taskVersion: "b" } });
    expect(acceptInterpretation("sentiment", [a, b], TARGET)).toEqual(acceptInterpretation("sentiment", [b, a], TARGET));
  });
});

describe("human correction contract", () => {
  it("creates a new human assessment with high confidence, or an explicit human abstention", () => {
    const created = createHumanCorrection({ ref: "h-20", target: TARGET, dimension: "safety", actor: { kind: "workspace_member", ref: "member-2" }, correction: { kind: "values", keys: ["none"] }, assessedAt: "2026-10-29T10:00:00.000Z" });
    expect(created).toMatchObject({ ok: true, assessment: { method: { kind: "human" }, content: { kind: "values", values: [{ key: "none", confidence: { level: "high" } }] } } });
    const abstained = createHumanCorrection({ ref: "h-21", target: TARGET, dimension: "intent", actor: { kind: "workspace_member", ref: "member-2" }, correction: { kind: "abstained", abstention: "insufficient_evidence" }, assessedAt: "2026-10-29T10:00:00.000Z" });
    expect(abstained).toMatchObject({ ok: true, assessment: { content: { kind: "abstained" } } });
  });

  it("refuses an actor without an identity and unknown values", () => {
    expect(createHumanCorrection({ ref: "h-22", target: TARGET, dimension: "intent", actor: { kind: "workspace_member", ref: "" }, correction: { kind: "values", keys: ["complaint"] }, assessedAt: "2026-10-29T10:00:00.000Z" })).toMatchObject({ ok: false, violations: ["METHOD_INVALID"] });
    expect(createHumanCorrection({ ref: "h-23", target: TARGET, dimension: "intent", actor: { kind: "workspace_member", ref: "m" }, correction: { kind: "values", keys: ["valuable"] }, assessedAt: "2026-10-29T10:00:00.000Z" })).toMatchObject({ ok: false, violations: ["VALUE_UNKNOWN"] });
  });
});
