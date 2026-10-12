import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  VoiceProfileSchema,
  VoiceSelectionSchema,
  VoiceSynthesisRequestSchema,
  type VoiceProfile,
  type VoiceProviderId,
  type VoiceSynthesisRequest,
} from "@/voice/contracts/voice-contract";
import { VoiceProviderError, type ProviderAudio, type VoiceProviderAdapter } from "@/voice/providers/provider";
import { VoiceEngine, VoiceEngineError } from "@/voice/routing/voice-engine";
import { VoiceProviderHealthTracker } from "@/voice/routing/provider-health";
import { VoiceSynthesisCache } from "@/voice/cache/synthesis-cache";
import { ProjectVoicePinStore } from "@/voice/state/project-voice-pin-store";

const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00]);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeStorage(): { pinStore: ProjectVoicePinStore; cache: VoiceSynthesisCache } {
  const directory = mkdtempSync(path.join(tmpdir(), "fqmg-voice-test-"));
  temporaryDirectories.push(directory);
  return {
    pinStore: new ProjectVoicePinStore(path.join(directory, "pins")),
    cache: new VoiceSynthesisCache({ directory: path.join(directory, "audio") }),
  };
}

function makeProfile(
  providerId: VoiceProviderId,
  voiceId: string,
  options: Partial<VoiceProfile> = {},
): VoiceProfile {
  return VoiceProfileSchema.parse({
    providerId,
    voiceId,
    displayName: voiceId,
    modelId: `${providerId}-model`,
    languageTags: [],
    localeTags: [],
    verifiedLanguageTags: [],
    verifiedDialects: [],
    styles: [],
    evidenceSource: "account-inventory",
    ...options,
  });
}

class FixtureVoiceProvider implements VoiceProviderAdapter {
  readonly requiredEnvironment = ["FIXTURE_PROVIDER"] as const;
  readonly supportsFreeformStyle = false;
  readonly synthesizeAttempts: Array<{ request: VoiceSynthesisRequest; voiceId: string }> = [];
  private readonly failures: VoiceProviderError[];

  constructor(
    readonly id: VoiceProviderId,
    readonly voices: VoiceProfile[],
    private readonly configured = true,
    failures: VoiceProviderError[] = [],
  ) {
    this.failures = [...failures];
  }

  isConfigured(): boolean {
    return this.configured;
  }

  async listVoices(): Promise<VoiceProfile[]> {
    return this.voices;
  }

  async synthesize(request: VoiceSynthesisRequest, voice: VoiceProfile): Promise<ProviderAudio> {
    this.synthesizeAttempts.push({ request, voiceId: voice.voiceId });
    const failure = this.failures.shift();
    if (failure) throw failure;
    return { bytes: Buffer.from(mp3), mimeType: "audio/mpeg", modelId: voice.modelId ?? `${this.id}-model` };
  }
}

class FailingInventoryProvider extends FixtureVoiceProvider {
  async listVoices(): Promise<VoiceProfile[]> {
    throw new VoiceProviderError(this.id, "network");
  }
}

function voiceRequest(overrides: Record<string, unknown> = {}): VoiceSynthesisRequest {
  return VoiceSynthesisRequestSchema.parse({
    projectId: "project-engine-test",
    text: "A short fixture narration.",
    languageTag: "en-US",
    ...overrides,
  });
}

function engine(providers: VoiceProviderAdapter[], options: {
  order?: string;
  maxRetries?: number;
  maxFallbacks?: number;
  healthTracker?: VoiceProviderHealthTracker;
} = {}): VoiceEngine {
  const storage = makeStorage();
  return new VoiceEngine({
    providers,
    environment: { VOICE_PROVIDER_ORDER: options.order },
    pinStore: storage.pinStore,
    cache: storage.cache,
    maxRetries: options.maxRetries ?? 0,
    maxFallbacks: options.maxFallbacks ?? 2,
    healthTracker: options.healthTracker,
    backoffMs: 0,
  });
}

function fixtureMp3Profile(providerId: VoiceProviderId, voiceId: string, locale: string): VoiceProfile {
  const baseLanguage = locale.split("-")[0];
  return makeProfile(providerId, voiceId, {
    languageTags: [baseLanguage],
    localeTags: [locale],
    verifiedLanguageTags: [locale],
  });
}

describe("VoiceEngine capability routing", () => {
  it("prefers exact inventory locale evidence over a generic documented language", async () => {
    const generic = makeProfile("openai", "generic-voice", {
      languageTags: ["ar"],
      evidenceSource: "provider-documentation",
    });
    const exact = fixtureMp3Profile("azure-speech", "fixture-exact-voice", "ar-DZ");
    const openai = new FixtureVoiceProvider("openai", [generic]);
    const azure = new FixtureVoiceProvider("azure-speech", [exact]);
    const runner = engine([openai, azure], {
      order: "openai,azure-speech",
      maxRetries: 0,
      maxFallbacks: 0,
    });

    const result = await runner.synthesize(voiceRequest({
      projectId: "exact-locale-project",
      languageTag: "ar-DZ",
      allowUnverifiedDialect: true,
    }));

    expect(result.providerId).toBe("azure-speech");
    expect(result.selection.capabilityConfidence).toBe("exact-locale-inventory");
    expect(result.disclosures).toEqual([]);
    expect(openai.synthesizeAttempts).toHaveLength(0);
    expect(azure.synthesizeAttempts).toHaveLength(1);
  });

  it("fails closed for AUTO Algerian Arabic when only generic Arabic is documented", async () => {
    const generic = makeProfile("openai", "generic-voice", {
      languageTags: ["ar"],
      evidenceSource: "provider-documentation",
    });
    const openai = new FixtureVoiceProvider("openai", [generic]);
    const runner = engine([openai], { maxRetries: 0, maxFallbacks: 0 });

    await expect(runner.synthesize(voiceRequest({
      projectId: "strict-dialect-project",
      languageTag: "ar-DZ",
    }))).rejects.toMatchObject({
      code: "UNVERIFIED_DIALECT",
      status: 422,
    });
    expect(openai.synthesizeAttempts).toHaveLength(0);
  });

  it("allows an explicit voice ID with a clear unverified-capability disclosure", async () => {
    const generic = makeProfile("openai", "generic-voice", {
      languageTags: ["ar"],
      evidenceSource: "provider-documentation",
    });
    const openai = new FixtureVoiceProvider("openai", [generic]);
    const runner = engine([openai]);

    const result = await runner.synthesize(voiceRequest({
      projectId: "manual-voice-project",
      languageTag: "ar-DZ",
      provider: "openai",
      voiceId: "generic-voice",
    }));

    expect(result.selection.capabilityConfidence).toBe("manual-unverified");
    expect(result.disclosures.join(" ")).toContain("does not verify");
    expect(openai.synthesizeAttempts).toHaveLength(1);
  });

  it("permits approximate AUTO locale matching only with explicit opt-in and discloses it", async () => {
    const generic = makeProfile("openai", "generic-voice", {
      languageTags: ["ar"],
      evidenceSource: "provider-documentation",
    });
    const openai = new FixtureVoiceProvider("openai", [generic]);
    const runner = engine([openai]);

    const result = await runner.synthesize(voiceRequest({
      projectId: "approximate-project",
      languageTag: "ar-DZ",
      allowUnverifiedDialect: true,
    }));

    expect(result.selection.capabilityConfidence).toBe("documented-language-only");
    expect(result.disclosures.join(" ")).toContain("not verified");
  });

  it("retries transient errors a bounded number of times, then discloses a provider fallback", async () => {
    const openaiVoice = fixtureMp3Profile("openai", "openai-voice", "en-US");
    const azureVoice = fixtureMp3Profile("azure-speech", "azure-voice", "en-US");
    const openai = new FixtureVoiceProvider("openai", [openaiVoice], true, [
      new VoiceProviderError("openai", "rate-limited"),
      new VoiceProviderError("openai", "rate-limited"),
    ]);
    const azure = new FixtureVoiceProvider("azure-speech", [azureVoice]);
    const runner = engine([openai, azure], {
      order: "openai,azure-speech",
      maxRetries: 1,
      maxFallbacks: 1,
    });

    const result = await runner.synthesize(voiceRequest({ projectId: "retry-fallback-project" }));

    expect(openai.synthesizeAttempts).toHaveLength(2);
    expect(azure.synthesizeAttempts).toHaveLength(1);
    expect(result.providerId).toBe("azure-speech");
    expect(result.fallback).toMatchObject({
      fromProviderId: "openai",
      toProviderId: "azure-speech",
      reason: "rate-limited",
    });
  });

  it("keeps the selected provider and voice pinned per project", async () => {
    const first = new FixtureVoiceProvider("azure-speech", [fixtureMp3Profile("azure-speech", "first-voice", "en-US")]);
    const second = new FixtureVoiceProvider("openai", [fixtureMp3Profile("openai", "second-voice", "en-US")]);
    const runner = engine([first, second], { order: "azure-speech,openai", maxRetries: 0 });

    const firstResult = await runner.synthesize(voiceRequest({ projectId: "pinned-project" }));
    runner.healthTracker.record("openai", true, 1);
    runner.healthTracker.record("openai", true, 1);
    runner.healthTracker.record("openai", true, 1);
    const secondResult = await runner.synthesize(voiceRequest({ projectId: "pinned-project" }));
    const pin = await runner.pinStore.get("pinned-project");

    expect(firstResult.providerId).toBe("azure-speech");
    expect(secondResult.providerId).toBe("azure-speech");
    expect(secondResult.selection.voiceId).toBe("first-voice");
    expect(pin?.providerId).toBe("azure-speech");
    expect(second.synthesizeAttempts).toHaveLength(0);
  });

  it("seeds a project pin from Motion Specification metadata inside the project lock and rejects conflicts", async () => {
    const voice = fixtureMp3Profile("azure-speech", "persisted-voice", "en-US");
    const provider = new FixtureVoiceProvider("azure-speech", [voice]);
    const runner = engine([provider], { maxRetries: 0 });
    const persistedSelection = VoiceSelectionSchema.parse({
      providerId: "azure-speech",
      voiceId: "persisted-voice",
      voiceName: "Persisted voice",
      modelId: voice.modelId,
      languageTag: "en-US",
      matchedLocaleTag: "en-US",
      capabilityConfidence: "exact-locale-inventory",
      selectedAt: "2026-10-09T12:00:00.000Z",
    });

    const result = await runner.synthesize(
      voiceRequest({ projectId: "specification-pin-project" }),
      { projectVoiceSelection: persistedSelection },
    );
    expect(result.selection.voiceId).toBe("persisted-voice");
    expect((await runner.pinStore.get("specification-pin-project"))?.voiceId).toBe("persisted-voice");

    const conflictingSelection = VoiceSelectionSchema.parse({
      ...persistedSelection,
      voiceId: "another-voice",
    });
    await expect(runner.synthesize(
      voiceRequest({ projectId: "specification-pin-project" }),
      { projectVoiceSelection: conflictingSelection },
    )).rejects.toMatchObject({ code: "PROJECT_VOICE_CONFLICT", status: 409 });
    expect(provider.synthesizeAttempts).toHaveLength(1);
  });

  it("reports provider health using recent API success rate and latency", async () => {
    const provider = new FixtureVoiceProvider("azure-speech", [fixtureMp3Profile("azure-speech", "english-voice", "en-US")]);
    const tracker = new VoiceProviderHealthTracker();
    const runner = engine([provider], { healthTracker: tracker });
    tracker.record("azure-speech", true, 20, new Date("2026-10-09T11:59:00.000Z"));
    tracker.record("azure-speech", false, 80, new Date("2026-10-09T11:59:01.000Z"));

    const [health] = await runner.getProviderHealth("en-US");

    expect(health).toMatchObject({
      configured: true,
      recentSuccessRate: 0.5,
      consecutiveFailures: 1,
      voiceCount: 1,
      algerianVoiceCount: 0,
    });
    expect(health.meanLatencyMs).toBeGreaterThan(0);
  });

  it("distinguishes an unavailable voice inventory from a successful empty inventory", async () => {
    const provider = new FailingInventoryProvider("azure-speech", [], true);
    const runner = engine([provider], { maxRetries: 0 });
    const [health] = await runner.getProviderHealth("ar-DZ");

    expect(health.configured).toBe(true);
    expect(health.inventoryStatus).toBe("unavailable");
    expect(health.voiceCount).toBe(0);
    expect(health.algerianVoiceCount).toBe(0);
  });

  it("does not exceed configured retries or fallback providers", async () => {
    const p1 = new FixtureVoiceProvider("openai", [fixtureMp3Profile("openai", "v1", "en-US")], true, [
      new VoiceProviderError("openai", "timeout"),
      new VoiceProviderError("openai", "timeout"),
    ]);
    const p2 = new FixtureVoiceProvider("azure-speech", [fixtureMp3Profile("azure-speech", "v2", "en-US")], true, [
      new VoiceProviderError("azure-speech", "timeout"),
    ]);
    const p3 = new FixtureVoiceProvider("elevenlabs", [fixtureMp3Profile("elevenlabs", "v3", "en-US")]);
    const runner = engine([p1, p2, p3], {
      order: "openai,azure-speech,elevenlabs",
      maxRetries: 1,
      maxFallbacks: 1,
    });

    const result = await runner.synthesize(voiceRequest({ projectId: "bounded-project" }));

    expect(p1.synthesizeAttempts).toHaveLength(2);
    expect(p2.synthesizeAttempts).toHaveLength(2);
    expect(p3.synthesizeAttempts).toHaveLength(0);
    expect(result.providerId).toBe("azure-speech");
  });

  it("reports no provider as ready when no credentials are configured", async () => {
    const storage = makeStorage();
    const runner = new VoiceEngine({
      environment: {},
      pinStore: storage.pinStore,
      cache: storage.cache,
      maxRetries: 0,
    });
    await expect(runner.synthesize(voiceRequest({ projectId: "unconfigured-project" }))).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED",
      status: 503,
    });
    const health = await runner.getProviderHealth("ar-DZ");
    expect(health.every((entry) => entry.status === "not-configured")).toBe(true);
  });

  it("rejects malformed requests before touching a provider", async () => {
    const provider = new FixtureVoiceProvider("azure-speech", [fixtureMp3Profile("azure-speech", "test", "en-US")]);
    const runner = engine([provider]);
    await expect(runner.synthesize({ projectId: "../bad", text: "hello", languageTag: "en-US" })).rejects.toBeInstanceOf(VoiceEngineError);
    expect(provider.synthesizeAttempts).toHaveLength(0);
  });
});
