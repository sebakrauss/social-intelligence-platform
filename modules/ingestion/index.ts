/** ingestion module public API (TA §7.1, L1; H6-A1 pure domain contracts; H6-B canonical ingestion application services). */
export {
  RECONCILE_ACCOUNT_TOPIC,
  RECONCILE_SLICE_TOPIC,
  RECONCILIATION_DEFAULTS,
  SLICE_CURSOR_MAX_AGE_MS,
  SLICE_CURSOR_MAX_LENGTH,
  SLICE_MAX_PAGES,
  SLICE_OVERLAP_MAX_MS,
  SLICE_UNITS,
  advanceSlice,
  cursorResumable,
  maxInteractionPagesPerContent,
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
export { INITIAL_IMPORT_POLICY, PROVIDER_EVENT_INBOX_POLICY, reconciliationArrival } from "./domain/policy";
export {
  INGESTION_CONFLICT_CLASSES,
  OPEN_RUN_STATES,
  OPEN_SLICE_STATES,
  RECONCILIATION_RUN_STATES,
  DEFAULT_MAX_OPERATIONS,
  LIVE_ACCEPTANCE_MAX_OPERATIONS,
  RECONCILIATION_OPERATIONS_CEILING,
  RECONCILIATION_RUNTIME,
  RECONCILIATION_SLICE_STATES,
  defaultBudgetSnapshot,
  type IngestionConflictClass,
  type ReconciliationBudgetSnapshot,
  type ReconciliationRunState,
  type ReconciliationSliceState,
} from "./domain/reconciliation-state";
export { IngestionAuthorityConflict, ingestInteractionFact, type IngestInteractionInput, type IngestOutcome, type IngestionConflict } from "./application/ingest-interaction";
export { orderParentsFirst } from "./application/ordering";
export { recordIngestionCoverage, type RecordCoverageInput } from "./application/record-coverage";
export { SourceFactRejectedError, interactionSourceFactFromDto, textHashOf, type SourceFactContext } from "./application/source-fact-mapping";
export type { IngestionClock, IngestionEventStore, IngestionStores } from "./application/ports";
export {
  acceptObservedInteraction,
  planReconciliation,
  requestReconciliation,
  runReconciliationSlice,
  type ObservedOutcome,
  type PlanOutcome,
  type ReconciliationClock,
  type ReconciliationScope,
  type RequestReconciliationOutcome,
  type SliceDependencies,
  type SliceOutcome,
} from "./application/reconciliation";
export { requestMemberReconciliation, type MemberReconciliationRequest } from "./application/member-request";
export {
  confirmStoredInteraction,
  requestInteractionConfirmation,
  type ConfirmationDependencies,
  type ConfirmationRequestOutcome,
  type ConfirmationResult,
} from "./application/confirm-interaction";
export { CONFIRMATION_OUTCOMES, CONFIRMATION_RUNTIME, CONFIRM_INTERACTION_TOPIC, confirmationDispatchKey, type ConfirmationOutcome } from "./domain/confirmation";
export type {
  ObservedEventAuthority,
  ReconciliationAuthorityStore,
  ReconciliationRequestPort,
  ReconciliationRunRecord,
  ReconciliationSliceRecord,
  ReconciliationStore,
  ReconciliationWatermarkRecord,
} from "./application/reconciliation-ports";
