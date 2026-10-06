/**
 * Local/test composition of the SEALING half only. Web composition roots use this (never the opener):
 * it returns a CredentialSealer and nothing that can unwrap or decrypt.
 */
import { localKeyringFromEnvironment, type RuntimeEnvironment } from "./local-keyring";
import { createCredentialSealer, type CredentialSealer } from "./seal";

export function localCredentialSealerFromEnvironment(environment: RuntimeEnvironment): CredentialSealer {
  return createCredentialSealer(localKeyringFromEnvironment(environment).generator);
}
