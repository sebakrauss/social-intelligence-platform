/**
 * INTEGRATION-plane tasks (Step 7E.4B.3; discovered only by trigger.integration.config.ts): the only tasks that open a
 * provider credential. connections.discover_assets (Step 5D) and capability.evaluate_account (Step 5F) call providers,
 * so they run as multi-step tenant jobs (no database transaction held across the provider call). Their payloads carry
 * identifiers only; the services re-read the connection, account and active credential from the database under the
 * run's single bound workspace.
 */
import { runDiscoverAssets, runEvaluateAccountCapabilities } from "../../connections";
import { PRODUCTION_TASKS } from "../../registry";
import { defineTenantStepTask } from "../define";

export const connectionsDiscoverAssets = defineTenantStepTask(PRODUCTION_TASKS, "connections.discover_assets", (context) => runDiscoverAssets(context));
export const capabilityEvaluateAccount = defineTenantStepTask(PRODUCTION_TASKS, "capability.evaluate_account", (context) => runEvaluateAccountCapabilities(context));
