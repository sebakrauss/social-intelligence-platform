/**
 * Deterministic signals: narrow FACTS about one source text version, never meaning (Step H7-A1; Model §15.2; TA §24.2;
 * H7-A0 §7.1, D-H7-3; S19). Pure.
 *
 *   watch_term_match   "the text contains this configured term" (rule identity + matcher version + source spans)
 *   link_present       a URL-like token exists (spans) — detected locally, NEVER fetched or resolved (SSRF)
 *   text_empty         nothing but whitespace
 *   text_emoji_only    only emoji clusters (and whitespace)
 *   author_own_brand   the interaction was authored by the connected account itself (from the author-role source fact)
 *
 * A signal has no dimension and no value: it can't be an assessment, can't enter precedence, can't change protection
 * or priority/value, and is not an input of the AI understanding contract (watch terms by D-H7-3; link reputation is a
 * separate, later rule). Evidence is spans into the source text — the text itself is never copied. Profanity is not a
 * signal in v1 (a later decision, H7-A0 §4.3).
 */
import { isEmojiCluster, type SourceSpan } from "./text-segments";
import { WATCH_TERM_MATCHER_VERSION, type WatchTermHit } from "./watch-terms";

export const SIGNALS_VERSION = "signals.v1" as const;

export const SIGNAL_KINDS = ["watch_term_match", "link_present", "text_empty", "text_emoji_only", "author_own_brand"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export interface WatchTermMatchSignal {
  readonly kind: "watch_term_match";
  readonly termId: string;
  readonly ruleSetVersion: string;
  readonly matcherVersion: typeof WATCH_TERM_MATCHER_VERSION;
  readonly spans: readonly SourceSpan[];
  readonly truncated: boolean;
}

export interface LinkPresentSignal {
  readonly kind: "link_present";
  readonly spans: readonly SourceSpan[];
  readonly truncated: boolean;
}

export interface FlagSignal {
  readonly kind: "text_empty" | "text_emoji_only" | "author_own_brand";
}

export type Signal = WatchTermMatchSignal | LinkPresentSignal | FlagSignal;

export interface SignalSet {
  readonly signals: readonly Signal[];
  readonly signalsVersion: typeof SIGNALS_VERSION;
}

/** The watch-term hits of one rule set, as signals (one per matched term). */
export function watchTermSignals(hits: readonly WatchTermHit[], ruleSetVersion: string): readonly WatchTermMatchSignal[] {
  return Object.freeze(hits.map((hit) => Object.freeze({
    kind: "watch_term_match" as const,
    termId: hit.termId,
    ruleSetVersion,
    matcherVersion: WATCH_TERM_MATCHER_VERSION,
    spans: Object.freeze(hit.occurrences.map((o) => Object.freeze({ start: o.start, end: o.end }))),
    truncated: hit.truncated,
  })));
}

export const MAX_LINK_SPANS = 20;
const MAX_CHUNK = 2_048;
const SCHEME_OR_WWW = /^(?:https?:\/\/|www\.)\S/iu;
// Disjoint character classes (label chars vs the dot), anchored, on one bounded whitespace-free chunk: no backtracking blow-up.
const DOMAIN_WITH_PATH = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\/\S*$/iu;
const LEADING_NOISE = /^[^\p{L}\p{N}]+/u;

/** URL-like spans of the source text (local detection only; nothing is fetched, resolved or stored as text). */
export function detectLinks(sourceText: string): LinkPresentSignal | undefined {
  const spans: SourceSpan[] = [];
  let truncated = false;
  for (const match of sourceText.matchAll(/\S+/gu)) {
    const raw = match[0];
    if (raw.length > MAX_CHUNK) continue;
    const lead = LEADING_NOISE.exec(raw)?.[0].length ?? 0;
    const chunk = raw.slice(lead);
    if (!SCHEME_OR_WWW.test(chunk) && !DOMAIN_WITH_PATH.test(chunk)) continue;
    if (spans.length === MAX_LINK_SPANS) {
      truncated = true;
      break;
    }
    const start = match.index + lead;
    spans.push(Object.freeze({ start, end: start + chunk.length }));
  }
  return spans.length === 0 ? undefined : Object.freeze({ kind: "link_present" as const, spans: Object.freeze(spans), truncated });
}

const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });

export function isEmptyText(sourceText: string): boolean {
  return sourceText.trim().length === 0;
}

export function isEmojiOnly(sourceText: string): boolean {
  let any = false;
  for (const { segment } of graphemes.segment(sourceText)) {
    if (segment.trim().length === 0) continue;
    if (!isEmojiCluster(segment)) return false;
    any = true;
  }
  return any;
}

/** The text-derived signals of one source text version (watch terms are matched separately, per rule set). */
export function detectTextSignals(sourceText: string): readonly Signal[] {
  const out: Signal[] = [];
  if (isEmptyText(sourceText)) out.push(Object.freeze({ kind: "text_empty" as const }));
  else if (isEmojiOnly(sourceText)) out.push(Object.freeze({ kind: "text_emoji_only" as const }));
  const links = detectLinks(sourceText);
  if (links !== undefined) out.push(links);
  return Object.freeze(out);
}

/** From the author-role source fact (`account_identity` = the connected account itself). */
export function ownBrandSignal(authorRole: "account_identity" | "user" | "unknown"): FlagSignal | undefined {
  return authorRole === "account_identity" ? Object.freeze({ kind: "author_own_brand" as const }) : undefined;
}
