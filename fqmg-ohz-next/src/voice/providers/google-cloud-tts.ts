import { z } from "zod";
import {
  VoiceProfileSchema,
  type VoiceProfile,
  type VoiceSynthesisRequest,
} from "@/voice/contracts/voice-contract";
import {
  ensureProviderConfigured,
  fetchProviderResponse,
  getBaseLanguageTag,
  mapProviderGender,
  readProviderJson,
  uniqueLanguageTags,
  validateProviderMp3Bytes,
} from "@/voice/providers/provider-utils";
import {
  VoiceProviderError,
  type ProviderAudio,
  type VoiceProviderAdapter,
  type VoiceProviderEnvironment,
} from "@/voice/providers/provider";

const PROVIDER_ID = "google-cloud" as const;
const MODEL_ID = "google-cloud-tts-v1";
const GOOGLE_CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const GoogleVoiceSchema = z.object({
  name: z.string().min(1).max(256),
  languageCodes: z.array(z.string().min(2).max(35)).min(1).max(100),
  ssmlGender: z.string().max(64).optional(),
  naturalSampleRateHertz: z.number().int().positive().optional(),
}).passthrough();
const GoogleVoiceListSchema = z.object({
  voices: z.array(GoogleVoiceSchema).max(10_000),
}).passthrough();
const GoogleSynthesisResponseSchema = z.object({
  audioContent: z.string().min(8).max(100 * 1024 * 1024),
}).passthrough();

type GoogleAccessTokenClient = { getAccessToken(): Promise<unknown> };

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  providerId: typeof PROVIDER_ID,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new VoiceProviderError(providerId, "timeout"));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new VoiceProviderError(providerId, "timeout"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function extractAccessToken(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && "token" in value) {
    const token = value.token;
    if (typeof token === "string" && token.trim()) return token.trim();
  }
  return undefined;
}

export class GoogleCloudTtsAdapter implements VoiceProviderAdapter {
  readonly id = PROVIDER_ID;
  readonly requiredEnvironment = ["GOOGLE_APPLICATION_CREDENTIALS or Google ADC", "GOOGLE_CLOUD_PROJECT (recommended)"] as const;
  readonly supportsFreeformStyle = false;

  private googleClientPromise: Promise<GoogleAccessTokenClient> | undefined;

  constructor(
    private readonly environment: VoiceProviderEnvironment = process.env,
    private readonly fetcher: typeof fetch = fetch,
    private readonly accessTokenProvider?: () => Promise<string>,
  ) {}

  isConfigured(): boolean {
    return Boolean(
      this.environment.GOOGLE_APPLICATION_CREDENTIALS?.trim() ||
      this.environment.GOOGLE_CLOUD_PROJECT?.trim(),
    );
  }

  private async getAccessToken(signal: AbortSignal): Promise<string> {
    ensureProviderConfigured(this.id, this.isConfigured());
    const tokenPromise = (async () => {
      try {
        if (this.accessTokenProvider) {
          const injectedToken = await this.accessTokenProvider();
          if (injectedToken.trim()) return injectedToken.trim();
          throw new Error("empty token");
        }

        this.googleClientPromise ??= import("google-auth-library").then(async ({ GoogleAuth }) => {
          const auth = new GoogleAuth({ scopes: [GOOGLE_CLOUD_SCOPE] });
          return auth.getClient();
        });
        const client = await this.googleClientPromise;
        const token = extractAccessToken(await client.getAccessToken());
        if (token) return token;
        throw new Error("empty token");
      } catch {
        throw new VoiceProviderError(this.id, "authentication");
      }
    })();
    return raceWithAbort(tokenPromise, signal, this.id);
  }

  async listVoices(languageTag: string, signal: AbortSignal): Promise<VoiceProfile[]> {
    ensureProviderConfigured(this.id, this.isConfigured());
    const accessToken = await this.getAccessToken(signal);
    const url = new URL("https://texttospeech.googleapis.com/v1/voices");
    url.searchParams.set("languageCode", languageTag);
    const response = await fetchProviderResponse(this.id, this.fetcher, url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal,
    });
    const raw = GoogleVoiceListSchema.safeParse(await readProviderJson(this.id, response));
    if (!raw.success) throw new VoiceProviderError(this.id, "invalid-response");

    return raw.data.voices.map((record) => {
      const localeTags = uniqueLanguageTags(record.languageCodes);
      const languageTags = uniqueLanguageTags(localeTags.map(getBaseLanguageTag));
      const genderValue = record.ssmlGender === "SSML_VOICE_GENDER_UNSPECIFIED" ? undefined : record.ssmlGender;
      return VoiceProfileSchema.parse({
        providerId: this.id,
        voiceId: record.name,
        displayName: record.name,
        modelId: MODEL_ID,
        languageTags,
        localeTags,
        verifiedLanguageTags: localeTags,
        verifiedDialects: [],
        styles: [],
        gender: mapProviderGender(genderValue),
        evidenceSource: "account-inventory",
      });
    });
  }

  async synthesize(
    request: VoiceSynthesisRequest,
    voice: VoiceProfile,
    signal: AbortSignal,
  ): Promise<ProviderAudio> {
    ensureProviderConfigured(this.id, this.isConfigured());
    if (voice.providerId !== this.id) throw new VoiceProviderError(this.id, "not-found");
    if (request.voiceStyle) throw new VoiceProviderError(this.id, "invalid-request");
    const accessToken = await this.getAccessToken(signal);

    const response = await fetchProviderResponse(this.id, this.fetcher, "https://texttospeech.googleapis.com/v1/text:synthesize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: { text: request.text },
        voice: { languageCode: request.languageTag, name: voice.voiceId },
        audioConfig: { audioEncoding: "MP3", speakingRate: request.speakingRate },
      }),
      signal,
    });
    const raw = GoogleSynthesisResponseSchema.safeParse(await readProviderJson(this.id, response));
    if (!raw.success) throw new VoiceProviderError(this.id, "invalid-response");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.data.audioContent)) {
      throw new VoiceProviderError(this.id, "invalid-response");
    }

    const bytes = Buffer.from(raw.data.audioContent, "base64");
    return validateProviderMp3Bytes(this.id, bytes, voice.modelId ?? MODEL_ID);
  }
}
