/**
 * Local/test composition of the OPENING half. Job runtime only (boundary rule), like the opener itself.
 */
import { localKeyringFromEnvironment, type RuntimeEnvironment } from "./local-keyring";
import { createCredentialOpener, type CredentialOpener } from "./open";

export function localCredentialOpenerFromEnvironment(environment: RuntimeEnvironment): CredentialOpener {
  return createCredentialOpener(localKeyringFromEnvironment(environment).unwrapper);
}
