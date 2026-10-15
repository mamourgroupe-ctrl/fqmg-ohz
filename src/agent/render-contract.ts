import { z } from "zod";
import type { RenderArtifact } from "@/agent/artifact";
import type { MotionSpecification } from "@/motion/schemas/motion-specification";

/**
 * Render adapter contract for the agent loop.
 *
 * This is deliberately separate from `RendererAdapter` (specification -> blueprint): the loop
 * renders through a backend that may be local (filesystem output) or Lambda (remote artifact),
 * and the loop never assumes that a render produced a local path.
 */

export const RenderEngineIdSchema = z.enum(["remotion-local", "remotion-lambda"]);
export type RenderEngineId = z.infer<typeof RenderEngineIdSchema>;

export interface RenderBackendRequest {
  jobId: string;
  specification: MotionSpecification;
  /** Render scale, 0.1 - 1. */
  scale?: number;
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: { renderedFrames: number; progress: number }) => void;
}

export interface RenderBackend {
  readonly engineId: RenderEngineId;
  /** True when the backend is ready to render (for example AWS credentials are present). */
  readonly isConfigured: boolean;
  render(request: RenderBackendRequest): Promise<RenderArtifact>;
}

export type RenderBackendErrorCode =
  | "unsupported-specification"
  | "not-configured"
  | "bundle-failed"
  | "browser-missing"
  | "select-composition-failed"
  | "render-failed"
  | "render-timeout"
  | "cancelled"
  | "invalid-output";

export class RenderBackendError extends Error {
  constructor(
    readonly code: RenderBackendErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "RenderBackendError";
  }
}

export const DEFAULT_AGENT_COMPOSITION_ID = "FQMG-OHZ-Preview";

/** Scale used for preview renders so critique frames come from a cheap render. */
export const DEFAULT_PREVIEW_SCALE = 0.5;
