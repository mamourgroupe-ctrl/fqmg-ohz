import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Dependency security policy (Phase 1) — regression guard for the advisory
 * fixes documented in docs/audit-after.md and docs/decisions.md D-007..D-009.
 *
 * Written failing-first against the pre-Phase-1 lockfile (zod 4.5.4): it goes
 * red there and green on the current tree. When a pin must move (e.g. a new
 * advisory-safe window), update it TOGETHER with package.json/package-lock.json
 * and cite the advisory ranges current at that date in the commit message.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const lock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8")) as {
  packages: Record<string, { version?: string }>;
};
const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
  overrides?: Record<string, string>;
};

type Triple = [number, number, number];

function parseVersion(version: string): Triple {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    throw new Error(`Unparseable version: ${version}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(actual: string, minimum: Triple): boolean {
  const a = parseVersion(actual);
  return (
    a[0] !== minimum[0] ? a[0] - minimum[0]
    : a[1] !== minimum[1] ? a[1] - minimum[1]
    : a[2] - minimum[2]
  ) >= 0;
}

/** All lockfile entries for a package name, wherever it sits in the tree. */
function lockedVersions(name: string): string[] {
  const prefix = `node_modules/${name}`;
  return Object.entries(lock.packages)
    .filter(([key]) => key === prefix || key.endsWith(`/${prefix}`))
    .map(([, entry]) => entry.version ?? "")
    .filter(Boolean);
}

describe("dependency security policy (docs/audit-after.md)", () => {
  it("keeps every zod copy at >= 4.6.6 (GHSA-mrhx-c7xc-m3w5)", () => {
    const versions = lockedVersions("zod");
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      expect(atLeast(version, [4, 6, 6]), `zod ${version} < 4.6.6`).toBe(true);
    }
  });

  it("keeps every dompurify copy at >= 3.4.17 (critical XSS chain)", () => {
    const versions = lockedVersions("dompurify");
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      expect(atLeast(version, [3, 4, 17]), `dompurify ${version} < 3.4.17`).toBe(true);
    }
  });

  it("keeps monaco-editor on the advisory-clean 0.56.x line (D-009)", () => {
    // >=0.57.0-rc.2 is flagged low; 0.56.0 stable is clean. Revisit when a
    // patched 0.57.x line ships, then relax this pin consciously.
    const versions = lockedVersions("monaco-editor");
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      expect(version.startsWith("0.56."), `monaco-editor ${version} outside 0.56.x`).toBe(true);
    }
  });

  it("keeps the ai-sdk chain inside the documented safe windows (D-008)", () => {
    // ai 5.0.223-5.0.282 is flagged moderate; @ai-sdk/react 2.0.225-2.0.285 too;
    // gateway 2.0.122-2.0.173 too; provider-utils 3.0.31-3.0.42 drags in a
    // vulnerable undici 5.x + @fastify/busboy 2.x chain. The safe pins below
    // remove undici/@fastify/busboy from the tree entirely.
    expect(lockedVersions("ai")).toEqual(["5.0.222"]);
    expect(lockedVersions("@ai-sdk/react")).toEqual(["2.0.224"]);
    expect(lockedVersions("@ai-sdk/gateway")).toEqual(["2.0.121"]);
    const providerUtils = lockedVersions("@ai-sdk/provider-utils");
    expect(providerUtils.length).toBeGreaterThan(0);
    for (const version of providerUtils) {
      expect(version, "@ai-sdk/provider-utils must stay 3.0.30 (safe window 3.0.28-3.0.30)").toBe("3.0.30");
    }
  });

  it("keeps @ai-sdk/openai past the low-severity fix (>= 2.0.110)", () => {
    const versions = lockedVersions("@ai-sdk/openai");
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      expect(atLeast(version, [2, 0, 110]), `@ai-sdk/openai ${version} <= 2.0.109`).toBe(true);
    }
  });

  it("keeps undici and @fastify/busboy out of the dependency tree", () => {
    expect(lockedVersions("undici")).toEqual([]);
    expect(lockedVersions("@fastify/busboy")).toEqual([]);
  });

  it("keeps the overrides that make the pins enforceable", () => {
    expect(pkg.overrides?.zod).toBe("^4.6.7");
    expect(pkg.overrides?.dompurify).toBe("3.4.17");
    expect(pkg.overrides?.["@ai-sdk/provider-utils"]).toBe("3.0.30");
  });
});
