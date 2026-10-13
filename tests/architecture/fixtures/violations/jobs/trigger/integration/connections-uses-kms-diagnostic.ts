/** Violation (Step 7E.7-B): an unrelated integration task file never reaches the KMS worker-auth diagnostic module. */
import { leaked } from "../../integration-kms-diagnostic";
export const reached = leaked;
