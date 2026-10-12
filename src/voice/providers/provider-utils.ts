import { MAX_AUDIO_BYTES, LanguageTagSchema, type LanguageTag, type VoiceProviderId } from "@/voice/contracts/voice-contract";
import { VoiceProviderError } from "@/voice/providers/provider";

const MAX_PROVIDER_JSON_BYTES = 2 * 1024 * 1024;

export function getBaseLanguageTag(languageTag: string): string {
  return languageTag.split("-")[0].toLowerCase();
}

export function parseLanguageTag(value: string | undefined): LanguageTag | undefined {
  const parsed = LanguageTagSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function uniqueLanguageTags(values: Array<string | undefined>): LanguageTag[] {
  const normalized = values
    .map((value) => parseLanguageTag(value))
    .filter((value): value is LanguageTag => value !== undefined);
  return [...new Set(normalized)];
}

export function mapHttpStatusToFailure(status: number): ConstructorParameters<typeof VoiceProviderError>[1] {
  if (status === 401 || status === 403) return "authentication";
  if (status === 404) return "not-found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "unavailable";
  if (status >= 400) return "invalid-request";
  return "invalid-response";
}

export async function fetchProviderResponse(
  providerId: VoiceProviderId,
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    const response = await fetcher(url, init);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new VoiceProviderError(providerId, mapHttpStatusToFailure(response.status));
    }
    return response;
  } catch (error) {
    if (error instanceof VoiceProviderError) throw error;
    if (init.signal?.aborted) throw new VoiceProviderError(providerId, "timeout");
    throw new VoiceProviderError(providerId, "network");
  }
}

export async function readProviderJson(
  providerId: VoiceProviderId,
  response: Response,
): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_PROVIDER_JSON_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new VoiceProviderError(providerId, "invalid-response");
  }

  try {
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_PROVIDER_JSON_BYTES) {
      throw new VoiceProviderError(providerId, "invalid-response");
    }
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch (error) {
    if (error instanceof VoiceProviderError) throw error;
    throw new VoiceProviderError(providerId, "invalid-response");
  }
}

function hasMp3Signature(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  if (bytes.subarray(0, 3).toString("ascii") === "ID3") return true;
  const scanLimit = Math.min(bytes.length - 1, 64);
  for (let index = 0; index < scanLimit; index += 1) {
    if (bytes[index] === 0xff && (bytes[index + 1] & 0xe0) === 0xe0) return true;
  }
  return false;
}

export function validateProviderMp3Bytes(
  providerId: VoiceProviderId,
  bytes: Buffer,
  modelId: string,
): { bytes: Buffer; mimeType: "audio/mpeg"; modelId: string } {
  if (bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES || !hasMp3Signature(bytes)) {
    throw new VoiceProviderError(providerId, "invalid-response");
  }
  return { bytes, mimeType: "audio/mpeg", modelId };
}

export async function readProviderMp3(
  providerId: VoiceProviderId,
  response: Response,
  modelId: string,
): Promise<{ bytes: Buffer; mimeType: "audio/mpeg"; modelId: string }> {
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (!contentType || (!contentType.startsWith("audio/") && contentType !== "application/octet-stream")) {
    await response.body?.cancel().catch(() => undefined);
    throw new VoiceProviderError(providerId, "invalid-response");
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_AUDIO_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new VoiceProviderError(providerId, "invalid-response");
  }

  try {
    const bytes = Buffer.from(await response.arrayBuffer());
    return validateProviderMp3Bytes(providerId, bytes, modelId);
  } catch (error) {
    if (error instanceof VoiceProviderError) throw error;
    throw new VoiceProviderError(providerId, "invalid-response");
  }
}

export function mapProviderGender(value: string | undefined): "female" | "male" | "neutral" | "unknown" | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "female") return "female";
  if (normalized === "male") return "male";
  if (normalized === "neutral") return "neutral";
  if (normalized === "unknown") return "unknown";
  return undefined;
}

export function ensureProviderConfigured(providerId: VoiceProviderId, configured: boolean): asserts configured {
  if (!configured) throw new VoiceProviderError(providerId, "not-configured");
}
