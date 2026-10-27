import { runInteractionsObserved, runReconcileAccount } from "../../reconciliation";
import { PRODUCTION_TASKS } from "../../registry";
import { defineTenantTask } from "../define";

export const ingestionReconcileAccount = defineTenantTask(PRODUCTION_TASKS, "ingestion.reconcile_account", runReconcileAccount);
export const interactionsObserved = defineTenantTask(PRODUCTION_TASKS, "interactions.observed", runInteractionsObserved);
