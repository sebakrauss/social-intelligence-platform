/** Violation: Vercel OIDC is read only by the web identity adapter; no CLI refresh helper is ever imported. */
import { getContext } from "@vercel/oidc";
import { execa } from "execa";
export const leaked = [getContext, execa];
