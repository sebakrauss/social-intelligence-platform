// ARCHITECTURE TEST FIXTURE — deliberately violates boundaries. Never imported by application code.
// Violation (Step 7G-H5.6B): the fetch tool reads the pins only, never another jobs/ module.
import { runDiscoverAssets } from "../../jobs/connections";

export const leaked = runDiscoverAssets;
