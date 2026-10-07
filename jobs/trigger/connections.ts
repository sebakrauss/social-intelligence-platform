/**
 * Connection tasks. connections.discover_assets (Step 5D) and capability.evaluate_account (Step 5F) call providers, so
 * they run as multi-step tenant jobs (no database transaction held across the provider call). The Move saga steps
 * (Step 5F) make no provider call: each runs in ONE worker transaction bound to its single workspace.
 */
import { runActivateDestination, runDiscoverAssets, runEvaluateAccountCapabilities, runRejectDestination, runReleaseSource } from "../connections";
import { PRODUCTION_TASKS } from "../registry";
import { defineTenantStepTask, defineTenantTask } from "./define";

export const connectionsDiscoverAssets = defineTenantStepTask(PRODUCTION_TASKS, "connections.discover_assets", (context) => runDiscoverAssets(context));
export const connectionsMoveReleaseSource = defineTenantTask(PRODUCTION_TASKS, "connections.move.release_source", runReleaseSource);
export const connectionsMoveActivateDestination = defineTenantTask(PRODUCTION_TASKS, "connections.move.activate_destination", runActivateDestination);
export const connectionsMoveRejectDestination = defineTenantTask(PRODUCTION_TASKS, "connections.move.reject_destination", runRejectDestination);
export const capabilityEvaluateAccount = defineTenantStepTask(PRODUCTION_TASKS, "capability.evaluate_account", (context) => runEvaluateAccountCapabilities(context));
