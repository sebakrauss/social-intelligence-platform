/** Allowed: the web's connection runtime composes the Vercel identity adapter and reads the Meta app configuration. */
import { adapter } from "./vercel-aws-identity";
import { readMetaAppConfig } from "./meta-app-config";
export const composed = [adapter, readMetaAppConfig];
