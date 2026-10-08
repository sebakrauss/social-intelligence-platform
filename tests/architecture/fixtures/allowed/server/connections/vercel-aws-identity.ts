/** Allowed: the hosted web's identity adapter reads the request token (getContext) and builds the official provider. */
import { getContext } from "@vercel/oidc";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";
export const adapter = [getContext, awsCredentialsProvider];
