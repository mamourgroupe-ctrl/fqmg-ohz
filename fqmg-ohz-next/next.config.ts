import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep the nested application independent from the repository-root package lock/config.
  turbopack: {
    root: process.cwd(),
  },
  // Arena's live preview uses a sandbox subdomain; keep dev-server origin checks compatible.
  allowedDevOrigins: ["*.e2b.app"],
};

export default nextConfig;
