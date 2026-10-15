import { z } from "zod";
import {
  materializeArtifact as defaultMaterializeArtifact,
  removeMaterializedFile,
  RenderArtifactSchema,
  toPublicArtifact,
  type MaterializedArtifact,
  type PublicArtifact,
  type RenderArtifact,
} from "@/agent/artifact";
import {
  BudgetLedger,
  BudgetApprovalSchema,
  type BudgetApproval,
  type BudgetSnapshot,
} from "@/agent/budget";
import type { AgentConfig } from "@/agent/config";
import {
  AGENT_MAX_FRAMES,
  extractRepresentativeFrames,
  type FrameExtractionRequest,
  type FrameExtractionResult,
} from "@/agent/frame-extractor";
import { getCritiqueRubricLines } from "@/agent/motion-rules";
import {
  applyLocalMotionRepairs,
  isLocallyRepairableRule,
  type RepairIssueInput,
} from "@/agent/local-repair-provider";
import {
  buildUsageEstimate,
  estimateCost,
  type CostEstimate,
  type PriceBook,
} from "@/agent/pricing";
import { redactSecrets, sanitizeDiagnosticText } from "@/agent/redaction";
import {
  DEFAULT_PREVIEW_SCALE,
  type RenderBackend,
  type RenderEngineId,
} from "@/agent/render-contract";
import {
  validateRepairCandidate,
  type MotionRepairProvider,
} from "@/agent/repair-provider";
import {
  critiqueFrames as defaultCritiqueFrames,
  estimateVisionCritiqueCost,
  VisionCritiqueError,
  type CritiqueOutcome,
  type VisionProvider,
} from "@/agent/vision-critique";
import {
  MotionSpecificationSchema,
  type MotionSpecification,
} from "@/motion/schemas/motion-specification";
import { verifyRenderOutput } from "@/render/engine/render-job";

/**
 * Bounded render → validate → critique → repair loop.
 *
 * Guarantees encoded here (each one has a test):
 *  - the existing technical ffprobe gate runs before any visual critique;
 *  - a critique is validated before its verdict can drive a change, and a malformed critique can
 *    never be read as approval;
 *  - iterations are bounded, and each iteration performs exactly one render and one critique
 *    (no unbounded retry);
 *  - rendering failures and critique failures are distinguished, as are "technically valid" and
 *    "visually approved";
 *  - the last valid render is preserved when a later repair fails, and superseded renders are
 *    deleted instead of accumulating;
 *  - `approved` is true only for an explicit approving verdict from an executed critique;
 *  - reaching the iteration limit returns `needs_review`, never success;
 *  - cancellation and per-stage timeouts are honoured.
 */

export const AgentStatusSchema = z.enum(["passed", "needs_review", "failed", "cancelled"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AGENT_STAGES = [
  "queued",
  "rendering",
  "validating",
  "extracting-frames",
  "critiquing",
  "repairing",
  "completed",
] as const;
export const AgentStageSchema = z.enum(AGENT_STAGES);
export type AgentStage = z.infer<typeof AgentStageSchema>;

export const AGENT_FAILURE_REASONS = [
  "render-failed",
  "validation-failed",
  "frame-extraction-failed",
  "critique-failed",
  "repair-failed",
  "budget-refused",
  "no-repairable-issues",
  "max-iterations",
  "timeout",
  "cancelled",
] as const;
export const AgentFailureReasonSchema = z.enum(AGENT_FAILURE_REASONS);
export type AgentFailureReason = z.infer<typeof AgentFailureReasonSchema>;

export class AgentRequestError extends Error {
  constructor(
    readonly code: "invalid-request",
    message: string,
  ) {
    super(message);
    this.name = "AgentRequestError";
  }
}

export interface MediaValidation {
  sizeBytes: number;
  format: "mp4" | "webm";
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
}

export interface AgentProgress {
  stage: AgentStage;
  iteration: number;
  maxIterations: number;
  progress: number;
  detail?: string;
}

export interface AgentIterationRecord {
  iteration: number;
  engine: RenderEngineId | null;
  renderDurationMs: number | null;
  validated: boolean;
  media: MediaValidation | null;
  probedFrameCount: number | null;
  frameCountConsistent: boolean | null;
  frameHashes: string[];
  critique: {
    verdict: "approve" | "revise";
    score: number;
    providerId: string;
    modelId: string;
    issues: Array<{ code: string; severity: "critical" | "major" | "minor"; message: string }>;
  } | null;
  repair: {
    providerId: string;
    appliedRuleIds: string[];
    unrepairableRuleIds: string[];
  } | null;
  failureReason: AgentFailureReason | null;
  costEstimateUsd: number | null;
}

export interface AgentCritiqueSummary {
  verdict: "approve" | "revise" | "unavailable";
  score: number | null;
  providerId: string;
  modelId: string | null;
  issueCount: number;
  ruleIds: string[];
  issues: Array<{ code: string; severity: "critical" | "major" | "minor"; message: string }>;
}

export interface AgentLoopResult {
  status: AgentStatus;
  /** True only when an executed critique returned an approving verdict. */
  approved: boolean;
  iterations: number;
  engine: RenderEngineId | null;
  /** Internal artifact handle. Project it with toPublicArtifact before returning it to a browser. */
  artifact: RenderArtifact | null;
  /** Same artifact, projected for the browser: never contains a server filesystem path. */
  previewArtifact: PublicArtifact | null;
  validation: MediaValidation | null;
  critiqueSummary: AgentCritiqueSummary | null;
  stage: AgentStage;
  failureReason: AgentFailureReason | null;
  errorMessage: string | null;
  budget: BudgetSnapshot;
  estimatedCostUsd: number | null;
  iterationsLog: AgentIterationRecord[];
  disclosures: string[];
  startedAt: string;
  finishedAt: string;
}

export interface AgentLoopDependencies {
  renderBackend: RenderBackend;
  budget: BudgetLedger;
  visionProvider: VisionProvider;
  repairProvider: MotionRepairProvider;
  config: AgentConfig;
  priceBook: PriceBook;
  /** Test seams; each defaults to the production implementation. */
  materialize?: typeof defaultMaterializeArtifact;
  validateMedia?: (filePath: string) => Promise<MediaValidation>;
  extractFrames?: (request: FrameExtractionRequest, options: object) => Promise<FrameExtractionResult>;
  critique?: typeof defaultCritiqueFrames;
  now?: () => number;
  workDir?: (jobId: string) => string;
}

export interface AgentLoopRequest {
  jobId: string;
  taskId?: string;
  specification: unknown;
  maxIterations?: number;
  scale?: number;
  approval?: BudgetApproval;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: AgentProgress) => void;
}

const JobIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

/**
 * Task ids are labels for budget reservations and job deduplication, never paths, so their
 * charset is wider than a job id's (the job API composes them as `qa:<dedupe key>`).
 */
const TaskIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);

function defaultWorkDir(jobId: string): string {
  return `${process.cwd()}/renders/agent/${jobId}/work`;
}

function sanitizeIssueMessage(message: string): string {
  return sanitizeDiagnosticText(redactSecrets(message), [], 160);
}

function mediaSummary(input: {
  sizeBytes: number;
  format: "mp4" | "webm";
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
}): MediaValidation {
  return {
    sizeBytes: input.sizeBytes,
    format: input.format,
    durationSeconds: input.durationSeconds,
    width: input.width,
    height: input.height,
    fps: input.fps,
  };
}

export async function runAgentLoop(
  request: AgentLoopRequest,
  dependencies: AgentLoopDependencies,
): Promise<AgentLoopResult> {
  const { config, budget, visionProvider, repairProvider, renderBackend, priceBook } = dependencies;
  const now = dependencies.now ?? Date.now;
  const materialize = dependencies.materialize ?? defaultMaterializeArtifact;
  const extractFrames = dependencies.extractFrames ?? extractRepresentativeFrames;
  const critique = dependencies.critique ?? defaultCritiqueFrames;
  const validateMedia =
    dependencies.validateMedia ??
    (async (filePath: string): Promise<MediaValidation> =>
      mediaSummary(await verifyRenderOutput(filePath)));
  const workDir = dependencies.workDir ?? defaultWorkDir;
  const rubric = getCritiqueRubricLines();

  const jobId = JobIdSchema.safeParse(request.jobId);
  if (!jobId.success) {
    throw new AgentRequestError("invalid-request", "The job id is not usable.");
  }
  const taskId = request.taskId ?? jobId.data;
  if (!TaskIdSchema.safeParse(taskId).success) {
    throw new AgentRequestError("invalid-request", "The task id is not usable.");
  }

  const maxIterations = request.maxIterations ?? config.maxIterations;
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > config.maxIterations) {
    throw new AgentRequestError(
      "invalid-request",
      `maxIterations must be a whole number between 1 and ${config.maxIterations}.`,
    );
  }

  const specificationParse = MotionSpecificationSchema.safeParse(request.specification);
  if (!specificationParse.success) {
    const issue = specificationParse.error.issues[0];
    throw new AgentRequestError(
      "invalid-request",
      `The motion specification did not pass validation (${issue.path.join(".") || "specification"}: ${issue.message}).`,
    );
  }

  if (request.approval) {
    const approval = BudgetApprovalSchema.safeParse(request.approval);
    if (!approval.success) {
      throw new AgentRequestError(
        "invalid-request",
        "The supplied budget exception approval is not valid.",
      );
    }
  }

  const startedAt = new Date(now()).toISOString();
  const deadline =
    now() +
    (request.timeoutMs ??
      config.renderTimeoutMs + (config.frameTimeoutMs + config.critiqueTimeoutMs) * maxIterations);

  const iterationsLog: AgentIterationRecord[] = [];
  const disclosures: string[] = [];
  let stage: AgentStage = "queued";
  let specification: MotionSpecification = specificationParse.data;
  let lastValid: {
    artifact: RenderArtifact;
    media: MediaValidation;
    frameHashes: string[];
    probedFrameCount: number | null;
    frameCountConsistent: boolean | null;
    materializedPath: string | null;
    removed: boolean;
  } | null = null;
  let status: AgentStatus = "failed";
  let approved = false;
  let failureReason: AgentFailureReason | null = null;
  let errorMessage: string | null = null;
  let critiqueSummary: AgentCritiqueSummary | null = null;
  let estimatedCostUsd: number | null = null;
  let iterations = 0;
  let engine: RenderEngineId | null = null;

  const report = (next: AgentStage, iteration: number, detail?: string): void => {
    stage = next;
    request.onProgress?.({
      stage: next,
      iteration,
      maxIterations,
      progress: Math.min(1, (iteration - 1 + 0.5) / maxIterations),
      ...(detail ? { detail } : {}),
    });
  };

  const isCancelled = (): boolean => request.signal?.aborted === true;
  const isExpired = (): boolean => now() > deadline;

  const artifactLocalPath = (artifact: RenderArtifact): string | null =>
    artifact.kind === "local-file" ? artifact.absolutePath : null;

  const discardSupersededArtifact = async (): Promise<void> => {
    const previous = lastValid;
    if (!previous || previous.removed) return;
    const localPath = artifactLocalPath(previous.artifact);
    if (localPath && previous.artifact.kind === "local-file" && previous.artifact.cleanup === "delete-after-job") {
      await removeMaterializedFile(localPath, {});
    }
    if (previous.materializedPath && previous.materializedPath !== localPath) {
      await removeMaterializedFile(previous.materializedPath, {});
    }
    previous.removed = true;
  };

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    iterations = iteration;
    const record: AgentIterationRecord = {
      iteration,
      engine: renderBackend.engineId,
      renderDurationMs: null,
      validated: false,
      media: null,
      probedFrameCount: null,
      frameCountConsistent: null,
      frameHashes: [],
      critique: null,
      repair: null,
      failureReason: null,
      costEstimateUsd: null,
    };
    iterationsLog.push(record);
    engine = renderBackend.engineId;

    if (isCancelled()) {
      status = "cancelled";
      failureReason = "cancelled";
      record.failureReason = "cancelled";
      break;
    }
    if (isExpired()) {
      status = lastValid ? "needs_review" : "failed";
      failureReason = "timeout";
      record.failureReason = "timeout";
      errorMessage = "The render-and-review cycle exceeded its time limit.";
      break;
    }

    /* ---------------- render ---------------- */
    report("rendering", iteration);
    const renderStarted = now();
    let artifact: RenderArtifact;
    try {
      artifact = RenderArtifactSchema.parse(
        await renderBackend.render({
          jobId: jobId.data,
          specification,
          scale: request.scale ?? DEFAULT_PREVIEW_SCALE,
          timeoutMs: config.renderTimeoutMs,
          ...(request.signal ? { signal: request.signal } : {}),
          onProgress: ({ progress }) =>
            request.onProgress?.({
              stage: "rendering",
              iteration,
              maxIterations,
              progress: Math.min(0.95, (iteration - 1 + progress * 0.9) / maxIterations),
            }),
        }),
      );
    } catch (error) {
      record.renderDurationMs = now() - renderStarted;
      record.failureReason = isCancelled() ? "cancelled" : "render-failed";
      const message = sanitizeDiagnosticText(
        redactSecrets(error instanceof Error ? error.message : String(error)),
        [],
        300,
      );
      if (record.failureReason === "cancelled") {
        status = "cancelled";
        failureReason = "cancelled";
        break;
      }
      failureReason = "render-failed";
      errorMessage = message;
      status = lastValid ? "needs_review" : "failed";
      if (lastValid) {
        disclosures.push(
          "The repair render failed; the previously validated render is retained as a preview.",
        );
      }
      break;
    }
    record.renderDurationMs = now() - renderStarted;

    /* ---------------- materialize + technical validation ---------------- */
    let materialized: MaterializedArtifact;
    try {
      materialized = await materialize(artifact, {
        workDir: workDir(jobId.data),
        signal: request.signal,
        timeoutMs: config.artifactDownloadTimeoutMs,
        maxBytes: config.maxArtifactBytes,
      });
    } catch (error) {
      if (isCancelled()) {
        status = "cancelled";
        failureReason = "cancelled";
        record.failureReason = "cancelled";
        break;
      }
      record.failureReason = "validation-failed";
      failureReason = "validation-failed";
      errorMessage = sanitizeDiagnosticText(
        redactSecrets(error instanceof Error ? error.message : String(error)),
        [],
        300,
      );
      status = lastValid ? "needs_review" : "failed";
      const failedLocalPath = artifactLocalPath(artifact);
      if (failedLocalPath && artifact.kind === "local-file") {
        await removeMaterializedFile(failedLocalPath, {});
      }
      break;
    }

    report("validating", iteration);
    let media: MediaValidation;
    try {
      media = await validateMedia(materialized.filePath);
    } catch (error) {
      record.failureReason = "validation-failed";
      failureReason = "validation-failed";
      errorMessage = sanitizeDiagnosticText(
        redactSecrets(error instanceof Error ? error.message : String(error)),
        [materialized.filePath],
        300,
      );
      status = lastValid ? "needs_review" : "failed";
      if (materialized.cleanupRequired) {
        await removeMaterializedFile(materialized.filePath, {});
      }
      const failedLocalPath = artifactLocalPath(artifact);
      if (failedLocalPath && artifact.kind === "local-file" && artifact.cleanup === "delete-after-job") {
        await removeMaterializedFile(failedLocalPath, {});
      }
      if (lastValid) {
        disclosures.push(
          "The repair render failed the technical ffprobe gate; the previously validated render is retained as a preview.",
        );
      }
      break;
    }

    record.validated = true;
    record.media = media;

    await discardSupersededArtifact();
    lastValid = {
      artifact,
      media,
      frameHashes: [],
      probedFrameCount: null,
      frameCountConsistent: null,
      materializedPath: materialized.filePath,
      removed: false,
    };

    /* ---------------- frame extraction ---------------- */
    report("extracting-frames", iteration);
    let frames: FrameExtractionResult;
    try {
      frames = await extractFrames(
        {
          videoPath: materialized.filePath,
          outputDir: `${workDir(jobId.data)}/frames-${iteration}`,
          frameCount: Math.min(config.frameCount, AGENT_MAX_FRAMES),
          width: config.frameWidth,
          timeoutMs: config.frameTimeoutMs,
          maxFrameBytes: config.maxFrameBytes,
          maxTotalBytes: config.maxTotalFrameBytes,
          keepFrames: config.keepFrames,
        },
        request.signal ? { signal: request.signal } : {},
      );
    } catch (error) {
      record.failureReason = isCancelled() ? "cancelled" : "frame-extraction-failed";
      if (record.failureReason === "cancelled") {
        status = "cancelled";
        failureReason = "cancelled";
        break;
      }
      failureReason = "frame-extraction-failed";
      status = "needs_review";
      errorMessage = sanitizeDiagnosticText(
        redactSecrets(error instanceof Error ? error.message : String(error)),
        [],
        300,
      );
      disclosures.push(
        "The render is technically valid but was not reviewed visually, so it is not approved.",
      );
      break;
    }

    record.probedFrameCount = frames.probedFrameCount;
    record.frameCountConsistent = frames.frameCountConsistent;
    record.frameHashes = frames.frames.map((frame) => frame.sha256);
    lastValid.frameHashes = record.frameHashes;
    lastValid.probedFrameCount = frames.probedFrameCount;
    lastValid.frameCountConsistent = frames.frameCountConsistent;

    if (!frames.frameCountConsistent) {
      disclosures.push(
        "The media frame count disagrees with duration x fps beyond rounding; the render was reviewed anyway.",
      );
    }

    /* ---------------- visual critique (paid, budget-gated) ---------------- */
    if (isCancelled()) {
      status = "cancelled";
      failureReason = "cancelled";
      record.failureReason = "cancelled";
      break;
    }

    if (!visionProvider.isConfigured) {
      failureReason = "critique-failed";
      record.failureReason = "critique-failed";
      status = "needs_review";
      errorMessage =
        "No vision provider is configured, so this render could not be reviewed visually. It is a preview, not an approved deliverable.";
      critiqueSummary = {
        verdict: "unavailable",
        score: null,
        providerId: visionProvider.id,
        modelId: visionProvider.modelId,
        issueCount: 0,
        ruleIds: [],
        issues: [],
      };
      disclosures.push(
        "Visual approval requires an explicitly enabled vision provider; none is configured.",
      );
      break;
    }

    const critiqueEstimate = estimateVisionCritiqueCost({
      priceBook,
      providerId: visionProvider.id,
      modelId: visionProvider.modelId,
      frames: frames.frames,
      rubric,
      language: specification.project.language,
      maxOutputTokens: config.critiqueMaxOutputTokens,
    });
    record.costEstimateUsd = critiqueEstimate?.usd ?? null;
    if (critiqueEstimate) {
      estimatedCostUsd = (estimatedCostUsd ?? 0) + critiqueEstimate.usd;
    }

    const critiqueReservation = budget.reserve({
      taskId: `${jobId.data}:critique:${iteration}`,
      estimate: critiqueEstimate,
      ...(request.approval ? { approval: request.approval } : {}),
    });
    if (!critiqueReservation.ok) {
      failureReason = "budget-refused";
      record.failureReason = "budget-refused";
      status = "needs_review";
      errorMessage = critiqueReservation.message;
      disclosures.push(
        "The visual critique was refused by the budget gate, so the render is a preview only and is not approved.",
      );
      break;
    }

    report("critiquing", iteration);
    let outcome: CritiqueOutcome;
    try {
      outcome = await critique({
        frames: frames.frames.map((frame) => ({
          index: frame.index,
          bytes: frame.bytes,
          width: frame.width,
          height: frame.height,
          timestampSeconds: frame.timestampSeconds,
          sha256: frame.sha256,
        })),
        provider: visionProvider,
        rubric,
        language: specification.project.language,
        maxOutputTokens: config.critiqueMaxOutputTokens,
        timeoutMs: config.critiqueTimeoutMs,
        limits: {
          maxBytes: config.maxFrameBytes,
          maxWidth: config.frameWidth,
          maxHeight: config.frameWidth * 2,
          minWidth: config.frameWidth,
          maxImages: Math.min(config.frameCount, AGENT_MAX_FRAMES),
        },
        ...(request.signal ? { signal: request.signal } : {}),
      });
      budget.settle(critiqueReservation.reservationId);
    } catch (error) {
      const code = error instanceof VisionCritiqueError ? error.code : "provider-failed";
      const beforeDispatch =
        code === "provider-unconfigured" ||
        code === "invalid-image" ||
        code === "too-many-images" ||
        code === "payload-too-large" ||
        (code === "provider-cancelled" && isCancelled());
      if (beforeDispatch) {
        budget.release(critiqueReservation.reservationId);
      } else {
        // The request may have reached the provider: charge the estimate rather than under-count.
        budget.settle(critiqueReservation.reservationId);
      }

      if (code === "provider-cancelled" && isCancelled()) {
        status = "cancelled";
        failureReason = "cancelled";
        record.failureReason = "cancelled";
        break;
      }

      failureReason = "critique-failed";
      record.failureReason = "critique-failed";
      status = "needs_review";
      errorMessage = sanitizeDiagnosticText(
        redactSecrets(error instanceof Error ? error.message : String(error)),
        [],
        300,
      );
      critiqueSummary = {
        verdict: "unavailable",
        score: null,
        providerId: visionProvider.id,
        modelId: visionProvider.modelId,
        issueCount: 0,
        ruleIds: [],
        issues: [],
      };
      disclosures.push(
        "The visual critique did not produce a usable verdict, so this render is not approved.",
      );
      break;
    }

    const critiqueResult = outcome.critique;
    record.critique = {
      verdict: critiqueResult.verdict,
      score: critiqueResult.score,
      providerId: outcome.providerId,
      modelId: outcome.modelId,
      issues: critiqueResult.issues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        message: sanitizeIssueMessage(issue.message),
      })),
    };
    critiqueSummary = {
      verdict: critiqueResult.verdict,
      score: critiqueResult.score,
      providerId: outcome.providerId,
      modelId: outcome.modelId,
      issueCount: critiqueResult.issues.length,
      ruleIds: [...new Set(critiqueResult.issues.map((issue) => issue.code))],
      issues: record.critique.issues,
    };

    if (critiqueResult.verdict === "approve") {
      status = "passed";
      approved = true;
      failureReason = null;
      break;
    }

    /* ---------------- repair ---------------- */
    if (iteration === maxIterations) {
      status = "needs_review";
      failureReason = "max-iterations";
      record.failureReason = "max-iterations";
      break;
    }

    if (isCancelled()) {
      status = "cancelled";
      failureReason = "cancelled";
      record.failureReason = "cancelled";
      break;
    }

    report("repairing", iteration);
    const issues: RepairIssueInput[] = critiqueResult.issues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      message: sanitizeIssueMessage(issue.message),
      ...(issue.sceneId ? { sceneId: issue.sceneId } : {}),
    }));

    const localRepair = applyLocalMotionRepairs(specification, issues);
    let repairedSpecification: MotionSpecification | null = null;
    let repairProviderId = "local-rules";
    let appliedRuleIds = localRepair.appliedRuleIds;
    let unrepairableRuleIds = localRepair.unrepairableRuleIds;

    if (localRepair.appliedRuleIds.length > 0) {
      repairedSpecification = validateRepairCandidate(specification, localRepair.specification);
    } else if (repairProvider.isConfigured) {
      const repairUsage = buildUsageEstimate({
        promptText: JSON.stringify(specification),
        maxOutputTokens: config.repairMaxOutputTokens,
      });
      const repairEstimate: CostEstimate | undefined = estimateCost({
        priceBook,
        providerId: repairProvider.id,
        modelId: repairProvider.modelId,
        usage: repairUsage,
      });
      record.costEstimateUsd = (record.costEstimateUsd ?? 0) + (repairEstimate?.usd ?? 0);
      if (repairEstimate) estimatedCostUsd = (estimatedCostUsd ?? 0) + repairEstimate.usd;

      const repairReservation = budget.reserve({
        taskId: `${jobId.data}:repair:${iteration}`,
        estimate: repairEstimate,
        ...(request.approval ? { approval: request.approval } : {}),
      });
      if (!repairReservation.ok) {
        failureReason = "budget-refused";
        record.failureReason = "budget-refused";
        status = "needs_review";
        errorMessage = repairReservation.message;
        disclosures.push(
          "The repair request was refused by the budget gate, so the render stays a preview and is not approved.",
        );
        break;
      }

      try {
        const proposal = await repairProvider.propose({
          specification,
          issues,
          rubric,
          maxOutputTokens: config.repairMaxOutputTokens,
          signal: request.signal ?? new AbortController().signal,
        });
        repairedSpecification = validateRepairCandidate(specification, proposal);
        budget.settle(repairReservation.reservationId);
        repairProviderId = repairProvider.id;
        appliedRuleIds = [...new Set(issues.map((issue) => issue.code))];
        unrepairableRuleIds = [];
      } catch (error) {
        const cancelled = isCancelled();
        if (cancelled) {
          budget.release(repairReservation.reservationId);
          status = "cancelled";
          failureReason = "cancelled";
          record.failureReason = "cancelled";
          break;
        }
        budget.settle(repairReservation.reservationId);
        failureReason = "repair-failed";
        record.failureReason = "repair-failed";
        status = "needs_review";
        errorMessage = sanitizeDiagnosticText(
          redactSecrets(error instanceof Error ? error.message : String(error)),
          [],
          300,
        );
        record.repair = {
          providerId: repairProvider.id,
          appliedRuleIds: [],
          unrepairableRuleIds: issues.map((issue) => issue.code),
        };
        disclosures.push(
          "The repair did not produce a valid specification; the last validated render is retained as a preview.",
        );
        break;
      }
    }

    if (!repairedSpecification) {
      const blockers = unrepairableRuleIds.filter((code) => !isLocallyRepairableRule(code));
      failureReason = "no-repairable-issues";
      record.failureReason = "no-repairable-issues";
      status = "needs_review";
      errorMessage =
        "The critique reported issues that no configured repair can fix deterministically, so no further render was started.";
      record.repair = {
        providerId: repairProviderId,
        appliedRuleIds: [],
        unrepairableRuleIds: blockers.length > 0 ? blockers : unrepairableRuleIds,
      };
      disclosures.push("Unresolved visual issues remain; the render is a preview, not an approved deliverable.");
      break;
    }

    const validatedRepair = MotionSpecificationSchema.safeParse(repairedSpecification);
    if (!validatedRepair.success) {
      failureReason = "repair-failed";
      record.failureReason = "repair-failed";
      status = "needs_review";
      errorMessage = "The repair produced a specification that no longer satisfies the schema.";
      break;
    }

    record.repair = {
      providerId: repairProviderId,
      appliedRuleIds,
      unrepairableRuleIds,
    };
    specification = validatedRepair.data;
  }

  report("completed", Math.max(1, iterations));

  if (
    lastValid &&
    lastValid.materializedPath &&
    lastValid.materializedPath !== artifactLocalPath(lastValid.artifact)
  ) {
    disclosures.push("A downloaded Lambda artifact is retained locally only for the review preview.");
  }

  if (budget.snapshot().enforcement === "process-local") {
    disclosures.push(
      "Budget reservations are process-local: they are not shared across server instances and do not replace the provider's invoice.",
    );
  }

  const previewArtifact = lastValid ? toPublicArtifact(lastValid.artifact) : null;

  if (previewArtifact && previewArtifact.kind === "local-file" && previewArtifact.previewPath === undefined) {
    disclosures.push(
      "This run did not use a job identifier issued by the job API, so the retained preview cannot be streamed through the preview route.",
    );
  }

  return {
    status,
    approved: status === "passed" && approved,
    iterations,
    engine,
    artifact: lastValid?.artifact ?? null,
    previewArtifact,
    validation: lastValid?.media ?? null,
    critiqueSummary,
    stage,
    failureReason,
    errorMessage,
    budget: budget.snapshot(),
    estimatedCostUsd,
    iterationsLog,
    disclosures,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
  };
}
