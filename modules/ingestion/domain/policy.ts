/**
 * Ingestion policies frozen by Step H6-A1 (TL decisions 3 and 6). Pure constants; enforcement lands with the gates
 * that persist or schedule (H6-B onwards).
 *
 * Raw webhook inbox (TL decision 3; TA §40; TA-Q-11 still VALIDATE for production): the verified raw webhook body may
 * exist ONLY in the restricted provider-event inbox, for at most `rawBodyRetentionDays`, and is never copied anywhere
 * else. The value is a policy constant, configurable later per environment; the cleanup schedule is a later gate.
 *
 * Initial historical import (TL decision 6): initial ingestion covers only what `read_interactions` truthfully reads
 * in the windows it actually reads. No 30-day historical import (PD D-09) is claimed until `read_history` is validated
 * on its own; coverage before the first read interval is HISTORY_DEPTH_NOT_VALIDATED.
 */

export const PROVIDER_EVENT_INBOX_POLICY = Object.freeze({
  rawBodyRetentionDays: 7,
  /** The only place a raw verified webhook body may be stored. */
  location: "provider_event_inbox" as const,
  /** Where it must never be copied. */
  forbiddenCopies: Object.freeze([
    "canonical_rows",
    "source_text_versions",
    "outbox_rows",
    "job_payloads",
    "logs",
    "analytics",
    "error_reports",
    "diagnostic_outputs",
  ] as const),
  /** Raw provider responses of polling/reconciliation are never stored at all (adapters whitelist fields). */
  storesPollingResponses: false,
});

export const INITIAL_IMPORT_POLICY = Object.freeze({
  /** Initial ingestion = the read_interactions windows actually read (never an implied history). */
  scope: "read_interactions_windows" as const,
  claimsHistoricalDepth: false,
  /** The capability whose validation would allow a historical-depth claim (UNKNOWN for Meta today). */
  historicalDepthCapability: "read_history" as const,
  /** Imported (backfilled) interactions arrive as `backfill`: never eligible for forward-only automation. */
  arrival: "backfill" as const,
});
