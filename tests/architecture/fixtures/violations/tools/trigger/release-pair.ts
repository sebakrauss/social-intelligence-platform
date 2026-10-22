// ARCHITECTURE TEST FIXTURE — deliberately violates boundaries. Never imported by application code.
// Violation (Step 7G-H5.5-P2-F2): the release planner reads the helper pins only, never another jobs/ module.
import { runDiscoverAssets } from "../../jobs/connections";

export const leaked = runDiscoverAssets;
