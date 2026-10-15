import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PublicArtifactSchema, removeMaterializedFile } from "@/agent/artifact";
import { sanitizeDiagnosticText } from "@/agent/redaction";
import {
  AGENT_STAGES,
  AGENT_FAILURE_REASONS,
  type AgentLoopResult,
  type AgentProgress,
} from "@/agent/loop";

/**
 * In-process job registry for render-and-review cycles.
 *
 * The repository has no durable queue or worker. This store keeps a bounded, single-instance
 * registry so a browser can poll progress instead of holding an HTTP request open for minutes,
 * and so duplicate active requests for the same task are refused instead of paying twice.
 *
 * Expiry deletes a job's retained local render, so a preview link cannot outlive its job.
 * Two notes are deliberate: state is not shared across server instances, and a process restart
 * loses the registry (and the retained preview).
 */

export const AgentJobStatusSchema = z.enum([
  "queued",
  "running",
  "passed",
  "needs_review",
  "failed",
  "cancelled",
]);
export type AgentJobStatus = z.infer<typeof AgentJobStatusSchema>;

export const ACTIVE_JOB_STATUSES: readonly AgentJobStatus[] = ["queued", "running"];

export class AgentJobConflictError extends Error {
  readonly code = "duplicate-active-request";
  constructor(message = "An identical render-and-review request is already running.") {
    super(message);
    this.name = "AgentJobConflictError";
  }
}

export class AgentJobCapacityError extends Error {
  readonly code = "job-capacity-reached";
  constructor(message = "Too many render-and-review jobs are active. Retry after they finish.") {
    super(message);
    this.name = "AgentJobCapacityError";
  }
}

export const AgentJobBudgetViewSchema = z.object({
  dailyCommittedUsd: z.number().nonnegative(),
  dailyLimitUsd: z.number().nonnegative(),
  taskLimitUsd: z.number().nonnegative(),
  activeReservations: z.number().int().nonnegative(),
  enforcement: z.literal("process-local"),
  invoiceGuarantee: z.literal(false),
});

export const AgentJobIterationViewSchema = z.object({
  iteration: z.number().int().positive(),
  engine: z.string().max(40).nullable(),
  renderDurationMs: z.number().int().nonnegative().nullable(),
  validated: z.boolean(),
  media: z
    .object({
      sizeBytes: z.number().int().nonnegative(),
      format: z.enum(["mp4", "webm"]),
      durationSeconds: z.number().positive(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      fps: z.number().positive(),
    })
    .nullable(),
  frameHashes: z.array(z.string().length(64)).max(8),
  critique: z
    .object({
      verdict: z.enum(["approve", "revise"]),
      score: z.number().min(0).max(10),
      issues: z
        .array(
          z.object({
            code: z.string().max(48),
            severity: z.enum(["critical", "major", "minor"]),
            message: z.string().max(200),
          }),
        )
        .max(12),
    })
    .nullable(),
  repair: z
    .object({
      providerId: z.string().max(80),
      appliedRuleIds: z.array(z.string().max(48)).max(12),
      unrepairableRuleIds: z.array(z.string().max(48)).max(12),
    })
    .nullable(),
  failureReason: z.enum(AGENT_FAILURE_REASONS).nullable(),
  costEstimateUsd: z.number().nonnegative().nullable(),
});

/** The only job shape the browser receives. */
export const AgentJobViewSchema = z.object({
  jobId: z.string().uuid(),
  status: AgentJobStatusSchema,
  stage: z.enum(AGENT_STAGES),
  progress: z.number().min(0).max(1),
  approved: z.boolean(),
  iterations: z.number().int().nonnegative(),
  engine: z.string().max(40).nullable(),
  artifact: PublicArtifactSchema.nullable(),
  validation: AgentJobIterationViewSchema.shape.media,
  critique: z
    .object({
      verdict: z.enum(["approve", "revise", "unavailable"]),
      score: z.number().min(0).max(10).nullable(),
      providerId: z.string().max(80),
      issueCount: z.number().int().nonnegative(),
      ruleIds: z.array(z.string().max(48)).max(12),
      issues: z
        .array(
          z.object({
            code: z.string().max(48),
            severity: z.enum(["critical", "major", "minor"]),
            message: z.string().max(200),
          }),
        )
        .max(12),
    })
    .nullable(),
  failureReason: z.enum(AGENT_FAILURE_REASONS).nullable(),
  error: z.string().max(300).nullable(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
  budget: AgentJobBudgetViewSchema,
  iterationsLog: z.array(AgentJobIterationViewSchema).max(4),
  disclosures: z.array(z.string().max(400)).max(12),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type AgentJobView = z.infer<typeof AgentJobViewSchema>;

export interface AgentJobRecord {
  jobId: string;
  taskId: string;
  dedupeKey: string;
  status: AgentJobStatus;
  stage: (typeof AGENT_STAGES)[number];
  progress: number;
  createdAt: number;
  updatedAt: number;
  controller: AbortController;
  result: AgentLoopResult | null;
  view: AgentJobView | null;
  error: string | null;
  /** Local files created for this job (retained artifact + work directory). */
  localPaths: string[];
}

export interface StartAgentJobInput {
  /**
   * Optional caller-supplied identifier. The job API generates it up front so the run callback can
   * know the id it is running under (the run callback must not read the record being created).
   */
  jobId?: string;
  taskId: string;
  dedupeKey: string;
  run: (signal: AbortSignal, onProgress: (progress: AgentProgress) => void) => Promise<AgentLoopResult>;
  budgetSnapshot: () => z.infer<typeof AgentJobBudgetViewSchema>;
}

export interface AgentJobStoreOptions {
  ttlMs: number;
  maxJobs?: number;
  now?: () => number;
  /** Test seam for artifact cleanup. */
  removeFile?: (filePath: string) => Promise<void>;
}

function localPathsOf(result: AgentLoopResult): string[] {
  return result.artifact?.kind === "local-file" ? [result.artifact.absolutePath] : [];
}

export function toAgentJobView(
  job: AgentJobRecord,
  budget: z.infer<typeof AgentJobBudgetViewSchema>,
): AgentJobView {
  const result = job.result;

  const base = {
    jobId: job.jobId,
    status: job.status,
    stage: job.stage,
    progress: Math.max(0, Math.min(1, job.progress)),
    approved: result?.approved ?? false,
    iterations: result?.iterations ?? 0,
    engine: result?.engine ?? null,
    artifact: result?.previewArtifact ?? null,
    validation: result?.validation ?? null,
    critique: result?.critiqueSummary ?? null,
    failureReason: result?.failureReason ?? null,
    error: job.error ?? result?.errorMessage ?? null,
    estimatedCostUsd: result?.estimatedCostUsd ?? null,
    budget,
    iterationsLog:
      result?.iterationsLog.map((record) => ({
        iteration: record.iteration,
        engine: record.engine,
        renderDurationMs: record.renderDurationMs,
        validated: record.validated,
        media: record.media,
        frameHashes: record.frameHashes,
        critique: record.critique
          ? {
              verdict: record.critique.verdict,
              score: record.critique.score,
              issues: record.critique.issues,
            }
          : null,
        repair: record.repair,
        failureReason: record.failureReason,
        costEstimateUsd: record.costEstimateUsd,
      })) ?? [],
    disclosures: result?.disclosures ?? [],
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
  };

  const parsed = AgentJobViewSchema.safeParse(base);
  if (!parsed.success) {
    // Never leak an unvalidated internal shape: return the safe subset instead.
    const issue = parsed.error.issues[0];
    return AgentJobViewSchema.parse({
      ...base,
      iterationsLog: [],
      critique: null,
      artifact: null,
      error: `The job view could not be validated (${issue.path.join(".")}).`,
      disclosures: [
        "Internal details were withheld because the job view failed validation.",
      ],
    });
  }

  return parsed.data;
}

export class AgentJobStore {
  private readonly jobs = new Map<string, AgentJobRecord>();
  private readonly ttlMs: number;
  private readonly maxJobs: number;
  private readonly now: () => number;
  private readonly removeFile: (filePath: string) => Promise<void>;

  constructor(options: AgentJobStoreOptions) {
    this.ttlMs = options.ttlMs;
    this.maxJobs = options.maxJobs ?? 32;
    this.now = options.now ?? Date.now;
    this.removeFile = options.removeFile ?? ((filePath: string) => removeMaterializedFile(filePath, {}));
  }

  /** Refuses a duplicate active request for the same dedupe key. */
  findActiveByDedupeKey(dedupeKey: string): AgentJobRecord | undefined {
    this.prune();
    return [...this.jobs.values()].find(
      (job) => job.dedupeKey === dedupeKey && ACTIVE_JOB_STATUSES.includes(job.status),
    );
  }

  startJob(input: StartAgentJobInput): AgentJobRecord {
    this.prune();

    if (this.findActiveByDedupeKey(input.dedupeKey)) {
      throw new AgentJobConflictError();
    }
    const activeJobs = [...this.jobs.values()].filter((job) =>
      ACTIVE_JOB_STATUSES.includes(job.status),
    ).length;
    if (activeJobs >= this.maxJobs) {
      throw new AgentJobCapacityError();
    }

    if (input.jobId !== undefined && !z.string().uuid().safeParse(input.jobId).success) {
      throw new AgentJobCapacityError("The supplied job identifier is not usable.");
    }
    const jobId = input.jobId ?? randomUUID();
    if (this.jobs.has(jobId)) {
      throw new AgentJobConflictError("That job identifier is already in use.");
    }
    const job: AgentJobRecord = {
      jobId,
      taskId: input.taskId,
      dedupeKey: input.dedupeKey,
      status: "queued",
      stage: "queued",
      progress: 0,
      createdAt: this.now(),
      updatedAt: this.now(),
      controller: new AbortController(),
      result: null,
      view: null,
      error: null,
      localPaths: [],
    };
    this.jobs.set(jobId, job);

    const onProgress = (progress: AgentProgress): void => {
      job.status = "running";
      job.stage = progress.stage;
      job.progress = progress.progress;
      job.updatedAt = this.now();
    };

    void (async () => {
      job.status = "running";
      try {
        const result = await input.run(job.controller.signal, onProgress);
        job.result = result;
        job.status = result.status;
        job.stage = result.stage;
        job.progress = 1;
        job.error = result.errorMessage;
        job.localPaths = localPathsOf(result);
      } catch (error) {
        job.status = "failed";
        job.stage = "completed";
        job.error = "The render-and-review job failed before producing a result.";
        // The browser only gets the generic message above; operators get a sanitized line in the
        // server log so a broken job is diagnosable without leaking paths or provider bodies.
        console.error(
          "[agent-qa] job failed before producing a result:",
          sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
        );
        job.progress = 1;
      } finally {
        job.updatedAt = this.now();
        job.view = null;
      }
    })();

    return job;
  }

  getJob(jobId: string): AgentJobRecord | undefined {
    this.prune();
    return this.jobs.get(jobId);
  }

  cancelJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (ACTIVE_JOB_STATUSES.includes(job.status)) {
      job.status = "cancelled";
      job.stage = "completed";
      job.progress = 1;
      job.error = "The job was cancelled at the caller's request.";
      job.updatedAt = this.now();
      job.controller.abort(new Error("cancelled"));
      return true;
    }
    return false;
  }

  /** Removes expired jobs and their retained local artifacts. Returns how many were removed. */
  prune(): number {
    const cutoff = this.now() - this.ttlMs;
    let removed = 0;

    for (const [jobId, job] of this.jobs) {
      if (job.updatedAt > cutoff) continue;
      if (ACTIVE_JOB_STATUSES.includes(job.status)) continue;
      void this.cleanupJob(job);
      this.jobs.delete(jobId);
      removed += 1;
    }

    return removed;
  }

  private async cleanupJob(job: AgentJobRecord): Promise<void> {
    const paths = new Set(job.localPaths);
    if (job.result?.artifact?.kind === "local-file") paths.add(job.result.artifact.absolutePath);
    for (const filePath of paths) {
      await this.removeFile(filePath).catch(() => undefined);
    }
  }

  /** Drains every job (used by tests and by a graceful shutdown hook). */
  async disposeAll(): Promise<void> {
    for (const job of this.jobs.values()) {
      job.controller.abort(new Error("disposed"));
      await this.cleanupJob(job);
    }
    this.jobs.clear();
  }

  get size(): number {
    return this.jobs.size;
  }
}
