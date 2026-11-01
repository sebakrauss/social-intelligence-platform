import { runUnderstandAi } from "../../intelligence";
import { PRODUCTION_TASKS } from "../../registry";
import { defineTenantStepTask } from "../define";

// Step H7-D1d: the one INTELLIGENCE task — two short scoped steps around one gateway run, no transaction across the call.
export const classificationUnderstandAi = defineTenantStepTask(PRODUCTION_TASKS, "classification.understand_ai", (context) => runUnderstandAi(context));
