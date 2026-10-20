// ARCHITECTURE TEST FIXTURE — deliberately violates boundaries. Never imported by application code.
// Violation (Step 7G-H5.6B): only the fetch tool itself may read the helper pins from jobs/.
import { AWS_SIGNING_HELPER_VERSION } from "../../jobs/aws-signing-helper";

export const leaked = AWS_SIGNING_HELPER_VERSION;
