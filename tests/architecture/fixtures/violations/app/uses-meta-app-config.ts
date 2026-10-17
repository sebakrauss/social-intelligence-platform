/** Violation: app/ never reads the Meta app configuration; only the web's connection runtime does. */
import { readMetaAppConfig } from "../server/connections/meta-app-config";
export const leaked = readMetaAppConfig;
