/** Violation (Step 7E.7-B): the web never reaches the KMS worker-auth diagnostic module. */
import { leaked } from "../jobs/integration-kms-diagnostic";
export const reached = leaked;
