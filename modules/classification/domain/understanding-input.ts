/**
 * The bounded input contract of the future understanding task (task A) (Step H7-A1; TA §21.2, §21.4, §22.3; H7-A0 §13,
 * §14). Pure; no prompt is rendered here and no model is called.
 *
 * Social text is UNTRUSTED DATA: it is carried as an opaque field, never inspected for instructions, never used to
 * select a task, model, taxonomy, workspace, budget or route. Prompt-injection text belongs in evaluation fixtures, not
 * in control flow.
 *
 *   top-level comment   analyzed text + caption excerpt
 *   reply               analyzed text + parent excerpt (≤ 1 000) + root excerpt (≤ 500, when the root isn't the parent)
 *                       + caption excerpt
 * Excerpts are truncated at a grapheme boundary to their frozen bounds; the ANALYZED text is never truncated — beyond
 * the bound the build fails (`text_too_large` ⇒ AI_INPUT_TOO_LARGE upstream, deterministic signals only).
 *
 * By construction there is no field for an author name, handle, profile id, credential, raw webhook body, thread history
 * or watch-term match (D-H7-3): the builder copies only the fields below, whatever else a caller passes.
 */
import { isPlatformKey, type PlatformKey } from "@/domain/platforms";
import { TAXONOMY_VERSION } from "./taxonomy";
import { VALIDATED_LANGUAGES, type ValidatedLanguage } from "./language";

export const UNDERSTANDING_INPUT_CONTRACT_VERSION = "understanding-input.v1" as const;

export const UNDERSTANDING_INPUT_BOUNDS = Object.freeze({
  maxAnalyzedTextLength: 32_768,
  parentExcerptChars: 1_000,
  rootExcerptChars: 500,
  captionExcerptChars: 500,
  brandNameChars: 120,
});

/** Content source (PD D-38): Mixed is never forced into organic or paid. */
export const CONTENT_SOURCES = ["organic", "paid", "mixed", "unknown"] as const;
export type ContentSource = (typeof CONTENT_SOURCES)[number];

declare const untrustedBrand: unique symbol;
/** Social text as an opaque data value (never instructions). */
export type UntrustedText = string & { readonly [untrustedBrand]: true };

export interface UnderstandingInput {
  readonly contractVersion: typeof UNDERSTANDING_INPUT_CONTRACT_VERSION;
  readonly taxonomyVersion: typeof TAXONOMY_VERSION;
  readonly validatedLanguages: readonly ValidatedLanguage[];
  readonly interactionKind: "comment" | "reply";
  readonly platform: PlatformKey;
  readonly source: ContentSource;
  readonly text: UntrustedText;
  readonly parentExcerpt: UntrustedText | null;
  readonly rootExcerpt: UntrustedText | null;
  readonly captionExcerpt: UntrustedText | null;
  /** The brand's own display name, for "against the brand" judgments (not an author identity). */
  readonly brandName: string | null;
  readonly hints: {
    readonly linkPresent: boolean;
    readonly parentByOwnBrand: boolean | null;
    readonly rootByOwnBrand: boolean | null;
  };
}

export interface UnderstandingInputParams {
  readonly interactionKind: unknown;
  readonly platform: unknown;
  readonly source: unknown;
  readonly text: unknown;
  readonly parentText?: unknown;
  readonly rootText?: unknown;
  readonly captionText?: unknown;
  readonly brandName?: unknown;
  readonly linkPresent: unknown;
  readonly parentByOwnBrand?: unknown;
  readonly rootByOwnBrand?: unknown;
}

export const UNDERSTANDING_INPUT_VIOLATIONS = ["KIND_INVALID", "PLATFORM_INVALID", "SOURCE_INVALID", "TEXT_INVALID", "TEXT_TOO_LARGE", "PARENT_REQUIRED", "PARENT_NOT_ALLOWED", "CONTEXT_INVALID", "BRAND_NAME_INVALID", "HINT_INVALID"] as const;
export type UnderstandingInputViolation = (typeof UNDERSTANDING_INPUT_VIOLATIONS)[number];

const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });

/** The longest prefix of `text` of at most `max` UTF-16 units that ends on a grapheme boundary. */
export function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = 0;
  for (const { index, segment } of graphemes.segment(text)) {
    if (index + segment.length > max) break;
    end = index + segment.length;
  }
  return text.slice(0, end);
}

const optionalText = (value: unknown, max: number, out: Set<UnderstandingInputViolation>): UntrustedText | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    out.add("CONTEXT_INVALID");
    return null;
  }
  return excerpt(value, max) as UntrustedText;
};

const optionalFlag = (value: unknown, out: Set<UnderstandingInputViolation>): boolean | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") out.add("HINT_INVALID");
  return value === true;
};

export function buildUnderstandingInput(params: UnderstandingInputParams): { readonly ok: true; readonly input: UnderstandingInput } | { readonly ok: false; readonly violations: readonly UnderstandingInputViolation[] } {
  const out = new Set<UnderstandingInputViolation>();
  const kind = params.interactionKind === "comment" || params.interactionKind === "reply" ? params.interactionKind : undefined;
  if (kind === undefined) out.add("KIND_INVALID");
  if (!isPlatformKey(params.platform)) out.add("PLATFORM_INVALID");
  if (!(CONTENT_SOURCES as readonly unknown[]).includes(params.source)) out.add("SOURCE_INVALID");
  if (typeof params.text !== "string") out.add("TEXT_INVALID");
  else if (params.text.length > UNDERSTANDING_INPUT_BOUNDS.maxAnalyzedTextLength) out.add("TEXT_TOO_LARGE");
  if (typeof params.linkPresent !== "boolean") out.add("HINT_INVALID");
  const hasParent = params.parentText !== undefined && params.parentText !== null;
  const hasRoot = params.rootText !== undefined && params.rootText !== null;
  if (kind === "reply" && !hasParent) out.add("PARENT_REQUIRED");
  if (kind === "comment" && (hasParent || hasRoot || params.parentByOwnBrand !== undefined || params.rootByOwnBrand !== undefined)) out.add("PARENT_NOT_ALLOWED");
  const bounds = UNDERSTANDING_INPUT_BOUNDS;
  const parentExcerpt = optionalText(params.parentText, bounds.parentExcerptChars, out);
  const rootExcerpt = optionalText(params.rootText, bounds.rootExcerptChars, out);
  const captionExcerpt = optionalText(params.captionText, bounds.captionExcerptChars, out);
  let brandName: string | null = null;
  if (params.brandName !== undefined && params.brandName !== null) {
    if (typeof params.brandName !== "string" || params.brandName.length === 0 || params.brandName.length > bounds.brandNameChars) out.add("BRAND_NAME_INVALID");
    else brandName = params.brandName;
  }
  const parentByOwnBrand = optionalFlag(params.parentByOwnBrand, out);
  const rootByOwnBrand = optionalFlag(params.rootByOwnBrand, out);
  if (out.size > 0 || kind === undefined) return { ok: false, violations: (UNDERSTANDING_INPUT_VIOLATIONS as readonly UnderstandingInputViolation[]).filter((v) => out.has(v)) };
  return {
    ok: true,
    input: Object.freeze({
      contractVersion: UNDERSTANDING_INPUT_CONTRACT_VERSION,
      taxonomyVersion: TAXONOMY_VERSION,
      validatedLanguages: VALIDATED_LANGUAGES,
      interactionKind: kind,
      platform: params.platform as PlatformKey,
      source: params.source as ContentSource,
      text: params.text as UntrustedText,
      parentExcerpt,
      rootExcerpt,
      captionExcerpt,
      brandName,
      hints: Object.freeze({ linkPresent: params.linkPresent as boolean, parentByOwnBrand: kind === "reply" ? parentByOwnBrand : null, rootByOwnBrand: kind === "reply" ? rootByOwnBrand : null }),
    }),
  };
}
