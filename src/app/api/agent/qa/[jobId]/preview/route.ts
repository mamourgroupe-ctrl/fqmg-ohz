import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertPathWithinRoots, defaultAllowedRoots } from "@/agent/artifact";
import { AgentQaErrorSchema, type AgentQaErrorCode } from "@/agent/api/request-schema";
import { authenticateApiRequest, forbiddenResponse } from "@/auth/guard";
import { isAuthEnforced } from "@/auth/session";
import { getAgentRuntime } from "@/agent/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JobIdSchema = z.string().uuid();

function errorResponse(code: AgentQaErrorCode, message: string, status: number, retryable = false) {
  return NextResponse.json(
    AgentQaErrorSchema.parse({ error: { code, message, retryable } }),
    { status },
  );
}

/**
 * Streams the retained local preview for a job.
 *
 * Only a path recorded by the job store can be served, the resolved path must live inside an
 * allowed root, and the response never reveals the filesystem location. Lambda jobs expose their
 * provider HTTPS artifact URL through the polling route instead of being proxied here.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const auth = authenticateApiRequest(request);
  if (!auth.ok) return auth.response;

  const { jobId } = await context.params;
  if (!JobIdSchema.safeParse(jobId).success) {
    return errorResponse("JOB_NOT_FOUND", "No render-and-review job matches that identifier.", 404);
  }

  const runtime = getAgentRuntime();
  const job = await runtime.store.getJob(jobId);
  // Ownership is checked before existence so another user's job reveals nothing.
  if (job && isAuthEnforced() && job.owner && job.owner !== auth.user.username) {
    return forbiddenResponse();
  }
  const artifact = job?.result?.artifact;
  if (!job || !artifact) {
    return errorResponse("PREVIEW_NOT_AVAILABLE", "This job has no retained preview.", 404);
  }
  if (artifact.kind !== "local-file") {
    return errorResponse(
      "PREVIEW_NOT_AVAILABLE",
      "This job's artifact is served by its provider URL; use the polling response.",
      409,
    );
  }

  let absolutePath: string;
  try {
    absolutePath = await assertPathWithinRoots(
      artifact.absolutePath,
      defaultAllowedRoots(),
      "unsafe-path",
    );
  } catch {
    return errorResponse("PREVIEW_NOT_AVAILABLE", "The retained preview is outside the served roots.", 403);
  }

  const info = await stat(absolutePath).catch(() => undefined);
  if (!info?.isFile() || info.size === 0) {
    return errorResponse("PREVIEW_NOT_AVAILABLE", "The retained preview is no longer available.", 404);
  }

  const stream = Readable.toWeb(createReadStream(absolutePath)) as ReadableStream<Uint8Array>;

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": artifact.mimeType,
      "Content-Length": String(info.size),
      "Content-Disposition": 'inline; filename="preview.mp4"',
      // A preview is not an approved deliverable and must not be cached as one.
      "Cache-Control": "private, max-age=0, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
