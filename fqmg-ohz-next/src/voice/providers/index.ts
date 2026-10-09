import type { VoiceProviderAdapter, VoiceProviderEnvironment } from "@/voice/providers/provider";
import { AzureSpeechAdapter } from "@/voice/providers/azure-speech";
import { ElevenLabsAdapter } from "@/voice/providers/elevenlabs";
import { GoogleCloudTtsAdapter } from "@/voice/providers/google-cloud-tts";
import { OpenAITtsAdapter } from "@/voice/providers/openai-tts";

export function createDefaultVoiceProviders(
  environment: VoiceProviderEnvironment = process.env,
): VoiceProviderAdapter[] {
  return [
    new AzureSpeechAdapter(environment),
    new ElevenLabsAdapter(environment),
    new GoogleCloudTtsAdapter(environment),
    new OpenAITtsAdapter(environment),
  ];
}

export type { VoiceProviderAdapter, ProviderAudio } from "@/voice/providers/provider";
export { VoiceProviderError } from "@/voice/providers/provider";
