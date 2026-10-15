import { z } from "zod";
import { AGENT_MAX_FRAMES, AGENT_MAX_FRAME_WIDTH, AGENT_MIN_FRAME_WIDTH } from "@/agent/frame-extractor";
import { BudgetApprovalSchema } from "@/agent/budget";
import { MotionSpecificationSchema } from "@/motion/schemas/motion-specification";

/**
 * Request contract for POST /api/agent/qa.
 *
 * The body carries a complete, already-planned Motion Specification (the same data-only schema
 * `/api/plan` produces). Nothing here accepts code, file paths, shell commands, or provider
 * credentials, so the endpoint cannot be used to make the server run arbitrary work.
 */

export const AgentQaRequestSchema = z.object({
  specification: MotionSpecificationSchema,
  /** Render backend: local Remotion or the existing Remotion Lambda workflow. */
  engine: z.enum(["remotion-local", "remotion-lambda"]).default("remotion-local"),
  maxIterations: z.number().int().min(1).max(4).optional(),
  scale: z.number().min(0.1).max(1).optional(),
  /** Optional explicit approval for a per-task budget exception. */
  budgetApproval: BudgetApprovalSchema.optional(),
  /** Client-supplied idempotency key; identical active keys are refused instead of duplicated. */
  requestKey: z.string().trim().min(8).max(128).optional(),
});

export type AgentQaRequest = z.infer<typeof AgentQaRequestSchema>;

export const AGENT_QA_MAX_REQUEST_BYTES = 128 * 1024;

export const AgentQaAcceptedSchema = z.object({
  type: z.literal("accepted"),
  jobId: z.string().uuid(),
  status: z.literal("queued"),
  pollPath: z.string().regex(/^\/api\/agent\/qa\/[0-9a-fA-F-]{36}$/),
  engine: z.enum(["remotion-local", "remotion-lambda"]),
  maxIterations: z.number().int().min(1).max(4),
});

export const AgentQaErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      "INVALID_REQUEST",
      "DUPLICATE_ACTIVE_REQUEST",
      "JOB_CAPACITY_REACHED",
      "JOB_NOT_FOUND",
      "PREVIEW_NOT_AVAILABLE",
      "INTERNAL_ERROR",
    ]),
    message: z.string().min(1).max(400),
    retryable: z.boolean(),
  }),
});

export type AgentQaErrorCode = z.infer<typeof AgentQaErrorSchema>["error"]["code"];

/** Frame budgets exposed for documentation and for validating client expectations. */
export const AGENT_QA_FRAME_LIMITS = {
  minWidth: AGENT_MIN_FRAME_WIDTH,
  maxWidth: AGENT_MAX_FRAME_WIDTH,
  maxFrames: AGENT_MAX_FRAMES,
} as const;

export function buildDedupeKey(input: {
  requestKey?: string;
  engine: string;
  maxIterations?: number;
  specification: unknown;
}): string {
  if (input.requestKey) return `request:${input.requestKey}`;
  const fingerprintSource = JSON.stringify({
    engine: input.engine,
    maxIterations: input.maxIterations ?? null,
    specification: input.specification,
  });
  // FNV-1a keeps the key short; it only has to distinguish concurrent duplicates in-process.
  let hash = 0x811c9dc5;
  for (let index = 0; index < fingerprintSource.length; index += 1) {
    hash ^= fingerprintSource.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `spec:${hash.toString(16)}`;
}
