import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import previewSpecification from "../templates/phase-one-preview.json";
import { RenderArtifactSchema, findLocalFilesystemPaths } from "@/agent/artifact";
import {
  DEFAULT_AGENT_COMPOSITION_ID,
  RenderBackendError,
} from "@/agent/render-contract";
import { MotionSpecificationSchema } from "@/motion/schemas/motion-specification";
import { RemotionLocalRenderBackend } from "@/render/remotion/local-render-backend";
import { RemotionLambdaRenderBackend } from "@/render/lambda/lambda-render-backend";

const TEMP_DIRECTORIES: string[] = [];

async function makeDirectory(prefix = "fqmg-render-"): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  TEMP_DIRECTORIES.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of TEMP_DIRECTORIES.splice(0)) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

function createSpecification() {
  return MotionSpecificationSchema.parse(structuredClone(previewSpecification));
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("Network access is not allowed in unit tests.");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("local Remotion render backend", () => {
  it("bundles with the shared alias override, renders, and returns a local artifact", async () => {
    const outputDir = await makeDirectory();
    const bundleCalls: Array<Record<string, unknown>> = [];
    let renderedFrames = 0;

    const backend = new RemotionLocalRenderBackend({
      outputDir,
      bundleFn: (async (options: Record<string, unknown>) => {
        bundleCalls.push(options);
        return "/tmp/fqmg-serve-url";
      }) as never,
      selectCompositionFn: (async ({ id }: { id: string }) => ({
        id,
        width: 1080,
        height: 1920,
        fps: 30,
        durationInFrames: 300,
        defaultProps: {},
        props: {},
      })) as never,
      renderMediaFn: (async ({ outputLocation }: { outputLocation: string }) => {
        await writeFile(outputLocation, Buffer.alloc(2_048, 7));
      }) as never,
    });

    const artifact = await backend.render({
      jobId: "55555555-5555-4555-8555-555555555555",
      specification: createSpecification(),
      timeoutMs: 30_000,
      onProgress: ({ renderedFrames: frames }) => {
        renderedFrames = frames;
      },
    });

    expect(RenderArtifactSchema.safeParse(artifact).success).toBe(true);
    expect(artifact).toMatchObject({
      kind: "local-file",
      engine: "remotion-local",
      jobId: "55555555-5555-4555-8555-555555555555",
      mimeType: "video/mp4",
      cleanup: "delete-after-job",
      sizeBytes: 2_048,
    });
    if (artifact.kind !== "local-file") throw new Error("expected a local artifact");
    expect(path.dirname(artifact.absolutePath)).toBe(
      path.join(outputDir, "55555555-5555-4555-8555-555555555555"),
    );
    expect(findLocalFilesystemPaths({ artifactId: artifact.artifactId })).toEqual([]);

    // Bundling must use the same `@/*` alias override as the CLI/Lambda pipeline, or the
    // composition entry point cannot resolve its app imports.
    expect(bundleCalls).toHaveLength(1);
    expect(bundleCalls[0].entryPoint).toBe(
      path.resolve(process.cwd(), "src/remotion/entry.tsx"),
    );
    expect(bundleCalls[0].rspack).toBe(true);
    const override = bundleCalls[0].webpackOverride as (config: unknown) => {
      resolve: { alias: Record<string, string> };
    };
    const overridden = override({ resolve: { alias: { existing: "kept" } } });
    expect(overridden.resolve.alias).toMatchObject({
      existing: "kept",
      "@": path.resolve(process.cwd(), "src"),
    });
    expect(renderedFrames).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("caches the bundle across renders and forwards composition metadata to the renderer", async () => {
    const outputDir = await makeDirectory();
    const bundleFn = vi.fn(async () => "/tmp/fqmg-serve-url");
    const renderMediaFn = vi.fn(async ({ outputLocation }: { outputLocation: string }) => {
      await writeFile(outputLocation, Buffer.alloc(16));
    });
    const selectCompositionFn = vi.fn(async ({ id }: { id: string }) => ({
      id,
      width: 1,
      height: 1,
      fps: 1,
      durationInFrames: 1,
      defaultProps: {},
      props: {},
    }));

    const makeCancelSignalFn = vi.fn(() => ({
      cancelSignal: { cancel: () => undefined },
      cancel: () => undefined,
    }));

    const backend = new RemotionLocalRenderBackend({
      outputDir,
      bundleFn: bundleFn as never,
      selectCompositionFn: selectCompositionFn as never,
      renderMediaFn: renderMediaFn as never,
      makeCancelSignalFn: makeCancelSignalFn as never,
    });

    for (const jobId of ["66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777"]) {
      await backend.render({ jobId, specification: createSpecification(), timeoutMs: 5_000 });
    }

    expect(bundleFn).toHaveBeenCalledTimes(1);
    expect(selectCompositionFn).toHaveBeenCalledTimes(2);
    expect(selectCompositionFn.mock.calls[0][0]).toMatchObject({ id: DEFAULT_AGENT_COMPOSITION_ID });

    const firstRenderOptions = renderMediaFn.mock.calls[0][0] as Record<string, unknown>;
    expect(firstRenderOptions).toMatchObject({
      codec: "h264",
      scale: 0.5,
      timeoutInMilliseconds: 5_000,
      logLevel: "error",
      overwrite: true,
    });
    expect(firstRenderOptions.composition).toMatchObject({
      width: 1080,
      height: 1920,
      fps: 30,
      durationInFrames: 300,
    });
    expect(firstRenderOptions.cancelSignal).toBeDefined();
    expect(makeCancelSignalFn).toHaveBeenCalledTimes(2);
  });

  it("refuses specifications the existing adapter does not support", async () => {
    const outputDir = await makeDirectory();
    const withAudio = createSpecification();
    withAudio.assets.push({
      id: "voice-file",
      name: "Voice file",
      kind: "audio",
      source: "/uploads/voice.wav",
      licenseStatus: "user-provided",
    });
    withAudio.audio.tracks.push({
      id: "voice-track",
      assetId: "voice-file",
      role: "voice",
      startFrame: 0,
      durationInFrames: 30,
      gain: 1,
      fadeInFrames: 0,
      fadeOutFrames: 0,
    });

    const backend = new RemotionLocalRenderBackend({ outputDir });
    await expect(
      backend.render({ jobId: "88888888-8888-4888-8888-888888888888", specification: withAudio, timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: "unsupported-specification" });
  });

  it("maps a missing browser, a failed render, and a missing output file to distinct errors", async () => {
    const outputDir = await makeDirectory();

    const missingBrowser = new RemotionLocalRenderBackend({
      outputDir,
      bundleFn: (async () => {
        throw new Error("Could not find Chrome (verified path: /root/.cache/remotion/chrome). Run `npx remotion browser ensure`.");
      }) as never,
    });
    await expect(
      missingBrowser.render({
        jobId: "99999999-9999-4999-8999-999999999999",
        specification: createSpecification(),
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "browser-missing" });

    const failedBrowserDownload = new RemotionLocalRenderBackend({
      outputDir,
      bundleFn: (async () => "/tmp/fqmg-serve-url") as never,
      selectCompositionFn: (async ({ id }: { id: string }) => ({ id, width: 1, height: 1, fps: 1, durationInFrames: 1, defaultProps: {}, props: {} })) as never,
      renderMediaFn: (async () => {
        throw new Error(
          "Downloading Chrome Headless Shell https://www.remotion.dev/chrome-headless-shell failed: ECONNRESET remotion.media",
        );
      }) as never,
    });
    await expect(
      failedBrowserDownload.render({
        jobId: "abababab-abab-4bab-8bab-abababababab",
        specification: createSpecification(),
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "browser-missing" });

    const failingRender = new RemotionLocalRenderBackend({
      outputDir,
      bundleFn: (async () => "/tmp/fqmg-serve-url") as never,
      selectCompositionFn: (async ({ id }: { id: string }) => ({ id, width: 1, height: 1, fps: 1, durationInFrames: 1, defaultProps: {}, props: {} })) as never,
      renderMediaFn: (async () => {
        throw new Error("Composition FQMG-OHZ-Preview was not found in src/remotion/entry.tsx");
      }) as never,
    });
    await expect(
      failingRender.render({
        jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        specification: createSpecification(),
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "select-composition-failed" });

    const noOutput = new RemotionLocalRenderBackend({
      outputDir,
      bundleFn: (async () => "/tmp/fqmg-serve-url") as never,
      selectCompositionFn: (async ({ id }: { id: string }) => ({ id, width: 1, height: 1, fps: 1, durationInFrames: 1, defaultProps: {}, props: {} })) as never,
      renderMediaFn: (async () => undefined) as never,
    });
    await expect(
      noOutput.render({
        jobId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        specification: createSpecification(),
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "invalid-output" });
  });

  it("cancels before starting and while rendering", async () => {
    const outputDir = await makeDirectory();
    const bundleFn = vi.fn(async () => "/tmp/fqmg-serve-url");

    const backend = new RemotionLocalRenderBackend({
      outputDir,
      bundleFn: bundleFn as never,
      selectCompositionFn: (async ({ id }: { id: string }) => ({ id, width: 1, height: 1, fps: 1, durationInFrames: 1, defaultProps: {}, props: {} })) as never,
      renderMediaFn: (async () => undefined) as never,
    });

    const preAborted = new AbortController();
    preAborted.abort(new Error("cancelled"));
    await expect(
      backend.render({
        jobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        specification: createSpecification(),
        timeoutMs: 1_000,
        signal: preAborted.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(bundleFn).not.toHaveBeenCalled();

    const during = new AbortController();
    const abortingBackend = new RemotionLocalRenderBackend({
      outputDir,
      bundleFn: (async () => "/tmp/fqmg-serve-url") as never,
      selectCompositionFn: (async ({ id }: { id: string }) => ({ id, width: 1, height: 1, fps: 1, durationInFrames: 1, defaultProps: {}, props: {} })) as never,
      renderMediaFn: (async () => {
        during.abort(new Error("cancelled mid-render"));
        throw new Error("render cancelled");
      }) as never,
    });

    await expect(
      abortingBackend.render({
        jobId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        specification: createSpecification(),
        timeoutMs: 1_000,
        signal: during.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("lambda Remotion render backend", () => {
  const credentials = {
    AWS_ACCESS_KEY_ID: "test-access-key",
    AWS_SECRET_ACCESS_KEY: "test-secret-key",
  };

  function progress(overrides: Record<string, unknown>) {
    return {
      done: false,
      fatalErrorEncountered: false,
      errors: [],
      framesRendered: 0,
      overallProgress: 0,
      outputFile: null,
      outputSizeInBytes: null,
      ...overrides,
    };
  }

  it("fails closed without credentials and never calls the Lambda client", async () => {
    const renderMediaOnLambdaFn = vi.fn();
    const backend = new RemotionLambdaRenderBackend({
      region: "us-east-1",
      serveUrl: "https://example.invalid/site",
      functionName: "remotion-render",
      env: {},
      renderMediaOnLambdaFn: renderMediaOnLambdaFn as never,
    });

    expect(backend.isConfigured).toBe(false);
    await expect(
      backend.render({
        jobId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        specification: createSpecification(),
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "not-configured" });
    expect(renderMediaOnLambdaFn).not.toHaveBeenCalled();

    // Half a credential pair is still not configured.
    expect(
      new RemotionLambdaRenderBackend({
        region: "us-east-1",
        serveUrl: "https://example.invalid/site",
        functionName: "remotion-render",
        env: { AWS_ACCESS_KEY_ID: "only-access-key" },
      }).isConfigured,
    ).toBe(false);
  });

  it("polls until done and returns a remote HTTPS artifact, never a local path", async () => {
    const progressCalls: number[] = [];
    const onProgress = vi.fn();
    const backend = new RemotionLambdaRenderBackend({
      region: "us-east-1",
      serveUrl: "https://example.invalid/site",
      functionName: "remotion-render",
      env: credentials,
      pollIntervalMs: 1,
      renderMediaOnLambdaFn: (async () => ({
        renderId: "render-abc",
        bucketName: "fqmg-bucket",
      })) as never,
      getRenderProgressFn: (async () => {
        progressCalls.push(progressCalls.length);
        return progressCalls.length === 1
          ? progress({ framesRendered: 30, overallProgress: 0.5 })
          : progress({
              done: true,
              outputFile: "https://fqmg-bucket.s3.amazonaws.com/renders/video.mp4?signature=abc",
              outputSizeInBytes: 4_096,
              overallProgress: 1,
            });
      }) as never,
    });

    const artifact = await backend.render({
      jobId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      specification: createSpecification(),
      timeoutMs: 5_000,
      onProgress,
    });

    expect(artifact).toMatchObject({
      kind: "remote-url",
      engine: "remotion-lambda",
      cleanup: "provider-managed",
      bucketName: "fqmg-bucket",
      renderId: "render-abc",
      sizeBytes: 4_096,
    });
    expect(RenderArtifactSchema.safeParse(artifact).success).toBe(true);
    expect(findLocalFilesystemPaths(artifact)).toEqual([]);
    expect(onProgress).toHaveBeenCalled();
    expect(progressCalls.length).toBeGreaterThan(1);
  });

  it("reports server-side failures, unusable output URLs, cancellations, and timeouts", async () => {
    const base = {
      region: "us-east-1",
      serveUrl: "https://example.invalid/site",
      functionName: "remotion-render",
      env: credentials,
      pollIntervalMs: 1,
      renderMediaOnLambdaFn: (async () => ({ renderId: "r", bucketName: "b" })) as never,
    };

    const fatal = new RemotionLambdaRenderBackend({
      ...base,
      getRenderProgressFn: (async () =>
        progress({ fatalErrorEncountered: true, errors: [{ message: "Composition not found" }] })) as never,
    });
    await expect(
      fatal.render({
        jobId: "12121212-1212-4212-8212-121212121212",
        specification: createSpecification(),
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "render-failed" });

    const badOutput = new RemotionLambdaRenderBackend({
      ...base,
      getRenderProgressFn: (async () =>
        progress({ done: true, outputFile: "http://insecure.invalid/video.mp4" })) as never,
    });
    await expect(
      badOutput.render({
        jobId: "13131313-1313-4313-8313-131313131313",
        specification: createSpecification(),
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "invalid-output" });

    const controller = new AbortController();
    const cancelled = new RemotionLambdaRenderBackend({
      ...base,
      getRenderProgressFn: (async () => {
        controller.abort(new Error("cancelled"));
        return progress({});
      }) as never,
    });
    await expect(
      cancelled.render({
        jobId: "14141414-1414-4414-8414-141414141414",
        specification: createSpecification(),
        timeoutMs: 1_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });

    const timingOut = new RemotionLambdaRenderBackend({
      ...base,
      pollIntervalMs: 5,
      maxRenderIdleMs: 20,
      getRenderProgressFn: (async () => progress({ overallProgress: 0.1 })) as never,
    });
    await expect(
      timingOut.render({
        jobId: "15151515-1515-4515-8515-151515151515",
        specification: createSpecification(),
        timeoutMs: 10_000,
      }),
    ).rejects.toBeInstanceOf(RenderBackendError);
  });
});
