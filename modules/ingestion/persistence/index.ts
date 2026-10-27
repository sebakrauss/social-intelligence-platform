/** ingestion persistence (PostgreSQL; Step H6-B). Composed by server/persistence; tables owned by this module only. */
export { createPostgresIngestionEventStore } from "./store";
export { authorityConflicts, reconciliationRuns, reconciliationSlices, reconciliationWatermarks } from "./reconciliation-tables";
