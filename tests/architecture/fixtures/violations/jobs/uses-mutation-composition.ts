/** Violation (Step 7B-13C, F2): no other jobs module imports the mutation composition. */
import { runExecuteIntent } from "./mutations";
export const leaked = runExecuteIntent;
