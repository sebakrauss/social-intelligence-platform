// ARCHITECTURE TEST FIXTURE — allowed dependencies. Never imported by application code.
import { mutations } from "../integrations/providers/meta/mutation-port";
import { execute } from "../mutations/executor";
export const composeExecutor = (): void => { execute(mutations); };
