/** Violation (Step 7E.4C): a main-plane task file never reaches the integration worker's AWS identity. */
import { workerIdentity } from "../../integration-aws-identity";
export const leaked = workerIdentity;
