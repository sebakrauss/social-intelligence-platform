/**
 * Local/test composition of the SEALING half only. Web composition roots use this (never the opener):
 * it returns a CredentialSealer and nothing that can unwrap or decrypt.
 */
import { localKeyringFromEnvironment, type RuntimeEnvironment } from "./local-keyring";
import { createCredentialSealer, type CredentialSealer } from "./seal";

// The startup guard and the key's variable name, for web composition roots (which may not import the keyring module).
export { LOCAL_KEYRING_KEY_ENV, assertNoLocalKeyringOutsideLocal } from "./local-keyring";

export function localCredentialSealerFromEnvironment(environment: RuntimeEnvironment): CredentialSealer {
  return createCredentialSealer(localKeyringFromEnvironment(environment).generator);
}
