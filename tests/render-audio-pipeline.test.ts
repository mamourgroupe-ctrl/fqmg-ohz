import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import previewSpecification from "../templates/phase-one-preview.json";
import { getFfmpegExecutable, verifyRenderOutput } from "@/render/engine/render-job";
import {
  MotionSpecificationSchema,
  type MotionSpecification,
} from "@/motion/schemas/motion-specification";
import { RemotionLocalRenderBackend } from "@/render/remotion/local-render-backend";

/**
 * Phase-7 end-to-end: the unified composition MIXES AUDIO.
 *
 *   ffmpeg tone -> publicDir/assets/tone.wav -> spec with an audio track
 *   -> RemotionLocalRenderBackend (bundles entry.tsx with the publicDir)
 *   -> <Audio> mixing (gain x masterVolume, fades) -> MP4
 *   -> verifyRenderOutput({ expectAudio: true }) proves a real audio stream
 *      whose duration matches the video.
 *
 * The corrupt-media case must fail loudly, not render a silent video.
 *
 * Environment honesty: rendering needs the Chrome Headless Shell, so offline
 * sandboxes skip WITH a logged reason ([audio-unified] SKIPPED) and with
 * FQMG_REQUIRE_RENDER_PIPELINE=1 (CI) a skip fails instead. The gate itself
 * (ffprobe side) is exercised everywhere by tests/render-job.test.ts.
 */

const REQUIRED = process.env.FQMG_REQUIRE_RENDER_PIPELINE === "1";

async function browserDownloadHostReachable(): Promise<boolean> {
  try {
    await fetch("https://remotion.media/", { method: "HEAD" });
    return true;
  } catch {
    return false;
  }
}

/** Same proportional shrink as the unified-pipeline test (0-clamping safe). */
function buildAudioSpecification(options: {
  toneSource: string;
  mimeType: string;
  trackDurationFrames: number;
}): MotionSpecification {
  const d = (n: number): number => Math.round(n / 5);
  const dDuration = (n: number): number => Math.max(1, Math.round(n / 5));
  const raw = previewSpecification as Record<string, unknown>;
  const base = raw as {
    composition: { durationInFrames: number } & Record<string, unknown>;
    scenes: Array<{
      startFrame: number;
      durationInFrames: number;
      transition?: { durationInFrames: number } & Record<string, unknown>;
      layers: Array<{
        startFrame: number;
        durationInFrames: number;
        keyframes?: Array<{ frame: number } & Record<string, unknown>>;
      }>;
    }>;
  };

  return MotionSpecificationSchema.parse({
    ...raw,
    composition: {
      ...base.composition,
      durationInFrames: dDuration(base.composition.durationInFrames),
    },
    scenes: base.scenes.map((scene) => ({
      ...scene,
      startFrame: d(scene.startFrame),
      durationInFrames: dDuration(scene.durationInFrames),
      transition: scene.transition
        ? { ...scene.transition, durationInFrames: dDuration(scene.transition.durationInFrames) }
        : undefined,
      layers: scene.layers.map((layer) => ({
        ...layer,
        startFrame: d(layer.startFrame),
        durationInFrames: dDuration(layer.durationInFrames),
      })),
    })),
    assets: [
      {
        kind: "audio",
        id: "tone-asset",
        name: "Tone",
        source: options.toneSource,
        mimeType: options.mimeType,
        licenseStatus: "generated",
      },
    ],
    audio: {
      tracks: [
        {
          id: "tone-track",
          assetId: "tone-asset",
          role: "music",
          startFrame: 0,
          durationInFrames: options.trackDurationFrames,
          gain: 0.9,
          fadeInFrames: 6,
          fadeOutFrames: 12,
        },
      ],
      masterVolume: 0.9,
      normalize: false,
      ducking: false,
    },
  });
}

describe("unified render pipeline with audio mixing (phase 7)", () => {
  let outputDir = "";
  let publicDir = "";
  let ownBundleDir = "";
  let bundleDir = "";
  let browserReady = false;
  let browserFailure = "";

  beforeAll(async () => {
    try {
      if (await browserDownloadHostReachable()) {
        const { ensureBrowser } = await import("@remotion/renderer");
        await ensureBrowser();
        browserReady = true;
      } else {
        browserFailure = "the browser download host (remotion.media) is unreachable";
      }
    } catch (error) {
      browserFailure = error instanceof Error ? error.message : String(error);
    }
  }, 180_000);

  afterAll(async () => {
    await Promise.all([
      outputDir ? fs.rm(outputDir, { recursive: true, force: true }) : Promise.resolve(),
      publicDir ? fs.rm(publicDir, { recursive: true, force: true }) : Promise.resolve(),
      ownBundleDir ? fs.rm(ownBundleDir, { recursive: true, force: true }) : Promise.resolve(),
    ]);
  });

  /** Synthesizes the fixture tone and lays out publicDir/assets/<name>. */
  async function makePublicAsset(name: string, seconds: number, corrupt = false): Promise<string> {
    publicDir ||= await fs.mkdtemp(path.join(os.tmpdir(), "fqmg-audio-public-"));
    const assetsDir = path.join(publicDir, "assets");
    await fs.mkdir(assetsDir, { recursive: true, mode: 0o700 });
    const filePath = path.join(assetsDir, name);
    if (corrupt) {
      const bytes = new Uint8Array(2048);
      crypto.getRandomValues(bytes);
      await fs.writeFile(filePath, bytes);
      return filePath;
    }
    execFileSync(
      getFfmpegExecutable(),
      [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
        "-ar", "44100", "-ac", "1",
        "-y", filePath,
      ],
      { timeout: 60_000 },
    );
    return filePath;
  }

  async function makeOutputDir(): Promise<string> {
    outputDir ||= await fs.mkdtemp(path.join(os.tmpdir(), "fqmg-audio-render-"));
    return outputDir;
  }

  it(
    "renders an audio-bearing project end-to-end and passes the audio-aware ffprobe gate",
    { timeout: 600_000 },
    async (ctx) => {
      if (!browserReady) {
        if (REQUIRED) {
          throw new Error(`FQMG_REQUIRE_RENDER_PIPELINE=1 but the browser is missing: ${browserFailure}`);
        }
        console.warn(`[audio-unified] SKIPPED: ${browserFailure}`);
        ctx.skip();
        return;
      }

      // 60 frames @ 30fps = 2.0s video; the tone is exactly 2.0s.
      const tonePath = await makePublicAsset("tone.wav", 2);
      const toneStat = await fs.stat(tonePath);
      expect(toneStat.size).toBeGreaterThan(1000);

      const specification = buildAudioSpecification({
        toneSource: "/assets/tone.wav",
        mimeType: "audio/wav",
        trackDurationFrames: 60,
      });
      const backend = new RemotionLocalRenderBackend({
        outputDir: await makeOutputDir(),
        allowedRoots: [outputDir],
        publicDir,
        scale: 0.15,
        logLevel: "error",
        // Own the bundle directory: Remotion's shared /tmp bundle namespace
        // gets cleaned up by concurrent bundle() calls while a render is
        // still reading it (CI run 40975060347 proved the assets/ copy was
        // gone from the served directory mid-render). A dedicated outDir is
        // outside that namespace and cache is force-disabled with it.
        bundleCaching: false,
        bundleOutputDir: (ownBundleDir ||= await fs.mkdtemp(
          path.join(os.tmpdir(), "fqmg-audio-bundle-"),
        )),
        onBundleReady: (serveUrl) => {
          bundleDir = serveUrl;
        },
      });

      let artifact;
      try {
        artifact = await backend.render({
          jobId: `audio-${randomUUID()}`,
          specification,
          timeoutMs: 480_000,
        });
      } catch (error) {
        // Re-throw WITH the served directory state: CI annotations carry
        // this message verbatim, so a 404 mystery is self-describing.
        const state = bundleDir
          ? `bundleDir=${bundleDir} assetsDirExists=${existsSync(path.join(bundleDir, "assets"))} ` +
            `listing=${(() => {
              try {
                return readdirSync(bundleDir).slice(0, 20).join(",");
              } catch (e) {
                return `unreadable: ${(e as Error).message}`;
              }
            })()}`
          : "onBundleReady never fired";
        throw new Error(
          `[audio-unified] render failed; ${state}; original error: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
      expect(artifact.kind).toBe("local-file");

      const verified = await verifyRenderOutput((artifact as { absolutePath: string }).absolutePath, {
        expectAudio: true,
      });
      expect(verified.audio).toBeDefined();
      expect(verified.audio?.streamCount).toBe(1);
      expect(verified.audio?.durationSeconds).toBeGreaterThan(1.5);
      // The mixed audio stream spans the full video timeline (silence-padded
      // around the track), so it must match the container duration closely.
      expect(
        Math.abs(verified.audio!.durationSeconds - verified.durationSeconds),
      ).toBeLessThanOrEqual(0.5);
      console.log(
        `[audio-unified] EXECUTED: mixed mp4 verified ${verified.width}x${verified.height} ` +
          `@${verified.fps}fps, video=${verified.durationSeconds.toFixed(2)}s, ` +
          `audio=${verified.audio!.codec} ${verified.audio!.durationSeconds.toFixed(2)}s`,
      );
    },
  );

  it(
    "fails loudly on a corrupt audio asset instead of rendering a silent video",
    { timeout: 600_000 },
    async (ctx) => {
      if (!browserReady) {
        if (REQUIRED) {
          throw new Error(`FQMG_REQUIRE_RENDER_PIPELINE=1 but the browser is missing: ${browserFailure}`);
        }
        console.warn(`[audio-unified-corrupt] SKIPPED: ${browserFailure}`);
        ctx.skip();
        return;
      }

      await makePublicAsset("corrupt.mp3", 0, true);
      const specification = buildAudioSpecification({
        toneSource: "/assets/corrupt.mp3",
        mimeType: "audio/mpeg",
        trackDurationFrames: 60,
      });
      const backend = new RemotionLocalRenderBackend({
        outputDir: await makeOutputDir(),
        allowedRoots: [outputDir],
        publicDir,
        scale: 0.15,
        logLevel: "error",
      });

      await expect(
        backend.render({
          jobId: `corrupt-${randomUUID()}`,
          specification,
          timeoutMs: 480_000,
        }),
      ).rejects.toMatchObject({ code: "render-failed" });
      console.log("[audio-unified-corrupt] EXECUTED: corrupt audio asset failed the render loudly");
    },
  );
});
