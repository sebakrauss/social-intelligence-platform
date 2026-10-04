/**
 * Locale catalogs and message resolution (PD §16; TA §3.1).
 *
 * A catalog maps every stable message key to a template for one locale. The `Catalog` type
 * requires every key, so a missing translation is a compile error. Templates use ICU-style
 * simple arguments (`{name}`), so a full ICU MessageFormat library can be adopted later
 * without changing catalogs or call sites (library choice is deferred to implementation).
 *
 * Which interface languages ship at MVP launch is OPEN (PD OQ-20). Nothing here declares a
 * supported-language list; locales are registered by the caller.
 */
import type { MessageKey } from "@/domain/i18n/message-keys";

/** BCP 47 language tag, e.g. "en" or "pt-BR". */
export type LocaleTag = string;

export type Catalog = { readonly [K in MessageKey]: string };

export type MessageParams = Readonly<Record<string, string | number | undefined>>;

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** Placeholder names used by a template, in order of first appearance. */
export function placeholdersOf(template: string): readonly string[] {
  const names: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/** Fills `{name}` placeholders. Unknown or missing parameters leave the placeholder visible. */
export function formatMessage(template: string, params: MessageParams = {}): string {
  return template.replace(PLACEHOLDER, (placeholder, name: string) => {
    const value = Object.hasOwn(params, name) ? params[name] : undefined;
    return value === undefined ? placeholder : String(value);
  });
}

export interface Translator {
  readonly locales: readonly LocaleTag[];
  translate(locale: LocaleTag, key: MessageKey, params?: MessageParams): string;
}

export interface TranslatorOptions {
  readonly catalogs: ReadonlyMap<LocaleTag, Catalog>;
  /** Locale used when the requested one has no catalog. Must be one of `catalogs`. */
  readonly fallbackLocale: LocaleTag;
}

export function createTranslator(options: TranslatorOptions): Translator {
  const fallback = options.catalogs.get(options.fallbackLocale);
  if (fallback === undefined) {
    throw new Error(`i18n: fallback locale "${options.fallbackLocale}" has no catalog`);
  }
  return {
    locales: [...options.catalogs.keys()],
    translate(locale, key, params) {
      const catalog = options.catalogs.get(locale) ?? fallback;
      return formatMessage(catalog[key], params);
    },
  };
}
