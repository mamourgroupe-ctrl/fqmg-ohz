"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { SandboxBridge } from "@/sandbox/sandbox-bridge";
import {
  buildSandboxFrameProps,
  isTrustedSandboxEvent,
} from "@/sandbox/iframe-sandbox";
import { ASPECT_RATIOS, type AspectRatioId } from "@/types/generation";

/**
 * Phase 4 — the ONLY sanctioned preview surface for generated code.
 *
 * Generated code is never instantiated in the main page context: the parent
 * validates + transpiles it (Babel output only) and hands the string to an
 * iframe with sandbox="allow-scripts" and NO allow-same-origin (opaque
 * origin — no cookies, no storage, no parent DOM, enforced by the browser).
 * The frame route is served with a no-network CSP (next.config.js). All
 * communication is structured postMessage validated on both ends, with a
 * ready-watchdog: a frame that never reports ready is reported as a timeout.
 */

export interface SandboxedPreviewHandle {
  /** Renders one frame INSIDE the sandbox and returns a JPEG data URL. */
  captureFrame: (frame: number) => Promise<string>;
}

interface SandboxedPreviewProps {
  transpiled: string | null;
  error: string | null;
  isCompiling?: boolean;
  isStreaming?: boolean;
  aspectRatio?: AspectRatioId;
  onAspectRatioChange?: (id: AspectRatioId) => void;
  fps: number;
  durationInFrames: number;
  onDurationChange?: (durationInFrames: number) => void;
  onFpsChange?: (fps: number) => void;
  onFrameChange?: (frame: number) => void;
  onRuntimeError?: (message: string) => void;
  /** Ready-watchdog; also bounds capture requests. */
  sandboxTimeoutMs?: number;
}

const DEFAULT_WATCHDOG_MS = 10_000;

export const SandboxedPreview = forwardRef<SandboxedPreviewHandle, SandboxedPreviewProps>(
  function SandboxedPreview(
    {
      transpiled,
      error,
      isCompiling = false,
      isStreaming = false,
      aspectRatio = "16:9",
      onAspectRatioChange,
      fps,
      durationInFrames,
      onDurationChange,
      onFpsChange,
      onFrameChange,
      onRuntimeError,
      sandboxTimeoutMs = DEFAULT_WATCHDOG_MS,
    },
    ref,
  ) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const bridgeRef = useRef<SandboxBridge | null>(null);
    const [bridgeError, setBridgeError] = useState<string | null>(null);
    const frameProps = buildSandboxFrameProps();

    // latest-values refs so listeners/bridge callbacks stay stable
    const latest = useRef({
      transpiled,
      fps,
      durationInFrames,
      aspectRatio,
      onDurationChange,
      onFpsChange,
      onFrameChange,
      onRuntimeError,
    });
    latest.current = {
      transpiled,
      fps,
      durationInFrames,
      aspectRatio,
      onDurationChange,
      onFpsChange,
      onFrameChange,
      onRuntimeError,
    };

    const postToSandbox = useCallback((payload: Parameters<SandboxBridge["requestCapture"]> extends never ? never : Parameters<NonNullable<ConstructorParameters<typeof SandboxBridge>[0]["postToSandbox"]>>[0]) => {
      const frameWindow = iframeRef.current?.contentWindow;
      // targetOrigin "*": the frame is opaque-origin and cannot match our
      // origin string; confidentiality is not required parent->frame (the
      // payload is the already-public transpiled code), integrity is ensured
      // by the frame's own structural validation.
      frameWindow?.postMessage(payload, "*");
    }, []);

    // One bridge for the component lifetime; beginSession() per iframe load.
    useEffect(() => {
      const bridge = new SandboxBridge({
        timeoutMs: sandboxTimeoutMs,
        onError: (message) => setBridgeError(message),
        onRuntimeError: (message) => latest.current.onRuntimeError?.(message),
        onMeta: (meta) => {
          latest.current.onDurationChange?.(meta.durationInFrames);
          latest.current.onFpsChange?.(meta.fps);
        },
        onFrame: (frame) => latest.current.onFrameChange?.(frame),
        // ready => hand the transpiled code to the frame for this session
        onReady: () => {
          const current = latest.current;
          setBridgeError(null);
          if (current.transpiled) {
            const { width, height } = ASPECT_RATIOS[current.aspectRatio];
            postToSandbox({
              type: "fqmg-sandbox/run",
              transpiled: current.transpiled,
              width,
              height,
              fps: current.fps,
              durationInFrames: current.durationInFrames,
            });
          }
        },
        postToSandbox,
      });
      bridgeRef.current = bridge;
      return () => {
        bridge.dispose();
        bridgeRef.current = null;
      };
    }, [postToSandbox, sandboxTimeoutMs]);

    const handleSandboxEvent = useCallback((event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow) return;
      if (!isTrustedSandboxEvent(event, frameWindow)) return;
      bridgeRef.current?.handleSandboxMessage(event.data);
    }, []);

    useEffect(() => {
      window.addEventListener("message", handleSandboxEvent);
      return () => window.removeEventListener("message", handleSandboxEvent);
    }, [handleSandboxEvent]);

    // iframe (re)mount = new session: arm the watchdog; the run payload is
    // sent when the frame reports ready.
    const handleFrameLoad = useCallback(() => {
      bridgeRef.current?.beginSession();
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        captureFrame: (frame: number) => {
          const bridge = bridgeRef.current;
          if (!bridge) {
            return Promise.reject(new Error("sandbox preview is not mounted"));
          }
          return bridge.requestCapture(frame);
        },
      }),
      [],
    );

    const displayError = error || bridgeError;

    return (
      <div className="flex h-full min-h-0 flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <span
            className="text-xs text-muted-foreground"
            title="Generated code runs inside an isolated iframe: opaque origin, no cookies, no network."
          >
            Sandboxed preview — isolated origin, no network
          </span>
          {onAspectRatioChange ? (
            <select
              aria-label="Aspect ratio"
              className="rounded-md border bg-background-elevated px-2 py-1 text-xs"
              value={aspectRatio}
              onChange={(event) => onAspectRatioChange(event.target.value as AspectRatioId)}
            >
              {Object.keys(ASPECT_RATIOS).map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border bg-black">
          {displayError ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/85 p-6">
              <div className="max-w-[80%] break-words text-center">
                <p className="text-sm font-semibold text-[#ff6b6b]">
                  {isCompiling ? "Compiling…" : "Preview error"}
                </p>
                <p className="mt-2 font-mono text-xs text-white/80">{displayError}</p>
              </div>
            </div>
          ) : null}
          {isStreaming ? (
            <div className="absolute inset-x-0 top-0 z-20 h-0.5 animate-pulse bg-primary" />
          ) : null}
          <iframe
            key={transpiled ?? "empty"}
            ref={iframeRef}
            {...frameProps}
            onLoad={handleFrameLoad}
            className="h-full w-full border-0"
          />
        </div>
      </div>
    );
  },
);
