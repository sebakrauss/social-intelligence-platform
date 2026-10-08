/** Violation: the job runtime never reaches the web's Vercel identity adapter (KMS_WORKER_AUTH is open). */
import { vercelAwsIdentity } from "../server/connections/vercel-aws-identity";
export const leaked = vercelAwsIdentity;
