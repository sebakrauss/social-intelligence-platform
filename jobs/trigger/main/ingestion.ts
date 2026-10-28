import { runProcessSignals } from "../../process-signals";
import { runInteractionsObserved, runReconcileAccount } from "../../reconciliation";
import { PRODUCTION_TASKS } from "../../registry";
import { jobLogger } from "../../runtime";
import { defineTenantTask } from "../define";

export const ingestionReconcileAccount = defineTenantTask(PRODUCTION_TASKS, "ingestion.reconcile_account", runReconcileAccount);
export const interactionsObserved = defineTenantTask(PRODUCTION_TASKS, "interactions.observed", runInteractionsObserved);
// Step H6-F4: the tenant half of webhook signals (DB planning only; produced only by the 0022 system definers).
export const ingestionProcessSignals = defineTenantTask(PRODUCTION_TASKS, "ingestion.process_signals", (context) => runProcessSignals(context, jobLogger));
