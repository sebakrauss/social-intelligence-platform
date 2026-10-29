/**
 * Attempt metadata (Step H7-C; H7-A0 §12 ledger, TA §57 provenance). One record per provider call (initial or the one
 * re-ask); a call refused before reaching a provider (disabled task, kill switch, budget, input limit) has none.
 * In-memory only: no table exists yet (no migration in H7-C). IDs, versions, counts and outcome classes only — never
 * a prompt, a response, social text or reasoning.
 */
import type { AiFailureClass } from "./failures";
import type { ProviderUsage } from "./provider-port";

export const ATTEMPT_OUTCOMES = ["accepted", "invalid_output", "refused", "unavailable", "input_too_large"] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** The ids a gateway call is about (opaque to the gateway; e.g. interaction and source text version). */
export type GatewaySubject = Readonly<Record<string, string>>;

export interface AttemptRecord {
  readonly workspaceId: string;
  readonly subject: GatewaySubject;
  readonly pipelineVersion: string;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly providerKey: string;
  readonly modelKey: string;
  /** As reported by the provider; null when it reports none (or never completed). */
  readonly modelVersion: string | null;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly outputSchemaVersion: string;
  readonly versions: Readonly<Record<string, string>>;
  readonly attemptNumber: 1 | 2;
  readonly kind: "initial" | "reask";
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly inputChars: number;
  readonly usage: ProviderUsage | null;
  /** TA-Q-23 OPEN: no price table, so no estimate. */
  readonly costEstimate: null;
  readonly outcome: AttemptOutcome;
  readonly failureClass: AiFailureClass | null;
  readonly issueCodes: readonly string[];
}
