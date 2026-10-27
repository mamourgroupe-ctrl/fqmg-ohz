import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
