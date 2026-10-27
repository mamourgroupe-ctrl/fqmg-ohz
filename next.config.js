/** @type {import('next').NextConfig} */
// Phase 4: the sandboxed preview frame route gets a strict no-network CSP.
// Keep this string in sync with SANDBOX_CSP in src/sandbox/iframe-sandbox.ts --
// tests/generated-code-sandbox.test.ts asserts the two match.
const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/preview-sandbox",
        headers: [
          { key: "Content-Security-Policy", value: SANDBOX_CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
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
