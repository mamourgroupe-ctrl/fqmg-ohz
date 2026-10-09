import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { completeRenderJobWithOutput, RenderJobSchema, verifyRenderOutput } from "@/render/engine/render-job";

let temporaryDirectory = "";

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

  it("rejects an output path without an MP4/WebM extension", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "fqmg-render-test-"));
    const filePath = path.join(temporaryDirectory, "preview.bin");
    await writeFile(filePath, "placeholder");
    await expect(verifyRenderOutput(filePath)).rejects.toThrow(".mp4 or .webm");
  });
});
