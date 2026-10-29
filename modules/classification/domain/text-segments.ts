/**
 * Token segmentation of a source text for deterministic matching (Step H7-A1; H7-A0 §7.3). Pure.
 *
 * Segmentation runs on the ORIGINAL source text with `Intl.Segmenter` (granularity `word`, locale `und`), so every token
 * carries exact offsets into the source text: UTF-16 code units of the JavaScript string, `[start, end)`. Normalization
 * happens per token afterwards (watch-terms.ts), so offsets never depend on normalization and need no mapping.
 *
 * Tokens: word-like segments, plus emoji clusters (skin tones and ZWJ sequences are one cluster). Punctuation and
 * whitespace are separators. A word token immediately preceded by `#` or `@` (NFKC, so fullwidth too) records that
 * prefix, so hashtags and mentions are distinguishable from ordinary words.
 *
 * Segmentation follows the runtime's ICU data (UAX #29): the matcher version pins the behavior the tests prove.
 */

/** A span of the SOURCE text: UTF-16 code-unit offsets `[start, end)` of the JavaScript string. */
export interface SourceSpan {
  readonly start: number;
  readonly end: number;
}

export type TokenPrefix = "none" | "hashtag" | "mention";

export interface TextToken {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly isEmoji: boolean;
  readonly prefix: TokenPrefix;
}

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const segmenter = new Intl.Segmenter("und", { granularity: "word" });

export const isEmojiCluster = (segment: string): boolean => EMOJI.test(segment) && !LETTER_OR_NUMBER.test(segment.replace(/[0-9#*]️?⃣/gu, ""));

export function tokenize(text: string): readonly TextToken[] {
  const tokens: TextToken[] = [];
  let previous: { readonly segment: string; readonly end: number } | undefined;
  for (const part of segmenter.segment(text)) {
    const start = part.index;
    const end = start + part.segment.length;
    const emoji = !part.isWordLike && isEmojiCluster(part.segment);
    if (part.isWordLike === true || emoji) {
      const marker = previous !== undefined && previous.end === start ? previous.segment.normalize("NFKC") : "";
      const prefix: TokenPrefix = !emoji && marker === "#" ? "hashtag" : !emoji && marker === "@" ? "mention" : "none";
      tokens.push(Object.freeze({ start, end, text: part.segment, isEmoji: emoji, prefix }));
    }
    previous = { segment: part.segment, end };
  }
  return Object.freeze(tokens);
}
