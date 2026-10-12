import { z } from "zod";
import {
  VoiceProfileSchema,
  type VoiceProfile,
  type VoiceProviderId,
  type VoiceSynthesisRequest,
} from "@/voice/contracts/voice-contract";
import {
  fetchProviderResponse,
  getBaseLanguageTag,
  mapProviderGender,
  parseLanguageTag,
  readProviderJson,
  readProviderMp3,
  uniqueLanguageTags,
} from "@/voice/providers/provider-utils";
import {
  VoiceProviderError,
  type ProviderAudio,
  type VoiceProviderAdapter,
  type VoiceProviderEnvironment,
} from "@/voice/providers/provider";

const PROVIDER_ID: VoiceProviderId = "azure-speech";
const AZURE_REGION_PATTERN = /^[a-z0-9-]{3,32}$/i;
const AzureVoiceRecordSchema = z.object({
  ShortName: z.string().min(1).max(256),
  DisplayName: z.string().max(256).optional(),
  Locale: z.string().min(2).max(35),
  SecondaryLocaleList: z.array(z.string().min(2).max(35)).nullish(),
  Gender: z.string().max(24).optional(),
  StyleList: z.array(z.string().min(1).max(120)).nullish(),
}).passthrough();
const AzureVoiceListSchema = z.array(AzureVoiceRecordSchema).max(10_000);

export interface AzureEndpoint {
  origin: string;
  kind: "resource" | "regional";
}

export function getAzureEndpoint(environment: VoiceProviderEnvironment): AzureEndpoint | null {
  const configuredEndpoint = environment.AZURE_SPEECH_ENDPOINT?.trim();
  if (configuredEndpoint) {
    try {
      const parsed = new URL(configuredEndpoint);
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        (parsed.pathname !== "/" && parsed.pathname !== "")
      ) {
        return null;
      }
      const hostname = parsed.hostname.toLowerCase();
      if (hostname.endsWith(".cognitiveservices.azure.com")) {
        return { origin: parsed.origin, kind: "resource" };
      }
      if (hostname.endsWith(".tts.speech.microsoft.com")) {
        return { origin: parsed.origin, kind: "regional" };
      }
      return null;
    } catch {
      return null;
    }
  }

  const region = environment.AZURE_SPEECH_REGION?.trim();
  if (!region || !AZURE_REGION_PATTERN.test(region)) return null;
  return { origin: `https://${region.toLowerCase()}.tts.speech.microsoft.com`, kind: "regional" };
}

function getGender(value: string | undefined): "female" | "male" | "neutral" | "unknown" | undefined {
  return mapProviderGender(value);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export class AzureSpeechAdapter implements VoiceProviderAdapter {
  readonly id = PROVIDER_ID;
  readonly requiredEnvironment = ["AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT"] as const;
  readonly supportsFreeformStyle = false;

  constructor(
    private readonly environment: VoiceProviderEnvironment = process.env,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.environment.AZURE_SPEECH_KEY?.trim() && getAzureEndpoint(this.environment));
  }

  async listVoices(languageTag: string, signal: AbortSignal): Promise<VoiceProfile[]> {
    const endpoint = getAzureEndpoint(this.environment);
    const key = this.environment.AZURE_SPEECH_KEY?.trim();
    if (!endpoint || !key) throw new VoiceProviderError(this.id, "not-configured");

    const path = endpoint.kind === "resource"
      ? "/tts/cognitiveservices/voices/list"
      : "/cognitiveservices/voices/list";
    const response = await fetchProviderResponse(this.id, this.fetcher, `${endpoint.origin}${path}`, {
      method: "GET",
      headers: { "Ocp-Apim-Subscription-Key": key },
      signal,
    });
    const raw = AzureVoiceListSchema.safeParse(await readProviderJson(this.id, response));
    if (!raw.success) throw new VoiceProviderError(this.id, "invalid-response");

    const requestLanguage = parseLanguageTag(languageTag);
    const requestBaseLanguage = requestLanguage ? getBaseLanguageTag(requestLanguage) : undefined;
    return raw.data.flatMap((record) => {
      const localeTags = uniqueLanguageTags([record.Locale, ...(record.SecondaryLocaleList ?? [])]);
      const languageTags = uniqueLanguageTags(localeTags.map(getBaseLanguageTag));
      if (
        requestBaseLanguage &&
        !languageTags.some((tag) => tag.toLowerCase() === requestBaseLanguage)
      ) {
        return [];
      }

      return [VoiceProfileSchema.parse({
        providerId: this.id,
        voiceId: record.ShortName,
        displayName: record.DisplayName,
        modelId: "azure-neural-tts",
        languageTags,
        localeTags,
        verifiedLanguageTags: localeTags,
        verifiedDialects: [],
        styles: record.StyleList ?? [],
        gender: getGender(record.Gender),
        evidenceSource: "account-inventory",
      })];
    });
  }

  async synthesize(
    request: VoiceSynthesisRequest,
    voice: VoiceProfile,
    signal: AbortSignal,
  ): Promise<ProviderAudio> {
    if (voice.providerId !== this.id) throw new VoiceProviderError(this.id, "not-found");
    if (request.voiceStyle && !voice.styles.includes(request.voiceStyle)) {
      throw new VoiceProviderError(this.id, "invalid-request");
    }

    const endpoint = getAzureEndpoint(this.environment);
    const key = this.environment.AZURE_SPEECH_KEY?.trim();
    if (!endpoint || !key) throw new VoiceProviderError(this.id, "not-configured");

    const path = endpoint.kind === "resource"
      ? "/tts/cognitiveservices/v1"
      : "/cognitiveservices/v1";
    const ratePercent = Math.round((request.speakingRate - 1) * 100);
    const rateAttribute = ratePercent === 0 ? "" : ` rate="${ratePercent}%"`;
    const speech = request.voiceStyle
      ? `<mstts:express-as style="${escapeXml(request.voiceStyle)}">${escapeXml(request.text)}</mstts:express-as>`
      : escapeXml(request.text);
    const ssml = [
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="${escapeXml(request.languageTag)}">`,
      `<voice name="${escapeXml(voice.voiceId)}"><prosody${rateAttribute}>${speech}</prosody></voice>`,
      `</speak>`,
    ].join("");

    const response = await fetchProviderResponse(this.id, this.fetcher, `${endpoint.origin}${path}`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-160kbitrate-mono-mp3",
        "User-Agent": "fqmg-ohz-voice-engine",
      },
      body: ssml,
      signal,
    });
    return readProviderMp3(this.id, response, voice.modelId ?? "azure-neural-tts");
  }
}
