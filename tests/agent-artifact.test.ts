import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertPathWithinRoots,
  createAgentWorkDirectory,
  findLocalFilesystemPaths,
  isPathWithin,
  materializeArtifact,
  PublicArtifactSchema,
  RemoteUrlArtifactSchema,
  removeMaterializedFile,
  RenderArtifactSchema,
  toPublicArtifact,
  type LocalFileArtifact,
  type RemoteUrlArtifact,
} from "@/agent/artifact";

const TEMP_DIRECTORIES: string[] = [];

async function makeDirectory(prefix = "fqmg-artifact-"): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  TEMP_DIRECTORIES.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of TEMP_DIRECTORIES.splice(0)) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

function localArtifact(overrides: Partial<LocalFileArtifact> = {}): LocalFileArtifact {
  return {
    kind: "local-file",
    artifactId: "11111111-1111-4111-8111-111111111111",
    absolutePath: path.join(os.tmpdir(), "render.mp4"),
    sizeBytes: 1_024,
    mimeType: "video/mp4",
    cleanup: "delete-after-job",
    jobId: "22222222-2222-4222-8222-222222222222",
    engine: "remotion-local",
    ...overrides,
  };
}

function remoteArtifact(overrides: Partial<RemoteUrlArtifact> = {}): RemoteUrlArtifact {
  return {
    kind: "remote-url",
    artifactId: "33333333-3333-4333-8333-333333333333",
    url: "https://example-bucket.s3.amazonaws.com/renders/video.mp4",
    sizeBytes: 2_048,
    mimeType: "video/mp4",
    cleanup: "provider-managed",
    jobId: "44444444-4444-4444-8444-444444444444",
    engine: "remotion-lambda",
    bucketName: "example-bucket",
    renderId: "render-1",
    ...overrides,
  };
}

describe("artifact contracts", () => {
  it("accepts a local render and a Lambda render and refuses ambiguous shapes", () => {
    expect(RenderArtifactSchema.safeParse(localArtifact()).success).toBe(true);
    expect(RenderArtifactSchema.safeParse(remoteArtifact()).success).toBe(true);

    // A Lambda artifact must be a credential-free HTTPS URL, never an internal path.
    expect(RemoteUrlArtifactSchema.safeParse({
      ...remoteArtifact(),
      url: "http://example-bucket.s3.amazonaws.com/renders/video.mp4",
    }).success).toBe(false);
    expect(RemoteUrlArtifactSchema.safeParse({
      ...remoteArtifact(),
      url: "https://user:secret@example-bucket.s3.amazonaws.com/renders/video.mp4",
    }).success).toBe(false);
    expect(RemoteUrlArtifactSchema.safeParse({
      ...remoteArtifact(),
      url: "/var/renders/video.mp4",
    }).success).toBe(false);

    // An artifact that is neither shape is refused instead of being coerced.
    expect(RenderArtifactSchema.safeParse({ kind: "file", absolutePath: "/tmp/x.mp4" }).success).toBe(false);
    expect(RenderArtifactSchema.safeParse({ ...localArtifact(), artifactId: "not-a-uuid" }).success).toBe(false);
  });

  it("projects a public artifact without any internal path", () => {
    const publicLocal = toPublicArtifact(localArtifact());
    expect(PublicArtifactSchema.safeParse(publicLocal).success).toBe(true);
    expect(publicLocal).toEqual({
      artifactId: "11111111-1111-4111-8111-111111111111",
      kind: "local-file",
      engine: "remotion-local",
      sizeBytes: 1_024,
      previewPath: "/api/agent/qa/22222222-2222-4222-8222-222222222222/preview",
    });
    expect(JSON.stringify(publicLocal)).not.toContain(os.tmpdir());
    expect(findLocalFilesystemPaths(publicLocal)).toEqual([]);

    const publicRemote = toPublicArtifact(remoteArtifact());
    expect(publicRemote.url).toBe(remoteArtifact().url);
    expect(publicRemote.previewPath).toBeUndefined();
    expect(findLocalFilesystemPaths(publicRemote)).toEqual([]);

    // A job that was not created by the job API has no servable preview link.
    expect(toPublicArtifact(localArtifact({ jobId: "job-1" })).previewPath).toBeUndefined();
  });

  it("detects leaked paths in nested structures, including Windows paths and the home directory", () => {
    expect(findLocalFilesystemPaths({ a: [{ b: "/etc/passwd" }] })).toEqual(["/etc/passwd"]);
    expect(findLocalFilesystemPaths({ a: "C:\\Users\\render\\out.mp4" })).toHaveLength(1);
    expect(findLocalFilesystemPaths({ a: `${os.homedir()}/renders/out.mp4` })).toHaveLength(1);
    expect(findLocalFilesystemPaths({ a: "/api/agent/qa/1234/preview" })).toEqual([]);
    expect(findLocalFilesystemPaths({ a: 1, b: null, c: true })).toEqual([]);
  });
});

describe("path containment", () => {
  it("allows paths inside a root and refuses traversal, absolute outsiders, and null bytes", async () => {
    const root = await makeDirectory();
    const inside = path.join(root, "job", "out.mp4");
    await mkdir(path.dirname(inside), { recursive: true });
    await writeFile(inside, "x");

    expect(isPathWithin(root, inside)).toBe(true);
    expect(isPathWithin(root, path.join(root, "..", "elsewhere"))).toBe(false);
    await expect(assertPathWithinRoots(inside, [root], "unsafe-path")).resolves.toBe(inside);
    await expect(
      assertPathWithinRoots(path.join(root, "..", "escape.mp4"), [root], "unsafe-path"),
    ).rejects.toMatchObject({ code: "unsafe-path" });
    await expect(assertPathWithinRoots("/etc/hosts", [root], "unsafe-path")).rejects.toMatchObject({
      code: "unsafe-path",
    });
    await expect(assertPathWithinRoots(`${root}/a\0b`, [root], "unsafe-path")).rejects.toMatchObject({
      code: "unsafe-path",
    });
    await expect(assertPathWithinRoots(inside, [], "unsafe-path")).rejects.toMatchObject({
      code: "unsafe-path",
    });
  });

  it("refuses a path that escapes its root through a symlink", async () => {
    const root = await makeDirectory();
    const outside = await makeDirectory("fqmg-artifact-outside-");
    const allowed = path.join(root, "allowed");
    await mkdir(allowed, { recursive: true });

    try {
      await symlink(outside, path.join(allowed, "link"));
    } catch {
      return; // Symlinks are unavailable on this platform.
    }

    await expect(
      assertPathWithinRoots(path.join(allowed, "link", "out.mp4"), [allowed], "unsafe-path"),
    ).rejects.toMatchObject({ code: "unsafe-path" });
  });

  it("issues unique work directories", () => {
    const first = createAgentWorkDirectory();
    const second = createAgentWorkDirectory();
    expect(first).not.toBe(second);
    expect(path.dirname(first)).toBe(os.tmpdir());
  });
});

describe("artifact materialisation", () => {
  it("returns an existing local render in place and enforces the byte ceiling", async () => {
    const root = await makeDirectory();
    const file = path.join(root, "render.mp4");
    await writeFile(file, Buffer.alloc(64, 1));

    const materialized = await materializeArtifact(
      localArtifact({ absolutePath: file, sizeBytes: 64 }),
      { workDir: path.join(root, "work"), allowedRoots: [root] },
    );
    expect(materialized).toMatchObject({
      filePath: file,
      sizeBytes: 64,
      mimeType: "video/mp4",
      cleanupRequired: true,
    });

    await expect(
      materializeArtifact(localArtifact({ absolutePath: file }), {
        workDir: path.join(root, "work"),
        allowedRoots: [root],
        maxBytes: 8,
      }),
    ).rejects.toMatchObject({ code: "too-large" });

    await expect(
      materializeArtifact(localArtifact({ absolutePath: file }), {
        workDir: path.join(root, "work"),
        allowedRoots: [await makeDirectory("fqmg-artifact-other-")],
      }),
    ).rejects.toMatchObject({ code: "unsafe-path" });

    await expect(
      materializeArtifact(localArtifact({ absolutePath: root }), {
        workDir: path.join(root, "work"),
        allowedRoots: [root],
      }),
    ).rejects.toMatchObject({ code: "invalid-artifact" });

    await expect(
      materializeArtifact(localArtifact({ absolutePath: path.join(root, "missing.mp4") }), {
        workDir: path.join(root, "work"),
        allowedRoots: [root],
      }),
    ).rejects.toMatchObject({ code: "missing-file" });
  });

  it("downloads a remote artifact into the work directory with limits applied", async () => {
    const root = await makeDirectory();
    const workDir = path.join(root, "work");
    const body = Buffer.from("fake-mp4-bytes");
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

    const materialized = await materializeArtifact(remoteArtifact({ sizeBytes: undefined }), {
      workDir,
      allowedRoots: [root],
      fetchImpl,
      timeoutMs: 2_000,
      maxBytes: 1_024,
    });

    expect(materialized.filePath).toBe(
      path.join(workDir, "33333333-3333-4333-8333-333333333333.mp4"),
    );
    expect(materialized.cleanupRequired).toBe(true);
    expect(await readFile(materialized.filePath)).toEqual(body);
  });

  it("fails closed on HTTP errors, oversized bodies, empty bodies, and timeouts", async () => {
    const root = await makeDirectory();
    const workDir = path.join(root, "work");
    const options = { workDir, allowedRoots: [root], timeoutMs: 5_000, maxBytes: 1_024 };

    await expect(
      materializeArtifact(remoteArtifact(), {
        ...options,
        fetchImpl: (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "download-failed" });

    await expect(
      materializeArtifact(remoteArtifact(), {
        ...options,
        fetchImpl: (async () =>
          new Response(Buffer.alloc(4_096), {
            status: 200,
            headers: { "content-length": "4096" },
          })) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "too-large" });

    await expect(
      materializeArtifact(remoteArtifact(), {
        ...options,
        fetchImpl: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "download-failed" });

    await expect(
      materializeArtifact(remoteArtifact(), {
        ...options,
        timeoutMs: 25,
        fetchImpl: (() => new Promise<never>(() => undefined)) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "download-timeout" });

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      materializeArtifact(remoteArtifact(), { ...options, signal: controller.signal, fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: "cancelled" });

    await expect(
      materializeArtifact(remoteArtifact(), {
        ...options,
        workDir: path.join(await makeDirectory("fqmg-artifact-outside-"), "work"),
        fetchImpl: (async () => new Response(Buffer.alloc(4))) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "unsafe-path" });

    // No partial file is left behind after a failure.
    await expect(stat(path.join(workDir, "33333333-3333-4333-8333-333333333333.mp4"))).rejects.toThrow();
  });
});

describe("artifact cleanup", () => {
  it("deletes materialised files only when they live inside an allowed root", async () => {
    const root = await makeDirectory();
    const inside = path.join(root, "inside.mp4");
    const outside = path.join(await makeDirectory("fqmg-artifact-keep-"), "outside.mp4");
    await writeFile(inside, "x");
    await writeFile(outside, "x");

    await removeMaterializedFile(inside, { allowedRoots: [root] });
    await expect(stat(inside)).rejects.toThrow();

    await removeMaterializedFile(outside, { allowedRoots: [root] });
    expect((await stat(outside)).isFile()).toBe(true);

    // A directory is never deleted by the file cleanup helper.
    const directory = path.join(root, "frames");
    await mkdir(directory);
    await removeMaterializedFile(directory, { allowedRoots: [root] });
    expect((await stat(directory)).isDirectory()).toBe(true);
  });
});
