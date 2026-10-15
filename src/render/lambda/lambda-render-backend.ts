import { randomUUID } from "node:crypto";
import { renderMediaOnLambda, getRenderProgress } from "@remotion/lambda/client";
import { RemoteUrlArtifactSchema, type RenderArtifact } from "@/agent/artifact";
import {
  DEFAULT_AGENT_COMPOSITION_ID,
  RenderBackendError,
  type RenderBackend,
  type RenderBackendRequest,
} from "@/agent/render-contract";
import { sanitizeDiagnosticText } from "@/agent/redaction";
import { RemotionAdapter } from "@/render/remotion/remotion-adapter";

/**
 * Remotion Lambda render backend.
 *
 * Output handling is explicit: a Lambda render produces a remote artifact (S3/HTTPS), never a
 * local filesystem path. The loop later downloads that artifact inside the configured byte and
 * time limits, runs the existing ffprobe gate on the local copy, and extracts frames from it.
 * AWS credentials are read from the environment only, are never logged, and their absence fails
 * closed before any request is made.
 */

export interface LambdaRenderBackendOptions {
  region: string;
  serveUrl: string;
  functionName: string;
  compositionId?: string;
  codec?: "h264" | "vp8" | "vp9" | "prores" | "h265" | "gif";
  framesPerLambda?: number;
  maxRenderIdleMs?: number;
  pollIntervalMs?: number;
  /** Test seams: replace the Lambda client calls. */
  renderMediaOnLambdaFn?: typeof renderMediaOnLambda;
  getRenderProgressFn?: typeof getRenderProgress;
  env?: Readonly<Record<string, string | undefined>>;
}

interface LambdaRenderHandle {
  renderId: string;
  bucketName: string;
}

function hasAwsCredentials(env: Readonly<Record<string, string | undefined>>): boolean {
  const accessKey = env.AWS_ACCESS_KEY_ID ?? env.REMOTION_AWS_ACCESS_KEY_ID;
  const secretKey = env.AWS_SECRET_ACCESS_KEY ?? env.REMOTION_AWS_SECRET_ACCESS_KEY;
  return Boolean(accessKey && secretKey);
}

export class RemotionLambdaRenderBackend implements RenderBackend {
  readonly engineId = "remotion-lambda" as const;
  readonly isConfigured: boolean;

  private readonly options: LambdaRenderBackendOptions;
  private readonly renderMediaOnLambdaFn: typeof renderMediaOnLambda;
  private readonly getRenderProgressFn: typeof getRenderProgress;
  private readonly env: Readonly<Record<string, string | undefined>>;

  constructor(options: LambdaRenderBackendOptions) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.renderMediaOnLambdaFn = options.renderMediaOnLambdaFn ?? renderMediaOnLambda;
    this.getRenderProgressFn = options.getRenderProgressFn ?? getRenderProgress;
    this.isConfigured = hasAwsCredentials(this.env);
  }

  private async startRender(
    request: RenderBackendRequest,
    inputProps: unknown,
  ): Promise<LambdaRenderHandle> {
    try {
      const started = await this.renderMediaOnLambdaFn({
        codec: this.options.codec ?? "h264",
        functionName: this.options.functionName,
        region: this.options.region as Parameters<typeof renderMediaOnLambda>[0]["region"],
        serveUrl: this.options.serveUrl,
        composition: this.options.compositionId ?? DEFAULT_AGENT_COMPOSITION_ID,
        inputProps: inputProps as Record<string, unknown>,
        framesPerLambda: this.options.framesPerLambda ?? 60,
        downloadBehavior: { type: "download", fileName: "video.mp4" },
      });

      return { renderId: started.renderId, bucketName: started.bucketName };
    } catch (error) {
      throw new RenderBackendError(
        "render-failed",
        "The Remotion Lambda render could not be started.",
        sanitizeDiagnosticText(error instanceof Error ? error.message : "", [], 300),
      );
    }
  }

  async render(request: RenderBackendRequest): Promise<RenderArtifact> {
    if (!this.isConfigured) {
      throw new RenderBackendError(
        "not-configured",
        "Remotion Lambda credentials are missing, so no cloud render was started. Set REMOTION_AWS_ACCESS_KEY_ID and REMOTION_AWS_SECRET_ACCESS_KEY (or the AWS_* equivalents).",
      );
    }

    const adapter = new RemotionAdapter();
    const assessment = adapter.assess(request.specification);
    if (!assessment.supported) {
      throw new RenderBackendError(
        "unsupported-specification",
        `The Lambda backend cannot render this specification: ${assessment.reasons.join(" ")}`,
      );
    }
    const blueprint = adapter.createBlueprint(request.specification);

    const handle = await this.startRender(request, blueprint.inputProps);
    const pollIntervalMs = this.options.pollIntervalMs ?? 2_000;
    const deadline = Date.now() + (this.options.maxRenderIdleMs ?? request.timeoutMs);

    while (true) {
      if (request.signal?.aborted) {
        throw new RenderBackendError("cancelled", "The Lambda render was cancelled.");
      }
      if (Date.now() > deadline) {
        throw new RenderBackendError(
          "render-timeout",
          `The Lambda render did not finish within ${this.options.maxRenderIdleMs ?? request.timeoutMs}ms.`,
        );
      }

      let progress;
      try {
        progress = await this.getRenderProgressFn({
          bucketName: handle.bucketName,
          functionName: this.options.functionName,
          region: this.options.region as Parameters<typeof getRenderProgress>[0]["region"],
          renderId: handle.renderId,
        });
      } catch (error) {
        throw new RenderBackendError(
          "render-failed",
          "The Lambda render progress could not be read.",
          sanitizeDiagnosticText(error instanceof Error ? error.message : "", [], 300),
        );
      }

      if (progress.fatalErrorEncountered) {
        throw new RenderBackendError(
          "render-failed",
          "The Lambda render failed.",
          sanitizeDiagnosticText(progress.errors[0]?.message ?? "", [], 300),
        );
      }

      if (progress.done) {
        request.onProgress?.({ renderedFrames: 0, progress: 1 });
        const outputFile = progress.outputFile;
        if (typeof outputFile !== "string" || !outputFile.startsWith("https://")) {
          throw new RenderBackendError(
            "invalid-output",
            "The Lambda render finished without an HTTPS artifact URL.",
          );
        }

        return RemoteUrlArtifactSchema.parse({
          kind: "remote-url",
          artifactId: randomUUID(),
          url: outputFile,
          ...(typeof progress.outputSizeInBytes === "number"
            ? { sizeBytes: Math.max(0, Math.round(progress.outputSizeInBytes)) }
            : {}),
          mimeType: "video/mp4",
          cleanup: "provider-managed",
          jobId: request.jobId,
          engine: "remotion-lambda",
          bucketName: handle.bucketName,
          renderId: handle.renderId,
        });
      }

      request.onProgress?.({
        renderedFrames: progress.framesRendered ?? 0,
        progress: Math.max(0, Math.min(1, progress.overallProgress ?? 0)),
      });

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

export function lambdaFunctionName(input: {
  diskSizeInMb: number;
  memorySizeInMb: number;
  timeoutInSeconds: number;
}): string {
  // Mirrors the existing /api/lambda/render route, which resolves the function name with
  // Remotion's speculateFunctionName helper; callers may pass an explicit name instead.
  return `remotion-render-4-0-534-mem${input.memorySizeInMb}mb-disk${input.diskSizeInMb}mb-${input.timeoutInSeconds}sec`;
}
