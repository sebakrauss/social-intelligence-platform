/** Violation: the UI never evaluates capability (TA §16.5); it renders server view models. */
import { capabilityApi } from "../modules/capability/index";
export const leaked = capabilityApi;
