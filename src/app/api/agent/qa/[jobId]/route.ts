import { NextResponse } from "next/server";
import { z } from "zod";
import { AgentQaErrorSchema, type AgentQaErrorCode } from "@/agent/api/request-schema";
import { toAgentJobView } from "@/agent/job-store";
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
 * Polls a render-and-review job.
 *
 * The response is the validated public view: status, stage, progress, verdict, sanitized issue
 * summaries, and an artifact identifier or a supported HTTPS artifact URL. Absolute server paths,
 * provider bodies, and credentials are never included (see AgentJobViewSchema).
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  if (!JobIdSchema.safeParse(jobId).success) {
    return errorResponse("JOB_NOT_FOUND", "No render-and-review job matches that identifier.", 404);
  }

  const runtime = getAgentRuntime();
  const job = runtime.store.getJob(jobId);
  if (!job) {
    return errorResponse(
      "JOB_NOT_FOUND",
      "The job is unknown or its retention window has passed.",
      404,
    );
  }

  const snapshot = runtime.budget.snapshot();
  const view = job.view ?? toAgentJobView(job, {
    dailyCommittedUsd: snapshot.dailyCommittedUsd,
    dailyLimitUsd: snapshot.dailyLimitUsd,
    taskLimitUsd: snapshot.taskLimitUsd,
    activeReservations: snapshot.activeReservations,
    enforcement: "process-local",
    invoiceGuarantee: false,
  });

  return NextResponse.json(view, { status: 200 });
}

/** Cancels a running job. The loop stops at the next stage boundary and reports "cancelled". */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  if (!JobIdSchema.safeParse(jobId).success) {
    return errorResponse("JOB_NOT_FOUND", "No render-and-review job matches that identifier.", 404);
  }

  const runtime = getAgentRuntime();
  const cancelled = runtime.store.cancelJob(jobId);
  if (!cancelled) {
    const job = runtime.store.getJob(jobId);
    if (!job) {
      return errorResponse(
        "JOB_NOT_FOUND",
        "The job is unknown or its retention window has passed.",
        404,
      );
    }
    return errorResponse("INVALID_REQUEST", "The job has already finished.", 409);
  }

  return NextResponse.json({ type: "cancelled", jobId }, { status: 202 });
}
