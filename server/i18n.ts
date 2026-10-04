/**
 * Server-side translator for the current surfaces. Only the development reference catalog exists;
 * interface-language selection arrives with the product UI (PD OQ-20 remains OPEN).
 */
import type { MessageKey } from "@/domain/i18n/message-keys";
import {
  DEVELOPMENT_REFERENCE_LOCALE,
  createTranslator,
  developmentReferenceCatalog,
  type MessageParams,
} from "@/platform/i18n";

const translator = createTranslator({
  catalogs: new Map([[DEVELOPMENT_REFERENCE_LOCALE, developmentReferenceCatalog]]),
  fallbackLocale: DEVELOPMENT_REFERENCE_LOCALE,
});

export const interfaceLocale = DEVELOPMENT_REFERENCE_LOCALE;

export function t(key: MessageKey, params?: MessageParams): string {
  return translator.translate(interfaceLocale, key, params);
}
