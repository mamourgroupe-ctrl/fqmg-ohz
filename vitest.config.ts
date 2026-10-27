import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

/**
 * Matches the Next.js config, where *.md is loaded as raw source (raw-loader /
 * asset-source). Route modules import markdown through @/skills, so tests that
 * import those routes need the same behavior under Vitest.
 */
const rawMarkdown: Plugin = {
  name: "raw-markdown",
  transform(code, id) {
    if (id.split("?")[0].endsWith(".md")) {
      return { code: `export default ${JSON.stringify(code)};`, map: null };
    }
    return undefined;
  },
};

export default defineConfig({
  plugins: [rawMarkdown],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      // Phase 0 (docs/progress.md): measurement only — no thresholds enforced yet.
      // A coverage threshold for the core (src/agent, src/voice, src/render) is a
      // Phase 8 deliverable, after the current numbers are recorded in CI.
      provider: "v8",
      reporter: ["text", "text-summary", "html"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/__tests__/**", "src/**/*.d.ts"],
    },
  },
});
