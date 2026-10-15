import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertPathWithinRoots, defaultAllowedRoots } from "@/agent/artifact";
import { inspectImage } from "@/agent/image-inspection";
import { sanitizeDiagnosticText } from "@/agent/redaction";
import {
  probeFrameTimeline,
  probeVideoMetadata,
  VideoProbeError,
  type FrameTimeline,
  type ProbedVideo,
  type VideoProbe,
} from "@/agent/video-probe";
import { getMediaBinary, runMediaCommand } from "@/render/engine/media-binaries";

/**
 * Representative frame extraction for visual critique.
 *
 * Safety and honesty properties:
 *  - `execFile` only (never a shell); external input is passed as separate argv entries;
 *  - the output directory must resolve inside an allowed root, and symlink escapes are rejected;
 *  - frame count, frame width, per-frame bytes, total bytes, and every process timeout are bounded;
 *  - each sample timestamp is snapped to a presentation timestamp that ffprobe proved exists in
 *    the media, and the chosen timestamps must be distinct and strictly increasing;
 *  - every produced image is re-inspected (format, dimensions, byte size) and hashed, so the
 *    critique records exactly which bytes it reviewed, and the bytes are returned in memory so
 *    the critique never has to touch the filesystem again;
 *  - frames are deleted by default; retaining them is an explicit opt-in
 *    (`keepFrames` / AGENT_KEEP_FRAMES) and the applied policy is reported in the result.
 *
 * Known limitation: the bundled Remotion ffmpeg is a stripped build with no frame-timestamp
 * filter and no framemd5/framecrc muxer, so the extractor can prove *which timestamp it sought*
 * and *that a frame exists at that timestamp*, but it cannot prove pixel-for-pixel that the
 * written JPEG is that exact frame. The sha256 of each frame makes the reviewed bytes traceable.
 */

export const AGENT_MAX_FRAMES = 8;
export const AGENT_MIN_FRAME_WIDTH = 128;
export const AGENT_MAX_FRAME_WIDTH = 1_280;

export const FrameExtractionRequestSchema = z.object({
  videoPath: z.string().min(1).max(4_096),
  outputDir: z.string().min(1).max(4_096),
  frameCount: z.number().int().min(1).max(AGENT_MAX_FRAMES),
  width: z.number().int().min(AGENT_MIN_FRAME_WIDTH).max(AGENT_MAX_FRAME_WIDTH),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(20_000),
  maxFrameBytes: z.number().int().min(16 * 1024).max(8 * 1024 * 1024).default(2 * 1024 * 1024),
  maxTotalBytes: z.number().int().min(64 * 1024).max(48 * 1024 * 1024).default(12 * 1024 * 1024),
  keepFrames: z.boolean().default(false),
});

export type FrameExtractionRequest = z.input<typeof FrameExtractionRequestSchema>;

export type FrameExtractionErrorCode =
  | "invalid-input"
  | "unsafe-path"
  | "missing-file"
  | "probe-failed"
  | "unsafe-duration"
  | "extract-failed"
  | "extract-timeout"
  | "frame-invalid"
  | "too-large"
  | "ffmpeg-missing"
  | "video-too-long"
  | "cancelled";

export class FrameExtractionError extends Error {
  constructor(
    readonly code: FrameExtractionErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "FrameExtractionError";
  }
}

export interface ExtractedFrame {
  index: number;
  /** The frame bytes, already validated and bounded (maxFrameBytes / maxTotalBytes). */
  bytes: Buffer;
  /** Where the frame was written, for diagnostics; the caller may delete it immediately. */
  filePath: string;
  /** Timestamp requested from ffmpeg (snapped to a real frame timestamp). */
  timestampSeconds: number;
  /** Nearest real presentation timestamp reported by ffprobe for the sample interval. */
  probedTimestampSeconds: number;
  width: number;
  height: number;
  mimeType: "image/jpeg" | "image/png";
  sizeBytes: number;
  sha256: string;
}

export interface FrameExtractionResult {
  frames: ExtractedFrame[];
  outputDir: string;
  requestedFrameCount: number;
  extractedFrameCount: number;
  /** May be lower than requestedFrameCount for very short videos. */
  effectiveFrameCount: number;
  /** Frame count read from the media timeline by ffprobe. */
  probedFrameCount: number;
  /** Frame count implied by the ffprobe duration and frame rate. */
  metadataFrameCount: number;
  /** False when the probed timeline disagrees with duration x fps beyond rounding. */
  frameCountConsistent: boolean;
  videoDurationSeconds: number;
  videoFps: number;
  /** True when the video duration is shorter than requestedFrameCount / fps. */
  shortVideoAdjusted: boolean;
  cleanedUp: boolean;
  retainedFrames: boolean;
}

export interface FrameExtractionOptions {
  probe?: VideoProbe;
  ffmpegPath?: string;
  ffprobePath?: string;
  allowedRoots?: readonly string[];
  signal?: AbortSignal;
  /** Test seams. */
  runCommand?: typeof runMediaCommand;
  probeTimeline?: typeof probeFrameTimeline;
  onCommand?: (executable: string, args: readonly string[]) => void;
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new FrameExtractionError("cancelled", "Frame extraction was cancelled.");
  }
}

async function assertRegularReadableFile(filePath: string): Promise<string> {
  if (filePath.includes("\0")) {
    throw new FrameExtractionError("unsafe-path", "The video path contains a null byte.");
  }
  const absolute = path.resolve(filePath);

  let info;
  try {
    info = await lstat(absolute);
  } catch {
    throw new FrameExtractionError("missing-file", "The video to analyse does not exist.");
  }

  if (info.isSymbolicLink()) {
    const target = await stat(absolute).catch(() => undefined);
    if (!target?.isFile()) {
      throw new FrameExtractionError(
        "unsafe-path",
        "The video path must resolve to a regular file, not a device or directory.",
      );
    }
    return absolute;
  }

  if (!info.isFile()) {
    throw new FrameExtractionError(
      "unsafe-path",
      "The video path must be a regular file, not a device or directory.",
    );
  }

  return absolute;
}

/**
 * Chooses how many of the requested frames a video of this duration can support.
 * A short video is sampled with fewer frames instead of producing duplicate images.
 */
export function computeEffectiveFrameCount(
  durationSeconds: number,
  fps: number,
  requestedFrameCount: number,
): number {
  const minimumSpacing = Math.max(1 / fps, 0.02);
  const maximumSupported = Math.max(1, Math.floor(durationSeconds / minimumSpacing));
  return Math.max(1, Math.min(requestedFrameCount, maximumSupported));
}

export interface FrameSegment {
  startSeconds: number;
  endSeconds: number;
  centerSeconds: number;
}

/** Disjoint segments covering the whole duration; samples come from the centre of each. */
export function computeFrameSegments(
  durationSeconds: number,
  frameCount: number,
): FrameSegment[] {
  const segmentLength = durationSeconds / frameCount;
  return Array.from({ length: frameCount }, (_, index) => {
    const startSeconds = segmentLength * index;
    const endSeconds = index === frameCount - 1 ? durationSeconds : segmentLength * (index + 1);
    return {
      startSeconds,
      endSeconds,
      centerSeconds: Number(((startSeconds + endSeconds) / 2).toFixed(6)),
    };
  });
}

/** Picks the probed frame closest to the segment centre (ties resolve to the later frame). */
export function snapToProbedTimestamp(
  probed: readonly number[],
  centerSeconds: number,
): number | undefined {
  let best: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const timestamp of probed) {
    const distance = Math.abs(timestamp - centerSeconds);
    if (distance < bestDistance || (distance === bestDistance && best !== undefined && timestamp > best)) {
      best = timestamp;
      bestDistance = distance;
    }
  }
  return best;
}

function mapProcessFailure(
  error: unknown,
  sensitivePaths: readonly string[],
  timeoutMs: number,
): FrameExtractionError {
  const record = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; stderr?: string };
  const detail = sanitizeDiagnosticText(String(record?.stderr ?? ""), sensitivePaths);

  if (record?.code === "ENOENT") {
    return new FrameExtractionError(
      "ffmpeg-missing",
      "ffmpeg is unavailable, so frames cannot be extracted.",
      detail,
    );
  }
  if (record?.name === "AbortError" || record?.code === "ABORT_ERR") {
    return new FrameExtractionError("cancelled", "Frame extraction was cancelled.", detail);
  }
  if (record?.killed || record?.signal === "SIGTERM" || /timed?\s?out/i.test(String(record?.message))) {
    return new FrameExtractionError(
      "extract-timeout",
      `ffmpeg did not finish within ${timeoutMs}ms.`,
      detail,
    );
  }
  return new FrameExtractionError("extract-failed", "ffmpeg could not extract a frame.", detail);
}

export async function extractRepresentativeFrames(
  request: FrameExtractionRequest,
  options: FrameExtractionOptions = {},
): Promise<FrameExtractionResult> {
  const parsed = FrameExtractionRequestSchema.safeParse(request);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new FrameExtractionError(
      "invalid-input",
      `Frame extraction request is invalid (${issue.path.join(".") || "request"}: ${issue.message}).`,
    );
  }
  const input = parsed.data;
  const allowedRoots = options.allowedRoots ?? defaultAllowedRoots();
  const probe = options.probe ?? probeVideoMetadata;
  const probeTimeline = options.probeTimeline ?? probeFrameTimeline;
  const run = options.runCommand ?? runMediaCommand;
  const ffmpegPath = options.ffmpegPath ?? getMediaBinary("ffmpeg");
  const ffprobePath = options.ffprobePath ?? getMediaBinary("ffprobe");

  assertNotCancelled(options.signal);

  const videoPath = await assertRegularReadableFile(input.videoPath);

  let outputDir: string;
  try {
    outputDir = await assertPathWithinRoots(input.outputDir, allowedRoots, "unsafe-path");
  } catch {
    throw new FrameExtractionError(
      "unsafe-path",
      "The frame output directory must be inside an allowed work root.",
    );
  }

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (input.keepFrames || cleanedUp) return;
    await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    cleanedUp = true;
  };

  try {
    let probed: ProbedVideo;
    try {
      probed = await probe(videoPath);
    } catch (error) {
      if (error instanceof FrameExtractionError) throw error;
      throw new FrameExtractionError(
        "probe-failed",
        "The video could not be probed, so frame extraction was refused.",
        sanitizeDiagnosticText(error instanceof Error ? error.message : "", [videoPath]),
      );
    }

    if (!Number.isFinite(probed.durationSeconds) || probed.durationSeconds <= 0) {
      throw new FrameExtractionError(
        "unsafe-duration",
        "The video duration is missing or not a positive finite number.",
      );
    }
    if (!Number.isFinite(probed.fps) || probed.fps <= 0) {
      throw new FrameExtractionError("unsafe-duration", "The video frame rate is not usable.");
    }

    const effectiveFrameCount = computeEffectiveFrameCount(
      probed.durationSeconds,
      probed.fps,
      input.frameCount,
    );
    const segments = computeFrameSegments(probed.durationSeconds, effectiveFrameCount);

    let timeline: FrameTimeline;
    try {
      timeline = await probeTimeline({
        videoPath,
        timeoutMs: input.timeoutMs,
        signal: options.signal,
        ffprobePath,
      });
    } catch (error) {
      if (error instanceof VideoProbeError) {
        if (error.code === "cancelled") {
          throw new FrameExtractionError("cancelled", "Frame extraction was cancelled.");
        }
        if (error.code === "probe-too-many-frames") {
          throw new FrameExtractionError("video-too-long", error.message);
        }
      }
      throw new FrameExtractionError(
        "frame-invalid",
        "The video frame timeline could not be read, so extraction was refused.",
        sanitizeDiagnosticText(error instanceof Error ? error.message : "", [videoPath]),
      );
    }

    await mkdir(outputDir, { recursive: true, mode: 0o700 });

    const frames: ExtractedFrame[] = [];
    let totalBytes = 0;
    let previousTimestamp = -1;
    const epsilon = 1e-6;

    for (const [index, segment] of segments.entries()) {
      assertNotCancelled(options.signal);

      // Segments are half-open so a boundary timestamp belongs to exactly one segment and the
      // selected timestamps stay distinct across the whole video.
      const inSegment = timeline.timestamps.filter(
        (timestamp) =>
          timestamp >= segment.startSeconds - epsilon && timestamp < segment.endSeconds - epsilon,
      );
      const fallback = timeline.timestamps.filter(
        (timestamp) => timestamp > previousTimestamp + epsilon,
      );
      const snapped = snapToProbedTimestamp(
        inSegment.length > 0 ? inSegment : fallback,
        segment.centerSeconds,
      );
      if (snapped === undefined) {
        throw new FrameExtractionError(
          "frame-invalid",
          `No decodable frame was found between ${segment.startSeconds.toFixed(3)}s and ${segment.endSeconds.toFixed(3)}s.`,
        );
      }
      if (snapped <= previousTimestamp) {
        throw new FrameExtractionError(
          "frame-invalid",
          "Extracted frame timestamps must be strictly increasing across the video.",
        );
      }
      previousTimestamp = snapped;

      const framePath = path.join(outputDir, `frame-${String(index).padStart(2, "0")}.jpg`);
      const args = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-ss",
        snapped.toFixed(3),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-an",
        "-sn",
        "-vf",
        `scale=${input.width}:-2`,
        "-q:v",
        "3",
        "-y",
        framePath,
      ];

      options.onCommand?.(ffmpegPath, args);

      try {
        await run(ffmpegPath, args, {
          timeoutMs: input.timeoutMs,
          maxBuffer: 256 * 1024,
          signal: options.signal,
        });
      } catch (error) {
        throw mapProcessFailure(error, [videoPath, outputDir], input.timeoutMs);
      }

      const bytes = await readFile(framePath).catch(() => undefined);
      if (!bytes) {
        throw new FrameExtractionError(
          "frame-invalid",
          "ffmpeg reported success but produced no frame file.",
        );
      }

      let inspected;
      try {
        inspected = inspectImage(bytes, {
          maxBytes: input.maxFrameBytes,
          maxWidth: input.width,
          maxHeight: input.width * 2,
          minWidth: input.width,
          maxImages: 1,
        });
      } catch (error) {
        throw new FrameExtractionError(
          "frame-invalid",
          error instanceof Error ? error.message : "The extracted frame could not be inspected.",
        );
      }

      if (inspected.width !== input.width) {
        throw new FrameExtractionError(
          "frame-invalid",
          `The extracted frame is ${inspected.width}px wide instead of the requested ${input.width}px.`,
        );
      }

      totalBytes += inspected.sizeBytes;
      if (totalBytes > input.maxTotalBytes) {
        throw new FrameExtractionError(
          "too-large",
          `Extracted frames exceed the ${input.maxTotalBytes}-byte total limit.`,
        );
      }

      frames.push({
        index,
        bytes: inspected.bytes,
        filePath: framePath,
        timestampSeconds: snapped,
        probedTimestampSeconds: snapped,
        width: inspected.width,
        height: inspected.height,
        mimeType: inspected.mimeType,
        sizeBytes: inspected.sizeBytes,
        sha256: createHash("sha256").update(inspected.bytes).digest("hex"),
      });
    }

    if (frames.length !== effectiveFrameCount) {
      throw new FrameExtractionError(
        "frame-invalid",
        `Extraction produced ${frames.length} of ${effectiveFrameCount} expected frames.`,
      );
    }

    const metadataFrameCount = Math.max(1, Math.round(probed.durationSeconds * probed.fps));
    const frameCountTolerance = Math.max(2, Math.round(metadataFrameCount * 0.05));
    const frameCountConsistent =
      Math.abs(timeline.frameCount - metadataFrameCount) <= frameCountTolerance;

    await cleanup();

    return {
      frames,
      outputDir,
      requestedFrameCount: input.frameCount,
      extractedFrameCount: frames.length,
      effectiveFrameCount,
      probedFrameCount: timeline.frameCount,
      metadataFrameCount,
      frameCountConsistent,
      videoDurationSeconds: probed.durationSeconds,
      videoFps: probed.fps,
      shortVideoAdjusted: effectiveFrameCount < input.frameCount,
      cleanedUp,
      retainedFrames: input.keepFrames,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
