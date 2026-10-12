import { VoiceEngine } from "@/voice/routing/voice-engine";

const globalVoiceRuntime = globalThis as typeof globalThis & {
  __fqmgVoiceEngine?: VoiceEngine;
};

export function getVoiceEngine(): VoiceEngine {
  globalVoiceRuntime.__fqmgVoiceEngine ??= new VoiceEngine();
  return globalVoiceRuntime.__fqmgVoiceEngine;
}
