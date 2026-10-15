import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { RenderInternals } from "@remotion/renderer";

/**
 * Single resolver for the media toolchain.
 *
 * Remotion ships ffmpeg/ffprobe inside `@remotion/compositor-*`. When that package is absent
 * (for example on a platform Remotion does not publish binaries for) the resolver falls back
 * to the tool name on PATH, which the caller must treat as "may be missing".
 */

export type MediaBinaryType = "ffmpeg" | "ffprobe";

export function getMediaBinary(type: MediaBinaryType): string {
  try {
    const bundled = RenderInternals.getExecutablePath({
      type,
      indent: false,
      logLevel: "error",
      binariesDirectory: null,
    });
    if (existsSync(bundled)) return bundled;
  } catch {
    // Fall back to the system binary below.
  }
  return type;
}

/** True when the resolver returned an absolute path that exists on disk. */
export function isResolvedMediaBinary(executable: string): boolean {
  return path.isAbsolute(executable) && existsSync(executable);
}

/**
 * Runs a media command with `execFile` (never a shell), a hard timeout, and a bounded buffer.
 * External input is always passed as separate argv entries, so no shell interpolation happens.
 */
export function runMediaCommand(
  executable: string,
  args: readonly string[],
  options: { timeoutMs: number; maxBuffer?: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer ?? 1_048_576,
        windowsHide: true,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
