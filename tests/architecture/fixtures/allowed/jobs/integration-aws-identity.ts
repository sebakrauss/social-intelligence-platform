/** Allowed (Step 7E.4C): the integration worker's AWS identity adapter is the one STS client user. */
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
export const workerIdentity: unknown[] = [AssumeRoleCommand, STSClient];
