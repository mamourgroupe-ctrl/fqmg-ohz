import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { RenderInternals } from "@remotion/renderer";
import path from "node:path";
import { z } from "zod";

export const RenderJobSchema = z
  .object({
    id: z.string().min(1).max(128),
    projectId: z.string().min(1).max(128),
    engine: z.string().min(1).max(80),
    status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
    progress: z.number().min(0).max(100).optional(),
    output: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((job, ctx) => {
    if (job.status === "succeeded") {
      if (!job.output) {
        ctx.addIssue({ code: "custom", path: ["output"], message: "A successful render must reference a verified output file." });
      }
      if (job.progress !== 100) {
        ctx.addIssue({ code: "custom", path: ["progress"], message: "A successful render must have 100% progress." });
      }
      if (job.error) {
        ctx.addIssue({ code: "custom", path: ["error"], message: "A successful render cannot contain an error." });
      }
    }

    if (job.status === "failed" && !job.error) {
      ctx.addIssue({ code: "custom", path: ["error"], message: "A failed render must include a diagnostic error." });
    }
  });

export type RenderJob = z.infer<typeof RenderJobSchema>;

export interface VerifiedMediaOutput {
  absolutePath: string;
  sizeBytes: number;
  format: "mp4" | "webm";
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
}

interface FfprobeOutput {
  format?: {
    format_name?: string;
    duration?: string;
  };
  streams?: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
  }>;
}

function parseFrameRate(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator)) return 0;
  if (denominator === undefined) return numerator;
  return denominator > 0 ? numerator / denominator : 0;
}

function getFfprobeExecutable(): string {
  try {
    const bundled = RenderInternals.getExecutablePath({
      type: "ffprobe",
      indent: false,
      logLevel: "error",
      binariesDirectory: null,
    });
    if (existsSync(bundled)) return bundled;
  } catch {
    // Fall back to a system ffprobe for platforms without a Remotion binary package.
  }
  return "ffprobe";
}

function inspectVideoWithFfprobe(filePath: string): Promise<{
  formatName: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
}> {
  return new Promise((resolve, reject) => {
    execFile(
      getFfprobeExecutable(),
      [
        "-v", "error",
        "-show_entries", "format=format_name,duration:stream=codec_type,width,height,avg_frame_rate",
        "-of", "json",
        filePath,
      ],
      { encoding: "utf8", timeout: 15_000, maxBuffer: 1_048_576 },
      (error, stdout) => {
        if (error) {
          const message = (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "ffprobe is unavailable; refusing to mark a render successful."
            : "ffprobe could not validate the output video.";
          reject(new Error(message));
          return;
        }

        try {
          const probe = JSON.parse(String(stdout)) as FfprobeOutput;
          const formatName = probe.format?.format_name ?? "";
          const durationSeconds = Number(probe.format?.duration ?? 0);
          const videoStream = probe.streams?.find((stream) => stream.codec_type === "video");
          const width = videoStream?.width ?? 0;
          const height = videoStream?.height ?? 0;
          const fps = parseFrameRate(videoStream?.avg_frame_rate);
          if (!formatName || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || width <= 0 || height <= 0 || fps <= 0) {
            reject(new Error("ffprobe found no valid video stream, dimensions, frame rate, or duration."));
            return;
          }
          resolve({ formatName, durationSeconds, width, height, fps });
        } catch {
          reject(new Error("ffprobe returned an invalid media report."));
        }
      },
    );
  });
}

/**
 * Requires a real MP4/WebM file and a successful ffprobe report with a video stream.
 * If ffprobe is missing, the operation fails closed. Codec and visual QC remain later-phase work.
 */
export async function verifyRenderOutput(filePath: string): Promise<VerifiedMediaOutput> {
  const absolutePath = path.resolve(filePath);
  const extension = path.extname(absolutePath).toLowerCase();
  if (extension !== ".mp4" && extension !== ".webm") {
    throw new Error("Render output must use an .mp4 or .webm extension.");
  }

  const fileStats = await stat(absolutePath);
  if (!fileStats.isFile() || fileStats.size < 8) {
    throw new Error("Render output must be a non-empty regular file.");
  }

  const probe = await inspectVideoWithFfprobe(absolutePath);
  const formatMatches = extension === ".mp4"
    ? probe.formatName.split(",").some((format) => format === "mp4" || format === "mov")
    : probe.formatName.split(",").some((format) => format === "webm" || format === "matroska");
  if (!formatMatches) {
    throw new Error("The output extension does not match the detected video container.");
  }

  return {
    absolutePath,
    sizeBytes: fileStats.size,
    format: extension === ".mp4" ? "mp4" : "webm",
    durationSeconds: probe.durationSeconds,
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
  };
}

/** Create a succeeded state only after ffprobe verifies the concrete media file. */
export async function completeRenderJobWithOutput(
  job: Omit<RenderJob, "status" | "progress" | "output" | "error" | "updatedAt">,
  filePath: string,
): Promise<RenderJob> {
  const verified = await verifyRenderOutput(filePath);
  const now = new Date().toISOString();
  return RenderJobSchema.parse({
    ...job,
    status: "succeeded",
    progress: 100,
    output: verified.absolutePath,
    createdAt: job.createdAt,
    updatedAt: now,
  });
}
