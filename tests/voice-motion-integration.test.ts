import { describe, expect, it } from "vitest";
import previewSpecification from "../templates/phase-one-preview.json";
import { MotionSpecificationSchema } from "@/motion/schemas/motion-specification";
import { RemotionAdapter } from "@/render/remotion/remotion-adapter";
import { applyVoiceResultToMotionSpecification } from "@/voice/project/apply-voice-to-motion-specification";
import { VoiceSynthesisResultSchema, type VoiceSynthesisResult } from "@/voice/contracts/voice-contract";

const baseSpecification = MotionSpecificationSchema.parse(previewSpecification);

function result(overrides: Partial<VoiceSynthesisResult> = {}): VoiceSynthesisResult {
  return VoiceSynthesisResultSchema.parse({
    projectId: baseSpecification.project.id,
    requestedProvider: "openai",
    usedProviderId: "openai",
    selectedVoice: {
      providerId: "openai",
      voiceId: "fixture-voice",
      voiceName: "Fixture voice",
      modelId: "gpt-4o-mini-tts",
      languageTag: "en-US",
      matchedLocaleTag: "en-US",
      capabilityConfidence: "exact-locale-inventory",
      selectedAt: "2026-10-09T12:00:00.000Z",
    },
    audio: {
      id: "9a95aa98-50e0-4b36-979d-8f59a20809db",
      href: "/api/voice/audio/9a95aa98-50e0-4b36-979d-8f59a20809db",
      mimeType: "audio/mpeg",
      sizeBytes: 1_024,
    },
    cacheHit: false,
    latencyMs: 220,
    disclosures: [],
    completedAt: "2026-10-09T12:00:01.000Z",
    ...overrides,
  });
}

describe("voice result and Motion Specification integration", () => {
  it("preserves the Phase 1 preview while attaching a safe managed audio asset and voice track", () => {
    expect(new RemotionAdapter().assess(baseSpecification).supported).toBe(true);
    expect(baseSpecification.audio.voiceSelection).toBeUndefined();

    const updated = applyVoiceResultToMotionSpecification(
      baseSpecification,
      result(),
      { startFrame: 0, durationInFrames: 60, gain: 0.9 },
    );

    expect(MotionSpecificationSchema.safeParse(updated).success).toBe(true);
    expect(updated.assets.at(-1)).toMatchObject({
      kind: "audio",
      source: "/api/voice/audio/9a95aa98-50e0-4b36-979d-8f59a20809db",
      mimeType: "audio/mpeg",
      licenseStatus: "generated",
    });
    expect(updated.audio.tracks.at(-1)).toMatchObject({
      role: "voice",
      startFrame: 0,
      durationInFrames: 60,
      gain: 0.9,
      voiceSelection: { providerId: "openai", voiceId: "fixture-voice" },
    });
    expect(updated.audio.voiceSelection?.voiceId).toBe("fixture-voice");

    const assessment = new RemotionAdapter().assess(updated);
    expect(assessment.supported).toBe(false);
    expect(assessment.reasons.join(" ")).toContain("Audio mixing");
  });

  it("requires explicit confirmation before replacing the project voice pin", () => {
    const first = applyVoiceResultToMotionSpecification(
      baseSpecification,
      result(),
      { startFrame: 0, durationInFrames: 60 },
    );
    const alternate = result({
      audio: {
        id: "367554c9-5322-4682-a8c3-67dd61ce3ad0",
        href: "/api/voice/audio/367554c9-5322-4682-a8c3-67dd61ce3ad0",
        mimeType: "audio/mpeg",
        sizeBytes: 2_048,
      },
      selectedVoice: {
        ...result().selectedVoice,
        voiceId: "alternate-fixture-voice",
        voiceName: "Alternate fixture voice",
      },
    });

    expect(() => applyVoiceResultToMotionSpecification(
      first,
      alternate,
      { startFrame: 60, durationInFrames: 60 },
    )).toThrow("explicit confirmation");

    const changed = applyVoiceResultToMotionSpecification(
      first,
      alternate,
      { startFrame: 60, durationInFrames: 60, allowVoiceChange: true },
    );
    expect(changed.audio.tracks).toHaveLength(2);
    expect(changed.audio.tracks[0].voiceSelection?.voiceId).toBe("fixture-voice");
    expect(changed.audio.voiceSelection?.voiceId).toBe("alternate-fixture-voice");
  });

  it("rejects project mismatches, out-of-range timing, and non-managed audio references", () => {
    expect(() => applyVoiceResultToMotionSpecification(
      baseSpecification,
      result({ projectId: "another-project" }),
      { startFrame: 0, durationInFrames: 60 },
    )).toThrow("does not match");
    expect(() => applyVoiceResultToMotionSpecification(
      baseSpecification,
      result(),
      { startFrame: baseSpecification.composition.durationInFrames, durationInFrames: 60 },
    )).toThrow();
    expect(MotionSpecificationSchema.safeParse({
      ...baseSpecification,
      assets: [...baseSpecification.assets, {
        id: "unsafe-audio",
        name: "Unsafe",
        kind: "audio",
        source: "/api/voice/audio/../../private.mp3",
        mimeType: "audio/mpeg",
        licenseStatus: "generated",
      }],
    }).success).toBe(false);
  });
});
