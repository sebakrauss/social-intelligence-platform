/**
 * Pre-model eligibility of one understanding target (Step H7-D1d; H7-A0 §9, §13; H7-D1a). Pure: the canonical facts the
 * caller reloaded in tenant scope go in, a decision comes out. Shared by MAIN (before a dispatch) and INTELLIGENCE
 * (again at execution, against freshly reloaded state) so neither can call a model the other would have refused.
 *
 *   canonical   1 supported event state (observed comment / reply, known author role) · 2 the analyzed version is the
 *               interaction's CURRENT text · 3 not authored by the connected account itself (own brand) · 4 text not
 *               empty · 5 text not emoji-only (the deterministic stage's own detectors — never a watch term)
 *   route       6 enabled · 7 sampled · 8 kill switch inactive · 9 data eligible (decideUnderstandAiRoute)
 *   input       10 the frozen A1 builder (never truncated: too large ⇒ AI_INPUT_TOO_LARGE)
 *   later       11 budget (the gateway, before the call) · 12 no completed equivalent (the request's own state, the
 *               0025 one-result key) · 13 dispatch identity (the request generation + the dispatch key)
 *
 * Watch terms play no part: they are signals only — never model input, never routing, never a shortcut (D-H7-3).
 */
import { isPlatformKey } from "@/domain/platforms";
import { detectTextSignals } from "./signals";
import { buildUnderstandingInput, CONTENT_SOURCES, type ContentSource, type UnderstandingInput, type UnderstandingInputParams, type UnderstandingInputViolation } from "./understanding-input";

/** A context item (parent or thread root): its current text, when observed, and its canonical author role. */
export interface UnderstandingContextItem {
  readonly sourceText: string | null;
  readonly authorRole: string | null;
}

/** The canonical facts of one target, reloaded in tenant scope (structurally the interactions module's context record). */
export interface UnderstandingCandidate {
  readonly sourceTextVersionId: string;
  readonly currentSourceTextVersionId: string | null;
  readonly observed: boolean;
  readonly kind: string | null;
  readonly authorRole: string | null;
  readonly sourceText: string;
  readonly platform: string;
  readonly parent: UnderstandingContextItem | null;
  readonly root: UnderstandingContextItem | null;
}

export const CANONICAL_INELIGIBILITY = ["event_not_supported", "version_superseded", "own_brand", "text_empty", "text_emoji_only"] as const;
export type CanonicalIneligibility = (typeof CANONICAL_INELIGIBILITY)[number];

const AUTHOR_ROLES: readonly string[] = ["account_identity", "user", "unknown"];

/** account_identity ⇒ own brand · user ⇒ not · unknown / absent ⇒ null (never guessed). */
const byOwnBrand = (role: string | null | undefined): boolean | null => (role === "account_identity" ? true : role === "user" ? false : null);

const isContentSource = (value: unknown): value is ContentSource => typeof value === "string" && (CONTENT_SOURCES as readonly string[]).includes(value);

export type CanonicalEligibility = { readonly ok: true; readonly params: UnderstandingInputParams } | { readonly ok: false; readonly reason: CanonicalIneligibility };

/**
 * Checks 1–5, then the A1 builder parameters. `reportedSource` is the content's own organic / paid / mixed / unknown
 * (anything else, or no content, is `unknown` — Mixed is never forced). The brand's display name and the caption are
 * not yet canonical inputs (no approved source): both stay null, which the contract admits.
 */
export function canonicalEligibility(candidate: UnderstandingCandidate, reportedSource: string | undefined): CanonicalEligibility {
  const kind = candidate.kind;
  if (!candidate.observed || (kind !== "comment" && kind !== "reply") || candidate.authorRole === null || !AUTHOR_ROLES.includes(candidate.authorRole) || !isPlatformKey(candidate.platform)) {
    return { ok: false, reason: "event_not_supported" };
  }
  if (candidate.currentSourceTextVersionId !== candidate.sourceTextVersionId) return { ok: false, reason: "version_superseded" };
  if (candidate.authorRole === "account_identity") return { ok: false, reason: "own_brand" };
  const signals = detectTextSignals(candidate.sourceText);
  if (signals.some((s) => s.kind === "text_empty")) return { ok: false, reason: "text_empty" };
  if (signals.some((s) => s.kind === "text_emoji_only")) return { ok: false, reason: "text_emoji_only" };
  const linkPresent = signals.some((s) => s.kind === "link_present");
  const reply = kind === "reply";
  const params: UnderstandingInputParams = {
    interactionKind: kind,
    platform: candidate.platform,
    source: isContentSource(reportedSource) ? reportedSource : "unknown",
    text: candidate.sourceText,
    linkPresent,
    brandName: null,
    captionText: null,
    ...(reply
      ? {
        parentText: candidate.parent?.sourceText ?? null,
        rootText: candidate.root?.sourceText ?? null,
        parentByOwnBrand: byOwnBrand(candidate.parent?.authorRole),
        rootByOwnBrand: candidate.root === null ? null : byOwnBrand(candidate.root.authorRole),
      }
      : {}),
  };
  return { ok: true, params: Object.freeze(params) };
}

// ── Canonical model input (the frozen A1 builder) ───────────────────────────────────────────────────────────────

export type PreparedUnderstandingInput =
  | { readonly kind: "ready"; readonly input: UnderstandingInput }
  /** The analyzed text exceeds the frozen bound: never truncated, no provider call; deterministic fail-safe. */
  | { readonly kind: "failed"; readonly failure: { readonly class: "AI_INPUT_TOO_LARGE"; readonly cause: "input_limit"; readonly retryable: false } }
  | { readonly kind: "invalid"; readonly violations: readonly UnderstandingInputViolation[] };

export function prepareUnderstandingInput(params: UnderstandingInputParams): PreparedUnderstandingInput {
  const built = buildUnderstandingInput(params);
  if (built.ok) return Object.freeze({ kind: "ready" as const, input: built.input });
  if (built.violations.includes("TEXT_TOO_LARGE")) return Object.freeze({ kind: "failed" as const, failure: Object.freeze({ class: "AI_INPUT_TOO_LARGE" as const, cause: "input_limit" as const, retryable: false as const }) });
  return Object.freeze({ kind: "invalid" as const, violations: built.violations });
}
