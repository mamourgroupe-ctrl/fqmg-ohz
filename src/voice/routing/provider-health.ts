import {
  VoiceProviderHealthSchema,
  type VoiceProviderHealth,
  type VoiceProviderId,
} from "@/voice/contracts/voice-contract";

const MAX_RECENT_SAMPLES = 20;

interface ProviderSample {
  succeeded: boolean;
  latencyMs: number;
  completedAt: string;
}

interface ProviderHistory {
  samples: ProviderSample[];
  consecutiveFailures: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
}

export class VoiceProviderHealthTracker {
  private readonly history = new Map<VoiceProviderId, ProviderHistory>();

  record(providerId: VoiceProviderId, succeeded: boolean, latencyMs: number, at = new Date()): void {
    const previous = this.history.get(providerId) ?? { samples: [], consecutiveFailures: 0 };
    const completedAt = at.toISOString();
    const sample: ProviderSample = {
      succeeded,
      latencyMs: Math.max(0, Number.isFinite(latencyMs) ? latencyMs : 0),
      completedAt,
    };
    const samples = [...previous.samples, sample].slice(-MAX_RECENT_SAMPLES);
    this.history.set(providerId, {
      samples,
      consecutiveFailures: succeeded ? 0 : previous.consecutiveFailures + 1,
      lastSuccessAt: succeeded ? completedAt : previous.lastSuccessAt,
      lastFailureAt: succeeded ? previous.lastFailureAt : completedAt,
    });
  }

  snapshot(
    providerId: VoiceProviderId,
    configured: boolean,
    voiceCount: number,
    algerianVoiceCount: number,
    inventoryStatus: VoiceProviderHealth["inventoryStatus"] = "unknown",
    checkedAt = new Date(),
  ): VoiceProviderHealth {
    const history = this.history.get(providerId);
    const samples = history?.samples ?? [];
    const recentSuccessRate = samples.length > 0
      ? samples.filter((sample) => sample.succeeded).length / samples.length
      : null;
    const meanLatencyMs = samples.length > 0
      ? samples.reduce((sum, sample) => sum + sample.latencyMs, 0) / samples.length
      : null;

    let status: VoiceProviderHealth["status"] = "unknown";
    if (!configured) status = "not-configured";
    else if (history?.consecutiveFailures && history.consecutiveFailures >= 3) status = "unhealthy";
    else if (recentSuccessRate !== null && recentSuccessRate < 0.5) status = "degraded";
    else if (recentSuccessRate !== null) status = "healthy";

    return VoiceProviderHealthSchema.parse({
      providerId,
      configured,
      status,
      inventoryStatus,
      voiceCount,
      algerianVoiceCount,
      recentSuccessRate,
      meanLatencyMs,
      consecutiveFailures: history?.consecutiveFailures ?? 0,
      lastSuccessAt: history?.lastSuccessAt,
      lastFailureAt: history?.lastFailureAt,
      checkedAt: checkedAt.toISOString(),
    });
  }
}
