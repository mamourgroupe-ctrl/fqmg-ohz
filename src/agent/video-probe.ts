import { z } from "zod";
import { getMediaBinary, runMediaCommand } from "@/render/engine/media-binaries";
import { verifyRenderOutput } from "@/render/engine/render-job";

/**
 * Video probing for the frame extractor.
 *
 * The bundled Remotion ffmpeg is a stripped build: no `showinfo`, no `metadata` filter, no
 * `framemd5`/`framecrc` muxer, no `-debug_ts`. Frame timestamps therefore come from the bundled
 * ffprobe. Its `-read_intervals` start position is ignored by this build (it reads from the
 * beginning and only honours the interval duration), and `csv=p=0` emits a malformed first
 * line, so the extractor reads the real frame timeline once with
 * `-show_entries frame=pts_time -of default=noprint_wrappers=1:nokey=1`, under a hard frame
 * ceiling and a bounded output buffer.
 */

export interface ProbedVideo {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
}

export type VideoProbe = (filePath: string) => Promise<ProbedVideo>;

export class VideoProbeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "VideoProbeError";
  }
}

/** Frames beyond this ceiling are refused rather than silently truncated. */
export const MAX_PROBED_FRAMES = 60_000;

const MAX_PROBE_BUFFER_BYTES = 8 * 1024 * 1024;

export interface FrameTimeline {
  /** Real presentation timestamps in seconds, ascending. */
  timestamps: number[];
  frameCount: number;
}

export interface ProbeFrameTimelineOptions {
  videoPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
  ffprobePath?: string;
  maxFrames?: number;
  /** Test seam: replaces the process runner. */
  run?: typeof runMediaCommand;
}

/**
 * Reads every real frame timestamp of the video. The number of frames is capped, and the
 * process output is bounded, so a hostile or corrupt file cannot exhaust memory or disk.
 */
export async function probeFrameTimeline(
  options: ProbeFrameTimelineOptions,
): Promise<FrameTimeline> {
  const ffprobePath = options.ffprobePath ?? getMediaBinary("ffprobe");
  const run = options.run ?? runMediaCommand;
  const maxFrames = options.maxFrames ?? MAX_PROBED_FRAMES;

  let stdout: string;
  try {
    const result = await run(
      ffprobePath,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "frame=pts_time",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        options.videoPath,
      ],
      { timeoutMs: options.timeoutMs, maxBuffer: MAX_PROBE_BUFFER_BYTES, signal: options.signal },
    );
    stdout = result.stdout;
  } catch (error) {
    const record = error as NodeJS.ErrnoException & { killed?: boolean };
    if (record?.code === "ENOENT") {
      throw new VideoProbeError("probe-missing", "ffprobe is unavailable on this machine.");
    }
    if (record?.name === "AbortError" || record?.code === "ABORT_ERR") {
      throw new VideoProbeError("cancelled", "The video probe was cancelled.");
    }
    if (record?.killed === true) {
      throw new VideoProbeError("probe-timeout", "ffprobe did not finish in time.");
    }
    throw new VideoProbeError("probe-failed", "ffprobe could not read the video frames.");
  }

  const timestamps: number[] = [];
  for (const line of stdout.split("\n")) {
    const value = line.trim();
    if (!value) continue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new VideoProbeError("probe-invalid", "ffprobe reported a non-finite frame timestamp.");
    }
    timestamps.push(parsed);
    if (timestamps.length > maxFrames) {
      throw new VideoProbeError(
        "probe-too-many-frames",
        `The video has more than ${maxFrames} frames, which is beyond the review limit.`,
      );
    }
  }

  if (timestamps.length === 0) {
    throw new VideoProbeError("probe-invalid", "ffprobe reported no video frames.");
  }

  const validated = z.array(z.number().finite()).max(maxFrames).safeParse(timestamps);
  if (!validated.success) {
    throw new VideoProbeError("probe-invalid", "ffprobe returned an unexpected frame structure.");
  }

  const sorted = [...validated.data].sort((left, right) => left - right);
  return { timestamps: sorted, frameCount: sorted.length };
}

/**
 * Duration/dimensions/frame rate for a rendered file.
 * Default implementation reuses the existing ffprobe validation gate, so the extractor can
 * never accept a file the render gate already rejected.
 */
export async function probeVideoMetadata(filePath: string): Promise<ProbedVideo> {
  const verified = await verifyRenderOutput(filePath);
  return {
    durationSeconds: verified.durationSeconds,
    width: verified.width,
    height: verified.height,
    fps: verified.fps,
  };
}
