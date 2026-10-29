/**
 * Workspace watch terms: normalization and the deterministic token matcher (Step H7-A1; H7-A0 §7.2–§7.3, D-H7-3).
 * Pure; no regex built from user input; linear in the number of tokens per candidate phrase.
 *
 * A term is a single word or a phrase (a contiguous token sequence) plus explicit variants (`precio`, `precios`) and
 * optional exclude phrases (the term does not match when an exclude phrase occurs in the same text). No regex, no
 * wildcard, no substring, no stemming in v1.
 *
 * Normalization (applied identically to term tokens and text tokens, into a derived match form ONLY — the source text is
 * never modified): NFKC → locale-independent lower-casing → accent folding (default on: combining marks following a
 * Latin base letter are removed; `accentSensitive: true` opts a term out) → NFC.
 *
 * Matching is token-exact: `precio` matches "¿Cuál es el precio?" and "¡PRECIO!" but never "preciosa" or "aprecio".
 * Hashtag (`#precio`) and mention (`@precio`) tokens are EXCLUDED by default — their behavior is a later product
 * decision; a rule set may include them explicitly. Terms containing `#`/`@` are refused in v1 for the same reason.
 *
 * The outcome is a `watch_term_match` signal only (signals.ts): it never assigns a dimension value, never changes an
 * accepted interpretation, a Protection Evaluation or a priority/value result, and is never sent to an AI task.
 *
 * Bounds: WATCH_TERM_TECHNICAL_BOUNDS are defensive maxima of the pure matcher (input safety), NOT product limits; the
 * product-configurable limits (H7-A0 §7.2: ≤ 200 terms, ≤ 64 characters, ≤ 6 tokens, ≤ 20 variants) stay PROPOSED.
 */
import { tokenize, type SourceSpan, type TextToken } from "./text-segments";

export const WATCH_TERM_MATCHER_VERSION = "watch-term-matcher.v1" as const;

export const WATCH_TERM_TECHNICAL_BOUNDS = Object.freeze({
  maxTextLength: 32_768,
  maxTermIdLength: 128,
  maxRuleSetVersionLength: 128,
  maxPhraseLength: 256,
  maxTokensPerPhrase: 16,
  maxPhrasesPerTerm: 32,
  maxExcludesPerTerm: 32,
  maxTermsPerRuleSet: 1_000,
  maxPhrasesPerRuleSet: 8_192,
  maxOccurrencesPerTerm: 50,
});

export type PrefixPolicy = "exclude" | "include";

export interface WatchTermDefinition {
  /** The caller's stable term identity (opaque). */
  readonly termId: string;
  /** The term and its explicit variants (≥ 1). */
  readonly phrases: readonly string[];
  readonly excludes?: readonly string[];
  readonly accentSensitive?: boolean;
}

export interface WatchTermRuleSet {
  readonly ruleSetVersion: string;
  readonly terms: readonly WatchTermDefinition[];
  readonly hashtags?: PrefixPolicy;
  readonly mentions?: PrefixPolicy;
}

export const WATCH_TERM_VIOLATIONS = [
  "RULE_SET_VERSION_INVALID",
  "TOO_MANY_TERMS",
  "TOO_MANY_PHRASES",
  "TERM_ID_INVALID",
  "TERM_ID_DUPLICATE",
  "NO_PHRASES",
  "PHRASE_TOO_LONG",
  "PHRASE_EMPTY",
  "PHRASE_TOO_MANY_TOKENS",
  "PHRASE_HASHTAG_OR_MENTION_UNSUPPORTED",
  "TOO_MANY_VARIANTS",
  "TOO_MANY_EXCLUDES",
] as const;
export type WatchTermViolation = (typeof WATCH_TERM_VIOLATIONS)[number];

const LATIN = /\p{Script=Latin}/u;
const MARK = /\p{M}/u;

/** The derived match form of one token (never stored as evidence, never shown). */
export function normalizeToken(token: string, accentSensitive: boolean): string {
  const lowered = token.normalize("NFKC").toLowerCase();
  if (accentSensitive) return lowered.normalize("NFC");
  let out = "";
  let lastBaseLatin = false;
  for (const char of lowered.normalize("NFD")) {
    if (MARK.test(char)) {
      if (!lastBaseLatin) out += char;
      continue;
    }
    lastBaseLatin = LATIN.test(char);
    out += char;
  }
  return out.normalize("NFC");
}

interface CompiledPhrase {
  readonly forms: readonly string[];
}

interface CompiledTerm {
  readonly termId: string;
  readonly accentSensitive: boolean;
  readonly phrases: readonly CompiledPhrase[];
  readonly excludes: readonly CompiledPhrase[];
}

export interface CompiledWatchTerms {
  readonly ruleSetVersion: string;
  readonly matcherVersion: typeof WATCH_TERM_MATCHER_VERSION;
  readonly terms: readonly CompiledTerm[];
  readonly hashtags: PrefixPolicy;
  readonly mentions: PrefixPolicy;
}

function compilePhrase(phrase: unknown, accentSensitive: boolean, violations: Set<WatchTermViolation>): CompiledPhrase | undefined {
  if (typeof phrase !== "string" || phrase.length > WATCH_TERM_TECHNICAL_BOUNDS.maxPhraseLength) {
    violations.add("PHRASE_TOO_LONG");
    return undefined;
  }
  if (/[#@＃＠]/u.test(phrase)) {
    violations.add("PHRASE_HASHTAG_OR_MENTION_UNSUPPORTED");
    return undefined;
  }
  const tokens = tokenize(phrase);
  if (tokens.length === 0) {
    violations.add("PHRASE_EMPTY");
    return undefined;
  }
  if (tokens.length > WATCH_TERM_TECHNICAL_BOUNDS.maxTokensPerPhrase) {
    violations.add("PHRASE_TOO_MANY_TOKENS");
    return undefined;
  }
  return Object.freeze({ forms: Object.freeze(tokens.map((token) => normalizeToken(token.text, accentSensitive))) });
}

/** Validates and compiles a workspace rule set (all-or-nothing: any violation refuses the whole set). */
export function compileWatchTerms(ruleSet: WatchTermRuleSet): { readonly ok: true; readonly compiled: CompiledWatchTerms } | { readonly ok: false; readonly violations: readonly WatchTermViolation[] } {
  const violations = new Set<WatchTermViolation>();
  const bounds = WATCH_TERM_TECHNICAL_BOUNDS;
  if (typeof ruleSet.ruleSetVersion !== "string" || ruleSet.ruleSetVersion.length === 0 || ruleSet.ruleSetVersion.length > bounds.maxRuleSetVersionLength) violations.add("RULE_SET_VERSION_INVALID");
  if (ruleSet.terms.length > bounds.maxTermsPerRuleSet) violations.add("TOO_MANY_TERMS");
  const seen = new Set<string>();
  let phraseCount = 0;
  const terms: CompiledTerm[] = [];
  for (const term of ruleSet.terms.slice(0, bounds.maxTermsPerRuleSet)) {
    if (typeof term.termId !== "string" || term.termId.length === 0 || term.termId.length > bounds.maxTermIdLength) violations.add("TERM_ID_INVALID");
    else if (seen.has(term.termId)) violations.add("TERM_ID_DUPLICATE");
    seen.add(term.termId);
    const excludesInput = term.excludes ?? [];
    if (term.phrases.length === 0) violations.add("NO_PHRASES");
    if (term.phrases.length > bounds.maxPhrasesPerTerm) violations.add("TOO_MANY_VARIANTS");
    if (excludesInput.length > bounds.maxExcludesPerTerm) violations.add("TOO_MANY_EXCLUDES");
    phraseCount += term.phrases.length + excludesInput.length;
    const accentSensitive = term.accentSensitive === true;
    const phrases = term.phrases.slice(0, bounds.maxPhrasesPerTerm).map((p) => compilePhrase(p, accentSensitive, violations));
    const excludes = excludesInput.slice(0, bounds.maxExcludesPerTerm).map((p) => compilePhrase(p, accentSensitive, violations));
    terms.push(Object.freeze({
      termId: term.termId,
      accentSensitive,
      phrases: Object.freeze(phrases.filter((p): p is CompiledPhrase => p !== undefined)),
      excludes: Object.freeze(excludes.filter((p): p is CompiledPhrase => p !== undefined)),
    }));
  }
  if (phraseCount > bounds.maxPhrasesPerRuleSet) violations.add("TOO_MANY_PHRASES");
  if (violations.size > 0) return { ok: false, violations: (WATCH_TERM_VIOLATIONS as readonly WatchTermViolation[]).filter((v) => violations.has(v)) };
  return {
    ok: true,
    compiled: Object.freeze({
      ruleSetVersion: ruleSet.ruleSetVersion,
      matcherVersion: WATCH_TERM_MATCHER_VERSION,
      terms: Object.freeze(terms),
      hashtags: ruleSet.hashtags ?? "exclude",
      mentions: ruleSet.mentions ?? "exclude",
    }),
  };
}

export interface WatchTermOccurrence extends SourceSpan {
  /** Index into the term's `phrases` (which variant matched). */
  readonly phraseIndex: number;
}

export interface WatchTermHit {
  readonly termId: string;
  readonly occurrences: readonly WatchTermOccurrence[];
  /** True when more occurrences existed than WATCH_TERM_TECHNICAL_BOUNDS.maxOccurrencesPerTerm. */
  readonly truncated: boolean;
}

interface MatchToken {
  readonly token: TextToken;
  readonly folded: string;
  readonly exact: string;
}

function eligible(token: TextToken, compiled: CompiledWatchTerms): boolean {
  if (token.prefix === "hashtag") return compiled.hashtags === "include";
  if (token.prefix === "mention") return compiled.mentions === "include";
  return true;
}

function occurrencesOf(phrase: CompiledPhrase, tokens: readonly MatchToken[], accentSensitive: boolean, compiled: CompiledWatchTerms, limit: number): { readonly spans: SourceSpan[]; readonly more: boolean } {
  const spans: SourceSpan[] = [];
  const length = phrase.forms.length;
  for (let i = 0; i + length <= tokens.length; i++) {
    let hit = true;
    for (let j = 0; j < length; j++) {
      const candidate = tokens[i + j];
      if (candidate === undefined || !eligible(candidate.token, compiled) || (accentSensitive ? candidate.exact : candidate.folded) !== phrase.forms[j]) {
        hit = false;
        break;
      }
    }
    const first = tokens[i];
    const last = tokens[i + length - 1];
    if (!hit || first === undefined || last === undefined) continue;
    if (spans.length === limit) return { spans, more: true };
    spans.push({ start: first.token.start, end: last.token.end });
  }
  return { spans, more: false };
}

/**
 * Matches a compiled rule set against one source text version. Returns hits sorted by termId (deterministic), or a
 * refusal for text beyond the technical bound (callers record it; nothing is truncated silently).
 */
export function matchWatchTerms(compiled: CompiledWatchTerms, sourceText: string): { readonly ok: true; readonly hits: readonly WatchTermHit[] } | { readonly ok: false; readonly reason: "text_too_long" } {
  if (sourceText.length > WATCH_TERM_TECHNICAL_BOUNDS.maxTextLength) return { ok: false, reason: "text_too_long" };
  const tokens: MatchToken[] = tokenize(sourceText).map((token) => ({ token, folded: normalizeToken(token.text, false), exact: normalizeToken(token.text, true) }));
  const hits: WatchTermHit[] = [];
  const limit = WATCH_TERM_TECHNICAL_BOUNDS.maxOccurrencesPerTerm;
  for (const term of compiled.terms) {
    if (term.excludes.some((exclude) => occurrencesOf(exclude, tokens, term.accentSensitive, compiled, 1).spans.length > 0)) continue;
    const occurrences: WatchTermOccurrence[] = [];
    let truncated = false;
    term.phrases.forEach((phrase, phraseIndex) => {
      const found = occurrencesOf(phrase, tokens, term.accentSensitive, compiled, limit);
      truncated ||= found.more;
      for (const span of found.spans) occurrences.push(Object.freeze({ ...span, phraseIndex }));
    });
    if (occurrences.length === 0) continue;
    occurrences.sort((a, b) => a.start - b.start || a.end - b.end || a.phraseIndex - b.phraseIndex);
    if (occurrences.length > limit) truncated = true;
    hits.push(Object.freeze({ termId: term.termId, occurrences: Object.freeze(occurrences.slice(0, limit)), truncated }));
  }
  hits.sort((a, b) => (a.termId < b.termId ? -1 : a.termId > b.termId ? 1 : 0));
  return { ok: true, hits: Object.freeze(hits) };
}
