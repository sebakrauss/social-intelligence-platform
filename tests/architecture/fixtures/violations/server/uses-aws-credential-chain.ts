/** Violation: no AWS credential provider, default chain or STS is adopted (7D/7E decide credential composition). */
import { defaultProvider } from "@aws-sdk/credential-provider-node";
export const leaked = defaultProvider;
