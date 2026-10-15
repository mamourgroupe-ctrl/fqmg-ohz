import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import previewSpecification from "../templates/phase-one-preview.json";
import { BudgetLedger } from "@/agent/budget";
import { AGENT_CONFIG_DEFAULTS, type AgentConfig } from "@/agent/config";
import { toPublicArtifact, findLocalFilesystemPaths, type RenderArtifact } from "@/agent/artifact";
import {
  AgentRequestError,
  runAgentLoop,
  type AgentLoopDependencies,
  type MediaValidation,
} from "@/agent/loop";
import { EMPTY_PRICE_BOOK, type PriceBook } from "@/agent/pricing";
import { createDisabledMotionRepairProvider, type MotionRepairProvider } from "@/agent/repair-provider";
import type { RenderBackend, RenderBackendRequest } from "@/agent/render-contract";
import type { FrameExtractionResult } from "@/agent/frame-extractor";
import type { VisionProvider, VisionProviderRequest } from "@/agent/vision-critique";
import { MotionSpecificationSchema, type MotionSpecification } from "@/motion/schemas/motion-specification";

const STUB_PROVIDER_ID = "stub-vision";
const STUB_REPAIR_PROVIDER_ID = "stub-repair";
const STUB_MODEL_ID = "stub-model";
const JOB_UUID = "11111111-1111-4111-8111-111111111111";
const FRAME_WIDTH = 160;

const syntheticPngFrame = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAIAAACwpMoFAAAAQElEQVR4nO3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8GOpGgABimw4TgAAAABJRU5ErkJggg==",
  "base64",
);

const TEMP_DIRECTORIES: string[] = [];

afterEach(async () => {
  for (const directory of TEMP_DIRECTORIES.splice(0)) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** The preview fixture starts every scene with a text layer; tests rely on that. */
function firstTextLayer(specification: MotionSpecification) {
  const layer = specification.scenes[0].layers[0];
  if (layer.type !== "text") {
    throw new Error("The preview template no longer starts its first scene with a text layer.");
  }
  return layer;
}

function createSpecification(): MotionSpecification {
  // The preview template violates nothing on its own; tests mutate copies.
  return MotionSpecificationSchema.parse(structuredClone(previewSpecification)) as MotionSpecification;
}

function createConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...AGENT_CONFIG_DEFAULTS,
    maxIterations: 2,
    frameCount: 2,
    frameWidth: FRAME_WIDTH,
    frameTimeoutMs: 5_000,
    critiqueTimeoutMs: 5_000,
    renderTimeoutMs: 10_000,
    ...overrides,
  };
}

function createPriceBook(): PriceBook {
  return {
    entries: [
      {
        providerId: STUB_PROVIDER_ID,
        modelId: STUB_MODEL_ID,
        unit: "per-million-tokens",
        inputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 0.4,
        sourceUrl: "https://example.invalid/pricing",
        verifiedOn: "2026-10-15",
      },
      {
        providerId: STUB_REPAIR_PROVIDER_ID,
        modelId: STUB_MODEL_ID,
        unit: "per-million-tokens",
        inputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 0.4,
        sourceUrl: "https://example.invalid/pricing",
        verifiedOn: "2026-10-15",
      },
    ],
  };
}

function createArtifact(jobId: string, marker: string): RenderArtifact {
  return {
    kind: "local-file",
    artifactId: `00000000-0000-4000-8000-${marker.padStart(12, "0")}`,
    absolutePath: `/tmp/fqmg-fake-${marker}.mp4`,
    sizeBytes: 1_024,
    mimeType: "video/mp4",
    cleanup: "delete-after-job",
    jobId,
    engine: "remotion-local",
  };
}

function createFrameExtractionResult(): FrameExtractionResult {
  const frames = [0, 1].map((index) => ({
    index,
    bytes: syntheticPngFrame,
    filePath: `/tmp/fqmg-fake-frame-${index}.jpg`,
    timestampSeconds: 0.5 + index,
    probedTimestampSeconds: 0.5 + index,
    width: FRAME_WIDTH,
    height: 90,
    mimeType: "image/jpeg" as const,
    sizeBytes: syntheticPngFrame.byteLength,
    sha256: String(index).repeat(64).slice(0, 64),
  }));

  return {
    frames,
    outputDir: "/tmp/fqmg-fake-frames",
    requestedFrameCount: 2,
    extractedFrameCount: 2,
    effectiveFrameCount: 2,
    probedFrameCount: 60,
    metadataFrameCount: 60,
    frameCountConsistent: true,
    videoDurationSeconds: 2,
    videoFps: 30,
    shortVideoAdjusted: false,
    cleanedUp: true,
    retainedFrames: false,
  };
}

const MEDIA: MediaValidation = {
  sizeBytes: 1_024,
  format: "mp4",
  durationSeconds: 2,
  width: 1080,
  height: 1920,
  fps: 30,
};

function approveJson(score = 8.5): string {
  return JSON.stringify({
    verdict: "approve",
    score,
    issues: [],
    summary: "Frames are legible and the composition resolves cleanly.",
  });
}

function reviseJson(issue: { code: string; severity?: string }): string {
  return JSON.stringify({
    verdict: "revise",
    score: 4,
    issues: [
      {
        code: issue.code,
        severity: issue.severity ?? "major",
        frameIndex: 0,
        message: "The layout pushes the headline outside the safe area.",
      },
    ],
    summary: "One layout problem was found in the reviewed frames.",
  });
}

interface Harness {
  dependencies: AgentLoopDependencies;
  renderCalls: RenderBackendRequest[];
  validateCalls: string[];
  visionCalls: VisionProviderRequest[];
  specification: MotionSpecification;
  budget: BudgetLedger;
}

type RenderBehavior =
  | { type: "artifact"; artifact?: RenderArtifact }
  | { type: "error"; message?: string }
  | { type: "cancel-then-error" };

function createHarness(options: {
  specification?: MotionSpecification;
  renderBehaviors: RenderBehavior[];
  critiqueResponses: Array<string | Error>;
  priceBook?: PriceBook;
  repairProvider?: MotionRepairProvider;
  visionConfigured?: boolean;
  config?: Partial<AgentConfig>;
  validationBehavior?: Array<MediaValidation | Error>;
  frameBehavior?: Array<FrameExtractionResult | Error>;
  budget?: BudgetLedger;
}): Harness {
  const jobId = "job-1";
  const specification = options.specification ?? createSpecification();
  const renderCalls: RenderBackendRequest[] = [];
  const validateCalls: string[] = [];
  const visionCalls: VisionProviderRequest[] = [];
  const config = createConfig(options.config);
  const budget =
    options.budget ??
    new BudgetLedger({
      policy: { dailyLimitUsd: config.dailyBudgetUsd, taskLimitUsd: config.taskBudgetUsd },
    });

  let renderIndex = 0;
  const renderBackend: RenderBackend = {
    engineId: "remotion-local",
    isConfigured: true,
    async render(request: RenderBackendRequest): Promise<RenderArtifact> {
      renderCalls.push(request);
      const behavior = options.renderBehaviors[Math.min(renderIndex, options.renderBehaviors.length - 1)];
      const marker = `${renderIndex + 1}`;
      renderIndex += 1;

      if (behavior.type === "error") {
        throw new Error(behavior.message ?? "The local Remotion render failed.");
      }
      if (behavior.type === "cancel-then-error") {
        request.signal?.dispatchEvent(new Event("abort"));
        throw new Error("The local render was cancelled.");
      }
      return behavior.artifact ?? createArtifact(jobId, marker);
    },
  };

  let validationIndex = 0;
  let frameIndex = 0;
  let critiqueIndex = 0;

  const visionProvider: VisionProvider = {
    id: STUB_PROVIDER_ID,
    modelId: STUB_MODEL_ID,
    isConfigured: options.visionConfigured ?? true,
    async critique(request: VisionProviderRequest): Promise<unknown> {
      visionCalls.push(request);
      const response = options.critiqueResponses[
        Math.min(critiqueIndex, options.critiqueResponses.length - 1)
      ];
      critiqueIndex += 1;
      if (response instanceof Error) throw response;
      return response;
    },
  };

  const dependencies: AgentLoopDependencies = {
    renderBackend,
    budget,
    visionProvider,
    repairProvider: options.repairProvider ?? createDisabledMotionRepairProvider(),
    config,
    priceBook: options.priceBook ?? createPriceBook(),
    materialize: async (artifact) => {
      const parsed = artifact as RenderArtifact;
      return {
        filePath: parsed.kind === "local-file" ? parsed.absolutePath : "/tmp/fqmg-download.mp4",
        sizeBytes: parsed.sizeBytes ?? 1_024,
        mimeType: "video/mp4" as const,
        cleanupRequired: parsed.kind !== "local-file",
      };
    },
    validateMedia: async (filePath: string) => {
      validateCalls.push(filePath);
      const behavior = options.validationBehavior?.[
        Math.min(validationIndex, (options.validationBehavior ?? []).length - 1)
      ];
      validationIndex += 1;
      if (behavior instanceof Error) throw behavior;
      return behavior ?? MEDIA;
    },
    extractFrames: async () => {
      const behavior = options.frameBehavior?.[
        Math.min(frameIndex, (options.frameBehavior ?? []).length - 1)
      ];
      frameIndex += 1;
      if (behavior instanceof Error) throw behavior;
      return behavior ?? createFrameExtractionResult();
    },
    workDir: (id) => `/tmp/fqmg-work-${id}`,
  };

  return {
    dependencies,
    renderCalls,
    validateCalls,
    visionCalls,
    specification,
    budget,
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("Network access is not allowed in unit tests.");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* Request validation                                                  */
/* ------------------------------------------------------------------ */

describe("agent loop request validation", () => {
  it("rejects invalid iteration limits instead of silently clamping them", async () => {
    for (const maxIterations of [0, -1, 1.5, 5]) {
      const harness = createHarness({
        renderBehaviors: [{ type: "artifact" }],
        critiqueResponses: [approveJson()],
      });
      await expect(
        runAgentLoop(
          { jobId: "job-1", specification: harness.specification, maxIterations },
          harness.dependencies,
        ),
      ).rejects.toBeInstanceOf(AgentRequestError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an unusable job id and an invalid specification", async () => {
    const harness = createHarness({
      renderBehaviors: [{ type: "artifact" }],
      critiqueResponses: [approveJson()],
    });

    await expect(
      runAgentLoop({ jobId: "not a job id", specification: harness.specification }, harness.dependencies),
    ).rejects.toBeInstanceOf(AgentRequestError);

    await expect(
      runAgentLoop(
        {
          jobId: "job-1",
          specification: { ...harness.specification, composition: { width: 1 } },
        },
        harness.dependencies,
      ),
    ).rejects.toMatchObject({ code: "invalid-request" });
  });
});

/* ------------------------------------------------------------------ */
/* Happy paths                                                         */
/* ------------------------------------------------------------------ */

describe("agent loop outcomes", () => {
  it("passes on the first iteration and returns a browser-safe artifact", async () => {
    const harness = createHarness({
      renderBehaviors: [{ type: "artifact" }],
      critiqueResponses: [approveJson()],
    });

    const result = await runAgentLoop(
      { jobId: "job-1", specification: harness.specification },
      harness.dependencies,
    );

    expect(result.status).toBe("passed");
    expect(result.approved).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.failureReason).toBeNull();
    expect(result.validation).toEqual(MEDIA);
    expect(result.critiqueSummary).toMatchObject({ verdict: "approve", score: 8.5 });
    expect(harness.renderCalls).toHaveLength(1);
    expect(harness.validateCalls).toHaveLength(1);
    expect(harness.visionCalls).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();

    // "job-1" was not issued by the job API, so no preview link is advertised for it.
    expect(result.previewArtifact).toMatchObject({ kind: "local-file" });
    expect(result.previewArtifact?.previewPath).toBeUndefined();
    expect(result.previewArtifact?.url).toBeUndefined();
    expect(result.disclosures.join(" ")).toMatch(/job API/);
    expect(findLocalFilesystemPaths(result.previewArtifact)).toEqual([]);
    expect(findLocalFilesystemPaths(JSON.parse(JSON.stringify(result.previewArtifact)))).toEqual([]);
    expect(JSON.stringify(result.previewArtifact)).not.toContain("/tmp/");
  });

  it("repairs a deterministic rule violation and passes on a fresh render", async () => {
    const specification = createSpecification();
    const textLayer = firstTextLayer(specification);
    textLayer.layout.widthPercent = 99;
    textLayer.layout.xPercent = 99;

    const harness = createHarness({
      specification,
      renderBehaviors: [{ type: "artifact" }, { type: "artifact" }],
      critiqueResponses: [reviseJson({ code: "layout-safe-area" }), approveJson()],
    });

    const result = await runAgentLoop(
      { jobId: "job-1", specification: harness.specification },
      harness.dependencies,
    );

    expect(result.status).toBe("passed");
    expect(result.approved).toBe(true);
    expect(result.iterations).toBe(2);
    expect(harness.renderCalls).toHaveLength(2);
    expect(harness.validateCalls).toHaveLength(2);
    expect(harness.visionCalls).toHaveLength(2);

    // The second render used a repaired specification that satisfies the safe-area rule.
    const repaired = harness.renderCalls[1].specification;
    expect(repaired.scenes[0].layers[0].layout.widthPercent).toBeLessThanOrEqual(92);
    expect(repaired.scenes[0].layers[0].layout.xPercent).toBeLessThanOrEqual(96);
    expect(result.iterationsLog[0].repair).toMatchObject({
      providerId: "local-rules",
      appliedRuleIds: ["layout-safe-area"],
    });
    expect(result.iterationsLog[1].repair).toBeNull();
  });

  it("uses the configured AI repair provider only when local rules cannot fix the issue", async () => {
    const repairedSpecification = createSpecification();
    repairedSpecification.scenes[0].title = "عنوان مُصلَح";
    const proposal = vi.fn(async () => ({ specification: repairedSpecification }));
    const repairProvider: MotionRepairProvider = {
      id: STUB_REPAIR_PROVIDER_ID,
      modelId: STUB_MODEL_ID,
      isConfigured: true,
      propose: proposal,
    };

    const harness = createHarness({
      renderBehaviors: [{ type: "artifact" }, { type: "artifact" }],
      critiqueResponses: [reviseJson({ code: "content-no-placeholders", severity: "critical" }), approveJson()],
      repairProvider,
    });

    const result = await runAgentLoop(
      { jobId: "job-1", specification: harness.specification },
      harness.dependencies,
    );

    expect(proposal).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("passed");
    expect(result.iterationsLog[0].repair?.providerId).toBe(STUB_REPAIR_PROVIDER_ID);
    expect(harness.renderCalls[1].specification.scenes[0].title).toBe("عنوان مُصلَح");
  });
});

/* ------------------------------------------------------------------ */
/* Bounded iterations and terminal statuses                            */
/* ------------------------------------------------------------------ */

describe("agent loop bounds and statuses", () => {
  it("returns needs_review (never success) when the iteration limit is reached", async () => {
    const harness = createHarness({
      renderBehaviors: [{ type: "artifact" }, { type: "artifact" }],
      critiqueResponses: [reviseJson({ code: "layout-safe-area" })],
      config: { maxIterations: 2 },
    });

    const result = await runAgentLoop(
      { jobId: "job-1", specification: harness.specification },
      harness.dependencies,
    );

    expect(result.status).toBe("needs_review");
    expect(result.approved).toBe(false);
    expect(result.failureReason).toBe("max-iterations");
    expect(result.iterations).toBe(2);
    expect(harness.renderCalls).toHaveLength(2);
    expect(result.artifact).not.toBeNull();
    expect(result.critiqueSummary?.verdict).toBe("revise");
  });

  it("stops without re-rendering when no configured repair can fix the reported issues", async () => {
    const harness = createHarness({
      renderBehaviors: [{ type: "artifact" }],
      critiqueResponses: [reviseJson({ code: "content-no-placeholders", severity: "critical" })],
    });

    const result = await runAgentLoop(
      { jobId: "job-1", specification: harness.specification },
      harness.dependencies,
    );

    expect(result.status).toBe("needs_review");
    expect(result.approved).toBe(false);
    expect(result.failureReason).toBe("no-repairable-issues");
    expect(harness.renderCalls).toHaveLength(1);
    expect(result.iterationsLog[0].repair?.unrepairableRuleIds).toContain("content-no-placeholders");
  });

  it("fails when the first render fails and never claims approval", async () => {
    const harness = createHarness({
      renderBehaviors: [{ type: "error", message: "No Remotion browser is available." }],
      critiqueResponses: [approveJson()],
    });

    const result = await runAgentLoop(
      { jobId: "job-1", specification: harness.specification },
      harness.dependencies,
    );

    expect(result.status).toBe("failed");
    expect(result.approved).toBe(false);
    expect(result.failureReason).toBe("render-failed");
    expect(result.artifact).toBeNull();
    expect(result.previewArtifact).toBeNull();
    expect(harness.validateCalls).toHaveLength(0);
    expect(harness.visionCalls).toHaveLength(0);
    expect(result.errorMessage).toContain("browser");
  });
});

/* ------------------------------------------------------------------ */
/* Preservation of the last valid render                               */
/* ------------------------------------------------------------------ */

describe("agent loop preservation rules", () => {
  it("keeps the last valid render when the repair render fails", async () => {
    const harness = createHarness({
      renderBehaviors: [{ type: "artifact" }, { type: "error", message: "render crashed" }],
      critiqueResponses: [reviseJson({ code: "layout-safe-area" })],
    });

    const result = await runAgentLoop(
      { jobId: "job-1", specification: harness.specification },
      harness.dependencies,
    );

    expect(result.status).toBe("needs_review");
    expect(result.approved).toBe(false);
    expect(result.failureReason).toBe("render-failed");
    expect(result.artifact?.artifactId).toBe(createArtifact("job-1", "1").artifactId);
    expect(result.validation).toEqual(MEDIA);
    expect(result.disclosures.join(" ")).toMatch(/previously validated render is retained/i);
  });

  it("keeps the last valid render when the repair render fails the technical gate", async () => {
    const harness = createHarness({
      renderBehaviors: [{ type: "artifact" }, { type: "artifact" }],
      critiqueResponses: [reviseJson({ code: "layout-safe-area" })],
      validationBehavior: [MEDIA, new Error("ffprobe found no valid video stream.")],
    });

    const result = await runAgentLoop(
      { jobId: "job-1", specification: harness.specification },
      harness.dependencies,
    );

    expect(result.status).toBe("needs_review");
    expect(result.failureReason).toBe("validation-failed");
    expect(result.artifact?.artifactId).toBe(createArtifact("job-1", "1").artifactId);
    expect(result.errorMessage).toContain("ffprobe");
    expect(result.disclosures.join(" ")).toMatch(/technical ffprobe gate/i);
  });

  it("treats a technically valid render without a usable critique as needs_review", async () => {
    const harness = createHarness({
      renderBehaviors: [{ type: "artifact" }],
      critiqueResponses: [new Error("The vision provider answered HTTP 500.")],
    });

    const result = await runAgentLoop(
      { jobId: "job-1", specification: harness.specification },
      harness.dependencies,
    );

    expect(result.status).toBe("needs_review");
    expect(result.approved).toBe(false);
    expect(result.failureReason).toBe("critique-failed");
    expect(result.validation).toEqual(MEDIA);
    expect(result.artifact).not.toBeNull();
    expect(result.critiqueSummary?.verdict).toBe("unavailable");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a malformed critique instead of reading it as approval", async () => {
    const harness = createHarness({
      renderBehaviors: [{ type: "artifact" }],
      critiqueResponses: ["The frames look acceptable, but I will not produce JSON today."],
    });

    const result = await runAgentLoop(
      { jobId: "job-1", specification: harness.specification },
      harness.dependencies,
    );

    expect(result.status).toBe("needs_review");
    expect(result.approved).toBe(false);
    expect(result.failureReason).toBe("critique-failed");
    expect(result.iterationsLog[0].critique).toBeNull();
    expect(harness.renderCalls).toHaveLength(1);
  });

  it("reports needs_review when frame extraction fails after a valid render", async () => {
    const harness = createHarness({
      renderBehaviors: [{ type: "artifact" }],
      critiqueResponses: [approveJson()],
      frameBehavior: [new Error("The video has no readable frame in a sampled interval.")],
    });

    const result = await runAgentLoop(
      { jobId: "job-1", specification: harness.specification },
      harness.dependencies,
    );

    expect(result.status).toBe("needs_review");
    expect(result.failureReason).toBe("frame-extraction-failed");
    expect(result.approved).toBe(false);
    expect(result.artifact).not.toBeNull();
    expect(harness.visionCalls).toHaveLength(0);
  });

  it("keeps the last valid render when an AI repair violates the project identity", async () => {
    const tampered = createSpecification();
    tampered.project.id = "other-project";
    const repairProvider: MotionRepairProvider = {
      id: STUB_REPAIR_PROVIDER_ID,
      modelId: STUB_MODEL_ID,
      isConfigured: true,
      async propose() {
        return { specification: tampered };
      },
    };

    const harness = createHarness({
      renderBehaviors: [{ type: "artifact" }],
      critiqueResponses: [reviseJson({ code: "content-no-placeholders", severity: "critical" })],
      repairProvider,
    });

    const result = await runAgentLoop(
      { jobId: "job-1", specification: harness.specification },
      harness.dependencies,
    );

    expect(result.status).toBe("needs_review");
    expect(result.failureReason).toBe("repair-failed");
    expect(result.artifact?.artifactId).toBe(createArtifact("job-1", "1").artifactId);
    expect(harness.renderCalls).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Credentials, budget, cancellation, network policy                   */
/* ------------------------------------------------------------------ */

describe("agent loop controls", () => {
  it("reports missing vision credentials without rendering again or reserving budget", async () => {
    const harness = createHarness({
      renderBehaviors: [{ type: "artifact" }],
      critiqueResponses: [approveJson()],
      visionConfigured: false,
    });

    const result = await runAgentLoop(
      { jobId: "job-1", specification: harness.specification },
      harness.dependencies,
    );

    expect(result.status).toBe("needs_review");
    expect(result.failureReason).toBe("critique-failed");
    expect(result.approved).toBe(false);
    expect(result.errorMessage).toMatch(/vision provider is configured/i);
    expect(harness.visionCalls).toHaveLength(0);
    expect(harness.renderCalls).toHaveLength(1);
    expect(result.budget.activeReservations).toBe(0);
    expect(result.budget.dailyCommittedUsd).toBe(0);
  });

  it("refuses a paid critique when the cost cannot be determined, and settles nothing", async () => {
    const harness = createHarness({
      renderBehaviors: [{ type: "artifact" }],
      critiqueResponses: [approveJson()],
      priceBook: EMPTY_PRICE_BOOK,
    });

    const result = await runAgentLoop(
      { jobId: "job-1", specification: harness.specification },
      harness.dependencies,
    );

    expect(result.status).toBe("needs_review");
    expect(result.failureReason).toBe("budget-refused");
    expect(result.errorMessage).toMatch(/cannot be determined/i);
    expect(harness.visionCalls).toHaveLength(0);
    expect(result.budget.dailyCommittedUsd).toBe(0);
    expect(result.budget.activeReservations).toBe(0);
    expect(result.approved).toBe(false);
  });

  it("charges the estimate when the provider may have been reached, and discloses the limitation", async () => {
    const harness = createHarness({
      renderBehaviors: [{ type: "artifact" }],
      critiqueResponses: [new Error("The vision provider could not complete the critique.")],
    });

    const result = await runAgentLoop(
      { jobId: "job-1", specification: harness.specification },
      harness.dependencies,
    );

    expect(result.estimatedCostUsd).toBeGreaterThan(0);
    expect(result.budget.dailySettledUsd).toBeGreaterThan(0);
    expect(result.budget.activeReservations).toBe(0);
    expect(result.disclosures.join(" ")).toMatch(/process-local/i);
    expect(result.budget.invoiceGuarantee).toBe(false);
  });

  it("supports an approved per-task exception without exceeding the daily ceiling", async () => {
    const budget = new BudgetLedger({ policy: { dailyLimitUsd: 0.25, taskLimitUsd: 0.0000001 } });
    // The first reservation is tiny; the second iteration needs an approval the caller supplied.
    const harness = createHarness({
      renderBehaviors: [{ type: "artifact" }, { type: "artifact" }],
      critiqueResponses: [reviseJson({ code: "layout-safe-area" }), approveJson()],
      budget,
    });

    const result = await runAgentLoop(
      {
        jobId: "job-1",
        specification: harness.specification,
        approval: {
          kind: "user-approved-exception",
          approvedBy: "owner@example.com",
          maxUsd: 0.01,
          reason: "Owner approved a manual review above the per-task micro-limit.",
        },
      },
      harness.dependencies,
    );

    expect(result.status).toBe("passed");
    expect(result.budget.dailyCommittedUsd).toBeLessThanOrEqual(0.25);
  });

  it("cancels before rendering when the caller already aborted", async () => {
    const harness = createHarness({
      renderBehaviors: [{ type: "artifact" }],
      critiqueResponses: [approveJson()],
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled by caller"));

    const result = await runAgentLoop(
      { jobId: "job-1", specification: harness.specification, signal: controller.signal },
      harness.dependencies,
    );

    expect(result.status).toBe("cancelled");
    expect(result.approved).toBe(false);
    expect(result.failureReason).toBe("cancelled");
    expect(harness.renderCalls).toHaveLength(0);
    expect(result.artifact).toBeNull();
  });

  it("cancels when the caller aborts during the render", async () => {
    const harness = createHarness({
      renderBehaviors: [{ type: "artifact" }, { type: "artifact" }],
      critiqueResponses: [approveJson()],
    });
    const controller = new AbortController();

    const renderSpy = vi
      .spyOn(harness.dependencies.renderBackend, "render")
      .mockImplementationOnce(async (request: RenderBackendRequest) => {
        controller.abort(new Error("cancelled during render"));
        void request;
        throw new Error("The local render was cancelled.");
      });

    const result = await runAgentLoop(
      { jobId: "job-1", specification: harness.specification, signal: controller.signal },
      harness.dependencies,
    );

    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("cancelled");
    expect(result.failureReason).toBe("cancelled");
    expect(result.approved).toBe(false);
  });

  it("never touches the network during a full repair cycle", async () => {
    const specification = createSpecification();
    firstTextLayer(specification).style.color = "#F0F0F0";
    specification.composition.backgroundColor = "#FAFAFA";

    const harness = createHarness({
      specification,
      renderBehaviors: [{ type: "artifact" }, { type: "artifact" }],
      critiqueResponses: [reviseJson({ code: "typography-contrast" }), approveJson()],
    });

    const result = await runAgentLoop(
      { jobId: "job-1", specification: harness.specification },
      harness.dependencies,
    );

    expect(result.status).toBe("passed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(firstTextLayer(harness.renderCalls[1].specification).style.color).toBe("#101828");
  });

  it("projects artifacts without leaking internal paths", () => {
    const artifact = createArtifact(JOB_UUID, "7");
    const publicArtifact = toPublicArtifact(artifact);
    expect(publicArtifact.previewPath).toBe(`/api/agent/qa/${JOB_UUID}/preview`);
    expect(publicArtifact).not.toHaveProperty("absolutePath");
    expect(findLocalFilesystemPaths(publicArtifact)).toEqual([]);
    expect(JSON.stringify(publicArtifact)).not.toContain("/tmp/");

    // A job that was not created through the job API has no servable preview link at all.
    const foreignArtifact = toPublicArtifact(createArtifact("job-9", "8"));
    expect(foreignArtifact.previewPath).toBeUndefined();
    expect(findLocalFilesystemPaths(foreignArtifact)).toEqual([]);
  });
});
