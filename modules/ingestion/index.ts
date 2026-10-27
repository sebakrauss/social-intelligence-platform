/** ingestion module public API (TA §7.1, L1; Step H6-A1: pure domain contracts only — no jobs, no persistence yet). */
export {
  SLICE_CURSOR_MAX_AGE_MS,
  SLICE_CURSOR_MAX_LENGTH,
  SLICE_MAX_PAGES,
  SLICE_OVERLAP_MAX_MS,
  SLICE_UNITS,
  advanceSlice,
  cursorResumable,
  nextWindowStart,
  sliceDispatchKey,
  sliceViolations,
  type ProviderSliceCursor,
  type ReconciliationSlice,
  type SliceCapabilityScope,
  type SlicePage,
  type SliceStep,
  type SliceUnit,
  type SliceViolation,
} from "./domain/reconciliation-slice";
export {
  INTERACTIONS_OBSERVED_TOPIC,
  OBSERVED_ARRIVALS,
  OBSERVED_CHANGES,
  ingestionEventViolations,
  interactionsObservedOutboxRow,
  type IngestionEventRecord,
  type InteractionsObservedOutboxRow,
  type ObservedArrival,
  type ObservedChange,
} from "./domain/events";
export { INITIAL_IMPORT_POLICY, PROVIDER_EVENT_INBOX_POLICY } from "./domain/policy";
