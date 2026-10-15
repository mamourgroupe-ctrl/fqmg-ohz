/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Remotion's Node packages (and esbuild's platform binary) must be required from node_modules at
  // runtime instead of being bundled: they resolve optional, platform-specific native packages
  // (`@remotion/compositor-*`, `@remotion/whisper-webgpu`, `@remotion/video-matting`, esbuild's
  // binary) that do not exist for every target and cannot be parsed as JavaScript.
  // The visual QA job API imports the local/Lambda render backends, so without this the whole
  // production build fails while resolving those optional packages.
  serverExternalPackages: ["@remotion/bundler", "@remotion/renderer", "@remotion/lambda", "esbuild"],
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
