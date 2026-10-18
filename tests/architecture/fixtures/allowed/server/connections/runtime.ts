/** Allowed: the web's connection runtime composes the Vercel identity adapter, reads the Meta app configuration and composes the Meta authorization adapter. */
import { adapter } from "./vercel-aws-identity";
import { readMetaAppConfig } from "./meta-app-config";
import { createMetaAuthorizationPort } from "../../integrations/providers/meta/authorization";
export const composed = [adapter, readMetaAppConfig, createMetaAuthorizationPort];
