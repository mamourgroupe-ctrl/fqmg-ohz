import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { getCritiqueRubricLines } from "@/agent/motion-rules";
import { redactSecrets, sanitizeDiagnosticText } from "@/agent/redaction";
import {
  MotionSpecificationSchema,
  type MotionSpecification,
} from "@/motion/schemas/motion-specification";
import type { RepairIssueInput } from "@/agent/local-repair-provider";

/**
 * AI repair provider (opt-in).
 *
 * The provider proposes a full Motion Specification. That proposal is UNTRUSTED: it is validated
 * against the existing Zod schema, and the integrity checks below refuse a "repair" that changes
 * the project identity, the canvas, the frame rate, or the total duration. Repairs therefore
 * cannot smuggle in a different project, a different resolution, executable code, or new asset
 * sources outside the schema's allow-list.
 */

export interface MotionRepairRequest {
  specification: MotionSpecification;
  issues: RepairIssueInput[];
  rubric: string[];
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface MotionRepairProvider {
  readonly id: string;
  readonly modelId: string;
  readonly isConfigured: boolean;
  propose(request: MotionRepairRequest): Promise<unknown>;
}

export type MotionRepairErrorCode =
  | "provider-unconfigured"
  | "provider-failed"
  | "provider-cancelled"
  | "invalid-candidate"
  | "integrity-violation";

export class MotionRepairError extends Error {
  constructor(
    readonly code: MotionRepairErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "MotionRepairError";
  }
}

export const REPAIR_CANDIDATE_SCHEMA = z.object({
  specification: MotionSpecificationSchema,
});

export function createDisabledMotionRepairProvider(modelId = "unconfigured"): MotionRepairProvider {
  return {
    id: "disabled",
    modelId,
    isConfigured: false,
    async propose(): Promise<never> {
      throw new MotionRepairError(
        "provider-unconfigured",
        "No repair provider is configured, so no AI repair was requested.",
      );
    },
  };
}

export interface GenerateObjectRepairOptions {
  id: string;
  modelId: string;
  model: LanguageModel;
  /** Test seam: defaults to the AI SDK `generateObject`. */
  generate?: typeof generateObject;
}

export function createGenerateObjectRepairProvider(
  options: GenerateObjectRepairOptions,
): MotionRepairProvider {
  const generate = options.generate ?? generateObject;

  return {
    id: options.id,
    modelId: options.modelId,
    isConfigured: true,

    async propose(request: MotionRepairRequest): Promise<unknown> {
      const prompt = [
        "You repair a data-only motion specification so that it satisfies the listed motion rules.",
        "Return the COMPLETE corrected specification. Do not change project.id, composition (aspect",
        "ratio, width, height, fps, durationInFrames), scene ids, or scene timing. Fix only what the",
        "issues require. Never add code, paths, credentials, or new asset sources.",
        "",
        "Motion rules:",
        getCritiqueRubricLines().join("\n"),
        "",
        "Reported issues:",
        request.issues
          .map(
            (issue) =>
              `- ${issue.code} [${issue.severity}]${issue.sceneId ? ` (scene ${issue.sceneId})` : ""}: ${issue.message}`,
          )
          .join("\n"),
        "",
        "Current specification:",
        JSON.stringify(request.specification),
      ].join("\n");

      try {
        const result = await generate({
          model: options.model,
          schema: REPAIR_CANDIDATE_SCHEMA,
          maxOutputTokens: request.maxOutputTokens,
          abortSignal: request.signal,
          prompt,
        });
        return (result as { object?: unknown }).object;
      } catch (error) {
        if (request.signal.aborted) {
          throw new MotionRepairError("provider-cancelled", "The AI repair was cancelled.");
        }
        throw new MotionRepairError(
          "provider-failed",
          "The AI repair provider could not propose a corrected specification.",
          sanitizeDiagnosticText(redactSecrets(error instanceof Error ? error.message : ""), []),
        );
      }
    },
  };
}

/**
 * Validates an untrusted repair proposal. Anything that changes the identity or the canvas of
 * the project is refused, because that would be a different video, not a repair.
 */
export function validateRepairCandidate(
  original: MotionSpecification,
  candidate: unknown,
): MotionSpecification {
  const raw =
    candidate !== null &&
    typeof candidate === "object" &&
    "specification" in (candidate as Record<string, unknown>)
      ? (candidate as { specification: unknown }).specification
      : candidate;

  const parsed = MotionSpecificationSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new MotionRepairError(
      "invalid-candidate",
      "The proposed repair does not satisfy the motion specification schema.",
      `${issue.path.join(".") || "specification"}: ${issue.message}`,
    );
  }

  const specification = parsed.data as MotionSpecification;

  if (specification.project.id !== original.project.id) {
    throw new MotionRepairError(
      "integrity-violation",
      "A repair must not replace the project identity.",
    );
  }
  if (specification.scenes.length !== original.scenes.length) {
    throw new MotionRepairError("integrity-violation", "A repair must not add or remove scenes.");
  }
  if (specification.scenes.some((scene, index) => scene.id !== original.scenes[index]?.id)) {
    throw new MotionRepairError(
      "integrity-violation",
      "A repair must not rename or reorder scenes.",
    );
  }

  // Assets must not be added or repointed: a "repair" must never introduce a new remote source.
  const originalAssets = new Map(original.assets.map((asset) => [asset.id, asset.source]));
  if (specification.assets.length !== original.assets.length) {
    throw new MotionRepairError("integrity-violation", "A repair must not add or remove assets.");
  }
  for (const asset of specification.assets) {
    const originalSource = originalAssets.get(asset.id);
    if (originalSource === undefined) {
      throw new MotionRepairError(
        "integrity-violation",
        "A repair must not introduce assets that were not part of the original project.",
      );
    }
    if (originalSource !== asset.source) {
      throw new MotionRepairError(
        "integrity-violation",
        "A repair must not repoint an existing asset to a different source.",
      );
    }
  }

  const compositionKeys = ["aspectRatio", "width", "height", "fps", "durationInFrames"] as const;
  for (const key of compositionKeys) {
    if (specification.composition[key] !== original.composition[key]) {
      throw new MotionRepairError(
        "integrity-violation",
        `A repair must not change composition.${key}.`,
      );
    }
  }

  return specification;
}
