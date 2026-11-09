/**
 * INTEGRATION-plane task of the Platform Mutation Executor (Step 7B-1; discovered only by trigger.integration.config.ts):
 * the only task that obtains a provider MUTATION port. Multi-step tenant job: EXECUTING is committed in one
 * transaction, the provider is called outside any transaction, the outcome is recorded in another.
 */
import { runExecuteIntent } from "../../mutations";
import { PRODUCTION_TASKS } from "../../registry";
import { defineTenantStepTask } from "../define";

export const mutationsExecuteIntent = defineTenantStepTask(PRODUCTION_TASKS, "mutations.execute_intent", (context) => runExecuteIntent(context));
