/**
 * Social interaction text is UNTRUSTED DATA (PD §13.4-7; TA §21.4; Step H6-A1 prompt-injection boundary).
 *
 * The brand makes the boundary visible in types: text is stored and passed along as evidence, never interpreted.
 *   - Ingestion never reads text as instructions, and text never selects a tool, a task, a topic or a route.
 *   - Links inside text are inert: nothing in ingestion extracts, resolves or fetches a URL found in text (SSRF).
 *   - Text never travels in an outbox row or job payload: downstream work re-reads it from Postgres in its tenant
 *     scope (TA §19.4), and the canonical event is IDs-only.
 *   - Text is kept exactly as the provider returned it (Model §13: a source text version is the text "exactly as the
 *     platform provided it"): no trimming, normalization, translation or redaction here.
 * Future AI use (Step 8) goes through the AI gateway only, inside delimited data sections, and is outside H6.
 */
import { SOURCE_TEXT_MAX_LENGTH } from "./vocabulary";

declare const untrustedBrand: unique symbol;

export type UntrustedSocialText = string & { readonly [untrustedBrand]: true };

/** Accepts provider text as-is (bounded length only); never inspects, rewrites or interprets it. */
export function asUntrustedSocialText(value: unknown): UntrustedSocialText | undefined {
  return typeof value === "string" && value.length <= SOURCE_TEXT_MAX_LENGTH ? (value as UntrustedSocialText) : undefined;
}
