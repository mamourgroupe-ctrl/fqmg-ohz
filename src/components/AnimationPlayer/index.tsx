"use client";

/**
 * LEGACY (phase 4): this player renders a LIVE generated component in the
 * main page context and is no longer used by /generate or /code-examples —
 * those went through src/sandbox/SandboxedPreview (opaque-origin iframe).
 * Kept only as a legacy surface; do not wire new screens to it.
 */
import { Player, type ErrorFallback, type PlayerRef } from "@remotion/player";
import React, { useEffect, useRef } from "react";
import { ASPECT_RATIOS, type AspectRatioId } from "@/types/generation";
import { ErrorDisplay, type ErrorType } from "../ErrorDisplay";
import { RenderControls } from "./RenderControls";
import { SettingsModal } from "./SettingsModal";

const errorTitles: Record<ErrorType, string> = {
  validation: "Invalid Prompt",
  api: "API Error",
  compilation: "Compilation Error",
  truncated: "Output Truncated",
};

const renderErrorFallback: ErrorFallback = ({ error }) => {
  return (
    <ErrorDisplay
      error={error.message || "An error occurred while rendering"}
      title="Runtime Error"
      variant="fullscreen"
      size="lg"
    />
  );
};

interface AnimationPlayerProps {
  Component: React.ComponentType | null;
  durationInFrames: number;
  fps: number;
  onDurationChange: (duration: number) => void;
  onFpsChange: (fps: number) => void;
  isCompiling: boolean;
  isStreaming: boolean;
  error: string | null;
  errorType?: ErrorType;
  code: string;
  onRuntimeError?: (error: string) => void;
  onFrameChange?: (frame: number) => void;
  aspectRatio?: AspectRatioId;
  onAspectRatioChange?: (id: AspectRatioId) => void;
}

export const AnimationPlayer: React.FC<AnimationPlayerProps> = ({
  Component,
  durationInFrames,
  fps,
  onDurationChange,
  onFpsChange,
  isCompiling,
  isStreaming,
  error,
  errorType = "compilation",
  code,
  onRuntimeError,
  onFrameChange,
  aspectRatio = "16:9",
  onAspectRatioChange,
}) => {
  const { width: compWidth, height: compHeight } = ASPECT_RATIOS[aspectRatio];
  const playerRef = useRef<PlayerRef>(null);

  // Listen for runtime errors from the Player's error boundary
  // Component is included in deps because the Player remounts when Component changes (via key={Component.toString()})
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !onRuntimeError) return;

    const handleError = (e: { detail: { error: Error } }) => {
      onRuntimeError(e.detail.error.message);
    };

    player.addEventListener("error", handleError);
    return () => {
      player.removeEventListener("error", handleError);
    };
  }, [onRuntimeError, Component]);

  // Listen for frame changes and report to parent
  // Component is included in deps because the Player remounts when Component changes (via key={Component.toString()})
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !onFrameChange) return;

    const handleFrameUpdate = (e: { detail: { frame: number } }) => {
      onFrameChange(e.detail.frame);
    };

    player.addEventListener("frameupdate", handleFrameUpdate);
    return () => {
      player.removeEventListener("frameupdate", handleFrameUpdate);
    };
  }, [onFrameChange, Component]);

  const renderContent = () => {
    if (isStreaming) {
      return (
        <div className="w-full aspect-video max-h-[calc(100%-80px)] flex flex-col justify-center items-center gap-4 bg-background-elevated rounded-lg overflow-hidden shadow-[0_0_60px_rgba(0,0,0,0.5)]">
          <div className="w-12 h-12 border-4 border-border border-t-primary rounded-full animate-spin" />
          <p className="text-muted-foreground text-sm">
            Waiting for code generation to finish...
          </p>
        </div>
      );
    }

    if (isCompiling) {
      return (
        <div className="w-full aspect-video max-h-[calc(100%-80px)] flex justify-center items-center bg-background-elevated rounded-lg overflow-hidden shadow-[0_0_60px_rgba(0,0,0,0.5)]">
          <div className="w-12 h-12 border-4 border-border border-t-primary rounded-full animate-spin" />
        </div>
      );
    }

    if (error) {
      return (
        <ErrorDisplay
          error={error}
          title={errorTitles[errorType]}
          variant="fullscreen"
          size="lg"
        />
      );
    }

    if (!Component) {
      return (
        <div className="w-full aspect-video max-h-[calc(100%-80px)] flex justify-center items-center bg-background-elevated rounded-lg overflow-hidden shadow-[0_0_60px_rgba(0,0,0,0.5)] text-muted-foreground-dim text-lg font-sans">
          Select an example to get started
        </div>
      );
    }

    return (
      <>
        <div className="w-full aspect-video max-h-[calc(100%-80px)] rounded-lg overflow-hidden shadow-[0_0_60px_rgba(0,0,0,0.5)]">
          <Player
            ref={playerRef}
            key={Component.toString()}
            component={Component}
            durationInFrames={durationInFrames}
            fps={fps}
            compositionHeight={compHeight}
            compositionWidth={compWidth}
            style={{
              width: "100%",
              height: "100%",
              backgroundColor: "transparent",
            }}
            controls
            autoPlay
            loop
            errorFallback={renderErrorFallback}
            spaceKeyToPlayOrPause={false}
            clickToPlay={false}
            initiallyMuted
          />
        </div>
        <div className="flex items-center justify-between gap-6 mt-4">
          <RenderControls
            code={code}
            durationInFrames={durationInFrames}
            fps={fps}
          />
          <SettingsModal
            durationInFrames={durationInFrames}
            onDurationChange={onDurationChange}
            fps={fps}
            onFpsChange={onFpsChange}
            aspectRatio={aspectRatio}
            onAspectRatioChange={onAspectRatioChange || (() => {})}
          />
        </div>
      </>
    );
  };

  return (
    <div className="flex flex-col bg-background min-w-0 h-full">
      <div className="w-full h-full flex flex-col">{renderContent()}</div>
    </div>
  );
};
