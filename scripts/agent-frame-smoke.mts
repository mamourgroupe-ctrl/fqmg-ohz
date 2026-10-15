/**
 * Manual smoke test for real frame extraction.
 *
 * Builds a short clip with Remotion's bundled ffmpeg and extracts representative frames from it,
 * so the extraction path is exercised against real media instead of a mock. Run it with:
 *
 *   npm run agent:frame-smoke
 *
 * Unlike the unit suite it needs no network access, but it does need Remotion's bundled
 * ffmpeg/ffprobe binaries (installed with the package) to exist for this platform.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractRepresentativeFrames } from "../src/agent/frame-extractor.ts";
import { getMediaBinary } from "../src/render/engine/media-binaries.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAIAAACwpMoFAAAAQElEQVR4nO3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8GOpGgABimw4TgAAAABJRU5ErkJggg==",
  "base64",
);

const dir = await mkdtemp(path.join(os.tmpdir(), "fqmg-smoke-"));
const frame = path.join(dir, "frame.png");
await writeFile(frame, png);
const mp4 = path.join(dir, "clip.mp4");
execFileSync(getMediaBinary("ffmpeg"), [
  "-hide_banner","-loglevel","error","-loop","1","-framerate","24","-i",frame,
  "-frames:v","48","-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p","-movflags","+faststart","-y",mp4,
], { timeout: 30_000 });
console.log("created", mp4);

const result = await extractRepresentativeFrames({
  videoPath: mp4,
  outputDir: path.join(dir, "frames"),
  frameCount: 4,
  width: 320,
  keepFrames: true,
});
console.log(JSON.stringify(result, null, 2));

console.log(
  `extracted ${result.frames.length} frame(s) at ${result.frames
    .map((item) => item.timestampSeconds.toFixed(2))
    .join(", ")}s; probed frames=${result.probedFrameCount}; consistent=${result.frameCountConsistent}`,
);
