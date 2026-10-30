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
      provider: "v8",
      reporter: ["text", "text-summary", "html", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/__tests__/**", "src/**/*.d.ts"],
      // Phase 8 (D-028): per-glob floors for the core, set AT the measured
      // local baseline (the local run skips the redis/browser suites, so it
      // is the floor; CI, which executes them, measures strictly higher).
      thresholds: {
        "src/agent/**": { lines: 80, functions: 74, branches: 72 },
        "src/render/**": { lines: 63, functions: 56, branches: 58 },
        "src/voice/**": { lines: 85, functions: 88, branches: 70 },
      },
    },
  },
});
