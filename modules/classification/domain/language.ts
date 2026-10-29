/**
 * Language identity and the language confidence policy (Step H7-A1; Model §13; PD §16; H7-A0 §6, D-H7-5). Pure.
 *
 * Classification runs on the ORIGINAL text in its own language; nothing here translates or detects. A language
 * result is either detected tags (1..4 BCP-47 tags — more than one is code-switching) with a certainty, or unknown.
 *
 * Validated primary set: Spanish (any region), Brazilian Portuguese, English (any region), and clear mixes among them.
 * Only for those, with a certain detection, does the ordinary confidence policy apply. An unsupported language, an
 * uncertain detection or an unknown language caps every SEMANTIC value at `medium` (D-H7-5); abstention stays allowed
 * and preferred when evidence is weak. `pt` without region and `pt-PT` are not in the validated set (conservative).
 *
 * Tags accepted: language (2–3 letters), optional script (4 letters), optional region (2 letters or 3 digits). Other
 * BCP-47 forms (variants, extensions, private use) fail closed — a later version may widen this.
 */
import type { ConfidenceLevel } from "./confidence";

export const LANGUAGE_POLICY_VERSION = "language-policy.v1" as const;

export const VALIDATED_LANGUAGES = ["es", "pt-BR", "en"] as const;
export type ValidatedLanguage = (typeof VALIDATED_LANGUAGES)[number];

export const MAX_LANGUAGE_TAGS = 4;

declare const languageTagBrand: unique symbol;
export type LanguageTag = string & { readonly [languageTagBrand]: true };

const TAG = /^([a-zA-Z]{2,3})(?:-([a-zA-Z]{4}))?(?:-([a-zA-Z]{2}|[0-9]{3}))?$/;

/** A canonical-case BCP-47 tag (subset above), or undefined. */
export function parseLanguageTag(value: unknown): LanguageTag | undefined {
  if (typeof value !== "string") return undefined;
  const match = TAG.exec(value);
  if (match === null) return undefined;
  const [, language = "", script, region] = match;
  const parts = [language.toLowerCase()];
  if (script !== undefined) parts.push(script.slice(0, 1).toUpperCase() + script.slice(1).toLowerCase());
  if (region !== undefined) parts.push(region.toUpperCase());
  return parts.join("-") as LanguageTag;
}

export type LanguageCertainty = "certain" | "uncertain";

export type LanguageResult =
  | { readonly kind: "detected"; readonly languages: readonly LanguageTag[]; readonly certainty: LanguageCertainty }
  | { readonly kind: "unknown" };

/** The validated language a tag belongs to, if any (es-*, en-*, exactly pt-BR). */
export function validatedLanguageOf(tag: LanguageTag): ValidatedLanguage | undefined {
  const [language, ...rest] = tag.split("-");
  const region = rest.find((part) => /^[A-Z]{2}$|^[0-9]{3}$/.test(part));
  if (language === "es") return "es";
  if (language === "en") return "en";
  if (language === "pt" && region === "BR") return "pt-BR";
  return undefined;
}

export type LanguageSupport = "validated" | "validated_mixed" | "unsupported" | "uncertain" | "unknown";

export function languageSupport(result: LanguageResult): LanguageSupport {
  if (result.kind === "unknown" || result.languages.length === 0) return "unknown";
  if (result.certainty === "uncertain") return "uncertain";
  const validated = result.languages.map(validatedLanguageOf);
  if (validated.some((language) => language === undefined)) return "unsupported";
  return new Set(validated).size > 1 ? "validated_mixed" : "validated";
}

/** D-H7-5: the highest semantic confidence any non-human assessment may carry for text in this language. */
export function maxSemanticConfidence(result: LanguageResult): ConfidenceLevel {
  const support = languageSupport(result);
  return support === "validated" || support === "validated_mixed" ? "high" : "medium";
}

export const isLanguageValidated = (support: LanguageSupport): boolean => support === "validated" || support === "validated_mixed";
