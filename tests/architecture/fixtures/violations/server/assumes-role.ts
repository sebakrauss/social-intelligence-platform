/** Violation (Step 7E.4C): only the integration worker identity adapter talks to STS. */
import { STSClient } from "@aws-sdk/client-sts";
export const leaked = STSClient;
