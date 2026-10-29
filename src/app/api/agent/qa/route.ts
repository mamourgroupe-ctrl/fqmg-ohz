import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { readBoundedJson, VoiceRequestBodyError } from "@/voice/api/read-bounded-json";
import {
  AgentQaAcceptedSchema,
  AgentQaErrorSchema,
  AgentQaRequestSchema,
  AGENT_QA_MAX_REQUEST_BYTES,
  buildDedupeKey,
  type AgentQaErrorCode,
} from "@/agent/api/request-schema";
import { AgentJobCapacityError, AgentJobConflictError } from "@/agent/job-store";
import { AgentRequestError, runAgentLoop } from "@/agent/loop";
import { authenticateApiRequest } from "@/auth/guard";
import { isAuthEnforced } from "@/auth/session";
import { getAgentRuntime } from "@/agent/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Starts a background render-and-review job.
 *
 * The route returns 202 immediately and the caller polls
 * `GET /api/agent/qa/{jobId}`. Holding the HTTP request open for a render-and-repair cycle is
 * deliberately avoided: a cycle can take minutes.
 *
 * Nothing here reports success. `POST` only acknowledges that a job was accepted; the visual
 * verdict and any retained preview are reported by the polling route.
 */

function errorResponse(code: AgentQaErrorCode, message: string, status: number, retryable = false) {
  return NextResponse.json(
    AgentQaErrorSchema.parse({ error: { code, message, retryable } }),
    { status },
  );
}

export async function POST(request: Request) {
  const auth = authenticateApiRequest(request, "agent-qa");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await readBoundedJson(request, AGENT_QA_MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof VoiceRequestBodyError && error.kind === "too-large") {
      return errorResponse(
        "INVALID_REQUEST",
        `The QA request body exceeds the ${Math.round(AGENT_QA_MAX_REQUEST_BYTES / 1024)} KB limit.`,
        413,
      );
    }
    if (error instanceof VoiceRequestBodyError && error.kind === "unsupported-content-type") {
      return errorResponse(
        "INVALID_REQUEST",
        "QA requests must use an application/json content type.",
        415,
      );
    }
    return errorResponse("INVALID_REQUEST", "The QA request body must be valid UTF-8 JSON.", 400);
  }

  const parsed = AgentQaRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return errorResponse(
      "INVALID_REQUEST",
      `The QA request did not pass validation (${issue.path.join(".") || "request"}: ${issue.message}).`,
      400,
    );
  }

  const input = parsed.data;
  // Dedupe and task identity are scoped to the authenticated user: two users
  // submitting the same specification must not collide (phase 3).
  const ownerKey = auth.user.username.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  const dedupeKey = `${ownerKey}:${buildDedupeKey({
    ...(input.requestKey ? { requestKey: input.requestKey } : {}),
    engine: input.engine,
    ...(input.maxIterations ? { maxIterations: input.maxIterations } : {}),
    specification: input.specification,
  })}`;

  let runtime;
  try {
    runtime = getAgentRuntime();
  } catch {
    return errorResponse(
      "INTERNAL_ERROR",
      "The agent runtime is not configured correctly. Check the AGENT_* environment variables.",
      500,
    );
  }

  const maxIterations = input.maxIterations ?? runtime.config.maxIterations;
  // Generated here, not by the store: the run callback needs the identifier before the store
  // returns the record, and reading the record from inside its own initializer would not work.
  const jobId = randomUUID();
  const taskId = `qa-${ownerKey}:${dedupeKey}`;

  // Phase 5: captured once for the store's snapshot closure; live views read
  // runtime.budget.snapshot() directly (see the [jobId] route).
  const budgetSnapshotNow = await runtime.budget.snapshot();
  try {
    const job = await runtime.store.startJob({
      jobId,
      taskId,
      dedupeKey,
      owner: auth.user.username,
      budgetSnapshot: () => ({
        dailyCommittedUsd: budgetSnapshotNow.dailyCommittedUsd,
        dailyLimitUsd: budgetSnapshotNow.dailyLimitUsd,
        taskLimitUsd: budgetSnapshotNow.taskLimitUsd,
        activeReservations: budgetSnapshotNow.activeReservations,
        enforcement: budgetSnapshotNow.enforcement,
        invoiceGuarantee: false as const,
      }),
      run: (signal, onProgress) =>
        runAgentLoop(
          {
            jobId,
            taskId,
            ...(isAuthEnforced() ? { user: auth.user.username } : {}),
            specification: input.specification,
            maxIterations,
            ...(input.scale === undefined ? {} : { scale: input.scale }),
            ...(input.budgetApproval ? { approval: input.budgetApproval } : {}),
            signal,
            onProgress,
          },
          {
            renderBackend: runtime.getRenderBackend(input.engine),
            budget: runtime.budget,
            visionProvider: runtime.visionProvider,
            repairProvider: runtime.repairProvider,
            config: runtime.config,
            priceBook: runtime.priceBook,
          },
        ),
    });

    return NextResponse.json(
      AgentQaAcceptedSchema.parse({
        type: "accepted",
        jobId: job.jobId,
        status: "queued",
        pollPath: `/api/agent/qa/${job.jobId}`,
        engine: input.engine,
        maxIterations,
      }),
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof AgentJobConflictError) {
      return errorResponse("DUPLICATE_ACTIVE_REQUEST", error.message, 409, true);
    }
    if (error instanceof AgentJobCapacityError) {
      return errorResponse("JOB_CAPACITY_REACHED", error.message, 429, true);
    }
    if (error instanceof AgentRequestError) {
      return errorResponse("INVALID_REQUEST", error.message, 400);
    }
    return errorResponse(
      "INTERNAL_ERROR",
      "The render-and-review job could not be started.",
      500,
    );
  }
}
