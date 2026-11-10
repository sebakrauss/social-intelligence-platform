/** Violation (Step 7B-13C, F2): another INTEGRATION task file is not the executor's entrypoint either. */
import { runExecuteIntent } from "../../mutations";
export const leaked = runExecuteIntent;
