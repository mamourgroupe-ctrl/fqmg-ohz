import * as Babel from "@babel/standalone";
import type React from "react";
import {
  extractComponentBody,
  evaluateTranspiled,
} from "@/remotion/compiler";
import {
  validateGeneratedCode,
  type CodeViolation,
} from "@/sandbox/code-validator";

/**
 * Phase 4 — evaluation gate for the sandboxed preview.
 *
 * This module is the ONLY sanctioned path for turning generated code into a
 * component, and it is meant to run INSIDE the opaque-origin sandbox frame
 * (src/app/preview-sandbox). The parent app must never call it for preview
 * purposes: the parent validates + transpiles only, then hands the transpiled
 * string to the frame over postMessage.
 *
 * Layering: validateGeneratedCode (fail-closed AST whitelist) -> Babel
 * transpile (pure data) -> evaluateTranspiled (new Function with the React/
 * Remotion whitelist as the only injections). Inside the sandbox the realm is
 * opaque and network-free (SANDBOX_CSP), so even a validator bypass cannot
 * reach cookies, storage, the parent DOM, or the network.
 */

export interface SandboxEvaluationResult {
  Component: React.ComponentType | null;
  error: string | null;
  violations?: CodeViolation[];
}

function formatViolations(violations: CodeViolation[]): string {
  return violations.map((violation) => `${violation.kind}:${violation.name}`).join(", ");
}

function transpileBody(componentBody: string): {
  transpiled: string | null;
  error: string | null;
} {
  try {
    const wrappedSource = `const DynamicAnimation = () => {\n${componentBody}\n};`;
    const transpiled = Babel.transform(wrappedSource, {
      presets: ["react", "typescript"],
      filename: "dynamic-animation.tsx",
    });
    if (!transpiled.code) {
      return { transpiled: null, error: "Transpilation failed" };
    }
    return { transpiled: transpiled.code, error: null };
  } catch {
    return { transpiled: null, error: "Transpilation failed" };
  }
}

/** Validate + transpile WITHOUT creating any component (safe in the parent). */
export function transpileForSandbox(body: string): {
  transpiled: string | null;
  error: string | null;
  violations?: CodeViolation[];
} {
  const validation = validateGeneratedCode(body);
  if (!validation.ok) {
    return {
      transpiled: null,
      error: `Generated code rejected by the sandbox security policy: ${formatViolations(validation.violations)}`,
      violations: validation.violations,
    };
  }
  const componentBody = extractComponentBody(body);
  const result = transpileBody(componentBody);
  return { ...result, violations: undefined };
}

/**
 * Full evaluation INSIDE the sandbox realm. Malicious code is refused before
 * any evaluation happens; the return value proves it (Component null +
 * security error, no side effects).
 */
export function evaluateGeneratedComponent(body: string): SandboxEvaluationResult {
  const validation = validateGeneratedCode(body);
  if (!validation.ok) {
    return {
      Component: null,
      error: `Generated code rejected by the sandbox security policy: ${formatViolations(validation.violations)}`,
      violations: validation.violations,
    };
  }
  const componentBody = extractComponentBody(body);
  const transpiled = transpileBody(componentBody);
  if (!transpiled.transpiled) {
    return { Component: null, error: transpiled.error };
  }
  const evaluated = evaluateTranspiled(transpiled.transpiled);
  if (typeof evaluated !== "function") {
    return {
      Component: null,
      error: "Code must be a function that returns a React component",
    };
  }
  return { Component: evaluated as React.ComponentType, error: null };
}
