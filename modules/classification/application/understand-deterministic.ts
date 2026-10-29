/**
 * The deterministic stage of understanding (Step H7-B; H7-A0 §9, §11; migration 0024). MAIN plane, DB only: no provider,
 * no model, no credential, no network. Runs inside the `interactions.observed` consumer's single workspace-scoped job
 * transaction, after the canonical event was verified against its IDs-only payload.
 *
 * Target: the IMMUTABLE source text version the canonical event names — never the interaction's current-text pointer.
 * A later version is its own target; a removed interaction keeps the analysis of its historical text (nothing here
 * reads or writes availability, visibility or any canonical row).
 *
 *   1. ensure the ONE understanding request of (text version, DETERMINISTIC_PIPELINE_VERSION) — the 0024 unique key is
 *      the concurrency authority; a duplicate or replayed delivery converges on the same row
 *   2. derive the narrow facts with the pure domain (detectTextSignals: link_present / text_empty / text_emoji_only;
 *      ownBrandSignal from the canonical author role) and record each one idempotently: an equivalent row already
 *      recorded is success; a DIFFERENT row under the same identity is an impossible invariant (fail closed)
 *   3. advance the request: own-brand authored ⇒ SKIPPED_OWN_BRAND (terminal: brand-authored text needs no
 *      understanding, TA §58); otherwise ⇒ DETERMINISTIC_DONE (NON-terminal: it awaits the semantic stage, H7-C/E).
 *      A request already past PENDING is left as it is (later stages own it).
 *
 * Never written here: an assessment of any dimension (a link's presence is not its reputation; a keyword is not
 * meaning), a Protection Evaluation, a priority, a moderation request, an alert, an "understood" event. Watch terms are
 * NOT evaluated: the effective rule-set revision of a workspace is not yet decided (and no revision can exist yet).
 */
import { SIGNALS_VERSION, detectTextSignals, ownBrandSignal, type FlagSignal, type LinkPresentSignal, type Signal } from "../domain/signals";
import type { Arrival, ClassificationClock, ClassificationScope, RequestState, SignalRow } from "./ports";

/** The H7-B pipeline identity: change it (a new version) only to reprocess intentionally. */
export const DETERMINISTIC_PIPELINE_VERSION = "classification.deterministic.v1" as const;

export type DeterministicOutcome =
  | {
    readonly kind: "recorded";
    readonly requestId: string;
    readonly requestCreated: boolean;
    readonly state: RequestState;
    readonly signals: Readonly<Record<SignalRow["kind"], number>>;
    readonly signalsInserted: number;
    readonly signalsEquivalent: number;
  }
  | { readonly kind: "target_not_found" }
  | { readonly kind: "target_not_eligible" }
  | { readonly kind: "signal_conflict" };

export interface DeterministicInput {
  readonly interactionId: string;
  readonly sourceTextVersionId: string;
  readonly arrival: Arrival;
}

/** The only facts this stage records (an allowlist: anything else a domain function might return is ignored). */
const DETERMINISTIC_KINDS: readonly SignalRow["kind"][] = ["link_present", "text_empty", "text_emoji_only", "author_own_brand"];
const isDeterministicFact = (fact: Signal): fact is LinkPresentSignal | FlagSignal => (DETERMINISTIC_KINDS as readonly string[]).includes(fact.kind);

const AUTHOR_ROLES = ["account_identity", "user", "unknown"] as const;
type AuthorRole = (typeof AUTHOR_ROLES)[number];
const isAuthorRole = (value: unknown): value is AuthorRole => typeof value === "string" && (AUTHOR_ROLES as readonly string[]).includes(value);

export async function understandDeterministically(scope: ClassificationScope, clock: ClassificationClock, input: DeterministicInput): Promise<DeterministicOutcome> {
  const target = await scope.texts.analysisText(input.interactionId, input.sourceTextVersionId);
  // RLS and the (interaction, version) relation: another workspace's or another interaction's version reads as absent.
  if (target === undefined) return { kind: "target_not_found" };
  if (!target.observed || (target.kind !== "comment" && target.kind !== "reply") || !isAuthorRole(target.authorRole)) return { kind: "target_not_eligible" };

  const now = clock.now();
  const request = await scope.store.ensureRequest({
    id: clock.newId(),
    organizationId: target.organizationId,
    workspaceId: target.workspaceId,
    interactionId: target.interactionId,
    sourceTextVersionId: target.sourceTextVersionId,
    pipelineVersion: DETERMINISTIC_PIPELINE_VERSION,
    arrival: input.arrival,
    now,
  });

  const facts: Signal[] = [...detectTextSignals(target.sourceText)];
  const ownBrand = ownBrandSignal(target.authorRole);
  if (ownBrand !== undefined) facts.push(ownBrand);

  const counts: Record<SignalRow["kind"], number> = { link_present: 0, text_empty: 0, text_emoji_only: 0, author_own_brand: 0 };
  let inserted = 0;
  let equivalent = 0;
  for (const fact of facts.filter(isDeterministicFact)) {
    const row: SignalRow = {
      id: clock.newId(),
      organizationId: target.organizationId,
      workspaceId: target.workspaceId,
      interactionId: target.interactionId,
      sourceTextVersionId: target.sourceTextVersionId,
      kind: fact.kind,
      signalsVersion: SIGNALS_VERSION,
      spans: fact.kind === "link_present" ? fact.spans : null,
      truncated: fact.kind === "link_present" ? fact.truncated : false,
      now,
    };
    const written = await scope.store.recordSignal(row);
    if (written === "conflict") return { kind: "signal_conflict" };
    if (written === "inserted") inserted += 1;
    else equivalent += 1;
    counts[fact.kind] += 1;
  }

  let state = request.state;
  if (state === "PENDING") {
    const next: RequestState = ownBrand !== undefined ? "SKIPPED_OWN_BRAND" : "DETERMINISTIC_DONE";
    // Under the request's row lock (ensureRequest): only this transaction can move it.
    if (!(await scope.store.advanceRequest(request.id, "PENDING", next, now))) throw new Error("classification_request_moved_concurrently");
    state = next;
  }
  return { kind: "recorded", requestId: request.id, requestCreated: request.created, state, signals: counts, signalsInserted: inserted, signalsEquivalent: equivalent };
}
