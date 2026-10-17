/** Violation: the job runtime never reaches the hosted web's Meta app configuration (the App Secret is web-only). */
import { readMetaAppConfig } from "../server/connections/meta-app-config";
export const leaked = readMetaAppConfig;
