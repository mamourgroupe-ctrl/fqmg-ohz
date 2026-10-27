"use client";

import { useCallback, useEffect, useState } from "react";
import { transpileGeneratedCode } from "@/remotion/compiler";

/**
 * Phase 4 — main-context state for the legacy code path.
 *
 * This hook NEVER creates a live component: generated code is validated
 * (fail-closed AST whitelist) and transpiled to plain JS only. The transpiled
 * string is rendered by the opaque-origin sandbox iframe
 * (src/sandbox/SandboxedPreview + src/app/preview-sandbox), so no
 * LLM-generated code executes in the main page context anymore.
 */

export interface AnimationState {
  code: string;
  /** Babel output for the sandbox iframe — never a React component. */
  transpiled: string | null;
  error: string | null;
  isCompiling: boolean;
}

export function useAnimationState(initialCode: string = "") {
  const [state, setState] = useState<AnimationState>({
    code: initialCode,
    transpiled: null,
    error: null,
    isCompiling: false,
  });

  const compileCode = useCallback((code: string) => {
    setState((prev) => ({ ...prev, isCompiling: true }));
    const result = transpileGeneratedCode(code);
    setState((prev) => ({
      ...prev,
      transpiled: result.transpiled,
      error: result.error,
      isCompiling: false,
    }));
  }, []);

  const setCode = useCallback((newCode: string) => {
    setState((prev) => ({ ...prev, code: newCode }));
  }, []);

  // Auto-compile when component mounts with initial code
  useEffect(() => {
    if (initialCode) {
      compileCode(initialCode);
    }
  }, [initialCode, compileCode]);

  return {
    ...state,
    setCode,
    compileCode,
  };
}
