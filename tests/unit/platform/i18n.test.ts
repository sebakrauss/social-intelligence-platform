import { describe, expect, it } from "vitest";
import { AppError, ERROR_CODES, ERROR_DEFINITIONS, ERROR_PARAM_NAMES } from "@/domain/errors";
import { MESSAGE_KEYS, MESSAGE_KEY_PATTERN } from "@/domain/i18n/message-keys";
import {
  DEVELOPMENT_REFERENCE_LOCALE,
  createTranslator,
  developmentReferenceCatalog,
  formatMessage,
  placeholdersOf,
  translateError,
  type Catalog,
} from "@/platform/i18n";

/** Test-only pseudo-locale (qps-ploc) proving the multi-locale mechanics without choosing launch languages. */
const pseudoCatalog = Object.fromEntries(
  MESSAGE_KEYS.map((key) => [key, `[!! ${developmentReferenceCatalog[key]} !!]`]),
) as Catalog;

describe("message keys", () => {
  it("are unique, stable, language-independent identifiers", () => {
    expect(new Set(MESSAGE_KEYS).size).toBe(MESSAGE_KEYS.length);
    for (const key of MESSAGE_KEYS) {
      expect(key).toMatch(MESSAGE_KEY_PATTERN);
    }
  });
});

describe("development reference catalog", () => {
  it("has exactly one non-empty entry per message key", () => {
    expect(Object.keys(developmentReferenceCatalog).sort()).toEqual([...MESSAGE_KEYS].sort());
    for (const key of MESSAGE_KEYS) {
      expect(developmentReferenceCatalog[key].trim()).not.toBe("");
    }
  });

  it("uses only placeholders that the error code declares as safe params", () => {
    for (const code of ERROR_CODES) {
      const template = developmentReferenceCatalog[ERROR_DEFINITIONS[code].messageKey];
      const declared: readonly string[] = ERROR_PARAM_NAMES[code];
      for (const placeholder of placeholdersOf(template)) {
        expect(declared, `${code} uses {${placeholder}}`).toContain(placeholder);
      }
    }
  });

  it("contains no implementation vocabulary (IA §2.6)", () => {
    const forbidden = /\b(api|token|scope|webhook|sdk|stack|exception|null|undefined)\b/i;
    for (const key of MESSAGE_KEYS) {
      expect(developmentReferenceCatalog[key]).not.toMatch(forbidden);
    }
  });
});

describe("translator", () => {
  const translator = createTranslator({
    catalogs: new Map([
      [DEVELOPMENT_REFERENCE_LOCALE, developmentReferenceCatalog],
      ["qps-ploc", pseudoCatalog],
    ]),
    fallbackLocale: DEVELOPMENT_REFERENCE_LOCALE,
  });

  it("resolves keys per locale and fills parameters", () => {
    expect(translator.translate(DEVELOPMENT_REFERENCE_LOCALE, "error.provider_transient", { platform: "Instagram" })).toBe(
      "Instagram isn't responding. We'll retry.",
    );
    expect(translator.translate("qps-ploc", "error.mode_blocked")).toBe("[!! This workspace is Monitor-only. !!]");
  });

  it("falls back for locales without a catalog", () => {
    expect(translator.translate("xx-XX", "error.not_found")).toBe(developmentReferenceCatalog["error.not_found"]);
  });

  it("keeps the registered locale list caller-defined", () => {
    expect(translator.locales).toEqual([DEVELOPMENT_REFERENCE_LOCALE, "qps-ploc"]);
  });

  it("renders errors with platform tokens resolved to display names", () => {
    const error = new AppError("PROVIDER_TRANSIENT", { platform: "instagram" });
    expect(translateError(translator, DEVELOPMENT_REFERENCE_LOCALE, error)).toBe("Instagram isn't responding. We'll retry.");
    expect(translateError(translator, DEVELOPMENT_REFERENCE_LOCALE, new AppError("PROTECTION_VETO", { excludedCount: 2 }))).toBe(
      "2 items were excluded and need individual review.",
    );
    expect(translateError(translator, DEVELOPMENT_REFERENCE_LOCALE, new AppError("MODE_BLOCKED", {}))).toBe(
      "This workspace is Monitor-only.",
    );
  });

  it("rejects a fallback locale without a catalog", () => {
    expect(() => createTranslator({ catalogs: new Map(), fallbackLocale: "en" })).toThrow();
  });
});

describe("formatMessage", () => {
  it("leaves missing parameters visible instead of inventing values", () => {
    expect(formatMessage("{platform} is down", {})).toBe("{platform} is down");
    expect(formatMessage("{count} items", { count: 3 })).toBe("3 items");
  });

  it("lists placeholders once, in order", () => {
    expect(placeholdersOf("{a} and {b} and {a}")).toEqual(["a", "b"]);
  });
});
