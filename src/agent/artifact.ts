import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * Render artifacts are described explicitly instead of assuming "a render produced a local
 * filesystem path". A local Remotion render produces `local-file`; a Remotion Lambda render
 * produces `remote-url`. Only the public projection (never the internal path) may leave the
 * server, and materialisation (download for Lambda output) re-applies every limit.
 */

export const ArtifactCleanupPolicySchema = z.enum([
  "delete-after-job",
  "retain",
  "provider-managed",
]);

export const LocalFileArtifactSchema = z.object({
  kind: z.literal("local-file"),
  artifactId: z.string().uuid(),
  absolutePath: z.string().min(1).max(4_096),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.enum(["video/mp4", "video/webm"]),
  cleanup: ArtifactCleanupPolicySchema,
  jobId: z.string().min(1).max(128),
  engine: z.enum(["remotion-local"]),
});

export const RemoteUrlArtifactSchema = z.object({
  kind: z.literal("remote-url"),
  artifactId: z.string().uuid(),
  url: z
    .string()
    .min(10)
    .max(4_096)
    .refine((value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "https:" && !parsed.username && !parsed.password;
      } catch {
        return false;
      }
    }, "Remote artifacts must be credential-free HTTPS URLs."),
  sizeBytes: z.number().int().nonnegative().optional(),
  mimeType: z.enum(["video/mp4", "video/webm"]).default("video/mp4"),
  cleanup: ArtifactCleanupPolicySchema,
  jobId: z.string().min(1).max(128),
  engine: z.enum(["remotion-lambda", "external"]),
  bucketName: z.string().min(1).max(256).optional(),
  renderId: z.string().min(1).max(256).optional(),
});

export const RenderArtifactSchema = z.discriminatedUnion("kind", [
  LocalFileArtifactSchema,
  RemoteUrlArtifactSchema,
]);

export type RenderArtifact = z.infer<typeof RenderArtifactSchema>;
export type LocalFileArtifact = z.infer<typeof LocalFileArtifactSchema>;
export type RemoteUrlArtifact = z.infer<typeof RemoteUrlArtifactSchema>;

/** The only artifact shape that may reach the browser. */
export const PublicArtifactSchema = z.object({
  artifactId: z.string().uuid(),
  kind: z.enum(["local-file", "remote-url"]),
  engine: z.enum(["remotion-local", "remotion-lambda", "external"]),
  sizeBytes: z.number().int().nonnegative().optional(),
  /** Supported HTTPS artifact URL (Lambda S3 output). Absent for local files. */
  url: z.string().max(4_096).optional(),
  /**
   * Opaque polling route that streams a retained local preview. Absent for remote files and for
   * jobs that were not created through the job API (which issues UUID job identifiers).
   */
  previewPath: z
    .string()
    .regex(/^\/api\/agent\/qa\/[0-9a-fA-F-]{36}\/preview$/)
    .optional(),
});

const UuidJobIdPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export type PublicArtifact = z.infer<typeof PublicArtifactSchema>;

export function toPublicArtifact(artifact: RenderArtifact): PublicArtifact {
  if (artifact.kind === "local-file") {
    // The preview route only serves UUID job identifiers, so a job that was not created through the
    // job API gets no preview link at all rather than a link that can never resolve.
    const previewPath = UuidJobIdPattern.test(artifact.jobId)
      ? `/api/agent/qa/${artifact.jobId}/preview`
      : undefined;

    return PublicArtifactSchema.parse({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      engine: artifact.engine,
      sizeBytes: artifact.sizeBytes,
      ...(previewPath === undefined ? {} : { previewPath }),
    });
  }

  return PublicArtifactSchema.parse({
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    engine: artifact.engine,
    ...(artifact.sizeBytes === undefined ? {} : { sizeBytes: artifact.sizeBytes }),
    url: artifact.url,
  });
}

/** Used by tests and by the response builder to prove no internal path leaked. */
export function findLocalFilesystemPaths(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      if (/(?:^|[\s"'(])\/(?:home|root|tmp|var|etc|Users|opt|srv|mnt|media|private)\//.test(node)) {
        found.add(node);
      }
      if (/[A-Za-z]:\\{1,2}[^\\"\s]+/.test(node)) found.add(node);
      if (node.includes(os.homedir()) && os.homedir().length > 1) found.add(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node !== null && typeof node === "object") {
      Object.values(node as Record<string, unknown>).forEach(visit);
    }
  };
  visit(value);
  return [...found];
}

/* ------------------------------------------------------------------ */
/* Path safety                                                         */
/* ------------------------------------------------------------------ */

export class ArtifactError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

export function isPathWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveRealPath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    const parent = path.dirname(path.resolve(target));
    if (parent === path.resolve(target)) return path.resolve(target);
    return resolveRealPath(parent);
  }
}

/** Rejects symlink escapes: the resolved target (or its nearest existing ancestor) must be inside a root. */
export async function assertPathWithinRoots(
  target: string,
  roots: readonly string[],
  code: string,
): Promise<string> {
  if (target.includes("\0")) {
    throw new ArtifactError(code, "Paths must not contain null bytes.");
  }
  if (roots.length === 0) {
    throw new ArtifactError(code, "No allowed root directories were configured.");
  }
  const absolute = path.resolve(target);
  const realTarget = await resolveRealPath(absolute);

  for (const root of roots) {
    const absoluteRoot = path.resolve(root);
    const realRoot = await resolveRealPath(absoluteRoot);
    // Both checks are required: the literal check stops "../" traversal relative to the configured
    // root, and the resolved check stops a symlink inside the root from pointing outside it.
    if (isPathWithin(absoluteRoot, absolute) && isPathWithin(realRoot, realTarget)) {
      return absolute;
    }
  }

  throw new ArtifactError(code, "Path is outside the allowed root directories.");
}

export function defaultAllowedRoots(): string[] {
  return [path.resolve(process.cwd(), "renders"), os.tmpdir()];
}

export function createAgentWorkDirectory(prefix = "fqmg-agent-"): string {
  return path.join(os.tmpdir(), `${prefix}${randomUUID()}`);
}

/* ------------------------------------------------------------------ */
/* Materialisation                                                     */
/* ------------------------------------------------------------------ */

export interface MaterializeOptions {
  workDir: string;
  allowedRoots?: readonly string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface MaterializedArtifact {
  filePath: string;
  sizeBytes: number;
  mimeType: "video/mp4" | "video/webm";
  /** True when the caller owns deletion of the returned file. */
  cleanupRequired: boolean;
}

function extensionForMimeType(mimeType: "video/mp4" | "video/webm"): string {
  return mimeType === "video/webm" ? ".webm" : ".mp4";
}

async function downloadToFile(
  url: string,
  destination: string,
  options: Required<Pick<MaterializeOptions, "fetchImpl" | "timeoutMs" | "maxBytes">> &
    Pick<MaterializeOptions, "signal">,
): Promise<number> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(new Error("cancelled"));
  // An already-aborted signal never fires the listener, so check it explicitly.
  if (options.signal?.aborted) controller.abort(new Error("cancelled"));
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelListener: (() => void) | undefined;

  // The races below are what actually bound the transfer: aborting the signal only helps fetch
  // implementations that observe it, whereas a stalled socket or a stream that stops producing
  // must not be able to hold the job open.
  const timeoutRejection = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error("download timeout"));
      reject(new ArtifactError("download-timeout", "The render artifact download timed out."));
    }, options.timeoutMs);
  });

  const cancellationRejection = new Promise<never>((_resolve, reject) => {
    if (!options.signal) return;
    cancelListener = () => {
      controller.abort(new Error("cancelled"));
      reject(new ArtifactError("cancelled", "The render artifact download was cancelled."));
    };
    if (options.signal.aborted) cancelListener();
    else options.signal.addEventListener("abort", cancelListener, { once: true });
  });

  try {
    const response = await Promise.race([
      options.fetchImpl(url, { method: "GET", redirect: "follow", signal: controller.signal }),
      timeoutRejection,
      cancellationRejection,
    ]);

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ArtifactError(
        "download-failed",
        `The render artifact host answered HTTP ${response.status}.`,
      );
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ArtifactError(
        "too-large",
        `The render artifact exceeds the ${options.maxBytes}-byte materialisation limit.`,
      );
    }

    if (!response.body) {
      throw new ArtifactError("download-failed", "The render artifact response had no body.");
    }

    await mkdir(path.dirname(destination), { recursive: true });
    const sink = createWriteStream(destination, { mode: 0o600 });
    const reader = response.body.getReader();
    let written = 0;

    try {
      while (true) {
        const chunk = await Promise.race([reader.read(), timeoutRejection, cancellationRejection]);
        if (chunk.done) break;
        if (!chunk.value) continue;
        written += chunk.value.byteLength;
        if (written > options.maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new ArtifactError(
            "too-large",
            `The render artifact exceeds the ${options.maxBytes}-byte materialisation limit.`,
          );
        }
        await new Promise<void>((resolve, reject) => {
          sink.write(Buffer.from(chunk.value), (error) => (error ? reject(error) : resolve()));
        });
      }
    } finally {
      await new Promise<void>((resolve) => sink.end(resolve));
      reader.releaseLock?.();
    }

    return written;
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError("download-failed", "The render artifact could not be downloaded.");
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (cancelListener) options.signal?.removeEventListener("abort", cancelListener);
  }
}

/**
 * Produces a local file that the existing ffprobe gate can verify.
 * Local artifacts are validated in place; remote (Lambda) artifacts are downloaded with a
 * byte ceiling, a timeout, and cancellation support.
 */
export async function materializeArtifact(
  input: unknown,
  options: MaterializeOptions,
): Promise<MaterializedArtifact> {
  const artifact = RenderArtifactSchema.parse(input);
  const allowedRoots = options.allowedRoots ?? defaultAllowedRoots();

  if (artifact.kind === "local-file") {
    const absolute = await assertPathWithinRoots(
      artifact.absolutePath,
      allowedRoots,
      "unsafe-path",
    );
    const info = await lstat(absolute).catch(() => undefined);
    if (!info) {
      throw new ArtifactError("missing-file", "The local render artifact no longer exists.");
    }
    if (!info.isFile()) {
      throw new ArtifactError("invalid-artifact", "A local artifact must be a regular file.");
    }
    const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
    if (info.size > maxBytes) {
      throw new ArtifactError("too-large", "The local artifact exceeds the size limit.");
    }
    return {
      filePath: absolute,
      sizeBytes: info.size,
      mimeType: artifact.mimeType,
      cleanupRequired: artifact.cleanup === "delete-after-job",
    };
  }

  await assertPathWithinRoots(options.workDir, allowedRoots, "unsafe-path");
  await mkdir(options.workDir, { recursive: true });
  const destination = path.join(
    options.workDir,
    `${artifact.artifactId}${extensionForMimeType(artifact.mimeType)}`,
  );
  const written = await downloadToFile(artifact.url, destination, {
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? 120_000,
    maxBytes: options.maxBytes ?? 64 * 1024 * 1024,
    signal: options.signal,
  });

  return {
    filePath: destination,
    sizeBytes: written,
    mimeType: artifact.mimeType,
    cleanupRequired: true,
  };
}

/** Deletes a materialised artifact only when it lives inside the allowed roots. */
export async function removeMaterializedFile(
  filePath: string,
  options: { allowedRoots?: readonly string[] } = {},
): Promise<void> {
  const allowedRoots = options.allowedRoots ?? defaultAllowedRoots();
  try {
    await assertPathWithinRoots(filePath, allowedRoots, "unsafe-path");
  } catch {
    return;
  }
  const info = await stat(filePath).catch(() => undefined);
  if (!info?.isFile()) return;
  await rm(filePath, { force: true });
}
