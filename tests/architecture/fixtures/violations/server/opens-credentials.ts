/** Violation: the web deployment must never open credentials. */
import { open } from "../platform/crypto/credentials/open";
export const leaked = open;
