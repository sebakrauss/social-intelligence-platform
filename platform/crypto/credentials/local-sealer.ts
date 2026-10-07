/**
 * Local/test composition of the SEALING half only. Web composition roots use this (never the opener):
 * it returns a CredentialSealer and nothing that can unwrap or decrypt.
 */
import { localKeyringFromEnvironment, type RuntimeEnvironment } from "./local-keyring";
import { createCredentialSealer, type CredentialSealer } from "./seal";

// The startup guard, for web composition roots (which may not import the keyring module itself).
export { assertNoLocalKeyringOutsideLocal } from "./local-keyring";

export function localCredentialSealerFromEnvironment(environment: RuntimeEnvironment): CredentialSealer {
  return createCredentialSealer(localKeyringFromEnvironment(environment).generator);
}
