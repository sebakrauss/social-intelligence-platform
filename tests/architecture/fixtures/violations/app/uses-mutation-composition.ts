/** Violation (Step 7B-13C, F2): the web never imports the job runtime's mutation composition. */
import { runExecuteIntent } from "../jobs/mutations";
export const leaked = runExecuteIntent;
