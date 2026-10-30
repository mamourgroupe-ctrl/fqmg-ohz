import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RenderInternals } from "@remotion/renderer";
import { afterEach, describe, expect, it } from "vitest";
import { completeRenderJobWithOutput, RenderJobSchema, verifyRenderOutput } from "@/render/engine/render-job";

let temporaryDirectory = "";

const syntheticPngFrame = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAIAAACwpMoFAAAAQElEQVR4nO3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8GOpGgABimw4TgAAAABJRU5ErkJggg==",
  "base64",
);

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

  it("validates a real synthetic MP4 using Remotion's bundled ffmpeg and ffprobe", async () => {
    if (!bundledFfmpeg || !bundledFfprobe) {
      throw new Error("Remotion's bundled ffmpeg and ffprobe are required for the MP4 integrity test.");
    }

    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "fqmg-render-smoke-"));
    const width = 160;
    const height = 90;
    const fps = 24;
    const frameCount = 24;
    const inputPath = path.join(temporaryDirectory, "frame.png");
    const outputPath = path.join(temporaryDirectory, "smoke.mp4");

    await writeFile(inputPath, syntheticPngFrame);
    execFileSync(bundledFfmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-loop", "1",
      "-framerate", String(fps),
      "-i", inputPath,
      "-frames:v", String(frameCount),
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-y", outputPath,
    ], { timeout: 30_000 });

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

describe("audio-aware ffprobe gate (phase 7)", () => {
  function requireBundledBinaries(): void {
    if (!bundledFfmpeg || !bundledFfprobe) {
      throw new Error("Remotion's bundled ffmpeg and ffprobe are required for the audio gate tests.");
    }
  }

  /**
   * The Remotion-bundled ffmpeg has no lavfi VIDEO sources (no testsrc), so
   * the video stream is built from the synthetic PNG like the smoke test
   * above; the lavfi sine audio source works and drives the audio stream.
   * Without -shortest, a shorter sine simply yields a shorter audio stream
   * inside the full-length video container (the divergence case).
   */
  function synthesizeMp4(options: { videoSeconds: number; audioSeconds?: number }): string {
    requireBundledBinaries();
    const stem = Math.random().toString(36).slice(2);
    const framePath = path.join(temporaryDirectory, `frame-${stem}.png`);
    const outputPath = path.join(temporaryDirectory, `fixture-${stem}.mp4`);
    writeFileSync(framePath, syntheticPngFrame);
    const frameCount = Math.round(options.videoSeconds * 24);
    const videoArgs = [
      "-hide_banner", "-loglevel", "error",
      "-loop", "1", "-framerate", "24", "-i", framePath,
    ];
    const audioArgs = options.audioSeconds === undefined
      ? []
      : ["-f", "lavfi", "-i", `sine=frequency=440:duration=${options.audioSeconds}`];
    const codecArgs = [
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      ...(options.audioSeconds === undefined ? [] : ["-c:a", "aac"]),
    ];
    execFileSync(
      bundledFfmpeg as string,
      [
        ...videoArgs, ...audioArgs, ...codecArgs,
        "-frames:v", String(frameCount), "-movflags", "+faststart", "-y", outputPath,
      ],
      { timeout: 60_000 },
    );
    return outputPath;
  }

  it("verifies an audio-bearing MP4 when expectAudio is requested", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "fqmg-audio-gate-"));
    const outputPath = synthesizeMp4({ videoSeconds: 1, audioSeconds: 1 });

    const verified = await verifyRenderOutput(outputPath, { expectAudio: true });
    expect(verified.audio).toBeDefined();
    expect(verified.audio?.streamCount).toBe(1);
    expect(verified.audio?.codec.length).toBeGreaterThan(0);
    expect(verified.audio?.durationSeconds).toBeCloseTo(1, 1);
  });

  it("rejects audio-expected output that carries no audio stream", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "fqmg-audio-gate-"));
    const outputPath = synthesizeMp4({ videoSeconds: 1 });

    await expect(
      verifyRenderOutput(outputPath, { expectAudio: true }),
    ).rejects.toThrow(/audio/i);
  });

  it("rejects an audio stream whose duration diverges from the video beyond the tolerance", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "fqmg-audio-gate-"));
    const outputPath = synthesizeMp4({ videoSeconds: 2, audioSeconds: 0.5 });

    await expect(
      verifyRenderOutput(outputPath, { expectAudio: true }),
    ).rejects.toThrow(/duration/i);

    // A tolerance that covers the divergence accepts the same file.
    const verified = await verifyRenderOutput(outputPath, {
      expectAudio: true,
      audioToleranceSeconds: 2,
    });
    expect(verified.audio?.durationSeconds).toBeCloseTo(0.5, 1);
  });

  it("completeRenderJobWithOutput forwards the audio expectation", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "fqmg-audio-gate-"));
    const silent = synthesizeMp4({ videoSeconds: 1 });
    await expect(
      completeRenderJobWithOutput({
        id: "render-audio-1",
        projectId: "project-audio",
        engine: "remotion",
        createdAt: "2026-10-09T00:00:00.000Z",
      }, silent, { expectAudio: true }),
    ).rejects.toThrow(/audio/i);

    const audible = synthesizeMp4({ videoSeconds: 1, audioSeconds: 1 });
    const completed = await completeRenderJobWithOutput({
      id: "render-audio-2",
      projectId: "project-audio",
      engine: "remotion",
      createdAt: "2026-10-09T00:00:00.000Z",
    }, audible, { expectAudio: true });
    expect(completed).toMatchObject({ status: "succeeded", progress: 100 });
  });
});
