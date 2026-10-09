import { describe, expect, it, vi } from "vitest";
import { VoiceProfileSchema, VoiceSynthesisRequestSchema } from "@/voice/contracts/voice-contract";
import { ElevenLabsAdapter } from "@/voice/providers/elevenlabs";
import { GoogleCloudTtsAdapter } from "@/voice/providers/google-cloud-tts";
import { createDefaultVoiceProviders } from "@/voice/providers";

const mp3Bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00]);
const noSignal = new AbortController().signal;

function mockFetch(response: Response): typeof fetch {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

function mockFetchResponses(responses: Response[]): typeof fetch {
  return vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error("No fixture response remains.");
    return response;
  }) as unknown as typeof fetch;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const elevenRequest = VoiceSynthesisRequestSchema.parse({
  projectId: "eleven-test",
  text: "Bonjour.",
  languageTag: "fr-FR",
  provider: "elevenlabs",
});
const googleRequest = VoiceSynthesisRequestSchema.parse({
  projectId: "google-test",
  text: "Hello.",
  languageTag: "en-US",
  provider: "google-cloud",
});
const googleVoice = VoiceProfileSchema.parse({
  providerId: "google-cloud",
  voiceId: "en-US-Test-Standard-A",
  displayName: "Fixture Google voice",
  modelId: "google-cloud-tts-v1",
  languageTags: ["en"],
  localeTags: ["en-US"],
  verifiedLanguageTags: ["en-US"],
  verifiedDialects: [],
  styles: [],
  gender: "female",
  evidenceSource: "account-inventory",
});

describe("ElevenLabs adapter", () => {
  it("is not configured without an API key", () => {
    expect(new ElevenLabsAdapter({}, mockFetch(new Response(""))).isConfigured()).toBe(false);
  });

  it("discovers voice locales and dialect labels only from verified-language inventory", async () => {
    const fetcher = mockFetch(jsonResponse({
      voices: [{
        voice_id: "fixture-voice",
        name: "Fixture voice",
        verified_languages: [{
          language: "fr",
          locale: "fr-FR",
          model_id: "eleven_multilingual_v2",
          accent: "French",
        }],
      }],
      has_more: false,
      next_page_token: null,
    }));
    const adapter = new ElevenLabsAdapter({ ELEVENLABS_API_KEY: "fixture-key" }, fetcher);

    const voices = await adapter.listVoices("fr-FR", noSignal);

    expect(voices).toHaveLength(1);
    expect(voices[0]).toMatchObject({
      voiceId: "fixture-voice",
      localeTags: ["fr-FR"],
      verifiedLanguageTags: ["fr-FR"],
      verifiedDialects: ["French"],
    });
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("https://api.elevenlabs.io/v2/voices?page_size=100"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("fails inventory discovery instead of silently using an incomplete capped page set", async () => {
    const pages = Array.from({ length: 10 }, (_, page) => jsonResponse({
      voices: [{ voice_id: `voice-${page}`, name: `Voice ${page}`, verified_languages: [] }],
      has_more: true,
      next_page_token: `page-${page + 1}`,
    }));
    const fetcher = mockFetchResponses(pages);
    const adapter = new ElevenLabsAdapter({ ELEVENLABS_API_KEY: "fixture-key" }, fetcher);

    await expect(adapter.listVoices("ar-DZ", noSignal)).rejects.toMatchObject({
      code: "invalid-response",
      retryable: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(10);
  });

  it("synthesizes a selected voice into validated MP3 audio", async () => {
    const fetcher = mockFetchResponses([
      jsonResponse({
        voices: [{
          voice_id: "fixture-voice",
          name: "Fixture voice",
          verified_languages: [{ language: "fr", locale: "fr-FR", model_id: "eleven_multilingual_v2" }],
        }],
        has_more: false,
      }),
      new Response(mp3Bytes, { headers: { "Content-Type": "audio/mpeg" } }),
    ]);
    const adapter = new ElevenLabsAdapter({ ELEVENLABS_API_KEY: "fixture-key" }, fetcher);
    const [voice] = await adapter.listVoices("fr-FR", noSignal);
    const audio = await adapter.synthesize(elevenRequest, voice, noSignal);

    expect(audio.bytes).toEqual(Buffer.from(mp3Bytes));
    const [url, options] = vi.mocked(fetcher).mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toContain("https://api.elevenlabs.io/v1/text-to-speech/fixture-voice");
    expect(url).toContain("output_format=mp3_44100_128");
    const body = JSON.parse(String(options.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      text: "Bonjour.",
      model_id: "eleven_multilingual_v2",
      voice_settings: { speed: 1 },
    });
    expect(body).not.toHaveProperty("language_code");
  });

  it("does not retry authentication failures", async () => {
    const adapter = new ElevenLabsAdapter(
      { ELEVENLABS_API_KEY: "fixture-key" },
      mockFetch(new Response("private error body", { status: 401 })),
    );
    await expect(adapter.listVoices("ar-DZ", noSignal)).rejects.toMatchObject({
      code: "authentication",
      retryable: false,
    });
  });
});

describe("Google Cloud TTS adapter", () => {
  it("does not attempt discovery when Google credentials are absent", () => {
    expect(new GoogleCloudTtsAdapter({}, mockFetch(new Response(""))).isConfigured()).toBe(false);
  });

  it("queries the exact locale and normalizes Google voice metadata", async () => {
    const fetcher = mockFetch(jsonResponse({
      voices: [{
        name: "en-US-Test-Standard-A",
        languageCodes: ["en-US"],
        ssmlGender: "FEMALE",
        naturalSampleRateHertz: 24_000,
      }],
    }));
    const adapter = new GoogleCloudTtsAdapter(
      { GOOGLE_CLOUD_PROJECT: "fixture-project" },
      fetcher,
      async () => "fixture-token",
    );

    const voices = await adapter.listVoices("en-US", noSignal);

    expect(voices).toHaveLength(1);
    expect(voices[0]).toMatchObject({
      voiceId: "en-US-Test-Standard-A",
      localeTags: ["en-US"],
      verifiedLanguageTags: ["en-US"],
      gender: "female",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://texttospeech.googleapis.com/v1/voices?languageCode=en-US",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("uses OAuth and decodes only validated MP3 synthesis output", async () => {
    const fetcher = mockFetch(jsonResponse({ audioContent: Buffer.from(mp3Bytes).toString("base64") }));
    const adapter = new GoogleCloudTtsAdapter(
      { GOOGLE_CLOUD_PROJECT: "fixture-project" },
      fetcher,
      async () => "fixture-token",
    );
    const audio = await adapter.synthesize(googleRequest, googleVoice, noSignal);

    expect(audio.bytes).toEqual(Buffer.from(mp3Bytes));
    const [url, options] = vi.mocked(fetcher).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://texttospeech.googleapis.com/v1/text:synthesize");
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer fixture-token");
    expect(JSON.parse(String(options.body))).toMatchObject({
      input: { text: "Hello." },
      voice: { languageCode: "en-US", name: "en-US-Test-Standard-A" },
      audioConfig: { audioEncoding: "MP3", speakingRate: 1 },
    });
  });

  it("rejects content above Google's 5000-byte request limit before obtaining credentials", async () => {
    const fetcher = mockFetch(new Response(""));
    const accessTokenProvider = vi.fn(async () => "fixture-token");
    const adapter = new GoogleCloudTtsAdapter(
      { GOOGLE_CLOUD_PROJECT: "fixture-project" },
      fetcher,
      accessTokenProvider,
    );
    const request = VoiceSynthesisRequestSchema.parse({
      projectId: "google-test",
      text: "a".repeat(5001),
      languageTag: "en-US",
      provider: "google-cloud",
    });

    await expect(adapter.synthesize(request, googleVoice, noSignal)).rejects.toMatchObject({
      code: "invalid-request",
      retryable: false,
    });
    expect(accessTokenProvider).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps authentication errors safely and bounds credential acquisition by the request signal", async () => {
    const authErrorAdapter = new GoogleCloudTtsAdapter(
      { GOOGLE_CLOUD_PROJECT: "fixture-project" },
      mockFetch(new Response("private response body", { status: 403 })),
      async () => "fixture-token",
    );
    await expect(authErrorAdapter.listVoices("en-US", noSignal)).rejects.toMatchObject({
      code: "authentication",
      retryable: false,
    });

    const pendingTokenAdapter = new GoogleCloudTtsAdapter(
      { GOOGLE_CLOUD_PROJECT: "fixture-project" },
      mockFetch(new Response("")),
      async () => new Promise((resolve) => setTimeout(() => resolve("late-token"), 40)),
    );
    await expect(pendingTokenAdapter.listVoices("en-US", AbortSignal.timeout(5))).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    });
  });
});

describe("default provider registration", () => {
  it("registers all four isolated providers without making network calls", () => {
    const providers = createDefaultVoiceProviders({});
    expect(providers.map((provider) => provider.id)).toEqual([
      "azure-speech",
      "elevenlabs",
      "google-cloud",
      "openai",
    ]);
    expect(providers.every((provider) => !provider.isConfigured())).toBe(true);
  });
});
