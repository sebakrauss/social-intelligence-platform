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
export { CONFIRMATION_COMPLETING_OUTCOMES, CONFIRMATION_OUTCOMES, CONFIRMATION_RUNTIME, CONFIRM_INTERACTION_TOPIC, completesConfirmation, confirmationDispatchKey, type ConfirmationOutcome } from "./domain/confirmation";
export type {
  ObservedEventAuthority,
  ReconciliationAuthorityStore,
  ReconciliationRequestPort,
  ReconciliationRunRecord,
  ReconciliationSliceRecord,
  ReconciliationStore,
  ReconciliationWatermarkRecord,
} from "./application/reconciliation-ports";
export {
  PROVIDER_EVENT_RUNTIME,
  PURGE_PROVIDER_EVENTS_TASK,
  RECEIPT_OUTCOMES,
  ROUTE_OUTCOMES,
  ROUTE_PROVIDER_EVENTS_TASK,
  routerNudgeDispatchKey,
  type ReceiptOutcome,
  type RouteOutcome,
} from "./domain/provider-events";
export {
  dispatchDueSignalMarks,
  expireSignalMarksSweep,
  purgeExpiredProviderEvents,
  routeDueProviderEvents,
  type ProviderEventDependencies,
  type MarkExpirySummary,
  type ProviderEventStore,
  type PurgeSummary,
  type SignalMarkExpiry,
  type RouteSummary,
} from "./application/provider-events";
export {
  HINT_CHANGES,
  PROCESS_SIGNALS_TASK,
  SIGNAL_MARK_KINDS,
  SIGNAL_OUTCOMES,
  SIGNAL_RUNTIME,
  SIGNAL_RUN_CORRELATION_PREFIX,
  classifySignal,
  decideFollowUp,
  satisfactionBoundary,
  satisfiesMark,
  signalConfirmationDispatchKey,
  signalRunBudget,
  signalRunCorrelation,
  type FollowUpDecision,
  type HintChange,
  type PendingMarksSummary,
  type SignalAction,
  type SignalFacts,
  type SignalMarkKind,
  type SignalOutcome,
  type SignalRunPlan,
} from "./domain/signals";
export { relistArrival } from "./domain/policy";
export { processProviderSignal, type SignalInvocation, type SignalResult } from "./application/process-signals";
export { closeRunSignals, planRelistSlices, reviewSignalMarks, type MarkReview, type RunCloseResult } from "./application/signal-marks";
export type { NewSignalMark, RoutedHintRead, SignalMarkStore } from "./application/reconciliation-ports";
