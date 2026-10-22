// ARCHITECTURE TEST FIXTURE — deliberately violates boundaries. Never imported by application code.
// Violation (Step 7G-H5.5-P2-F2): the release executor imports no jobs/ module, not even the helper pins.
import { AWS_SIGNING_HELPER_VERSION } from "../../jobs/aws-signing-helper";

export const leaked = AWS_SIGNING_HELPER_VERSION;
