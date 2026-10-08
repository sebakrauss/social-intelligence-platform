/**
 * MAIN-plane Move saga tasks (Step 5F; discovered only by trigger.config.ts). They make no provider call and open no
 * credential: each runs in ONE worker transaction bound to its single workspace.
 */
import { runActivateDestination, runRejectDestination, runReleaseSource } from "../../moves";
import { PRODUCTION_TASKS } from "../../registry";
import { defineTenantTask } from "../define";

export const connectionsMoveReleaseSource = defineTenantTask(PRODUCTION_TASKS, "connections.move.release_source", runReleaseSource);
export const connectionsMoveActivateDestination = defineTenantTask(PRODUCTION_TASKS, "connections.move.activate_destination", runActivateDestination);
export const connectionsMoveRejectDestination = defineTenantTask(PRODUCTION_TASKS, "connections.move.reject_destination", runRejectDestination);
