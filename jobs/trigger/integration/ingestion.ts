import { runConfirmInteraction } from "../../confirm-interaction";
import { runReconcileSlice } from "../../reconciliation-slice";
import { PRODUCTION_TASKS } from "../../registry";
import { defineTenantStepTask } from "../define";

export const ingestionReconcileSlice = defineTenantStepTask(PRODUCTION_TASKS, "ingestion.reconcile_slice", (context) => runReconcileSlice(context));
export const ingestionConfirmInteraction = defineTenantStepTask(PRODUCTION_TASKS, "ingestion.confirm_interaction", (context) => runConfirmInteraction(context));
