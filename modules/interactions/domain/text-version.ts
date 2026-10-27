/**
 * Source text versions (Step H6-A1; Model §13, §44; TA §18.2; M-09 open). Pure.
 *
 * A version is the text exactly as the provider returned it, keyed by (interaction, text hash). Versions are
 * immutable and append-only: nothing ever overwrites or deletes an earlier one here (retention is a separate, audited
 * policy). The interaction's current state points at its latest ACCEPTED version.
 *
 *   no text in the fact (removed at source)          → no_text        (a state matter, not a text version)
 *   no current version                               → append         (the first version)
 *   same hash as the current version                 → unchanged      (identical text adds no version)
 *   different hash, but the fact is stale            → stale          (kept out of current state; the caller may log
 *                                                                       the sighting, never a newer-looking version)
 *   different hash, not stale                        → append         (an edit: a new version; the old one stays)
 *
 * Staleness: when BOTH sides carry a provider edit time, the provider's edit time decides; otherwise the observed time
 * decides (an earlier observation never replaces what a later one established). Arrival order never decides.
 */
import { compareInstants, type Instant } from "@/domain/instant";
import type { TextHash } from "./source-fact";

export interface TextVersionPointer {
  readonly textHash: TextHash;
  readonly providerEditedAt: Instant | null;
  readonly observedAt: Instant;
}

export interface IncomingText {
  readonly textHash: TextHash | null;
  readonly providerEditedAt: Instant | null;
  readonly observedAt: Instant;
}

export type TextVersionDecision = "no_text" | "append" | "unchanged" | "stale";

export function isStaleAgainst(current: { readonly providerEditedAt: Instant | null; readonly observedAt: Instant }, incoming: { readonly providerEditedAt: Instant | null; readonly observedAt: Instant }): boolean {
  if (current.providerEditedAt !== null && incoming.providerEditedAt !== null) return compareInstants(incoming.providerEditedAt, current.providerEditedAt) < 0;
  return compareInstants(incoming.observedAt, current.observedAt) < 0;
}

export function decideTextVersion(current: TextVersionPointer | null, incoming: IncomingText): TextVersionDecision {
  if (incoming.textHash === null) return "no_text";
  if (current === null) return "append";
  if (incoming.textHash === current.textHash) return "unchanged";
  return isStaleAgainst(current, incoming) ? "stale" : "append";
}
