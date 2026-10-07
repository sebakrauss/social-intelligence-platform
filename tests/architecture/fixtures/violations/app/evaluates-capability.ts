/** Violation: app/ never evaluates capability itself. */
import { capabilityApi } from "../modules/capability/index";
export const leaked = capabilityApi;
