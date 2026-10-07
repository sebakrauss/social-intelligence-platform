import type { NextConfig } from "next";
import { securityHeaderRules } from "./server/http/security-headers";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Pin the workspace root: the disposable spikes under spikes/ carry their own lockfiles.
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
  // TA-11A: minimum hosted-web security headers on every response (server/http/security-headers.ts).
  headers: () => Promise.resolve(securityHeaderRules()),
};

export default nextConfig;
