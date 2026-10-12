import { describe, expect, it } from "vitest";
import previewSpecification from "../templates/phase-one-preview.json";
import { VoiceSynthesisApiRequestSchema } from "@/voice/api/request-schema";
import { readBoundedJson, VoiceRequestBodyError } from "@/voice/api/read-bounded-json";
import { MotionSpecificationSchema } from "@/motion/schemas/motion-specification";
import { GET as getManagedVoiceAudio } from "@/app/api/voice/audio/[id]/route";

const specification = MotionSpecificationSchema.parse(previewSpecification);

function apiRequest(overrides: Record<string, unknown> = {}) {
  return {
    synthesis: {
      projectId: specification.project.id,
      text: "  API narration test.  ",
      languageTag: "en-us",
    },
    motionSpecification: specification,
    placement: { startFrame: 0, durationInFrames: 30 },
    ...overrides,
  };
}

describe("voice API request safety", () => {
  it("validates a synthesis and optional project attachment envelope", () => {
    const parsed = VoiceSynthesisApiRequestSchema.parse(apiRequest());
    expect(parsed.synthesis.text).toBe("API narration test.");
    expect(parsed.synthesis.languageTag).toBe("en-US");
    expect(parsed.placement?.durationInFrames).toBe(30);
  });

  it("requires the Motion Specification and placement together and rejects mismatched projects or timing", () => {
    expect(VoiceSynthesisApiRequestSchema.safeParse(apiRequest({ placement: undefined })).success).toBe(false);
    expect(VoiceSynthesisApiRequestSchema.safeParse(apiRequest({
      synthesis: { ...apiRequest().synthesis, projectId: "another-project" },
    })).success).toBe(false);
    expect(VoiceSynthesisApiRequestSchema.safeParse(apiRequest({
      placement: { startFrame: specification.composition.durationInFrames, durationInFrames: 1 },
    })).success).toBe(false);
  });

  it("requires explicit confirmation when a request changes the saved provider or voice", () => {
    const selection = {
      providerId: "openai",
      voiceId: "fixture-voice",
      modelId: "fixture-model",
      languageTag: "en-US",
      capabilityConfidence: "manual-unverified",
      selectedAt: "2026-10-09T12:00:00.000Z",
    };
    const pinnedSpecification = MotionSpecificationSchema.parse({
      ...specification,
      audio: { ...specification.audio, voiceSelection: selection },
    });

    expect(VoiceSynthesisApiRequestSchema.safeParse(apiRequest({
      motionSpecification: pinnedSpecification,
      synthesis: { ...apiRequest().synthesis, provider: "elevenlabs" },
    })).success).toBe(false);
    expect(VoiceSynthesisApiRequestSchema.safeParse(apiRequest({
      motionSpecification: pinnedSpecification,
      synthesis: { ...apiRequest().synthesis, provider: "openai", voiceId: "other-voice" },
    })).success).toBe(false);
    expect(VoiceSynthesisApiRequestSchema.safeParse(apiRequest({
      motionSpecification: pinnedSpecification,
      synthesis: { ...apiRequest().synthesis, provider: "openai", voiceId: "other-voice" },
      placement: { startFrame: 0, durationInFrames: 30, allowVoiceChange: true },
    })).success).toBe(true);
  });

  it("does not resolve malformed IDs as filesystem paths on the managed-audio route", async () => {
    const response = await getManagedVoiceAudio(
      new Request("https://example.test/api/voice/audio/not-a-uuid"),
      { params: Promise.resolve({ id: "../../project-voices.json" }) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "AUDIO_NOT_FOUND", retryable: false },
    });
  });

  it("rejects simple form content types to reduce cross-site synthesis requests", async () => {
    const request = new Request("https://example.test/api/voice/synthesize", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    await expect(readBoundedJson(request, 100)).rejects.toMatchObject<Partial<VoiceRequestBodyError>>({
      kind: "unsupported-content-type",
    });
  });

  it("bounds request bytes and returns no parser details for malformed JSON", async () => {
    const tooLarge = new Request("https://example.test/api/voice/synthesize", {
      method: "POST",
      headers: { "content-length": "100", "content-type": "application/json" },
      body: "{}",
    });
    await expect(readBoundedJson(tooLarge, 10)).rejects.toMatchObject<Partial<VoiceRequestBodyError>>({ kind: "too-large" });

    const invalidJson = new Request("https://example.test/api/voice/synthesize", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: "{not-json}",
    });
    await expect(readBoundedJson(invalidJson, 100)).rejects.toMatchObject<Partial<VoiceRequestBodyError>>({ kind: "invalid-json" });

    const validJson = new Request("https://example.test/api/voice/synthesize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });
    await expect(readBoundedJson(validJson, 100)).resolves.toEqual({ ok: true });
  });
});
