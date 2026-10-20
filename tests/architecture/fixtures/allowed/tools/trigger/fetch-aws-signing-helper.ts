// ARCHITECTURE TEST FIXTURE — allowed dependencies. Never imported by application code.
// Allowed (Step 7G-H5.6B): the operator fetch tool reads exactly the helper pins from jobs/.
import { AWS_SIGNING_HELPER_VERSION } from "../../jobs/aws-signing-helper";

export const version = AWS_SIGNING_HELPER_VERSION;
