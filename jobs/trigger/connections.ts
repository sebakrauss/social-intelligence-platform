/**
 * Connection tasks (Step 5D). connections.discover_assets runs as a multi-step tenant job: one workspace, worker
 * scope, IDs-only payload, and no database transaction held across the provider call.
 */
import { runDiscoverAssets } from "../connections";
import { PRODUCTION_TASKS } from "../registry";
import { defineTenantStepTask } from "./define";

export const connectionsDiscoverAssets = defineTenantStepTask(PRODUCTION_TASKS, "connections.discover_assets", (context) => runDiscoverAssets(context));
