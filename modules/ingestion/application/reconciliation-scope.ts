/**
 * The stores of ONE workspace-scoped job transaction used by reconciliation, confirmation and signal processing (Step
 * H6-C3; split into its own file in Step H6-F4 so the signal-mark services share it without an import cycle).
 */
import type { IngestionClock, IngestionStores } from "./ports";
import type { ReconciliationAuthorityStore, ReconciliationStore, SignalMarkStore } from "./reconciliation-ports";

/** One workspace-scoped transaction's stores. `isolated` runs work in a savepoint whose failure rolls back alone. */
export interface ReconciliationScope {
  readonly reconciliation: ReconciliationStore;
  readonly authority: ReconciliationAuthorityStore;
  readonly ingestion: IngestionStores;
  /** Step H6-F4: the tenant signal marks (0022). */
  readonly signals: SignalMarkStore;
  isolated<T>(work: (ingestion: IngestionStores) => Promise<T>): Promise<T>;
}

export type ReconciliationClock = IngestionClock;
