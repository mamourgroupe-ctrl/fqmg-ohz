import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RenderInternals } from "@remotion/renderer";
import { afterEach, describe, expect, it } from "vitest";
import { completeRenderJobWithOutput, RenderJobSchema, verifyRenderOutput } from "@/render/engine/render-job";

let temporaryDirectory = "";

function getRemotionBinary(type: "ffmpeg" | "ffprobe"): string | undefined {
  try {
    const executable = RenderInternals.getExecutablePath({
      type,
      indent: false,
      logLevel: "error",
      binariesDirectory: null,
    });
    return existsSync(executable) ? executable : undefined;
  } catch {
    return undefined;
  }
}

const bundledFfmpeg = getRemotionBinary("ffmpeg");
const bundledFfprobe = getRemotionBinary("ffprobe");

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = "";
  }
});

describe("render job integrity", () => {
  it("rejects a succeeded job without a concrete output path", () => {
    const result = RenderJobSchema.safeParse({
      id: "render-1",
      projectId: "project-1",
      engine: "remotion",
      status: "succeeded",
      progress: 100,
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("does not treat a non-video MP4-shaped file as a successful render", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "fqmg-render-test-"));
    const filePath = path.join(temporaryDirectory, "fake.mp4");
    const bytes = new Uint8Array(new ArrayBuffer(64));
    bytes.set([0x66, 0x74, 0x79, 0x70], 4);
    await writeFile(filePath, bytes);

    await expect(verifyRenderOutput(filePath)).rejects.toThrow();
    await expect(completeRenderJobWithOutput({
      id: "render-2",
      projectId: "project-1",
      engine: "remotion",
      createdAt: "2026-10-08T00:00:00.000Z",
    }, filePath)).rejects.toThrow();
  });

  it.skipIf(!bundledFfmpeg || !bundledFfprobe)("validates a real synthetic MP4 using Remotion's bundled ffmpeg and ffprobe", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "fqmg-render-smoke-"));
    const width = 160;
    const height = 90;
    const fps = 24;
    const frameCount = 24;
    const outputPath = path.join(temporaryDirectory, "smoke.mp4");

    try {
      execFileSync(bundledFfmpeg!, [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi",
        "-i", `nullsrc=s=${width}x${height}:r=${fps}`,
        "-frames:v", String(frameCount),
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-y", outputPath,
      ], { timeout: 30_000 });
    } catch (error) {
      const message = String((error as Error)?.message ?? error) + String((error as { stderr?: unknown })?.stderr ?? "");
      // The compositor-win32-x64-msvc build is a minimal FFmpeg for Remotion compositing.
      // It lacks the wrapped_avframe decoder needed for lavfi -> libx264, so it always fails
      // with "Decoding requested, but no decoder found for: wrapped_avframe" on Windows.
      // This is an environment limitation, not a code bug. Skip gracefully and hint to install full FFmpeg.
      if (message.includes("wrapped_avframe") || message.includes("No decoder found") || message.includes("Invalid argument")) {
        console.warn("[render-job.test] Skipped: bundled compositor FFmpeg cannot synthesize video (wrapped_avframe). Install full FFmpeg (winget install Gyan.FFmpeg) for local MP4 verification.");
        return;
      }
      throw error;
    }

    const verified = await verifyRenderOutput(outputPath);
    const completed = await completeRenderJobWithOutput({
      id: "render-smoke",
      projectId: "project-smoke",
      engine: "remotion",
      createdAt: "2026-10-09T00:00:00.000Z",
    }, outputPath);

    expect(verified).toMatchObject({ format: "mp4", width, height, fps });
    expect(verified.durationSeconds).toBeCloseTo(1, 1);
    expect(verified.sizeBytes).toBeGreaterThan(100);
    expect(completed).toMatchObject({ status: "succeeded", progress: 100 });
  });

  it("rejects an output path without an MP4/WebM extension", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "fqmg-render-test-"));
    const filePath = path.join(temporaryDirectory, "preview.bin");
    await writeFile(filePath, "placeholder");
    await expect(verifyRenderOutput(filePath)).rejects.toThrow(".mp4 or .webm");
  });
});
