import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Pin the workspace root: the disposable spikes under spikes/ carry their own lockfiles.
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
};

export default nextConfig;
