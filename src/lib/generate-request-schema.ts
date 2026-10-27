import { z } from "zod";
import {
  DEFAULT_IMAGE_LIMITS,
  ImageInspectionError,
  inspectImage,
  type ImageLimits,
} from "@/agent/image-inspection";

/**
 * Input contract for POST /api/generate (phase 2).
 *
 * The request body is untrusted client input: it is size-capped through
 * readBoundedJson in the route, shape-checked here, and every attached image
 * is inspected for its real container format and dimensions with the same
 * image-inspection module the visual QA loop uses. Limits are deliberately
 * more generous than the QA defaults because users attach photos and
 * screenshots, but every limit is enforced server-side (the client-side
 * checks in useImageAttachments are UX only, never a security boundary).
 */

export const GENERATE_MAX_REQUEST_BYTES = 32 * 1024 * 1024;

export const GENERATE_IMAGE_LIMITS: ImageLimits = {
  ...DEFAULT_IMAGE_LIMITS,
  maxWidth: 4_096,
  maxHeight: 4_096,
  /** The chat UI offers up to 4 attachments for the current message. */
  maxImages: 4,
};

/** frameImages plus every image in the conversation history, per request. */
export const GENERATE_MAX_TOTAL_IMAGES = 8;

const IMAGE_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/;

/**
 * A data URL string. The declared type and the actual bytes are checked
 * separately: the regex here keeps absurd payloads out of the schema pass,
 * and inspectImage verifies the magic bytes and dimensions for real.
 */
const ImageDataUrlSchema = z
  .string()
  .max(3_100_000)
  .refine((value) => IMAGE_DATA_URL_PATTERN.test(value), {
    message: "Attached images must be base64 data URLs of PNG or JPEG images.",
  });

export const GenerateRequestSchema = z
  .object({
    prompt: z.string().min(1).max(16_000),
    model: z.string().max(200).optional(),
    currentCode: z.string().max(120_000).optional(),
    conversationHistory: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string().max(20_000),
          attachedImages: z.array(ImageDataUrlSchema).max(2).optional(),
        }),
      )
      .max(12)
      .optional(),
    isFollowUp: z.boolean().optional(),
    hasManualEdits: z.boolean().optional(),
    errorCorrection: z
      .object({
        error: z.string().max(4_000),
        attemptNumber: z.number().int().min(0).max(50),
        maxAttempts: z.number().int().min(1).max(50),
        failedEdit: z
          .object({
            description: z.string().max(500),
            old_string: z.string().max(20_000),
            new_string: z.string().max(20_000),
          })
          .optional(),
        currentCodeAfterEdits: z.string().max(120_000).optional(),
      })
      .optional(),
    previouslyUsedSkills: z.array(z.string().max(64)).max(16).optional(),
    frameImages: z.array(ImageDataUrlSchema).max(GENERATE_IMAGE_LIMITS.maxImages).optional(),
    excludedModels: z.array(z.string().max(200)).max(16).optional(),
  })
  .superRefine((value, ctx) => {
    const totalImages =
      (value.frameImages?.length ?? 0) +
      (value.conversationHistory ?? []).reduce(
        (sum, message) => sum + (message.attachedImages?.length ?? 0),
        0,
      );
    if (totalImages > GENERATE_MAX_TOTAL_IMAGES) {
      ctx.addIssue({
        code: "custom",
        path: ["frameImages"],
        message: `At most ${GENERATE_MAX_TOTAL_IMAGES} images are allowed per request across the message and the conversation history.`,
      });
    }
  });

export type GenerateRequestBody = z.infer<typeof GenerateRequestSchema>;

export class GenerateImageValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GenerateImageValidationError";
  }
}

const PUBLIC_IMAGE_ERROR_MESSAGES: Record<string, string> = {
  "unsupported-format": "Attached images must be PNG or JPEG images.",
  "too-large": `An attached image exceeds the ${GENERATE_IMAGE_LIMITS.maxBytes / (1024 * 1024)} MB size limit.`,
  "too-small": "An attached image is too small to be useful.",
  "unreadable-dimensions": "An attached image could not be read as a valid PNG or JPEG image.",
  empty: "An attached image is empty.",
};

function validateGenerateImage(dataUrl: string): void {
  const match = IMAGE_DATA_URL_PATTERN.exec(dataUrl);
  if (!match) {
    throw new GenerateImageValidationError(
      "unsupported-format",
      PUBLIC_IMAGE_ERROR_MESSAGES["unsupported-format"],
    );
  }
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bytes = Buffer.from(base64, "base64");
  try {
    inspectImage(bytes, GENERATE_IMAGE_LIMITS);
  } catch (error) {
    if (error instanceof ImageInspectionError) {
      throw new GenerateImageValidationError(
        error.code,
        PUBLIC_IMAGE_ERROR_MESSAGES[error.code] ??
          "An attached image could not be accepted.",
      );
    }
    throw error;
  }
}

/** Inspects every image in the request (frame images + history attachments). */
export function validateGenerateRequestImages(request: GenerateRequestBody): void {
  for (const image of request.frameImages ?? []) {
    validateGenerateImage(image);
  }
  for (const message of request.conversationHistory ?? []) {
    for (const image of message.attachedImages ?? []) {
      validateGenerateImage(image);
    }
  }
}
