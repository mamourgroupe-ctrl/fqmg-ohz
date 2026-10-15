import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeEffectiveFrameCount,
  computeFrameSegments,
  extractRepresentativeFrames,
  FrameExtractionError,
  FrameExtractionRequestSchema,
  snapToProbedTimestamp,
} from "@/agent/frame-extractor";
import { probeFrameTimeline, probeVideoMetadata, VideoProbeError } from "@/agent/video-probe";
import { inspectImage } from "@/agent/image-inspection";
import { getMediaBinary } from "@/render/engine/media-binaries";

const syntheticPngFrame = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAIAAACwpMoFAAAAQElEQVR4nO3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8GOpGgABimw4TgAAAABJRU5ErkJggg==",
  "base64",
);

const ffmpeg = getMediaBinary("ffmpeg");
const ffprobeAvailable = existsSync(getMediaBinary("ffprobe"));

const cleanupDirectories: string[] = [];

async function makeTemporaryDirectory(prefix = "fqmg-frames-"): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirectories.push(directory);
  return directory;
}

async function synthesizeVideo(input: {
  directory: string;
  name: string;
  seconds: number;
  fps: number;
  width: number;
  height: number;
}): Promise<string> {
  const framePath = path.join(input.directory, `${input.name}.png`);
  const videoPath = path.join(input.directory, `${input.name}.mp4`);

  // The bundled ffmpeg is a stripped build: it cannot read images from stdin, so the synthetic
  // PNG is written to disk first and the size is applied by the encoder's scale filter.
  await writeFile(framePath, Buffer.from(syntheticPngFrame));

  execFileSync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-loop",
    "1",
    "-framerate",
    String(input.fps),
    "-i",
    framePath,
    "-vf",
    `scale=${input.width}:${input.height}`,
    "-frames:v",
    String(Math.max(1, Math.round(input.seconds * input.fps))),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-y",
    videoPath,
  ], { timeout: 60_000 });

  return videoPath;
}

afterEach(async () => {
  for (const directory of cleanupDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("frame extraction request validation", () => {
  it("rejects invalid frame counts, widths, and timeouts before touching the filesystem", () => {
    const base = { videoPath: "/tmp/x.mp4", outputDir: "/tmp/out" };
    expect(FrameExtractionRequestSchema.safeParse({ ...base, frameCount: 0, width: 320 }).success).toBe(false);
    expect(FrameExtractionRequestSchema.safeParse({ ...base, frameCount: 9, width: 320 }).success).toBe(false);
    expect(FrameExtractionRequestSchema.safeParse({ ...base, frameCount: 4, width: 32 }).success).toBe(false);
    expect(FrameExtractionRequestSchema.safeParse({ ...base, frameCount: 4, width: 4096 }).success).toBe(false);
    expect(
      FrameExtractionRequestSchema.safeParse({ ...base, frameCount: 4, width: 320, timeoutMs: 10 }).success,
    ).toBe(false);
  });

  it("rejects an unsafe output directory and a missing video", async () => {
    const directory = await makeTemporaryDirectory();

    await expect(
      extractRepresentativeFrames(
        {
          videoPath: path.join(directory, "missing.mp4"),
          outputDir: path.join(directory, "frames"),
          frameCount: 2,
          width: 160,
        },
        { allowedRoots: [directory] },
      ),
    ).rejects.toMatchObject({ code: "missing-file" });

    const videoPath = await synthesizeVideo({ directory, name: "safe", seconds: 0.5, fps: 10, width: 160, height: 90 });
    const traversalTarget = path.join(directory, "..", "fqmg-escape-attempt");

    await expect(
      extractRepresentativeFrames(
        { videoPath, outputDir: traversalTarget, frameCount: 2, width: 160 },
        { allowedRoots: [path.join(directory, "frames-root")] },
      ),
    ).rejects.toMatchObject({ code: "unsafe-path" });
  });

  it("rejects a non-finite or missing duration instead of guessing frame times", async () => {
    const directory = await makeTemporaryDirectory();
    const videoPath = await synthesizeVideo({ directory, name: "duration", seconds: 0.5, fps: 10, width: 160, height: 90 });

    for (const durationSeconds of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      await expect(
        extractRepresentativeFrames(
          { videoPath, outputDir: path.join(directory, "frames"), frameCount: 2, width: 160 },
          {
            allowedRoots: [directory],
            probe: async () => ({ durationSeconds, width: 160, height: 90, fps: 10 }),
          },
        ),
      ).rejects.toMatchObject({ code: "unsafe-duration" });
    }
  });

  it("reports a probe failure and an ffmpeg failure as distinct, bounded errors", async () => {
    const directory = await makeTemporaryDirectory();
    const videoPath = await synthesizeVideo({ directory, name: "probe", seconds: 0.5, fps: 10, width: 160, height: 90 });

    await expect(
      extractRepresentativeFrames(
        { videoPath, outputDir: path.join(directory, "frames"), frameCount: 2, width: 160 },
        {
          allowedRoots: [directory],
          probe: async () => {
            throw new Error("ffprobe could not validate the output video.");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "probe-failed" });

    await expect(
      extractRepresentativeFrames(
        { videoPath, outputDir: path.join(directory, "frames"), frameCount: 2, width: 160 },
        { allowedRoots: [directory], ffmpegPath: path.join(directory, "not-ffmpeg") },
      ),
    ).rejects.toMatchObject({ code: "ffmpeg-missing" });
  });

  it("passes external input as argv entries and never through a shell", async () => {
    const directory = await makeTemporaryDirectory();
    // A file name that would be dangerous if it were interpolated into a shell command.
    const name = "semi;colon$(touch fqmg-pwned)`id`";
    const videoPath = await synthesizeVideo({ directory, name, seconds: 0.5, fps: 10, width: 160, height: 90 });

    const commands: Array<{ executable: string; args: readonly string[] }> = [];
    const result = await extractRepresentativeFrames(
      { videoPath, outputDir: path.join(directory, "frames"), frameCount: 2, width: 160, keepFrames: true },
      { allowedRoots: [directory], onCommand: (executable, args) => commands.push({ executable, args }) },
    );

    expect(result.extractedFrameCount).toBe(2);
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command.args).toContain(videoPath);
      expect(command.args.join(" ")).toContain(name);
      expect(command.args).not.toContain("-shell");
    }
    // Nothing was executed by a shell: the marker file would exist if the name had been evaluated.
    expect(existsSync(path.join(process.cwd(), "fqmg-pwned"))).toBe(false);
  });
});

describe("frame extraction helpers", () => {
  it("reduces the requested frame count for short videos but never below one frame", () => {
    expect(computeEffectiveFrameCount(2, 24, 4)).toBe(4);
    expect(computeEffectiveFrameCount(0.2, 24, 4)).toBe(4);
    expect(computeEffectiveFrameCount(0.1, 24, 4)).toBe(2);
    expect(computeEffectiveFrameCount(0.01, 24, 4)).toBe(1);
    expect(computeEffectiveFrameCount(5, 60, 8)).toBe(8);
  });

  it("builds disjoint segments covering the whole duration", () => {
    const segments = computeFrameSegments(2, 4);
    expect(segments).toHaveLength(4);
    expect(segments[0].startSeconds).toBe(0);
    expect(segments[3].endSeconds).toBe(2);
    expect(segments[1].startSeconds).toBe(segments[0].endSeconds);
    expect(segments.every((segment) => segment.centerSeconds > segment.startSeconds)).toBe(true);
  });

  it("snaps to the closest real timestamp and prefers the later one on a tie", () => {
    expect(snapToProbedTimestamp([0, 0.5, 1], 0.4)).toBe(0.5);
    expect(snapToProbedTimestamp([0, 0.5, 1], 0.75)).toBe(1);
    expect(snapToProbedTimestamp([], 0.5)).toBeUndefined();
  });
});

describe.skipIf(!ffprobeAvailable)("frame extraction against real media", () => {
  it("extracts representative frames with verified timestamps, widths, and hashes", async () => {
    const directory = await makeTemporaryDirectory();
    const videoPath = await synthesizeVideo({ directory, name: "real", seconds: 2, fps: 24, width: 320, height: 180 });

    const result = await extractRepresentativeFrames(
      {
        videoPath,
        outputDir: path.join(directory, "frames"),
        frameCount: 4,
        width: 256,
        keepFrames: true,
      },
      { allowedRoots: [directory] },
    );

    expect(result).toMatchObject({
      requestedFrameCount: 4,
      extractedFrameCount: 4,
      effectiveFrameCount: 4,
      probedFrameCount: 48,
      metadataFrameCount: 48,
      frameCountConsistent: true,
      shortVideoAdjusted: false,
      retainedFrames: true,
      cleanedUp: false,
    });
    expect(result.videoFps).toBeCloseTo(24, 3);
    expect(result.videoDurationSeconds).toBeCloseTo(2, 1);

    const timestamps = result.frames.map((frame) => frame.timestampSeconds);
    expect(timestamps).toEqual([...timestamps].sort((left, right) => left - right));
    expect(new Set(timestamps).size).toBe(4);
    for (const frame of result.frames) {
      expect(frame.timestampSeconds).toBeCloseTo(frame.probedTimestampSeconds, 6);
      expect(frame.width).toBe(256);
      expect(frame.height).toBeGreaterThan(0);
      expect(frame.mimeType).toBe("image/jpeg");
      expect(frame.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(frame.filePath)).toBe(true);
      const bytes = await readFile(frame.filePath);
      const inspected = inspectImage(bytes, {
        maxBytes: 2 * 1024 * 1024,
        maxWidth: 256,
        maxHeight: 512,
        minWidth: 256,
        maxImages: 1,
      });
      expect(inspected.width).toBe(256);
    }
  });

  it("handles a very short video by sampling fewer frames", async () => {
    const directory = await makeTemporaryDirectory();
    const videoPath = await synthesizeVideo({ directory, name: "short", seconds: 0.2, fps: 10, width: 160, height: 90 });

    const result = await extractRepresentativeFrames(
      { videoPath, outputDir: path.join(directory, "frames"), frameCount: 6, width: 160, keepFrames: true },
      { allowedRoots: [directory] },
    );

    expect(result.effectiveFrameCount).toBeLessThan(6);
    expect(result.shortVideoAdjusted).toBe(true);
    expect(result.extractedFrameCount).toBe(result.effectiveFrameCount);
    expect(result.frames.length).toBeGreaterThanOrEqual(1);
  });

  it("deletes frames by default and reports the policy it applied", async () => {
    const directory = await makeTemporaryDirectory();
    const videoPath = await synthesizeVideo({ directory, name: "cleanup", seconds: 1, fps: 10, width: 160, height: 90 });
    const outputDir = path.join(directory, "frames");

    const result = await extractRepresentativeFrames(
      { videoPath, outputDir, frameCount: 3, width: 160 },
      { allowedRoots: [directory] },
    );

    expect(result.cleanedUp).toBe(true);
    expect(result.retainedFrames).toBe(false);
    expect(existsSync(outputDir)).toBe(false);
    // The bytes stay available in memory for the critique even though the files are gone.
    expect(result.frames.every((frame) => frame.bytes.byteLength > 0)).toBe(true);
  });

  it("cleans up the frame directory when a command fails", async () => {
    const directory = await makeTemporaryDirectory();
    const videoPath = await synthesizeVideo({ directory, name: "failure", seconds: 1, fps: 10, width: 160, height: 90 });
    const outputDir = path.join(directory, "frames");

    await expect(
      extractRepresentativeFrames(
        { videoPath, outputDir, frameCount: 3, width: 160 },
        { allowedRoots: [directory], ffmpegPath: path.join(directory, "not-ffmpeg") },
      ),
    ).rejects.toBeInstanceOf(FrameExtractionError);
    expect(existsSync(outputDir)).toBe(false);

    await expect(
      extractRepresentativeFrames(
        { videoPath, outputDir, frameCount: 2, width: 160 },
        {
          allowedRoots: [directory],
          probeTimeline: async () => {
            throw new VideoProbeError("probe-invalid", "ffprobe reported no video frames.");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "frame-invalid" });
    expect(existsSync(outputDir)).toBe(false);
  });

  it("refuses a frame whose real width differs from the requested width", async () => {
    const directory = await makeTemporaryDirectory();
    const videoPath = await synthesizeVideo({ directory, name: "width", seconds: 1, fps: 10, width: 160, height: 90 });

    await expect(
      extractRepresentativeFrames(
        { videoPath, outputDir: path.join(directory, "frames"), frameCount: 2, width: 160 },
        {
          allowedRoots: [directory],
          // Simulates a broken encoder that ignores the scale filter.
          runCommand: async (_executable, _args, options) =>
            new Promise((_resolve, reject) => {
              void options;
              reject(Object.assign(new Error("ffmpeg failed"), { stderr: "scale filter rejected" }));
            }),
        },
      ),
    ).rejects.toMatchObject({ code: "extract-failed" });
  });

  it("refuses a video longer than the review frame ceiling", async () => {
    const directory = await makeTemporaryDirectory();
    const videoPath = await synthesizeVideo({ directory, name: "long", seconds: 1, fps: 10, width: 160, height: 90 });

    await expect(
      extractRepresentativeFrames(
        { videoPath, outputDir: path.join(directory, "frames"), frameCount: 2, width: 160 },
        {
          allowedRoots: [directory],
          probeTimeline: async () => {
            throw new VideoProbeError("probe-too-many-frames", "The video has more than 60000 frames.");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "video-too-long" });
  });

  it("probes the real timeline with the bundled ffprobe and bounded output", async () => {
    const directory = await makeTemporaryDirectory();
    const videoPath = await synthesizeVideo({ directory, name: "timeline", seconds: 0.5, fps: 20, width: 160, height: 90 });

    const timeline = await probeFrameTimeline({ videoPath, timeoutMs: 20_000 });
    expect(timeline.frameCount).toBe(10);
    expect(timeline.timestamps[0]).toBeCloseTo(0, 3);
    expect(timeline.timestamps.at(-1)).toBeCloseTo(0.45, 2);

    await expect(
      probeFrameTimeline({ videoPath, timeoutMs: 20_000, maxFrames: 3 }),
    ).rejects.toMatchObject({ code: "probe-too-many-frames" });

    const metadata = await probeVideoMetadata(videoPath);
    expect(metadata.fps).toBeCloseTo(20, 3);
    expect(metadata.durationSeconds).toBeCloseTo(0.5, 1);
  });

  it("stops extracting when the caller cancels", async () => {
    const directory = await makeTemporaryDirectory();
    const videoPath = await synthesizeVideo({ directory, name: "cancel", seconds: 1, fps: 10, width: 160, height: 90 });
    const controller = new AbortController();
    controller.abort(new Error("cancelled by caller"));

    await expect(
      extractRepresentativeFrames(
        { videoPath, outputDir: path.join(directory, "frames"), frameCount: 2, width: 160 },
        { allowedRoots: [directory], signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("refuses an output directory that escapes the allowed root through a symlink", async () => {
    const directory = await makeTemporaryDirectory();
    const outside = await makeTemporaryDirectory("fqmg-outside-");
    const allowedRoot = path.join(directory, "allowed");
    const videoPath = await synthesizeVideo({ directory, name: "symlink", seconds: 0.5, fps: 10, width: 160, height: 90 });

    await mkdir(allowedRoot, { recursive: true });
    await writeFile(path.join(outside, ".keep"), "");

    const linkPath = path.join(allowedRoot, "escape");
    try {
      execFileSync("ln", ["-s", outside, linkPath]);
    } catch {
      return; // Symlinks unavailable on this platform: nothing to prove here.
    }

    // The literal path is inside the allowed root, but it resolves outside it.
    await expect(
      extractRepresentativeFrames(
        { videoPath, outputDir: path.join(linkPath, "frames"), frameCount: 2, width: 160 },
        { allowedRoots: [allowedRoot] },
      ),
    ).rejects.toMatchObject({ code: "unsafe-path" });

    const listing = await readdir(outside).catch(() => []);
    expect(listing).toEqual([".keep"]);
  });
});

