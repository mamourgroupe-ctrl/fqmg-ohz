import { randomUUID } from "node:crypto";
import { cp as fsCp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { makeCancelSignal, renderMedia, selectComposition } from "@remotion/renderer";
import { LocalFileArtifactSchema, type RenderArtifact } from "@/agent/artifact";
import {
  DEFAULT_AGENT_COMPOSITION_ID,
  DEFAULT_PREVIEW_SCALE,
  RenderBackendError,
  type RenderBackend,
  type RenderBackendRequest,
} from "@/agent/render-contract";
import { sanitizeDiagnosticText } from "@/agent/redaction";
import { RemotionAdapter } from "@/render/remotion/remotion-adapter";
// The same override the Remotion CLI and Lambda deploy use: the composition imports app modules
// through the `@/*` alias, so bundling here without it cannot resolve the entry point.
import { webpackOverride } from "@/remotion/webpack-override.mjs";

/**
 * Local Remotion render backend.
 *
 * Reuses the existing pipeline instead of adding a second one: the specification is validated
 * and turned into composition input props by the existing `RemotionAdapter`, and the render uses
 * the existing `src/remotion/entry.tsx` composition (`FQMG-OHZ-Preview`) through Remotion's own
 * bundler and renderer. The produced file still has to pass the existing ffprobe gate
 * (`verifyRenderOutput`) in the loop, so this backend never marks its own output successful.
 */

export interface LocalRenderBackendOptions {
  entryPoint?: string;
  compositionId?: string;
  outputDir?: string;
  scale?: number;
  logLevel?: "error" | "warn" | "info";
  /**
   * Directory of app-relative media (e.g. `assets/tone.wav` under it).
   * Its CONTENTS are copied into the bundle ROOT after bundling, mirroring
   * production URL semantics (Next serves public/ at the origin root), so a
   * spec source like `/assets/tone.wav` resolves during the render exactly
   * like it would against the deployed app. (Remotion's own publicDir
   * serving exposes files under /public/..., which the asset-source schema
   * forbids — verified empirically, D-027.)
   */
  publicDir?: string;
  /**
   * Disable Remotion's content-hash bundle cache (default: enabled). Backends
   * with their own publicDir/bundleOutputDir should disable it so parallel
   * renders never share one bundle directory and overwrite each other's
   * copied media (D-027).
   */
  bundleCaching?: boolean;
  /**
   * Dedicated bundle output directory (Remotion `outDir`). Keeps the bundle
   * out of Remotion's shared /tmp/remotion-webpack-bundle-* namespace so
   * concurrent renders never resolve against another worker's directory
   * (D-027). Absolute path; caching is force-disabled with it.
   */
  bundleOutputDir?: string;
  /** Test seams. */
  bundleFn?: typeof bundle;
  selectCompositionFn?: typeof selectComposition;
  renderMediaFn?: typeof renderMedia;
  makeCancelSignalFn?: typeof makeCancelSignal;
  allowedRoots?: readonly string[];
}

function mapRemotionFailure(error: unknown, sensitivePaths: readonly string[]): RenderBackendError {
  const message = sanitizeDiagnosticText(
    error instanceof Error ? error.message : String(error),
    sensitivePaths,
    300,
  );
  const lowered = message.toLowerCase();

  // Remotion reports a missing browser either as "no browser"/"could not find Chrome" or as a
  // failed download of the headless shell, which is what an offline environment produces.
  if (
    lowered.includes("no browser") ||
    lowered.includes("browser executable") ||
    lowered.includes("could not find chrome") ||
    lowered.includes("chrome-headless-shell") ||
    lowered.includes("executable doesn't exist") ||
    lowered.includes("headless shell") ||
    (lowered.includes("chrome") && lowered.includes("download")) ||
    lowered.includes("remotion browser ensure")
  ) {
    return new RenderBackendError(
      "browser-missing",
      "No Remotion browser is available. Install one with `npx remotion browser ensure` (or provide a CHROME/CHROMIUM executable) before rendering locally.",
      message,
    );
  }
  if (lowered.includes("timeout") || lowered.includes("timed out")) {
    return new RenderBackendError("render-timeout", "The local render timed out.", message);
  }
  if (
    lowered.includes("compositions") ||
    lowered.includes("composition id") ||
    (lowered.includes("composition") &&
      (lowered.includes("not found") || lowered.includes("could not be found") || lowered.includes("does not exist")))
  ) {
    return new RenderBackendError(
      "select-composition-failed",
      "The Remotion composition could not be selected.",
      message,
    );
  }
  return new RenderBackendError("render-failed", "The local Remotion render failed.", message);
}

export class RemotionLocalRenderBackend implements RenderBackend {
  readonly engineId = "remotion-local" as const;
  readonly isConfigured = true;

  private readonly entryPoint: string;
  private readonly compositionId: string;
  private readonly outputDir: string;
  private readonly scale: number;
  private readonly logLevel: "error" | "warn" | "info";
  private readonly publicDir?: string;
  private readonly bundleCaching: boolean;
  private readonly bundleOutputDir?: string;
  private readonly bundleFn: typeof bundle;
  private readonly selectCompositionFn: typeof selectComposition;
  private readonly renderMediaFn: typeof renderMedia;
  private readonly makeCancelSignalFn: typeof makeCancelSignal;
  private bundlePromise: Promise<string> | undefined;

  constructor(options: LocalRenderBackendOptions = {}) {
    this.entryPoint =
      options.entryPoint ?? path.resolve(process.cwd(), "src/remotion/entry.tsx");
    this.compositionId = options.compositionId ?? DEFAULT_AGENT_COMPOSITION_ID;
    this.outputDir = options.outputDir ?? path.resolve(process.cwd(), "renders/agent");
    this.scale = options.scale ?? DEFAULT_PREVIEW_SCALE;
    this.logLevel = options.logLevel ?? "error";
    this.publicDir = options.publicDir;
    this.bundleCaching = options.bundleCaching ?? true;
    this.bundleOutputDir = options.bundleOutputDir;
    this.bundleFn = options.bundleFn ?? bundle;
    this.selectCompositionFn = options.selectCompositionFn ?? selectComposition;
    this.renderMediaFn = options.renderMediaFn ?? renderMedia;
    this.makeCancelSignalFn = options.makeCancelSignalFn ?? makeCancelSignal;
  }

  private async ensureBundle(signal?: AbortSignal): Promise<string> {
    if (this.bundlePromise) return this.bundlePromise;

    this.bundlePromise = this.bundleFn({
      entryPoint: this.entryPoint,
      onProgress: () => undefined,
      webpackOverride,
      // Deliberately NOT rspack: Remotion's rspack bundler never invokes
      // webpackOverride (verified: the override callback is not called and
      // the `@/*` alias from webpack-override.mjs does not apply), so the
      // unified entry.tsx fails with "Module not found: @/motion/...".
      // Webpack honors the override; this is D-026 in docs/decisions.md.
      enableCaching: this.bundleCaching && !this.bundleOutputDir,
      ...(this.bundleOutputDir ? { outDir: this.bundleOutputDir } : {}),
      ...(signal ? { signal } : {}),
    })
      .then(async (serveUrl) => {
        // App-relative media sources (/assets/...) must resolve at the serve
        // origin root like they do against the deployed app. Remotion's own
        // publicDir serving would put them under /public/... (verified), so
        // copy the contents into the bundle root instead.
        if (this.publicDir) {
          await fsCp(this.publicDir, serveUrl, { recursive: true });
        }
        return serveUrl;
      })
      .catch((error: unknown) => {
        this.bundlePromise = undefined;
        throw mapRemotionFailure(error, [this.entryPoint, this.outputDir]);
      });

    return this.bundlePromise;
  }

  async render(request: RenderBackendRequest): Promise<RenderArtifact> {
    const adapter = new RemotionAdapter();
    const assessment = adapter.assess(request.specification);
    if (!assessment.supported) {
      throw new RenderBackendError(
        "unsupported-specification",
        `The Remotion backend cannot render this specification: ${assessment.reasons.join(" ")}`,
      );
    }
    const blueprint = adapter.createBlueprint(request.specification);

    const jobDir = path.join(this.outputDir, request.jobId);
    const outputLocation = path.join(jobDir, `${randomUUID()}.mp4`);

    // Checked before bundling: a cancelled job must not spend minutes building a bundle.
    if (request.signal?.aborted) {
      throw new RenderBackendError("cancelled", "The local render was cancelled before it started.");
    }

    try {
      await mkdir(jobDir, { recursive: true, mode: 0o700 });
      const serveUrl = await this.ensureBundle(request.signal);

      const composition = await this.selectCompositionFn({
        serveUrl,
        id: this.compositionId,
        inputProps: blueprint.inputProps,
      });

      const cancelSignalPair = this.makeCancelSignalFn();
      const onAbort = () => cancelSignalPair.cancel();
      request.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        await this.renderMediaFn({
          composition: {
            ...composition,
            width: blueprint.width,
            height: blueprint.height,
            fps: blueprint.fps,
            durationInFrames: blueprint.durationInFrames,
          },
          serveUrl,
          codec: "h264",
          outputLocation,
          inputProps: blueprint.inputProps,
          scale: request.scale ?? this.scale,
          logLevel: this.logLevel,
          timeoutInMilliseconds: request.timeoutMs,
          overwrite: true,
          cancelSignal: cancelSignalPair.cancelSignal,
          onProgress: ({ renderedFrames, progress }) =>
            request.onProgress?.({ renderedFrames, progress }),
        });
      } catch (error) {
        if (request.signal?.aborted) {
          throw new RenderBackendError("cancelled", "The local render was cancelled.");
        }
        throw error;
      } finally {
        request.signal?.removeEventListener("abort", onAbort);
      }
    } catch (error) {
      if (error instanceof RenderBackendError) throw error;
      throw mapRemotionFailure(error, [this.entryPoint, this.outputDir]);
    }

    const info = await stat(outputLocation).catch(() => undefined);
    if (!info?.isFile() || info.size === 0) {
      throw new RenderBackendError(
        "invalid-output",
        "Remotion reported success but produced no usable video file.",
        sanitizeDiagnosticText(outputLocation, [this.outputDir]),
      );
    }

    return LocalFileArtifactSchema.parse({
      kind: "local-file",
      artifactId: randomUUID(),
      absolutePath: outputLocation,
      sizeBytes: info.size,
      mimeType: "video/mp4",
      cleanup: "delete-after-job",
      jobId: request.jobId,
      engine: "remotion-local",
    });
  }
}

export function getLocalRenderOutputDir(
  options: LocalRenderBackendOptions = {},
): string {
  return options.outputDir ?? path.resolve(process.cwd(), "renders/agent");
}

export function getLocalRenderAllowedRoots(
  options: LocalRenderBackendOptions = {},
): readonly string[] {
  return options.allowedRoots ?? [getLocalRenderOutputDir(options)];
}
