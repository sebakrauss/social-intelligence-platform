/** Violation: the Meta adapter never reads configuration itself; the composition passes explicit values. */
import { readMetaAppConfig } from "../../../server/connections/meta-app-config";
export const leaked = readMetaAppConfig;
