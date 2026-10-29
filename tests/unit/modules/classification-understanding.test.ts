/** Step H7-A1 — language contract, the bounded input contract and the strict structured-output validator (pure). */
import { describe, expect, it } from "vitest";
import {
  UNDERSTANDING_INPUT_BOUNDS,
  UNDERSTANDING_OUTPUT_SCHEMA_VERSION,
  buildUnderstandingInput,
  capConfidence,
  excerpt,
  languageResultOf,
  languageSupport,
  maxSemanticConfidence,
  nextStepAfterValidation,
  parseLanguageTag,
  toAiAssessments,
  validateUnderstandingOutput,
  type LanguageResult,
  type LanguageTag,
} from "@/modules/classification";
import { AI_METHOD, TARGET, corpusItem } from "../../support/classification-corpus";

const tags = (...values: string[]): readonly LanguageTag[] => values.map((v) => {
  const tag = parseLanguageTag(v);
  if (tag === undefined) throw new Error(v);
  return tag;
});

describe("language contract and confidence policy (D-H7-5)", () => {
  it("parses a BCP-47 subset to canonical case; fails closed on other forms", () => {
    expect(parseLanguageTag("ES-cl")).toBe("es-CL");
    expect(parseLanguageTag("pt-br")).toBe("pt-BR");
    expect(parseLanguageTag("zh-hant-TW")).toBe("zh-Hant-TW");
    expect(parseLanguageTag("es-419")).toBe("es-419");
    for (const bad of ["", "e", "english", "en-US-x-private", "es_CL", 42]) expect(parseLanguageTag(bad)).toBeUndefined();
  });

  it("validated: es (any region), pt-BR, en (any region) and clear mixes; otherwise capped at medium", () => {
    const detected = (certainty: "certain" | "uncertain", ...values: string[]): LanguageResult => ({ kind: "detected", languages: tags(...values), certainty });
    expect(languageSupport(detected("certain", "es-AR"))).toBe("validated");
    expect(languageSupport(detected("certain", "en", "es"))).toBe("validated_mixed");
    expect(languageSupport(detected("certain", "pt-BR", "es"))).toBe("validated_mixed");
    expect(languageSupport(detected("certain", "pt"))).toBe("unsupported");
    expect(languageSupport(detected("certain", "pt-PT"))).toBe("unsupported");
    expect(languageSupport(detected("certain", "fr"))).toBe("unsupported");
    expect(languageSupport(detected("certain", "es", "fr"))).toBe("unsupported");
    expect(languageSupport(detected("uncertain", "es"))).toBe("uncertain");
    expect(languageSupport({ kind: "unknown" })).toBe("unknown");
    expect(maxSemanticConfidence(detected("certain", "es"))).toBe("high");
    expect(maxSemanticConfidence(detected("certain", "en", "es"))).toBe("high");
    for (const result of [detected("certain", "fr"), detected("uncertain", "es"), { kind: "unknown" } as const]) expect(maxSemanticConfidence(result)).toBe("medium");
  });

  it("capping keeps the score as evidence and never raises a level", () => {
    expect(capConfidence({ level: "high", score: 0.97 }, "medium")).toEqual({ level: "medium", score: 0.97 });
    expect(capConfidence({ level: "low", score: null }, "medium")).toEqual({ level: "low", score: null });
  });
});

describe("bounded input contract", () => {
  const base = { interactionKind: "comment", platform: "instagram", source: "paid", text: "¿Precio?", linkPresent: false };

  it("a top-level comment carries text + caption excerpt; no parent/root", () => {
    const built = buildUnderstandingInput({ ...base, captionText: "Nueva colección" });
    expect(built).toMatchObject({ ok: true, input: { interactionKind: "comment", parentExcerpt: null, rootExcerpt: null, captionExcerpt: "Nueva colección", hints: { linkPresent: false, parentByOwnBrand: null, rootByOwnBrand: null } } });
    expect(buildUnderstandingInput({ ...base, parentText: "x" })).toEqual({ ok: false, violations: ["PARENT_NOT_ALLOWED"] });
  });

  it("a reply requires its parent; parent/root/caption are bounded excerpts (grapheme-safe); the analyzed text is never truncated", () => {
    expect(buildUnderstandingInput({ ...base, interactionKind: "reply" })).toEqual({ ok: false, violations: ["PARENT_REQUIRED"] });
    const longParent = "a".repeat(999) + "👍🏽" + "b".repeat(50);
    const built = buildUnderstandingInput({ ...base, interactionKind: "reply", parentText: longParent, rootText: "r".repeat(900), captionText: "c".repeat(900), parentByOwnBrand: true });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input.parentExcerpt).toBe("a".repeat(999));
    expect(built.input.rootExcerpt).toHaveLength(UNDERSTANDING_INPUT_BOUNDS.rootExcerptChars);
    expect(built.input.captionExcerpt).toHaveLength(UNDERSTANDING_INPUT_BOUNDS.captionExcerptChars);
    expect(built.input.hints.parentByOwnBrand).toBe(true);
    expect(excerpt("ab👨‍👩‍👧", 5)).toBe("ab");
    expect(buildUnderstandingInput({ ...base, text: "x".repeat(UNDERSTANDING_INPUT_BOUNDS.maxAnalyzedTextLength + 1) })).toEqual({ ok: false, violations: ["TEXT_TOO_LARGE"] });
  });

  it("by construction carries no author, handle, profile, credential, raw body or watch-term field", () => {
    const smuggled = { ...base, authorName: "Ana", handle: "@ana", profileId: "123", accessToken: "secret", rawBody: "{}", watchTermMatches: ["estafa"] } as Parameters<typeof buildUnderstandingInput>[0];
    const built = buildUnderstandingInput(smuggled);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(Object.keys(built.input).sort()).toEqual(["brandName", "captionExcerpt", "contractVersion", "hints", "interactionKind", "parentExcerpt", "platform", "rootExcerpt", "source", "taxonomyVersion", "text", "validatedLanguages"]);
    expect(Object.keys(built.input.hints).sort()).toEqual(["linkPresent", "parentByOwnBrand", "rootByOwnBrand"]);
    expect(JSON.stringify(built.input)).not.toMatch(/Ana|@ana|secret|estafa/);
  });

  it("social text is an opaque data field: an injection attempt is carried verbatim and changes nothing else", () => {
    const injection = corpusItem("en_prompt_injection").text;
    const a = buildUnderstandingInput({ ...base, text: injection });
    const b = buildUnderstandingInput({ ...base, text: "How much is it?" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.input.text).toBe(injection);
    expect({ ...a.input, text: null }).toEqual({ ...b.input, text: null });
  });

  it("validates platform, source and kind (closed vocabularies)", () => {
    expect(buildUnderstandingInput({ ...base, platform: "x", source: "boosted", interactionKind: "dm" })).toEqual({ ok: false, violations: ["KIND_INVALID", "PLATFORM_INVALID", "SOURCE_INVALID"] });
  });
});

const TEXT = "Muy caro el precio, ¿hay descuento? 🔥";
const valid = () => ({
  schemaVersion: UNDERSTANDING_OUTPUT_SCHEMA_VERSION,
  taxonomyVersion: "taxonomy.v1",
  dimensions: {
    intent: { status: "assessed", values: [{ key: "price_objection", confidence: "high", score: 0.91 }, { key: "purchase_question", confidence: "medium" }] },
    sentiment: { status: "assessed", values: [{ key: "negative", confidence: "high" }] },
    safety: { status: "assessed", values: [{ key: "none", confidence: "high" }] },
    risk: { status: "assessed", values: [{ key: "low", confidence: "medium" }], reasonCodes: [] },
    response_need: { status: "insufficient_evidence" },
    language: { status: "assessed", languages: ["es"], certainty: "certain", confidence: "high" },
  },
  summary: "Objeta el precio y pregunta por descuento.",
  evidence: [{ quote: "Muy caro el precio" }, { quote: "🔥" }],
});

describe("structured output validator (closed, fail closed)", () => {
  it("accepts a valid output; evidence quotes become source spans; abstention stays explicit", () => {
    const result = validateUnderstandingOutput(valid(), TEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.evidence.map((s) => TEXT.slice(s.start, s.end))).toEqual(["Muy caro el precio", "🔥"]);
    expect(result.output.dimensions.response_need).toEqual({ status: "insufficient_evidence" });
    expect(result.output.dimensions.intent).toMatchObject({ status: "assessed", values: [{ key: "price_objection", confidence: { level: "high", score: 0.91 } }, { key: "purchase_question", confidence: { level: "medium", score: null } }] });
    expect(JSON.stringify(result.output)).not.toContain("Muy caro el precio,");
  });

  const broken = (mutate: (o: ReturnType<typeof valid>) => unknown): readonly string[] => {
    const result = validateUnderstandingOutput(mutate(valid()), TEXT);
    return result.ok ? [] : result.failure.issues;
  };

  it.each([
    ["chain-of-thought key", (o: ReturnType<typeof valid>) => ({ ...o, reasoning: "first I think..." }), "UNEXPECTED_KEY"],
    ["thinking inside a dimension", (o: ReturnType<typeof valid>) => ({ ...o, dimensions: { ...o.dimensions, sentiment: { ...o.dimensions.sentiment, thinking: "x" } } }), "UNEXPECTED_KEY"],
    ["unknown dimension (toxicity)", (o: ReturnType<typeof valid>) => ({ ...o, dimensions: { ...o.dimensions, toxicity: { status: "none_fits" } } }), "UNKNOWN_DIMENSION"],
    ["topics are task C, not task A", (o: ReturnType<typeof valid>) => ({ ...o, dimensions: { ...o.dimensions, topics: { status: "none_fits" } } }), "UNKNOWN_DIMENSION"],
    ["unknown value", (o: ReturnType<typeof valid>) => ({ ...o, dimensions: { ...o.dimensions, intent: { status: "assessed", values: [{ key: "expensive_price", confidence: "high" }] } } }), "UNKNOWN_VALUE"],
    ["single-valued with two values", (o: ReturnType<typeof valid>) => ({ ...o, dimensions: { ...o.dimensions, sentiment: { status: "assessed", values: [{ key: "negative", confidence: "high" }, { key: "positive", confidence: "low" }] } } }), "CARDINALITY_VIOLATION"],
    ["exclusive none combined", (o: ReturnType<typeof valid>) => ({ ...o, dimensions: { ...o.dimensions, safety: { status: "assessed", values: [{ key: "none", confidence: "high" }, { key: "obvious_spam", confidence: "low" }] } } }), "EXCLUSIVE_VALUE_COMBINED"],
    ["duplicate value", (o: ReturnType<typeof valid>) => ({ ...o, dimensions: { ...o.dimensions, intent: { status: "assessed", values: [{ key: "praise", confidence: "high" }, { key: "praise", confidence: "low" }] } } }), "DUPLICATE_VALUE"],
    ["confidence outside the closed set", (o: ReturnType<typeof valid>) => ({ ...o, dimensions: { ...o.dimensions, sentiment: { status: "assessed", values: [{ key: "negative", confidence: "very_high" }] } } }), "CONFIDENCE_INVALID"],
    ["score out of range", (o: ReturnType<typeof valid>) => ({ ...o, dimensions: { ...o.dimensions, sentiment: { status: "assessed", values: [{ key: "negative", confidence: "high", score: 1.5 }] } } }), "SCORE_INVALID"],
    ["unknown reason code", (o: ReturnType<typeof valid>) => ({ ...o, dimensions: { ...o.dimensions, risk: { status: "assessed", values: [{ key: "low", confidence: "high" }], reasonCodes: ["vibes"] } } }), "REASON_CODE_INVALID"],
    ["invalid language tag", (o: ReturnType<typeof valid>) => ({ ...o, dimensions: { ...o.dimensions, language: { status: "assessed", languages: ["spanish"], certainty: "certain", confidence: "high" } } }), "LANGUAGE_TAG_INVALID"],
    ["status outside the closed set", (o: ReturnType<typeof valid>) => ({ ...o, dimensions: { ...o.dimensions, risk: { status: "maybe" } } }), "STATUS_INVALID"],
    ["summary too long", (o: ReturnType<typeof valid>) => ({ ...o, summary: "x".repeat(241) }), "SUMMARY_INVALID"],
    ["summary with control characters", (o: ReturnType<typeof valid>) => ({ ...o, summary: "ok\u0007" }), "SUMMARY_INVALID"],
    ["quote not in the analyzed text", (o: ReturnType<typeof valid>) => ({ ...o, evidence: [{ quote: "muy barato" }] }), "QUOTE_NOT_IN_TEXT"],
    ["too many quotes", (o: ReturnType<typeof valid>) => ({ ...o, evidence: [{ quote: "Muy" }, { quote: "caro" }, { quote: "el" }, { quote: "precio" }] }), "EVIDENCE_INVALID"],
    ["schema version mismatch", (o: ReturnType<typeof valid>) => ({ ...o, schemaVersion: "understanding-output.v0" }), "SCHEMA_VERSION_MISMATCH"],
    ["taxonomy version mismatch", (o: ReturnType<typeof valid>) => ({ ...o, taxonomyVersion: "taxonomy.v0" }), "TAXONOMY_VERSION_MISMATCH"],
    ["not an object", () => "plain text answer", "NOT_AN_OBJECT"],
  ])("rejects %s", (_name, mutate, issue) => {
    expect(broken(mutate)).toContain(issue);
  });

  it("re-ask once, then no assessment", () => {
    const invalid = validateUnderstandingOutput({ nope: true }, TEXT);
    expect(nextStepAfterValidation(1, invalid)).toBe("reask");
    expect(nextStepAfterValidation(2, invalid)).toBe("no_assessment");
    expect(nextStepAfterValidation(1, validateUnderstandingOutput(valid(), TEXT))).toBe("accept");
  });

  it("toAiAssessments: validated language keeps levels; unsupported/uncertain/absent language caps semantic values at medium", () => {
    const refs = { safety: "r-s", authenticity: "r-a", intent: "r-i", sentiment: "r-se", risk: "r-r", response_need: "r-n", language: "r-l" };
    const at = "2026-10-29T10:00:00.000Z" as Parameters<typeof toAiAssessments>[1]["assessedAt"];
    const levels = (raw: unknown) => {
      const result = validateUnderstandingOutput(raw, TEXT);
      if (!result.ok) throw new Error(result.failure.issues.join(","));
      return toAiAssessments(result.output, { target: TARGET, method: AI_METHOD, assessedAt: at, refs })
        .filter((a) => a.dimension !== "language")
        .flatMap((a) => (a.content.kind === "values" ? a.content.values.map((v) => `${a.dimension}.${v.key}:${v.confidence.level}`) : [`${a.dimension}:${a.content.abstention}`]));
    };
    expect(levels(valid())).toEqual(["safety.none:high", "intent.price_objection:high", "intent.purchase_question:medium", "sentiment.negative:high", "risk.low:medium", "response_need:insufficient_evidence"]);
    const french = { ...valid(), dimensions: { ...valid().dimensions, language: { status: "assessed", languages: ["fr"], certainty: "certain", confidence: "high" } } };
    expect(levels(french)).toEqual(["safety.none:medium", "intent.price_objection:medium", "intent.purchase_question:medium", "sentiment.negative:medium", "risk.low:medium", "response_need:insufficient_evidence"]);
    const uncertain = { ...valid(), dimensions: { ...valid().dimensions, language: { status: "assessed", languages: ["es"], certainty: "uncertain", confidence: "medium" } } };
    expect(levels(uncertain).every((entry) => !entry.endsWith(":high"))).toBe(true);
    const withoutLanguage: Partial<ReturnType<typeof valid>["dimensions"]> = { ...valid().dimensions };
    delete withoutLanguage.language;
    expect(levels({ ...valid(), dimensions: withoutLanguage }).every((entry) => !entry.endsWith(":high"))).toBe(true);
  });

  it("the output's language result feeds the policy (none ⇒ unknown)", () => {
    const result = validateUnderstandingOutput({ ...valid(), dimensions: { intent: valid().dimensions.intent } }, TEXT);
    if (!result.ok) throw new Error("unexpected");
    expect(languageResultOf(result.output)).toEqual({ kind: "unknown" });
  });
});
