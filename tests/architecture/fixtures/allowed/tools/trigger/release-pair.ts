// ARCHITECTURE TEST FIXTURE — allowed dependencies. Never imported by application code.
// Allowed (Step 7G-H5.5-P2-F2): the release planner reads exactly the helper pins from jobs/.
import { AWS_SIGNING_HELPER_VERSION } from "../../jobs/aws-signing-helper";

export const version = AWS_SIGNING_HELPER_VERSION;
