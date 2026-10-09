import {
  VoiceProfileSchema,
  type VoiceProfile,
  type VoiceSynthesisRequest,
} from "@/voice/contracts/voice-contract";
import {
  ensureProviderConfigured,
  fetchProviderResponse,
  getBaseLanguageTag,
  readProviderMp3,
} from "@/voice/providers/provider-utils";
import {
  VoiceProviderError,
  type ProviderAudio,
  type VoiceProviderAdapter,
  type VoiceProviderEnvironment,
} from "@/voice/providers/provider";

const OPENAI_PROVIDER_ID = "openai" as const;
const DEFAULT_MODEL_ID = "gpt-4o-mini-tts";
const FULL_VOICE_SET = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;
const STANDARD_MODEL_VOICES = [
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
] as const;
const DOCUMENTED_LANGUAGE_TAGS = [
  "af", "ar", "hy", "az", "be", "bs", "bg", "ca", "zh", "hr", "cs", "da", "nl", "en",
  "et", "fi", "fr", "gl", "de", "el", "he", "hi", "hu", "is", "id", "it", "ja", "kn",
  "kk", "ko", "lv", "lt", "mk", "ms", "mr", "mi", "ne", "no", "fa", "pl", "pt", "ro",
  "ru", "sr", "sk", "sl", "es", "sw", "sv", "tl", "ta", "th", "tr", "uk", "ur", "vi", "cy",
] as const;

const SMALL_VOICE_MODELS = new Set(["tts-1", "tts-1-hd"]);

function getModelId(environment: VoiceProviderEnvironment): string {
  return environment.OPENAI_TTS_MODEL?.trim() || DEFAULT_MODEL_ID;
}

function getVoiceIds(modelId: string): readonly string[] {
  if (modelId === DEFAULT_MODEL_ID) return FULL_VOICE_SET;
  if (SMALL_VOICE_MODELS.has(modelId)) return STANDARD_MODEL_VOICES;
  return [];
}

function getOpenAIBaseUrl(environment: VoiceProviderEnvironment): string | null {
  const value = environment.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
  try {
    const parsed = new URL(value);
    const allowLocalDevelopmentHttp = environment.NODE_ENV !== "production" &&
      ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    if (
      (parsed.protocol !== "https:" && !(allowLocalDevelopmentHttp && parsed.protocol === "http:")) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${path}`;
  } catch {
    return null;
  }
}

export class OpenAITtsAdapter implements VoiceProviderAdapter {
  readonly id = OPENAI_PROVIDER_ID;
  readonly requiredEnvironment = ["OPENAI_API_KEY"] as const;
  readonly supportsFreeformStyle = true;

  constructor(
    private readonly environment: VoiceProviderEnvironment = process.env,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.environment.OPENAI_API_KEY?.trim() && getOpenAIBaseUrl(this.environment));
  }

  async listVoices(languageTag: string, _signal: AbortSignal): Promise<VoiceProfile[]> {
    const modelId = getModelId(this.environment);
    const voiceIds = getVoiceIds(modelId);
    if (voiceIds.length === 0) throw new VoiceProviderError(this.id, "invalid-request");

    const baseLanguage = getBaseLanguageTag(languageTag);
    if (!DOCUMENTED_LANGUAGE_TAGS.includes(baseLanguage as typeof DOCUMENTED_LANGUAGE_TAGS[number])) return [];

    return voiceIds.map((voiceId) => VoiceProfileSchema.parse({
      providerId: this.id,
      voiceId,
      displayName: voiceId,
      modelId,
      languageTags: DOCUMENTED_LANGUAGE_TAGS,
      // OpenAI documents generic languages, not per-voice locale or dialect inventory.
      localeTags: [],
      verifiedLanguageTags: [],
      verifiedDialects: [],
      styles: [],
      evidenceSource: "provider-documentation",
    }));
  }

  async synthesize(
    request: VoiceSynthesisRequest,
    voice: VoiceProfile,
    signal: AbortSignal,
  ): Promise<ProviderAudio> {
    ensureProviderConfigured(this.id, this.isConfigured());
    if (voice.providerId !== this.id) throw new VoiceProviderError(this.id, "not-found");

    const modelId = getModelId(this.environment);
    const voiceIds = getVoiceIds(modelId);
    if (voice.modelId !== modelId || !voiceIds.includes(voice.voiceId)) {
      throw new VoiceProviderError(this.id, "not-found");
    }

    const apiKey = this.environment.OPENAI_API_KEY?.trim();
    const baseUrl = getOpenAIBaseUrl(this.environment);
    if (!apiKey || !baseUrl) ensureProviderConfigured(this.id, false);

    const response = await fetchProviderResponse(this.id, this.fetcher, `${baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        voice: voice.voiceId,
        input: request.text,
        instructions: request.voiceStyle,
        speed: request.speakingRate,
        response_format: "mp3",
      }),
      signal,
    });

    return readProviderMp3(this.id, response, modelId);
  }
}
