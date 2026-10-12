import { describe, expect, it } from "vitest";
import {
  VoiceAudioReferenceSchema,
  VoiceProfileSchema,
  VoiceSynthesisRequestSchema,
  VoiceSynthesisResultSchema,
} from "@/voice/contracts/voice-contract";

describe("provider-independent voice contract", () => {
  it("canonicalizes locale and normalizes speech text", () => {
    const parsed = VoiceSynthesisRequestSchema.parse({
      projectId: "project_1",
      text: "  مرحبا  \r\n   بالعالم  ",
      languageTag: "ar-dz",
    });

    expect(parsed.languageTag).toBe("ar-DZ");
    expect(parsed.text).toBe("مرحبا\nبالعالم");
    expect(parsed.provider).toBe("auto");
    expect(parsed.speakingRate).toBe(1);
    expect(parsed.outputFormat).toBe("mp3");
  });

  it("normalizes canonically equivalent Unicode before synthesis", () => {
    const parsed = VoiceSynthesisRequestSchema.parse({
      projectId: "project-2",
      text: "Cafe\u0301",
      languageTag: "fr-fr",
    });

    expect(parsed.text).toBe("Café");
    expect(parsed.languageTag).toBe("fr-FR");
  });

  it("rejects blank text, malformed locales, unsafe project IDs, and AUTO plus a pinned voice", () => {
    const base = { projectId: "project-3", text: "hello", languageTag: "en-US" };
    expect(VoiceSynthesisRequestSchema.safeParse({ ...base, text: " \r\n " }).success).toBe(false);
    expect(VoiceSynthesisRequestSchema.safeParse({ ...base, languageTag: "not a locale" }).success).toBe(false);
    expect(VoiceSynthesisRequestSchema.safeParse({ ...base, projectId: "../other" }).success).toBe(false);
    expect(VoiceSynthesisRequestSchema.safeParse({ ...base, voiceId: "voice-123" }).success).toBe(false);
  });

  it("rejects unsupported contract fields and out-of-range normalized options", () => {
    const base = { projectId: "project-4", text: "hello", languageTag: "en" };
    expect(VoiceSynthesisRequestSchema.safeParse({ ...base, debug: true }).success).toBe(false);
    expect(VoiceSynthesisRequestSchema.safeParse({ ...base, speakingRate: 2 }).success).toBe(false);
    expect(VoiceSynthesisRequestSchema.safeParse({ ...base, outputFormat: "wav" }).success).toBe(false);
  });

  it("validates normalized provider inventory metadata without inventing capabilities", () => {
    const voice = VoiceProfileSchema.parse({
      providerId: "azure-speech",
      voiceId: "configured-voice",
      displayName: "Configured voice",
      languageTags: ["ar"],
      localeTags: [],
      verifiedLanguageTags: ["ar"],
      verifiedDialects: [],
      styles: [],
      evidenceSource: "account-inventory",
    });

    expect(voice.languageTags).toEqual(["ar"]);
    expect(voice.localeTags).toEqual([]);
    expect(voice.verifiedLanguageTags).toEqual(["ar"]);
  });

  it("accepts only an opaque managed audio route and matching UUID", () => {
    const id = "8c46cc6f-2371-4b84-96a9-9ab65156a0a0";
    const valid = {
      id,
      href: `/api/voice/audio/${id}`,
      mimeType: "audio/mpeg",
      sizeBytes: 1_024,
    };
    expect(VoiceAudioReferenceSchema.safeParse(valid).success).toBe(true);
    expect(VoiceAudioReferenceSchema.safeParse({ ...valid, href: "/tmp/private.mp3" }).success).toBe(false);
    expect(VoiceAudioReferenceSchema.safeParse({ ...valid, href: `/api/voice/audio/${"f".repeat(64)}` }).success).toBe(false);
    expect(VoiceAudioReferenceSchema.safeParse({ ...valid, id: "different-id" }).success).toBe(false);
  });

  it("validates a result with a provider fallback disclosure", () => {
    const result = VoiceSynthesisResultSchema.parse({
      projectId: "project-5",
      requestedProvider: "auto",
      usedProviderId: "azure-speech",
      selectedVoice: {
        providerId: "azure-speech",
        voiceId: "fixture-voice",
        voiceName: "Fixture voice",
        modelId: "azure-neural",
        languageTag: "en-US",
        matchedLocaleTag: "en-US",
        capabilityConfidence: "exact-locale-inventory",
        selectedAt: "2026-10-09T12:00:00.000Z",
      },
      audio: {
        id: "8c46cc6f-2371-4b84-96a9-9ab65156a0a0",
        href: "/api/voice/audio/8c46cc6f-2371-4b84-96a9-9ab65156a0a0",
        mimeType: "audio/mpeg",
        sizeBytes: 512,
      },
      cacheHit: false,
      latencyMs: 420,
      fallback: {
        fromProviderId: "elevenlabs",
        toProviderId: "azure-speech",
        reason: "provider-unavailable",
        message: "The primary provider was unavailable; another provider was used.",
        dialectVerified: false,
      },
      disclosures: [],
      completedAt: "2026-10-09T12:00:01.000Z",
    });

    expect(result.fallback?.toProviderId).toBe("azure-speech");
    expect(result.audio.href).toBe(`/api/voice/audio/${result.audio.id}`);
  });
});
