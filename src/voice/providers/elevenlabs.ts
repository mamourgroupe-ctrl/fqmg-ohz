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
  parseLanguageTag,
  readProviderJson,
  readProviderMp3,
  uniqueLanguageTags,
} from "@/voice/providers/provider-utils";
import { VoiceProviderError, type ProviderAudio, type VoiceProviderAdapter, type VoiceProviderEnvironment } from "@/voice/providers/provider";

const PROVIDER_ID = "elevenlabs" as const;
const DEFAULT_MODEL_ID = "eleven_multilingual_v2";
const PAGE_SIZE = 100;
const MAX_VOICE_PAGES = 10;

const ElevenVerifiedLanguageSchema = z.object({
  language: z.string().min(1).max(35).optional(),
  locale: z.string().min(1).max(35).optional(),
  model_id: z.string().min(1).max(128).optional(),
  accent: z.string().trim().min(1).max(80).optional(),
}).passthrough();
const ElevenVoiceSchema = z.object({
  voice_id: z.string().min(1).max(256),
  name: z.string().min(1).max(256).optional(),
  verified_languages: z.array(ElevenVerifiedLanguageSchema).nullish(),
}).passthrough();
const ElevenVoicePageSchema = z.object({
  voices: z.array(ElevenVoiceSchema).max(PAGE_SIZE),
  next_page_token: z.string().max(512).nullish(),
  has_more: z.boolean().optional(),
}).passthrough();

function getVerifiedLanguageTags(
  verifiedLanguages: Array<z.infer<typeof ElevenVerifiedLanguageSchema>>,
): string[] {
  return verifiedLanguages.flatMap((entry) => {
    const locale = parseLanguageTag(entry.locale);
    if (locale) return [locale];
    const language = parseLanguageTag(entry.language);
    return language ? [language] : [];
  });
}

export class ElevenLabsAdapter implements VoiceProviderAdapter {
  readonly id = PROVIDER_ID;
  readonly requiredEnvironment = ["ELEVENLABS_API_KEY"] as const;
  readonly supportsFreeformStyle = false;

  constructor(
    private readonly environment: VoiceProviderEnvironment = process.env,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.environment.ELEVENLABS_API_KEY?.trim());
  }

  async listVoices(languageTag: string, signal: AbortSignal): Promise<VoiceProfile[]> {
    ensureProviderConfigured(this.id, this.isConfigured());
    const apiKey = this.environment.ELEVENLABS_API_KEY?.trim();
    if (!apiKey) throw new VoiceProviderError(this.id, "not-configured");

    const pages: z.infer<typeof ElevenVoiceSchema>[] = [];
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;

    for (let pageNumber = 0; pageNumber < MAX_VOICE_PAGES; pageNumber += 1) {
      const url = new URL("https://api.elevenlabs.io/v2/voices");
      url.searchParams.set("page_size", String(PAGE_SIZE));
      url.searchParams.set("include_total_count", "false");
      if (pageToken) url.searchParams.set("next_page_token", pageToken);

      const response = await fetchProviderResponse(this.id, this.fetcher, url.toString(), {
        method: "GET",
        headers: { "xi-api-key": apiKey },
        signal,
      });
      const parsed = ElevenVoicePageSchema.safeParse(await readProviderJson(this.id, response));
      if (!parsed.success) throw new VoiceProviderError(this.id, "invalid-response");
      pages.push(...parsed.data.voices);

      const nextToken = parsed.data.next_page_token ?? undefined;
      const hasMore = parsed.data.has_more ?? Boolean(nextToken);
      if (!hasMore) break;
      if (!nextToken || seenPageTokens.has(nextToken) || pageNumber === MAX_VOICE_PAGES - 1) {
        throw new VoiceProviderError(this.id, "invalid-response");
      }
      seenPageTokens.add(nextToken);
      pageToken = nextToken;
    }

    const requestedTag = parseLanguageTag(languageTag);
    const requestedBase = requestedTag ? getBaseLanguageTag(requestedTag) : undefined;
    return pages.flatMap((record) => {
      const verifiedLanguages = record.verified_languages ?? [];
      const verifiedLanguageTags = uniqueLanguageTags(getVerifiedLanguageTags(verifiedLanguages));
      const localeTags = uniqueLanguageTags(
        verifiedLanguages.map((entry) => parseLanguageTag(entry.locale)).filter((tag): tag is string => Boolean(tag)),
      );
      const languageTags = uniqueLanguageTags([
        ...verifiedLanguageTags,
        ...verifiedLanguageTags.map(getBaseLanguageTag),
      ]);
      if (
        requestedBase &&
        languageTags.length > 0 &&
        !languageTags.some((tag) => getBaseLanguageTag(tag) === requestedBase)
      ) {
        return [];
      }

      const matchingLanguage = verifiedLanguages.find((entry) => {
        const locale = parseLanguageTag(entry.locale);
        const language = parseLanguageTag(entry.language);
        return locale === requestedTag || language === requestedTag ||
          (language && requestedBase && getBaseLanguageTag(language) === requestedBase);
      });
      const verifiedDialects = [...new Set(verifiedLanguages
        .map((entry) => entry.accent?.trim())
        .filter((accent): accent is string => Boolean(accent)))];

      return [VoiceProfileSchema.parse({
        providerId: this.id,
        voiceId: record.voice_id,
        displayName: record.name,
        modelId: matchingLanguage?.model_id ?? verifiedLanguages[0]?.model_id ?? DEFAULT_MODEL_ID,
        languageTags,
        localeTags,
        verifiedLanguageTags,
        verifiedDialects,
        styles: [],
        evidenceSource: "account-inventory",
      })];
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

    const apiKey = this.environment.ELEVENLABS_API_KEY?.trim();
    if (!apiKey) throw new VoiceProviderError(this.id, "not-configured");

    const modelId = voice.modelId ?? DEFAULT_MODEL_ID;
    const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice.voiceId)}`);
    url.searchParams.set("output_format", "mp3_44100_128");
    const response = await fetchProviderResponse(this.id, this.fetcher, url.toString(), {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: request.text,
        model_id: modelId,
        voice_settings: { speed: request.speakingRate },
      }),
      signal,
    });
    return readProviderMp3(this.id, response, modelId);
  }
}
