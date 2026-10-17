/** Violation: the integration plane never reads the Meta app configuration ("Require App Secret" is OFF). */
import { readMetaAppConfig } from "../../../server/connections/meta-app-config";
export const leaked = readMetaAppConfig;
