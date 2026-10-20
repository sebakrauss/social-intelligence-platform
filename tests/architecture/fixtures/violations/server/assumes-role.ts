/** Violation (Step 7G-H5.6B): no first-party module talks to STS. */
import { STSClient } from "@aws-sdk/client-sts";
export const leaked = STSClient;
