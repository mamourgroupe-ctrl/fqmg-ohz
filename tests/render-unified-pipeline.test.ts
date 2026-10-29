import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureBrowser, renderMedia, selectComposition } from "@remotion/renderer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import previewSpecification from "../templates/phase-one-preview.json";
import { DEFAULT_AGENT_COMPOSITION_ID } from "@/agent/render-contract";
import {
  getFfprobeExecutable,
  verifyRenderOutput,
} from "@/render/engine/render-job";
import {
  MotionSpecificationSchema,
  type MotionSpecification,
} from "@/motion/schemas/motion-specification";
import { RemotionLocalRenderBackend } from "@/render/remotion/local-render-backend";
import { RemotionAdapter } from "@/render/remotion/remotion-adapter";

/**
 * Phase-6 integration test: the ONE unified composition path.
 *
 * The phase-6 acceptance criterion is that the local render backend and the
 * Lambda deploy target the same data-only composition (`src/remotion/
 * entry.tsx`, id `FQMG-OHZ-Preview`) and that there is no second, legacy
 * path. This test drives the REAL production pieces end to end:
 *
 *   template -> MotionSpecificationSchema -> RemotionLocalRenderBackend
 *   (bundles src/remotion/entry.tsx, selects FQMG-OHZ-Preview, renders)
 *   -> verifyRenderOutput (the production ffprobe gate used by the QA loop).
 *
 * Environment honesty (per the standing rules):
 * - If ffprobe is unavailable the gate CANNOT be verified -> the test is
 *   skipped with a logged reason, and with FQMG_REQUIRE_RENDER_PIPELINE=1
 *   it FAILS instead (CI sets this).
 * - If no Chrome Headless Shell can be ensured (offline sandbox), the render
 *   test is skipped with a logged reason, and with the require flag set it
 *   FAILS instead.
 *
 * In CI (ubuntu-24.04, open network) both prerequisites are satisfied and the
 * whole pipeline executes for real, including an actual ffprobe invocation.
 */

const REQUIRED = process.env.FQMG_REQUIRE_RENDER_PIPELINE === "1";

function ffprobeWorks(): boolean {
  try {
    execFileSync(getFfprobeExecutable(), ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const probeReady = ffprobeWorks();
let browserReady = false;
let browserFailure = "";

/**
 * Only ask Remotion to ensure its browser when the download host is actually
 * reachable: in an offline sandbox `ensureBrowser` leaves a network rejection
 * that surfaces as an unhandled error, so we gate the call on connectivity.
 */
async function browserDownloadHostReachable(): Promise<boolean> {
  try {
    await fetch("https://remotion.media/", { method: "HEAD" });
    return true;
  } catch {
    return false;
  }
}

/** Shrink the real template proportionally so the render stays small but valid. */
function shrinkSpecification(divisor: number): MotionSpecification {
  // Durations must stay >= 1, but START frames and keyframe frames may be 0:
  // clamping them to 1 broke "layer timing must fit inside its scene".
  const d = (n: number): number => Math.round(n / divisor);
  const dDuration = (n: number): number => Math.max(1, Math.round(n / divisor));
  const shrunk = {
    ...(previewSpecification as object),
    composition: {
      ...(previewSpecification as { composition: object }).composition,
      durationInFrames: dDuration(
        (previewSpecification as { composition: { durationInFrames: number } })
          .composition.durationInFrames,
      ),
    },
    scenes: (
      previewSpecification as {
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
      }
    ).scenes.map((scene) => {
      return {
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
          ...(layer.keyframes
            ? {
                keyframes: layer.keyframes.map((kf) => ({
                  ...kf,
                  frame: Math.min(d(kf.frame), dDuration(layer.durationInFrames) - 1),
                })),
              }
            : {}),
        })),
      };
    }),
  };
  return MotionSpecificationSchema.parse(shrunk);
}

describe("unified render pipeline (phase 6)", () => {
  let outputDir = "";
  let selectedCompositionId = "";
  let renderedInputProps: unknown;

  beforeAll(async () => {
    if (!probeReady) return;
    if (!(await browserDownloadHostReachable())) {
      browserFailure = "the browser download host (remotion.media) is unreachable";
      return;
    }
    try {
      await ensureBrowser();
      browserReady = true;
    } catch (error) {
      browserFailure = error instanceof Error ? error.message : String(error);
    }
  }, 180_000);

  afterAll(async () => {
    if (outputDir) {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("has a working production ffprobe gate", { timeout: 30_000 }, () => {
    if (!probeReady) {
      if (REQUIRED) {
        throw new Error(
          "FQMG_REQUIRE_RENDER_PIPELINE=1 but no ffprobe executable is available " +
            `(resolved: ${getFfprobeExecutable()})`,
        );
      }
      return;
    }
    expect(probeReady).toBe(true);
  });

  /**
   * This test runs WITHOUT a browser, everywhere (local sandbox and CI): it
   * exercises the data-only half of the unified path that the render test
   * would otherwise skip offline. Shrinking, schema parsing and the adapter
   * assessment are exactly the steps the render performs before any frame.
   */
  it(
    "prepares valid data-only input props through the unified adapter (no browser needed)",
    { timeout: 30_000 },
    () => {
      const specification = shrinkSpecification(5);
      expect(specification.composition.durationInFrames).toBe(60);
      expect(specification.scenes).toHaveLength(3);

      const adapter = new RemotionAdapter();
      const assessment = adapter.assess(specification);
      expect(assessment.supported).toBe(true);
      const blueprint = adapter.createBlueprint(specification);
      expect(blueprint.inputProps).toEqual({ spec: specification });
      expect(blueprint.width).toBe(specification.composition.width);
      expect(blueprint.height).toBe(specification.composition.height);
      expect(blueprint.fps).toBe(specification.composition.fps);
      expect(blueprint.durationInFrames).toBe(
        specification.composition.durationInFrames,
      );
    },
  );

  it(
    "renders the unified entry.tsx composition end-to-end and passes the production ffprobe gate",
    { timeout: 600_000 },
    async (ctx) => {
      if (!probeReady || !browserReady) {
        const reasons = [
          probeReady ? null : "no ffprobe executable",
          browserReady ? null : `no Chrome Headless Shell (${browserFailure.slice(0, 160)})`,
        ]
          .filter(Boolean)
          .join("; ");
        if (REQUIRED) {
          throw new Error(
            `FQMG_REQUIRE_RENDER_PIPELINE=1 but the render prerequisites are missing: ${reasons}`,
          );
        }
        console.warn(`[render-unified] SKIPPED: ${reasons}`);
        ctx.skip();
        return;
      }

      const specification = shrinkSpecification(5);
      // 1080x1920 template at scale 0.15 -> ~162x288 px, 60 frames @ 30fps.
      outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "fqmg-unified-render-"));

      const realSelectComposition = selectComposition;
      const realRenderMedia = renderMedia;
      const backend = new RemotionLocalRenderBackend({
        outputDir,
        allowedRoots: [outputDir],
        scale: 0.15,
        logLevel: "error",
        // Spy seams: prove the request really goes through the unified
        // composition with data-only input props ({ spec } and nothing else).
        selectCompositionFn: (async (args: unknown) => {
          const typed = args as { id: string; inputProps: unknown };
          selectedCompositionId = typed.id;
          renderedInputProps = typed.inputProps;
          return realSelectComposition(
            args as Parameters<typeof realSelectComposition>[0],
          );
        }) as typeof selectComposition,
        renderMediaFn: ((opts: unknown) => {
          const typed = opts as { inputProps?: unknown };
          renderedInputProps = typed.inputProps ?? renderedInputProps;
          return realRenderMedia(opts as Parameters<typeof realRenderMedia>[0]);
        }) as typeof renderMedia,
      });

      const artifact = await backend.render({
        jobId: `it-${randomUUID()}`,
        specification,
        timeoutMs: 480_000,
      });

      // The unified path, not a legacy second composition.
      expect(selectedCompositionId).toBe(DEFAULT_AGENT_COMPOSITION_ID);
      expect(selectedCompositionId).toBe("FQMG-OHZ-Preview");
      expect(renderedInputProps).toEqual({ spec: expect.anything() });
      const specFromProps = (
        renderedInputProps as { spec: unknown } | null
      )?.spec;
      expect(MotionSpecificationSchema.safeParse(specFromProps).success).toBe(
        true,
      );

      // The produced artifact is a real local mp4.
      expect(artifact.kind).toBe("local-file");
      expect(artifact).toMatchObject({
        engine: "remotion-local",
        mimeType: "video/mp4",
      });
      const localArtifact = artifact as { absolutePath: string };
      const fileStat = await fs.stat(localArtifact.absolutePath);
      expect(fileStat.isFile()).toBe(true);
      expect(fileStat.size).toBeGreaterThan(8);

      // THE production gate: the same verifyRenderOutput the QA loop uses.
      // An actual ffprobe process runs here; a pass means the file is a real,
      // decodable mp4 with sane dimensions, fps and duration.
      const verified = await verifyRenderOutput(localArtifact.absolutePath);
      expect(verified.format).toBe("mp4");
      expect(verified.width).toBeGreaterThan(0);
      expect(verified.height).toBeGreaterThan(0);
      expect(verified.fps).toBeGreaterThan(0);
      expect(verified.durationSeconds).toBeGreaterThan(0);
      expect(verified.durationSeconds).toBeLessThanOrEqual(
        specification.composition.durationInFrames / specification.composition.fps + 2,
      );
      console.log(
        `[render-unified] EXECUTED: ffprobe verified ${verified.width}x${verified.height} ` +
          `@${verified.fps}fps, ${verified.durationSeconds.toFixed(2)}s, ` +
          `${(verified.sizeBytes / 1024).toFixed(0)}KB, composition=${selectedCompositionId}`,
      );
    },
  );
});
