/**
 * Renders an application error in a locale. Platform tokens are turned into their display names
 * here; every other parameter is already a validated token, identifier or count.
 */
import type { SafeParamValue, SerializedAppError } from "@/domain/errors";
import { PLATFORM_DISPLAY_NAMES, isPlatformKey } from "@/domain/platforms";
import type { LocaleTag, MessageParams, Translator } from "./catalog";

export function translateError(
  translator: Translator,
  locale: LocaleTag,
  error: Pick<SerializedAppError, "messageKey" | "params">,
): string {
  const params: Record<string, SafeParamValue> = {};
  for (const [name, value] of Object.entries(error.params as Readonly<Record<string, SafeParamValue | undefined>>)) {
    if (value !== undefined) {
      params[name] = name === "platform" && isPlatformKey(value) ? PLATFORM_DISPLAY_NAMES[value] : value;
    }
  }
  return translator.translate(locale, error.messageKey, params satisfies MessageParams);
}
