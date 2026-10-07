/**
 * Capability persistence ports (Step 5E). The current profile of a Connected Account is derived state: one header
 * (catalog + normalized inputs) and its entries, written only by the job runtime inside its single bound workspace,
 * read by non-guest members through the web. Rows a caller may not see are simply absent (forced RLS).
 */
import type { CatalogId } from "../domain/catalog";
import type { CapabilityObservation, CapabilityProfile, FactsInput, ProfileEntry } from "../domain/profile";

/** A stored evaluation header (no entries). */
export interface StoredProfileHeader {
  readonly connectedAccountId: string;
  readonly catalogId: CatalogId;
  readonly catalogRevision: number;
  readonly facts: FactsInput;
  readonly observations: readonly CapabilityObservation[];
  readonly inputsAsOf: Date;
  readonly inputDigest: string;
  /** When the current semantic revision was computed. */
  readonly evaluatedAt: Date;
  /** Latest identical re-evaluation (bookkeeping only; never used for freshness). */
  readonly lastVerifiedAt: Date;
  readonly revision: number;
}

export interface ProfileWrite {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly connectedAccountId: string;
  readonly profile: CapabilityProfile;
  readonly facts: FactsInput;
  readonly observations: readonly CapabilityObservation[];
  readonly inputDigest: string;
}

/**
 * applied   the current profile now reflects this evaluation (new semantic revision);
 * unchanged identical evaluation content — only "last verified" bookkeeping may advance; entries and revision stay;
 * stale     an evaluation with a newer catalog revision or newer inputs is already stored; nothing changes;
 * conflict  same catalog revision and same inputs_as_of but different content: ambiguous, rejected; nothing changes.
 */
export type ProfileWriteOutcome =
  | { readonly kind: "applied"; readonly revision: number }
  | { readonly kind: "unchanged" | "stale" | "conflict"; readonly revision: number };

export interface CapabilityProfileStore {
  readonly header: (connectedAccountId: string) => Promise<StoredProfileHeader | undefined>;
  readonly entries: (connectedAccountId: string) => Promise<readonly ProfileEntry[]>;
  /** Job runtime only. Applies the evaluation unless an equal-or-newer one is stored (see writeIsNewer). */
  readonly write: (write: ProfileWrite) => Promise<ProfileWriteOutcome>;
}

/** Read side (web). */
export type CapabilityReadStore = Pick<CapabilityProfileStore, "header" | "entries">;

export interface Freshness {
  /** Monotonic integer catalog revision (never a textual label). */
  readonly catalogRevision: number;
  /** Newest normalized input actually used (see CapabilityProfile.inputsAsOf). */
  readonly inputsAsOf: Date;
  /** Fingerprint of the evaluation content: EQUALITY ONLY, never an order. */
  readonly inputDigest: string;
}

/**
 * The semantic freshness rule (no hash ordering, no evaluation wall-clock):
 *   1. a higher catalog revision wins; a lower one is stale;
 *   2. same revision: newer inputs_as_of wins; older is stale;
 *   3. same revision and same inputs_as_of: same digest → same evaluation; different digest → conflict (ambiguous,
 *      rejected — a digest never decides which capability truth wins).
 * An identical-content evaluation with newer inputs ("re-verified") is reported as "same_content_newer", so the
 * store can advance bookkeeping without a semantic revision.
 */
export type FreshnessVerdict = "newer" | "stale" | "same" | "same_content_newer" | "conflict";

export function compareFreshness(next: Freshness, stored: Freshness): FreshnessVerdict {
  if (next.catalogRevision !== stored.catalogRevision) return next.catalogRevision > stored.catalogRevision ? "newer" : "stale";
  const nextAt = next.inputsAsOf.getTime();
  const storedAt = stored.inputsAsOf.getTime();
  if (nextAt < storedAt) return "stale";
  const sameContent = next.inputDigest === stored.inputDigest;
  if (nextAt > storedAt) return sameContent ? "same_content_newer" : "newer";
  return sameContent ? "same" : "conflict";
}
