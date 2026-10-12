import { beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceSynthesisRequestSchema, VoiceProfileSchema } from "@/voice/contracts/voice-contract";
import { AzureSpeechAdapter } from "@/voice/providers/azure-speech";
import { OpenAITtsAdapter } from "@/voice/providers/openai-tts";

const mp3Bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00]);
const noSignal = new AbortController().signal;

function mockFetch(response: Response): typeof fetch {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const validRequest = VoiceSynthesisRequestSchema.parse({
  projectId: "provider-test",
  text: "Hello from a test.",
  languageTag: "en-US",
  provider: "azure-speech",
});

const azureVoice = VoiceProfileSchema.parse({
  providerId: "azure-speech",
  voiceId: "en-US-TestNeural",
  displayName: "Test voice",
  modelId: "azure-neural-tts",
  languageTags: ["en"],
  localeTags: ["en-US"],
  verifiedLanguageTags: ["en-US"],
  verifiedDialects: [],
  styles: ["cheerful"],
  gender: "female",
  evidenceSource: "account-inventory",
});

describe("Azure Speech adapter", () => {
  it("is not ready when credentials and endpoint configuration are absent", () => {
    const adapter = new AzureSpeechAdapter({}, mockFetch(new Response("")));
    expect(adapter.isConfigured()).toBe(false);
  });

  it("normalizes voice inventory records returned by the configured resource", async () => {
    const fetcher = mockFetch(jsonResponse([{
      ShortName: "en-US-TestNeural",
      DisplayName: "Test voice",
      Locale: "en-US",
      SecondaryLocaleList: [],
      Gender: "Female",
      StyleList: ["cheerful"],
    }]));
    const adapter = new AzureSpeechAdapter({
      AZURE_SPEECH_KEY: "fixture-key",
      AZURE_SPEECH_REGION: "westeurope",
    }, fetcher);

    const voices = await adapter.listVoices("en-US", noSignal);

    expect(voices).toHaveLength(1);
    expect(voices[0]).toMatchObject({
      providerId: "azure-speech",
      voiceId: "en-US-TestNeural",
      localeTags: ["en-US"],
      verifiedLanguageTags: ["en-US"],
      styles: ["cheerful"],
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://westeurope.tts.speech.microsoft.com/cognitiveservices/voices/list",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("sends escaped SSML and returns bounded MP3 bytes", async () => {
    const request = VoiceSynthesisRequestSchema.parse({
      ...validRequest,
      text: "Fish & chips",
      speakingRate: 1.1,
    });
    const fetcher = mockFetch(new Response(mp3Bytes, {
      headers: { "Content-Type": "audio/mpeg" },
    }));
    const adapter = new AzureSpeechAdapter({
      AZURE_SPEECH_KEY: "fixture-key",
      AZURE_SPEECH_ENDPOINT: "https://fixture.cognitiveservices.azure.com/",
    }, fetcher);

    const audio = await adapter.synthesize(request, azureVoice, noSignal);

    expect(audio.bytes).toEqual(Buffer.from(mp3Bytes));
    expect(audio.mimeType).toBe("audio/mpeg");
    const [url, options] = vi.mocked(fetcher).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://fixture.cognitiveservices.azure.com/tts/cognitiveservices/v1");
    expect(String(options.body)).toContain("Fish &amp; chips");
    expect(String(options.body)).toContain('rate="10%"');
    expect((options.headers as Record<string, string>)["Ocp-Apim-Subscription-Key"]).toBe("fixture-key");
  });

  it("classifies throttling as retryable without exposing a provider response body", async () => {
    const adapter = new AzureSpeechAdapter({
      AZURE_SPEECH_KEY: "fixture-key",
      AZURE_SPEECH_REGION: "eastus",
    }, mockFetch(new Response("sensitive provider details", { status: 429 })));

    await expect(adapter.synthesize(validRequest, azureVoice, noSignal)).rejects.toMatchObject({
      code: "rate-limited",
      retryable: true,
    });
    await expect(adapter.synthesize(validRequest, azureVoice, noSignal)).rejects.not.toThrow("sensitive provider details");
  });
});

describe("OpenAI TTS adapter", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("uses the documented built-in voices but marks locale and dialect inventory unknown", async () => {
    const adapter = new OpenAITtsAdapter({ OPENAI_API_KEY: "fixture-key" }, mockFetch(new Response("")));
    const voices = await adapter.listVoices("ar-DZ", noSignal);

    expect(voices.length).toBeGreaterThan(0);
    expect(voices[0].languageTags).toContain("ar");
    expect(voices[0].localeTags).toEqual([]);
    expect(voices[0].verifiedLanguageTags).toEqual([]);
    expect(voices[0].verifiedDialects).toEqual([]);
    expect(voices.every((voice) => voice.evidenceSource === "provider-documentation")).toBe(true);
  });

  it("posts the selected voice/model and validates the returned MP3", async () => {
    const fetcher = mockFetch(new Response(mp3Bytes, { headers: { "Content-Type": "audio/mpeg" } }));
    const adapter = new OpenAITtsAdapter({ OPENAI_API_KEY: "fixture-key" }, fetcher);
    const [voice] = await adapter.listVoices("en-US", noSignal);
    const request = VoiceSynthesisRequestSchema.parse({
      projectId: "provider-test",
      text: "Hello there.",
      languageTag: "en-US",
      provider: "openai",
      voiceId: voice.voiceId,
      voiceStyle: "calm narration",
      speakingRate: 1.1,
    });

    const audio = await adapter.synthesize(request, voice, noSignal);

    expect(audio.bytes).toEqual(Buffer.from(mp3Bytes));
    const [url, options] = vi.mocked(fetcher).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect(JSON.parse(String(options.body))).toMatchObject({
      model: "gpt-4o-mini-tts",
      voice: voice.voiceId,
      input: "Hello there.",
      instructions: "calm narration",
      speed: 1.1,
      response_format: "mp3",
    });
  });

  it("rejects unsupported instructions for legacy models before calling OpenAI", async () => {
    const fetcher = mockFetch(new Response(mp3Bytes, { headers: { "Content-Type": "audio/mpeg" } }));
    const adapter = new OpenAITtsAdapter({ OPENAI_API_KEY: "fixture-key", OPENAI_TTS_MODEL: "tts-1" }, fetcher);
    const [voice] = await adapter.listVoices("en-US", noSignal);
    const request = VoiceSynthesisRequestSchema.parse({
      projectId: "provider-test",
      text: "Hello there.",
      languageTag: "en-US",
      provider: "openai",
      voiceId: voice.voiceId,
      voiceStyle: "calm narration",
    });

    expect(adapter.supportsFreeformStyle).toBe(false);
    await expect(adapter.synthesize(request, voice, noSignal)).rejects.toMatchObject({
      code: "invalid-request",
      retryable: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects input above OpenAI's documented 4096-character limit before calling the API", async () => {
    const fetcher = mockFetch(new Response(mp3Bytes, { headers: { "Content-Type": "audio/mpeg" } }));
    const adapter = new OpenAITtsAdapter({ OPENAI_API_KEY: "fixture-key" }, fetcher);
    const [voice] = await adapter.listVoices("en-US", noSignal);
    const request = VoiceSynthesisRequestSchema.parse({
      projectId: "provider-test",
      text: "a".repeat(4097),
      languageTag: "en-US",
      provider: "openai",
      voiceId: voice.voiceId,
    });

    await expect(adapter.synthesize(request, voice, noSignal)).rejects.toMatchObject({
      code: "invalid-request",
      retryable: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("supports the documented dated mini TTS model alias", async () => {
    const adapter = new OpenAITtsAdapter({
      OPENAI_API_KEY: "fixture-key",
      OPENAI_TTS_MODEL: "gpt-4o-mini-tts-2025-12-15",
    }, mockFetch(new Response("")));
    expect(adapter.supportsFreeformStyle).toBe(true);
    expect(await adapter.listVoices("en-US", noSignal)).toHaveLength(13);
  });

  it("rejects insecure/custom base URLs before issuing a request", () => {
    const adapter = new OpenAITtsAdapter({
      OPENAI_API_KEY: "fixture-key",
      OPENAI_BASE_URL: "http://example.com/v1",
      NODE_ENV: "production",
    }, mockFetch(new Response("")));
    expect(adapter.isConfigured()).toBe(false);
  });
});
