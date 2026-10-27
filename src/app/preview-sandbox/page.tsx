"use client";

import React, { useEffect, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { renderStillOnWeb } from "@remotion/web-renderer";
import {
  parseSandboxMessage,
  type SandboxMessage,
} from "@/sandbox/iframe-sandbox";
import { evaluateTranspiled } from "@/remotion/compiler";

/**
 * Phase 4 — the in-iframe preview runtime (src/app/preview-sandbox).
 *
 * This document runs with an OPAQUE origin (sandbox="allow-scripts" without
 * allow-same-origin — set by SandboxedPreview) and a no-network CSP response
 * header (next.config.js). It receives ALREADY-VALIDATED transpiled code from
 * the parent over postMessage, evaluates it in this isolated realm with the
 * React/Remotion whitelist as the only injections, and renders it with the
 * Remotion Player. Cookies, storage, and the parent DOM are unreachable here
 * by browser enforcement; there is deliberately no fetch/XHR usage.
 */

type EvaluatedComponent = React.ComponentType;

const send = (message: SandboxMessage): void => {
  // The frame is opaque-origin: it cannot spell the parent origin, so the
  // message goes with targetOrigin "*" and the PARENT validates origin
  // ("null") + source + structure on its side.
  window.parent.postMessage(message, "*");
};

const PreviewSandboxPage: React.FC = () => {
  const [component, setComponent] = useState<EvaluatedComponent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composition, setComposition] = useState({
    width: 1920,
    height: 1080,
    fps: 30,
    durationInFrames: 150,
  });
  const playerRef = useRef<PlayerRef>(null);
  const stateRef = useRef({ component, composition });
  stateRef.current = { component, composition };

  useEffect(() => {
    // Evaluate is permissive ONLY because the parent already enforced the
    // AST whitelist before transpiling; the realm itself is opaque and
    // network-free, which is the real boundary.
    const run = (transpiled: string, config: { width: number; height: number; fps: number; durationInFrames: number }) => {
      try {
        const evaluated = evaluateTranspiled(transpiled) as unknown;
        if (typeof evaluated !== "function") {
          throw new Error("Code must be a function that returns a React component");
        }
        setComponent(() => evaluated as EvaluatedComponent);
        setComposition(config);
        setError(null);
        send({
          type: "fqmg-sandbox/meta",
          durationInFrames: config.durationInFrames,
          fps: config.fps,
        });
      } catch (cause) {
        setComponent(null);
        const detail = cause instanceof Error ? cause.message : "Unknown runtime error";
        setError(detail);
        send({ type: "fqmg-sandbox/error", message: detail });
      }
    };

    const captureStill = async (frame: number, requestId: string) => {
      const current = stateRef.current;
      if (!current.component) {
        send({ type: "fqmg-sandbox/error", message: "capture refused: nothing is rendered yet" });
        return;
      }
      try {
        const blob = await (
          await renderStillOnWeb({
            composition: {
              component: current.component,
              id: "sandbox-frame-capture",
              width: current.composition.width,
              height: current.composition.height,
              fps: current.composition.fps,
              durationInFrames: current.composition.durationInFrames,
            },
            frame,
            scale: 0.5,
            inputProps: {},
          })
        ).blob({ format: "jpeg" });
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 1) {
          binary += String.fromCharCode(bytes[i]);
        }
        send({
          type: "fqmg-sandbox/capture-result",
          requestId,
          dataUrl: `data:image/jpeg;base64,${btoa(binary)}`,
        });
      } catch {
        send({ type: "fqmg-sandbox/error", message: "capture failed inside the sandbox" });
      }
    };

    const onMessage = (event: MessageEvent) => {
      const message = parseSandboxMessage(event.data);
      if (!message) return;
      if (message.type === "fqmg-sandbox/run") {
        run(message.transpiled, {
          width: message.width,
          height: message.height,
          fps: message.fps,
          durationInFrames: message.durationInFrames,
        });
        return;
      }
      if (message.type === "fqmg-sandbox/capture-request") {
        void captureStill(message.frame, message.requestId);
      }
    };

    window.addEventListener("message", onMessage);
    send({ type: "fqmg-sandbox/ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Telemetry: frame updates from the Player flow back to the parent.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onFrameUpdate = (event: { detail: { frame: number } }) => {
      send({ type: "fqmg-sandbox/frame", frame: event.detail.frame });
    };
    player.addEventListener("frameupdate", onFrameUpdate);
    return () => player.removeEventListener("frameupdate", onFrameUpdate);
  }, [component]);

  const playerErrorFallback = () => {
    // Player-level runtime errors surface as sandbox errors, never crashes.
    return React.createElement(
      "div",
      { style: { color: "#fff", padding: 24, fontFamily: "monospace" } },
      "Runtime error inside the sandboxed composition.",
    );
  };

  return (
    <div className="h-screen w-screen bg-black">
      {component ? (
        <Player
          ref={playerRef}
          component={component}
          durationInFrames={composition.durationInFrames}
          fps={composition.fps}
          compositionWidth={composition.width}
          compositionHeight={composition.height}
          style={{ width: "100%", height: "100%" }}
          controls
          autoPlay
          loop
          errorFallback={playerErrorFallback}
        />
      ) : (
        <div className="flex h-full items-center justify-center">
          <p className="font-mono text-xs text-white/60">
            {error ? `sandbox error: ${error}` : "sandboxed preview idle"}
          </p>
        </div>
      )}
    </div>
  );
};

export default PreviewSandboxPage;
