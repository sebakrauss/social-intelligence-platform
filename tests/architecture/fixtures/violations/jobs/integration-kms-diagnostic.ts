/**
 * Violation (Step 7E.7-B/-R4): the KMS worker-auth diagnostic module opens through the composition only — never a
 * provider adapter, the outbox, the database, the main plane's modules or any other server/ subtree.
 */
import { adapter } from "../integrations/providers/meta/adapter";
import { delivery } from "../platform/outbox/delivery";
import { client } from "../platform/db/client";
import { moves } from "./moves";
import { runDiscoverAssets } from "./connections";
import { target as commands } from "../server/commands/kms-diagnostic-target";
import { target as pipeline } from "../server/pipeline/kms-diagnostic-target";
import { target as serverJobs } from "../server/jobs/kms-diagnostic-target";
import { target as http } from "../server/http/kms-diagnostic-target";
import { target as auth } from "../server/auth/kms-diagnostic-target";
import { target as persistence } from "../server/persistence/kms-diagnostic-target";
import { target as connections } from "../server/connections/kms-diagnostic-target";
export const leaked: unknown[] = [adapter, delivery, client, moves, runDiscoverAssets, commands, pipeline, serverJobs, http, auth, persistence, connections];
