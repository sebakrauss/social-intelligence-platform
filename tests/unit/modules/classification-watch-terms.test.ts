/** Step H7-A1 — watch-term normalization and the deterministic token matcher; deterministic signals (pure). */
import { describe, expect, it } from "vitest";
import {
  WATCH_TERM_MATCHER_VERSION,
  WATCH_TERM_TECHNICAL_BOUNDS,
  acceptInterpretation,
  compileWatchTerms,
  detectLinks,
  detectTextSignals,
  isEmojiOnly,
  matchWatchTerms,
  normalizeToken,
  ownBrandSignal,
  tokenize,
  watchTermSignals,
  type WatchTermRuleSet,
} from "@/modules/classification";
import { TARGET, corpusItem } from "../../support/classification-corpus";

const compile = (ruleSet: Partial<WatchTermRuleSet> & Pick<WatchTermRuleSet, "terms">) => {
  const result = compileWatchTerms({ ruleSetVersion: "ws-rules.v1", ...ruleSet });
  if (!result.ok) throw new Error(result.violations.join(","));
  return result.compiled;
};

const spans = (ruleSet: Partial<WatchTermRuleSet> & Pick<WatchTermRuleSet, "terms">, text: string): string[] => {
  const result = matchWatchTerms(compile(ruleSet), text);
  if (!result.ok) throw new Error(result.reason);
  return result.hits.flatMap((hit) => hit.occurrences.map((o) => `${hit.termId}:${text.slice(o.start, o.end)}@${String(o.start)}`));
};

const precio = { terms: [{ termId: "t-precio", phrases: ["precio"] }] };

describe("normalization (derived match form only)", () => {
  it("NFKC + lower-casing + accent folding on Latin; accent-sensitive opt-out keeps marks", () => {
    expect(normalizeToken("PRÉCIO", false)).toBe("precio");
    expect(normalizeToken("précio", false)).toBe("precio");
    expect(normalizeToken("ＰＲＥＣＩＯ", false)).toBe("precio");
    expect(normalizeToken("PREÇO", false)).toBe("preco");
    expect(normalizeToken("Año", true)).toBe("año");
    expect(normalizeToken("Año", false)).toBe("ano");
  });

  it("the source text is never modified", () => {
    const text = "¿Cuál es el PRÉCIO?";
    const copy = text.slice();
    matchWatchTerms(compile(precio), text);
    expect(text).toBe(copy);
  });
});

describe("token-exact matching", () => {
  it("`precio` matches the word, never inside `preciosa` or `aprecio`", () => {
    expect(spans(precio, "¿Cuál es el precio?")).toEqual(["t-precio:precio@12"]);
    expect(spans(precio, corpusItem("watch_term_false_positive").text)).toEqual([]);
    expect(spans(precio, "precio2024 precios precio_caro")).toEqual([]);
  });

  it("case, accents, punctuation and repeated whitespace", () => {
    expect(spans(precio, "¡¡PRECIO!!")).toEqual(["t-precio:PRECIO@2"]);
    expect(spans(precio, "el précio,  ¿cuánto?")).toEqual(["t-precio:précio@3"]);
    expect(spans({ terms: [{ termId: "p", phrases: ["precio caro"] }] }, "precio    caro / precio\ncaro / precio, caro / precio muy caro")).toEqual(["p:precio    caro@0", "p:precio\ncaro@17", "p:precio, caro@31"]);
  });

  it("emoji adjacent to a term, and emoji terms", () => {
    expect(spans(precio, "precio🔥🔥")).toEqual(["t-precio:precio@0"]);
    expect(spans({ terms: [{ termId: "fire", phrases: ["🔥"] }] }, "precio🔥 ok 🔥")).toEqual(["fire:🔥@6", "fire:🔥@12"]);
    expect(spans({ terms: [{ termId: "family", phrases: ["👨‍👩‍👧"] }] }, "hola 👨‍👩‍👧!")).toEqual(["family:👨‍👩‍👧@5"]);
  });

  it("Portuguese, English and mixed-language text", () => {
    expect(spans({ terms: [{ termId: "preco", phrases: ["preço"] }] }, "Qual é o PREÇO? e o preco?")).toEqual(["preco:PREÇO@9", "preco:preco@20"]);
    expect(spans({ terms: [{ termId: "price", phrases: ["price"] }] }, "Priceless. What's the price?")).toEqual(["price:price@22"]);
    expect(spans(precio, "Love it pero el precio es alto")).toEqual(["t-precio:precio@16"]);
  });

  it("explicit variants (phraseIndex) and accent-sensitive terms", () => {
    const result = matchWatchTerms(compile({ terms: [{ termId: "t", phrases: ["precio", "precios"] }] }), "precios y precio");
    expect(result).toMatchObject({ ok: true, hits: [{ termId: "t", occurrences: [{ start: 0, end: 7, phraseIndex: 1 }, { start: 10, end: 16, phraseIndex: 0 }] }] });
    expect(spans({ terms: [{ termId: "ano", phrases: ["año"], accentSensitive: true }] }, "el ano y el año")).toEqual(["ano:año@12"]);
  });

  it("exclude phrases suppress the term in the same text", () => {
    const rules = { terms: [{ termId: "estafa", phrases: ["estafa"], excludes: ["no es estafa"] }] };
    expect(spans(rules, "Esto es una estafa")).toEqual(["estafa:estafa@12"]);
    expect(spans(rules, "Tranquilos, esto no es estafa")).toEqual([]);
  });

  it("hashtags and mentions are excluded by default; a rule set may include them; # / @ terms are refused", () => {
    expect(spans(precio, "#precio @precio precio")).toEqual(["t-precio:precio@16"]);
    expect(spans({ ...precio, hashtags: "include" }, "#precio @precio")).toEqual(["t-precio:precio@1"]);
    expect(spans({ ...precio, mentions: "include" }, "#precio @precio")).toEqual(["t-precio:precio@9"]);
    expect(compileWatchTerms({ ruleSetVersion: "v", terms: [{ termId: "h", phrases: ["#precio"] }] })).toEqual({ ok: false, violations: ["PHRASE_HASHTAG_OR_MENTION_UNSUPPORTED"] });
  });
});

describe("evidence: source offsets under Unicode", () => {
  it("offsets are UTF-16 code units of the SOURCE text, for emoji, fullwidth and decomposed accents", () => {
    for (const text of ["👨‍👩‍👧 precio", "ＰＲＥＣＩＯ", "précio ya", "🔥precio"]) {
      const result = matchWatchTerms(compile(precio), text);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const [occurrence] = result.hits[0]?.occurrences ?? [];
      expect(occurrence).toBeDefined();
      if (occurrence === undefined) continue;
      expect(normalizeToken(text.slice(occurrence.start, occurrence.end), false)).toBe("precio");
    }
    const decomposed = matchWatchTerms(compile(precio), "précio");
    expect(decomposed).toMatchObject({ ok: true, hits: [{ occurrences: [{ start: 0, end: 7 }] }] });
  });

  it("a signal carries rule identity, matcher version and spans — never the text", () => {
    const result = matchWatchTerms(compile(precio), "El precio, el precio.");
    if (!result.ok) throw new Error("unexpected");
    const [signal] = watchTermSignals(result.hits, "ws-rules.v1");
    expect(signal).toEqual({ kind: "watch_term_match", termId: "t-precio", ruleSetVersion: "ws-rules.v1", matcherVersion: WATCH_TERM_MATCHER_VERSION, spans: [{ start: 3, end: 9 }, { start: 14, end: 20 }], truncated: false });
    expect(JSON.stringify(signal)).not.toContain("precio,");
  });

  it("hits are sorted by term id (deterministic)", () => {
    const result = matchWatchTerms(compile({ terms: [{ termId: "z", phrases: ["b"] }, { termId: "a", phrases: ["a"] }] }), "a b");
    expect(result).toMatchObject({ ok: true, hits: [{ termId: "a" }, { termId: "z" }] });
  });
});

describe("watch-term semantics: a signal, never meaning (D-H7-3, S19)", () => {
  it("`estafa` matches an accusation and a warning alike; the match carries no dimension and settles nothing", () => {
    const rules = { terms: [{ termId: "estafa", phrases: ["estafa"] }] };
    const accusation = spans(rules, "Esto es una estafa, pagué y no llegó nada");
    const warning = spans(rules, "Cuidado: ese link es una estafa");
    expect(accusation).toHaveLength(1);
    expect(warning).toHaveLength(1);
    const result = matchWatchTerms(compile(rules), "Esto es una estafa");
    if (!result.ok) throw new Error("unexpected");
    const [signal] = watchTermSignals(result.hits, "ws-rules.v1");
    expect(Object.keys(signal ?? {}).sort()).toEqual(["kind", "matcherVersion", "ruleSetVersion", "spans", "termId", "truncated"]);
    // With only a watch-term signal there is no assessment at all: safety and intent stay unassessed.
    expect(acceptInterpretation("safety", [], TARGET).status).toBe("none");
    expect(acceptInterpretation("intent", [], TARGET).status).toBe("none");
  });

  it("`precio` matches both a price inquiry and a price objection: the keyword can't tell them apart", () => {
    expect(spans(precio, corpusItem("es_price_inquiry").text)).toHaveLength(1);
    expect(spans(precio, corpusItem("es_price_objection").text)).toHaveLength(1);
  });
});

describe("technical bounds (defensive maxima, not product limits)", () => {
  it("refuses invalid rule sets as a whole", () => {
    const bad = compileWatchTerms({ ruleSetVersion: "", terms: [{ termId: "", phrases: [] }, { termId: "x", phrases: ["!!!"] }, { termId: "x", phrases: ["a".repeat(300)] }, { termId: "y", phrases: [Array.from({ length: 17 }, (_, i) => `w${String(i)}`).join(" ")] }] });
    expect(bad).toEqual({ ok: false, violations: ["RULE_SET_VERSION_INVALID", "TERM_ID_INVALID", "TERM_ID_DUPLICATE", "NO_PHRASES", "PHRASE_TOO_LONG", "PHRASE_EMPTY", "PHRASE_TOO_MANY_TOKENS"] });
    expect(compileWatchTerms({ ruleSetVersion: "v", terms: [{ termId: "v", phrases: Array.from({ length: 33 }, (_, i) => `w${String(i)}`) }] })).toEqual({ ok: false, violations: ["TOO_MANY_VARIANTS"] });
  });

  it("refuses text beyond the technical bound instead of truncating silently", () => {
    expect(matchWatchTerms(compile(precio), "a ".repeat(WATCH_TERM_TECHNICAL_BOUNDS.maxTextLength))).toEqual({ ok: false, reason: "text_too_long" });
  });

  it("bounds occurrences per term and says so", () => {
    const result = matchWatchTerms(compile(precio), "precio ".repeat(60));
    expect(result).toMatchObject({ ok: true, hits: [{ truncated: true }] });
    if (result.ok) expect(result.hits[0]?.occurrences).toHaveLength(WATCH_TERM_TECHNICAL_BOUNDS.maxOccurrencesPerTerm);
  });
});

describe("tokenization", () => {
  it("word tokens and emoji clusters with source offsets and hashtag/mention prefixes", () => {
    expect(tokenize("#hola @ana 👍🏽 ok").map((t) => [t.text, t.start, t.prefix, t.isEmoji])).toEqual([["hola", 1, "hashtag", false], ["ana", 7, "mention", false], ["👍🏽", 11, "none", true], ["ok", 16, "none", false]]);
  });
});

describe("deterministic signals", () => {
  it("links are detected locally as spans (scheme, www., bare domain with path) and never fetched", () => {
    const text = "mira https://ex.com/a y www.ex.org 👉bit.ly/free-prize — pero precio.caro no";
    const signal = detectLinks(text);
    expect(signal?.spans.map((s) => text.slice(s.start, s.end))).toEqual(["https://ex.com/a", "www.ex.org", "bit.ly/free-prize"]);
    expect(detectLinks("precio.caro y a@b.com")).toBeUndefined();
  });

  it("empty, emoji-only and own-brand flags", () => {
    expect(detectTextSignals("   ")).toEqual([{ kind: "text_empty" }]);
    expect(detectTextSignals(corpusItem("emoji_only").text)).toEqual([{ kind: "text_emoji_only" }]);
    expect(isEmojiOnly("🔥 ok")).toBe(false);
    expect(isEmojiOnly("")).toBe(false);
    expect(ownBrandSignal("account_identity")).toEqual({ kind: "author_own_brand" });
    expect(ownBrandSignal("user")).toBeUndefined();
  });

  it("signals have no dimension or value (facts, not taxonomy meaning)", () => {
    for (const signal of detectTextSignals("hola www.ex.com")) expect(Object.keys(signal).some((key) => key === "dimension" || key === "values" || key === "confidence")).toBe(false);
  });
});
