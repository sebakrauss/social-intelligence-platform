/** Violation: app/ never imports the Vercel identity adapter or the official AWS credentials provider. */
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";
import { vercelAwsIdentity } from "../server/connections/vercel-aws-identity";
export const leaked = [awsCredentialsProvider, vercelAwsIdentity];
