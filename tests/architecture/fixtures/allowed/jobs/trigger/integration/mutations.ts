/** Allowed (Step 7B-13C, F2): the executor's INTEGRATION task entrypoint imports the mutation composition. */
import { composeExecutor } from "../../mutations";
export const tasks: unknown[] = [composeExecutor];
