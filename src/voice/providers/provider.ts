import type {
  VoiceProfile,
  VoiceProviderId,
  VoiceSynthesisRequest,
} from "@/voice/contracts/voice-contract";

export type VoiceProviderEnvironment = Readonly<Record<string, string | undefined>>;

export type ProviderFailureCode =
  | "not-configured"
  | "authentication"
  | "rate-limited"
  | "timeout"
  | "network"
  | "invalid-request"
  | "invalid-response"
  | "not-found"
  | "unavailable";

const SAFE_PROVIDER_FAILURE_MESSAGES: Record<ProviderFailureCode, string> = {
  "not-configured": "This voice provider is not configured.",
  authentication: "The voice provider rejected its configured credentials.",
  "rate-limited": "The voice provider is temporarily rate-limiting requests.",
  timeout: "The voice provider request timed out.",
  network: "The voice provider could not be reached.",
  "invalid-request": "The voice provider rejected the synthesis request.",
  "invalid-response": "The voice provider returned an invalid response.",
  "not-found": "The selected voice is not available from this provider.",
  unavailable: "The voice provider is temporarily unavailable.",
};

const RETRYABLE_FAILURES = new Set<ProviderFailureCode>([
  "rate-limited",
  "timeout",
  "network",
  "unavailable",
]);

export class VoiceProviderError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly providerId: VoiceProviderId,
    readonly code: ProviderFailureCode,
  ) {
    super(SAFE_PROVIDER_FAILURE_MESSAGES[code]);
    this.name = "VoiceProviderError";
    this.retryable = RETRYABLE_FAILURES.has(code);
  }
}

export interface ProviderAudio {
  bytes: Buffer;
  mimeType: "audio/mpeg";
  modelId: string;
}

export interface VoiceProviderAdapter {
  readonly id: VoiceProviderId;
  readonly requiredEnvironment: readonly string[];
  readonly supportsFreeformStyle: boolean;
  isConfigured(): boolean;
  listVoices(languageTag: string, signal: AbortSignal): Promise<VoiceProfile[]>;
  synthesize(
    request: VoiceSynthesisRequest,
    voice: VoiceProfile,
    signal: AbortSignal,
  ): Promise<ProviderAudio>;
}
