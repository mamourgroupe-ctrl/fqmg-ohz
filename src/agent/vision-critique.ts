import { z } from "zod";
import {
  DEFAULT_IMAGE_LIMITS,
  detectImageMimeType,
  inspectImage,
  SUPPORTED_IMAGE_MIME_TYPES,
  ImageInspectionError,
  type ImageLimits,
  type SupportedImageMimeType,
} from "@/agent/image-inspection";
import { getCritiqueRubricLines, isKnownMotionRuleId, MotionRuleSeveritySchema } from "@/agent/motion-rules";
import { buildUsageEstimate, estimateCost, type CostEstimate, type PriceBook } from "@/agent/pricing";
import { redactSecrets, sanitizeDiagnosticText } from "@/agent/redaction";

/**
 * Visual critique of extracted frames.
 *
 * The provider is replaceable, its output is treated as untrusted (Zod-validated, verdict and
 * issue codes checked for internal consistency), no external call happens unless a provider is
 * explicitly configured, and every error is redacted before it can reach a log or a response.
 */

export const VISION_PROMPT_LANGUAGE_DEFAULT = "en" as const;

export const MAX_VISION_IMAGES = 6;
export const MAX_VISION_PAYLOAD_BYTES = 6 * 1024 * 1024;

/** Arbitrary extra code allowed for issues that no rule covers. */
export const OTHER_ISSUE_CODE = "other";

export const VisionIssueSchema = z.object({
  code: z.string().min(2).max(48),
  severity: MotionRuleSeveritySchema,
  frameIndex: z.number().int().min(0).max(63).optional(),
  sceneId: z.string().min(1).max(64).optional(),
  message: z.string().min(4).max(300),
});

export const VisionCritiqueSchema = z
  .object({
    verdict: z.enum(["approve", "revise"]),
    score: z.number().finite().min(0).max(10),
    issues: z.array(VisionIssueSchema).max(12),
    summary: z.string().min(4).max(600),
  })
  .superRefine((critique, ctx) => {
    for (let index = 0; index < critique.issues.length; index += 1) {
      const issue = critique.issues[index];
      if (issue.code !== OTHER_ISSUE_CODE && !isKnownMotionRuleId(issue.code)) {
        ctx.addIssue({
          code: "custom",
          path: ["issues", index, "code"],
          message: "Issue codes must reference a known motion rule or the 'other' code.",
        });
      }
    }

    if (critique.verdict === "approve") {
      const critical = critique.issues.filter((issue) => issue.severity === "critical");
      if (critical.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["verdict"],
          message: "A critique cannot approve a render while critical issues remain.",
        });
      }
      if (critique.score < 7) {
        ctx.addIssue({
          code: "custom",
          path: ["score"],
          message: "An approving critique needs a score of at least 7.",
        });
      }
    }

    if (critique.verdict === "revise" && critique.issues.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["issues"],
        message: "A revise verdict must list at least one issue.",
      });
    }
  });

export type VisionCritique = z.infer<typeof VisionCritiqueSchema>;
export type VisionIssue = z.infer<typeof VisionIssueSchema>;

export interface CritiqueFrame {
  index: number;
  bytes: Buffer;
  width: number;
  height: number;
  timestampSeconds: number;
  sha256: string;
}

export interface VisionPayloadFrame {
  index: number;
  mimeType: SupportedImageMimeType;
  dataUrl: string;
  width: number;
  height: number;
  timestampSeconds: number;
  sha256: string;
}

export interface VisionProviderRequest {
  frames: VisionPayloadFrame[];
  rubric: string[];
  prompt: string;
  maxOutputTokens: number;
  signal: AbortSignal;
}

/** Providers return untrusted text or objects; validation happens in this module. */
export interface VisionProvider {
  readonly id: string;
  readonly modelId: string;
  readonly isConfigured: boolean;
  critique(request: VisionProviderRequest): Promise<unknown>;
}

export type VisionCritiqueErrorCode =
  | "provider-unconfigured"
  | "provider-failed"
  | "provider-timeout"
  | "provider-cancelled"
  | "invalid-response"
  | "invalid-image"
  | "too-many-images"
  | "payload-too-large";

export class VisionCritiqueError extends Error {
  constructor(
    readonly code: VisionCritiqueErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "VisionCritiqueError";
  }
}

export interface CritiqueLimits extends ImageLimits {
  maxImages: number;
  maxPayloadBytes: number;
}

export const DEFAULT_CRITIQUE_LIMITS: CritiqueLimits = {
  ...DEFAULT_IMAGE_LIMITS,
  maxImages: MAX_VISION_IMAGES,
  maxPayloadBytes: MAX_VISION_PAYLOAD_BYTES,
};

export interface CritiqueRequest {
  frames: CritiqueFrame[];
  provider: VisionProvider;
  rubric?: string[];
  language?: string;
  maxOutputTokens: number;
  timeoutMs: number;
  limits?: Partial<CritiqueLimits>;
  signal?: AbortSignal;
}

export interface CritiqueOutcome {
  critique: VisionCritique;
  providerId: string;
  modelId: string;
  frameCount: number;
  payloadBytes: number;
  durationMs: number;
  /** The exact frame bytes the critique was based on. */
  frameHashes: string[];
}

export function getVisionInstruction(language: string = VISION_PROMPT_LANGUAGE_DEFAULT): string {
  return [
    "You are a motion-graphics visual QA reviewer. You receive frames sampled evenly from one rendered video.",
    `The video's language is ${language}.`,
    "Judge only what is visible in the frames: legibility, contrast, safe-area clipping, text overflow,",
    "empty or placeholder scenes, competing focal points, and whether the composition reaches a conclusion.",
    "",
    "Answer with ONE JSON object and nothing else:",
    '{"verdict":"approve"|"revise","score":0-10,"issues":[{"code":"<rule id>","severity":"critical"|"major"|"minor","frameIndex":0,"message":"..."}],"summary":"..."}',
    "",
    "Rules:",
    "- issue codes must be one of the rule ids listed below, or \"other\";",
    "- a critical issue can never be approved;",
    "- verdict \"approve\" requires score >= 7 and no critical issues;",
    "- verdict \"revise\" must include at least one issue;",
    "- never invent content that is not visible in the frames.",
  ].join("\n");
}

export function getVisionRubric(rubric: string[] = getCritiqueRubricLines()): string {
  return rubric.join("\n");
}

/** Deterministic prompt text, reused by the cost estimator so both stay in step. */
export function buildVisionPromptText(rubric: string[], language: string): string {
  return `${getVisionInstruction(language)}\n\nMotion rules:\n${getVisionRubric(rubric)}`;
}

export function estimateVisionCritiqueCost(input: {
  priceBook: PriceBook;
  providerId: string;
  modelId: string;
  frames: Array<{ width: number; height: number }>;
  rubric?: string[];
  language?: string;
  maxOutputTokens: number;
}): CostEstimate | undefined {
  const usage = buildUsageEstimate({
    imagePixels: input.frames,
    promptText: buildVisionPromptText(
      input.rubric ?? getCritiqueRubricLines(),
      input.language ?? VISION_PROMPT_LANGUAGE_DEFAULT,
    ),
    maxOutputTokens: input.maxOutputTokens,
  });

  return estimateCost({
    priceBook: input.priceBook,
    providerId: input.providerId,
    modelId: input.modelId,
    usage,
  });
}

function toDataUrl(mimeType: SupportedImageMimeType, bytes: Buffer): string {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

/** Validates and encodes the frames into the exact payload a provider would receive. */
export function buildVisionPayload(
  frames: readonly CritiqueFrame[],
  limits: CritiqueLimits = DEFAULT_CRITIQUE_LIMITS,
): { frames: VisionPayloadFrame[]; payloadBytes: number } {
  if (frames.length === 0) {
    throw new VisionCritiqueError("invalid-image", "At least one frame is required for a critique.");
  }
  if (frames.length > limits.maxImages) {
    throw new VisionCritiqueError(
      "too-many-images",
      `A critique accepts at most ${limits.maxImages} frames.`,
    );
  }

  let payloadBytes = 0;
  const payloadFrames: VisionPayloadFrame[] = [];

  for (const frame of frames) {
    if (!Buffer.isBuffer(frame.bytes)) {
      throw new VisionCritiqueError("invalid-image", "Frame bytes must be a Buffer.");
    }

    let inspected;
    try {
      inspected = inspectImage(frame.bytes, limits);
    } catch (error) {
      throw new VisionCritiqueError(
        "invalid-image",
        error instanceof ImageInspectionError
          ? error.message
          : "The frame could not be validated.",
      );
    }

    const mimeType = detectImageMimeType(frame.bytes);
    if (!mimeType) {
      throw new VisionCritiqueError(
        "invalid-image",
        `Frames must be ${SUPPORTED_IMAGE_MIME_TYPES.join(" or ")}.`,
      );
    }

    const dataUrl = toDataUrl(mimeType, frame.bytes);
    payloadBytes += dataUrl.length;
    if (payloadBytes > limits.maxPayloadBytes) {
      throw new VisionCritiqueError(
        "payload-too-large",
        `The frame payload exceeds the ${limits.maxPayloadBytes}-byte limit.`,
      );
    }

    payloadFrames.push({
      index: frame.index,
      mimeType,
      dataUrl,
      width: inspected.width,
      height: inspected.height,
      timestampSeconds: frame.timestampSeconds,
      sha256: frame.sha256,
    });
  }

  return { frames: payloadFrames, payloadBytes };
}

/**
 * Extracts the first complete JSON object from model output.
 * Providers sometimes wrap JSON in prose or code fences; anything else is rejected.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      // Fall through to balanced-brace extraction.
    }
  }

  const start = trimmed.indexOf("{");
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, index + 1)) as unknown;
        } catch {
          return undefined;
        }
      }
    }
  }

  return undefined;
}

/** Provider output → validated critique. Never returns partial or guessed data. */
export function parseVisionCritique(raw: unknown): VisionCritique {
  let candidate: unknown = raw;

  if (typeof raw === "string") {
    candidate = extractJsonObject(raw);
    if (candidate === undefined) {
      throw new VisionCritiqueError(
        "invalid-response",
        "The vision provider did not return a readable JSON object.",
      );
    }
  }

  const parsed = VisionCritiqueSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new VisionCritiqueError(
      "invalid-response",
      "The vision provider returned a critique that does not satisfy the review contract.",
      `${issue.path.join(".") || "critique"}: ${issue.message}`,
    );
  }

  return parsed.data;
}

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): Promise<T> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(new Error("cancelled"));
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  if (externalSignal?.aborted) controller.abort(new Error("cancelled"));

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancelListener: (() => void) | undefined;

  // The race is what actually bounds the call: aborting the signal only helps providers that
  // observe it, whereas a provider that ignores its signal must not be able to hang the loop.
  const timeoutRejection = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort(new Error("timeout"));
      reject(new Error("timeout"));
    }, timeoutMs);
  });

  const cancellationRejection = new Promise<never>((_resolve, reject) => {
    if (!externalSignal) return;
    cancelListener = () => {
      controller.abort(new Error("cancelled"));
      reject(new Error("cancelled"));
    };
    if (externalSignal.aborted) cancelListener();
    else externalSignal.addEventListener("abort", cancelListener, { once: true });
  });

  try {
    return await Promise.race([run(controller.signal), timeoutRejection, cancellationRejection]);
  } catch (error) {
    if (externalSignal?.aborted) {
      throw new VisionCritiqueError("provider-cancelled", "The visual critique was cancelled.");
    }
    if (controller.signal.aborted) {
      throw new VisionCritiqueError(
        "provider-timeout",
        `The vision provider did not answer within ${timeoutMs}ms.`,
        sanitizeDiagnosticText(error instanceof Error ? error.message : "", []),
      );
    }
    if (error instanceof VisionCritiqueError) throw error;
    throw new VisionCritiqueError(
      "provider-failed",
      "The vision provider could not complete the critique.",
      sanitizeDiagnosticText(redactSecrets(error instanceof Error ? error.message : ""), []),
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    if (cancelListener) {
      externalSignal?.removeEventListener("abort", cancelListener);
    }
  }
}

export async function critiqueFrames(request: CritiqueRequest): Promise<CritiqueOutcome> {
  const limits: CritiqueLimits = { ...DEFAULT_CRITIQUE_LIMITS, ...request.limits };
  const rubric = request.rubric ?? getCritiqueRubricLines();
  const language = request.language ?? VISION_PROMPT_LANGUAGE_DEFAULT;

  if (!request.provider.isConfigured) {
    throw new VisionCritiqueError(
      "provider-unconfigured",
      "No vision provider is configured, so a visual critique cannot be produced.",
    );
  }

  const { frames, payloadBytes } = buildVisionPayload(request.frames, limits);

  if (request.signal?.aborted) {
    throw new VisionCritiqueError("provider-cancelled", "The visual critique was cancelled.");
  }

  const startedAt = Date.now();
  const raw = await withTimeout(
    (signal) =>
      request.provider.critique({
        frames,
        rubric,
        prompt: buildVisionPromptText(rubric, language),
        maxOutputTokens: request.maxOutputTokens,
        signal,
      }),
    request.timeoutMs,
    request.signal,
  );

  const critique = parseVisionCritique(raw);

  return {
    critique,
    providerId: request.provider.id,
    modelId: request.provider.modelId,
    frameCount: frames.length,
    payloadBytes,
    durationMs: Date.now() - startedAt,
    frameHashes: frames.map((frame) => frame.sha256),
  };
}
