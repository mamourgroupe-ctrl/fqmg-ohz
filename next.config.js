/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Turbopack config for Next.js 16+
  turbopack: {
    rules: {
      "*.md": {
        loaders: ["raw-loader"],
        as: "*.js",
      },
    },
  },
  // Webpack config for fallback
  webpack: (config) => {
    config.module.rules.push({
      test: /\.md$/,
      type: "asset/source",
    });
    return config;
  },
  // The sandboxed live preview serves the dev server from a *.e2b.app subdomain.
  allowedDevOrigins: ["*.e2b.app"],
};

module.exports = nextConfig;
