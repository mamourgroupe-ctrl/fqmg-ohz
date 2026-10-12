import { NextResponse } from "next/server";
import {
  VoiceApiErrorSchema,
  VoiceSynthesisResultSchema,
  type VoiceApiErrorCode,
} from "@/voice/contracts/voice-contract";
import { VoiceSynthesisApiRequestSchema } from "@/voice/api/request-schema";
import { readBoundedJson, VoiceRequestBodyError } from "@/voice/api/read-bounded-json";
import { applyVoiceResultToMotionSpecification } from "@/voice/project/apply-voice-to-motion-specification";
import { VoiceEngineError } from "@/voice/routing/voice-engine";
import { getVoiceEngine } from "@/voice/runtime";

export const runtime = "nodejs";

const MAX_VOICE_REQUEST_BYTES = 1024 * 1024;

function errorResponse(
  code: VoiceApiErrorCode,
  message: string,
  status: number,
  retryable = false,
) {
  return NextResponse.json(VoiceApiErrorSchema.parse({
    error: { code, message, retryable },
  }), { status });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await readBoundedJson(request, MAX_VOICE_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof VoiceRequestBodyError && error.kind === "too-large") {
      return errorResponse("INVALID_REQUEST", "Voice request body exceeds the 1 MB limit.", 413);
    }
    if (error instanceof VoiceRequestBodyError && error.kind === "unsupported-content-type") {
      return errorResponse("INVALID_REQUEST", "Voice requests must use an application/json content type.", 415);
    }
    return errorResponse("INVALID_REQUEST", "Voice request body must be valid UTF-8 JSON.", 400);
  }

  const parsed = VoiceSynthesisApiRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_REQUEST", "The voice request did not pass validation.", 400);
  }

  const { synthesis, motionSpecification, placement } = parsed.data;
  const engine = getVoiceEngine();

  try {
    const outcome = await engine.synthesize(synthesis, {
      projectVoiceSelection: motionSpecification?.audio.voiceSelection,
    });
    const result = VoiceSynthesisResultSchema.parse({
      projectId: outcome.projectId,
      requestedProvider: outcome.request.provider,
      usedProviderId: outcome.providerId,
      selectedVoice: outcome.selection,
      audio: outcome.audioReference,
      cacheHit: outcome.cacheHit,
      latencyMs: outcome.latencyMs,
      fallback: outcome.fallback,
      disclosures: outcome.disclosures,
      completedAt: outcome.completedAt,
    });

    let updatedSpecification;
    if (motionSpecification && placement) {
      updatedSpecification = applyVoiceResultToMotionSpecification(
        motionSpecification,
        result,
        {
          ...placement,
          allowVoiceChange: placement.allowVoiceChange || Boolean(outcome.fallback),
        },
      );
    }

    return NextResponse.json({
      result,
      motionSpecification: updatedSpecification,
    }, { status: 200 });
  } catch (error) {
    if (error instanceof VoiceEngineError) {
      return errorResponse(error.code, error.message, error.status, error.retryable);
    }
    return errorResponse("INTERNAL_ERROR", "The voice engine could not complete the request.", 500);
  }
}
