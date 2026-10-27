/**
 * Interaction state observations (Step H6-A1; Model §11, §45; TA §14.3, §47.3). Pure.
 *
 * State = visibility (visible · hidden · unknown, only as the provider reports it) × availability (available ·
 * removed_at_source). Observations are append-only history; the current state moves only FORWARD in observed time.
 *
 * Absence is not removal. Missing from a listing → a removal CANDIDATE that asks for an authoritative direct re-fetch,
 * never a state. removed_at_source needs one of:
 *   - an explicit provider removal signal that was verified (a tombstone; a verified webhook removal), or
 *   - an authoritative direct re-fetch (the stored path) answering "gone" while the connection is healthy, on a
 *     platform whose not-found answer is VALIDATED to mean removal. Meta's node not-found (code 100 / subcode 33) is
 *     documented as ambiguous, so today it never confirms a removal on Facebook or Instagram.
 *
 * A stale observation (observed earlier than the current state) is kept as history but never rolls the current
 * state back. An identical observation adds nothing (a bounded heartbeat is a persistence concern).
 */
import { compareInstants, type Instant } from "@/domain/instant";
import type { InteractionAvailability, InteractionVisibility, RemovalBasis } from "./vocabulary";

export interface InteractionStateObservation {
  readonly visibility: InteractionVisibility;
  readonly availability: InteractionAvailability;
  readonly observedAt: Instant;
}

export type StateChange = "none" | "state_changed" | "removed_at_source";

export interface StateDecision {
  /** Whether the observation is appended to history. */
  readonly record: boolean;
  /** Whether it becomes the current state. */
  readonly advanceCurrent: boolean;
  readonly change: StateChange;
}

export function decideStateObservation(current: InteractionStateObservation | null, incoming: InteractionStateObservation): StateDecision {
  const change: StateChange = incoming.availability === "removed_at_source" ? "removed_at_source" : "state_changed";
  if (current === null) return { record: true, advanceCurrent: true, change };
  if (compareInstants(incoming.observedAt, current.observedAt) < 0) return { record: true, advanceCurrent: false, change: "none" };
  if (incoming.visibility === current.visibility && incoming.availability === current.availability) return { record: false, advanceCurrent: false, change: "none" };
  return { record: true, advanceCurrent: true, change };
}

/** Missing from a listing: never a state — only a request for an authoritative direct re-fetch. */
export function classifyListingAbsence(): { readonly kind: "removal_candidate"; readonly next: "direct_refetch" } {
  return { kind: "removal_candidate", next: "direct_refetch" };
}

export interface RemovalEvidence {
  /** A provider removal signal whose authenticity was verified (never an unverified webhook). */
  readonly verifiedProviderSignal: boolean;
  /** What an authoritative direct re-fetch answered, if one was made. */
  readonly directFetch: "not_attempted" | "found" | "not_found";
  readonly connectionHealthy: boolean;
  /** Whether the platform's not-found answer is VALIDATED to mean removal (false for Meta today). */
  readonly notFoundConfirmsRemoval: boolean;
}

/** The basis on which an interaction may be marked removed_at_source, or null: it stays as it is. */
export function removalBasisFrom(evidence: RemovalEvidence): RemovalBasis | null {
  if (evidence.directFetch === "found") return null;
  if (evidence.verifiedProviderSignal) return "explicit_provider_signal";
  if (evidence.directFetch === "not_found" && evidence.connectionHealthy && evidence.notFoundConfirmsRemoval) return "direct_fetch_confirmed";
  return null;
}
