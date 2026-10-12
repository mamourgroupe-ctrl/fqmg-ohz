import { performance } from "node:perf_hooks";
import path from "node:path";
import type { z } from "zod";
import {
  VoiceApiErrorCodeSchema,
  VoiceFallbackDisclosureSchema,
  VoiceProfileSchema,
  VoiceSelectionSchema,
  VoiceSynthesisRequestSchema,
  type VoiceAudioReference,
  type VoiceCapabilityConfidence,
  type VoiceFallbackDisclosure,
  type VoiceProfile,
  type VoiceProviderHealth,
  type VoiceProviderId,
  type VoiceSynthesisRequest,
  type VoiceSelection,
} from "@/voice/contracts/voice-contract";
import { createDefaultVoiceProviders } from "@/voice/providers";
import { validateProviderMp3Bytes } from "@/voice/providers/provider-utils";
import { buildVoiceSynthesisIdentity, VoiceCacheError, VoiceSynthesisCache } from "@/voice/cache/synthesis-cache";
import {
  VoiceProviderError,
  type ProviderAudio,
  type VoiceProviderAdapter,
  type VoiceProviderEnvironment,
} from "@/voice/providers/provider";
import { VoiceProviderHealthTracker } from "@/voice/routing/provider-health";
import { ProjectVoicePinStore, VoicePinStoreError } from "@/voice/state/project-voice-pin-store";

const DEFAULT_PROVIDER_ORDER: VoiceProviderId[] = ["azure-speech", "elevenlabs", "google-cloud", "openai"];
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_INVENTORY_TTL_MS = 30_000;
const FAILED_INVENTORY_TTL_MS = 5_000;
const MAX_PROVIDER_VOICES = 10_000;

const CAPABILITY_RANK: Record<VoiceCapabilityConfidence, number> = {
  "exact-locale-inventory": 5,
  "verified-dialect-inventory": 4,
  "verified-language-inventory": 3,
  "documented-language-only": 2,
  "manual-unverified": 1,
};

export type VoiceEngineErrorCode = z.infer<typeof VoiceApiErrorCodeSchema>;

const ENGINE_ERROR_DEFAULTS: Record<VoiceEngineErrorCode, { status: number; retryable: boolean }> = {
  INVALID_REQUEST: { status: 400, retryable: false },
  PROVIDER_NOT_CONFIGURED: { status: 503, retryable: false },
  PROJECT_VOICE_CONFLICT: { status: 409, retryable: false },
  NO_COMPATIBLE_VOICE: { status: 422, retryable: false },
  UNVERIFIED_DIALECT: { status: 422, retryable: false },
  PROVIDER_TIMEOUT: { status: 504, retryable: true },
  PROVIDER_UNAVAILABLE: { status: 502, retryable: true },
  SYNTHESIS_FAILED: { status: 502, retryable: false },
  AUDIO_NOT_FOUND: { status: 404, retryable: false },
  INTERNAL_ERROR: { status: 500, retryable: false },
};

export class VoiceEngineError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    readonly code: VoiceEngineErrorCode,
    message: string,
    options?: { status?: number; retryable?: boolean },
  ) {
    super(message);
    this.name = "VoiceEngineError";
    this.status = options?.status ?? ENGINE_ERROR_DEFAULTS[code].status;
    this.retryable = options?.retryable ?? ENGINE_ERROR_DEFAULTS[code].retryable;
  }
}

export interface VoiceEngineOutcome {
  projectId: string;
  request: VoiceSynthesisRequest;
  providerId: VoiceProviderId;
  profile: VoiceProfile;
  selection: VoiceSelection;
  audio: ProviderAudio;
  audioReference: VoiceAudioReference;
  latencyMs: number;
  cacheHit: boolean;
  fallback?: VoiceFallbackDisclosure;
  disclosures: string[];
  completedAt: string;
}

export interface VoiceEngineOptions {
  providers?: VoiceProviderAdapter[];
  environment?: VoiceProviderEnvironment;
  healthTracker?: VoiceProviderHealthTracker;
  pinStore?: ProjectVoicePinStore;
  cache?: VoiceSynthesisCache;
  requestTimeoutMs?: number;
  maxRetries?: number;
  maxFallbacks?: number;
  inventoryTtlMs?: number;
  backoffMs?: number;
}

interface InventoryEntry {
  expiresAt: number;
  voices: VoiceProfile[];
  failure?: VoiceProviderError;
}

interface CapabilityMatch {
  confidence: VoiceCapabilityConfidence;
  matchedLocaleTag?: string;
  requestedDialectVerified: boolean;
}

interface RankedVoiceCandidate extends CapabilityMatch {
  provider: VoiceProviderAdapter;
  profile: VoiceProfile;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function getProviderOrder(environment: VoiceProviderEnvironment): VoiceProviderId[] {
  const configured = environment.VOICE_PROVIDER_ORDER?.split(",").map((value) => value.trim()) ?? [];
  const allowed = new Set<VoiceProviderId>(DEFAULT_PROVIDER_ORDER);
  const order = configured.filter((value): value is VoiceProviderId => allowed.has(value as VoiceProviderId));
  return [...new Set([...order, ...DEFAULT_PROVIDER_ORDER])];
}

function safeConfigured(provider: VoiceProviderAdapter): boolean {
  try {
    return provider.isConfigured();
  } catch {
    return false;
  }
}

function normalizedLabel(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("en")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function isAlgerianLabel(value: string): boolean {
  return new Set([
    "algerian",
    "algerianarabic",
    "arabicalgeria",
    "arabicofalgeria",
    "ardz",
    "dz",
    "الجزائرية",
    "جزائري",
    "جزائرية",
  ]).has(normalizedLabel(value));
}

function hasAlgerianEvidence(profile: VoiceProfile): boolean {
  const supportedTags = [...profile.localeTags, ...profile.verifiedLanguageTags];
  return supportedTags.some((tag) => tag.toLowerCase() === "ar-dz") ||
    profile.verifiedDialects.some(isAlgerianLabel);
}

function isAlgerianRequest(request: VoiceSynthesisRequest): boolean {
  return request.languageTag.toLowerCase() === "ar-dz" ||
    (request.dialect ? isAlgerianLabel(request.dialect) : false);
}

function hasRegionOrDialectRequest(request: VoiceSynthesisRequest): boolean {
  return Boolean(request.dialect) || request.languageTag.includes("-");
}

function matchesVerifiedDialect(profile: VoiceProfile, dialect: string): boolean {
  const normalized = normalizedLabel(dialect);
  if (!normalized) return false;
  if (isAlgerianLabel(dialect)) return hasAlgerianEvidence(profile);
  return profile.verifiedDialects.some((label) => normalizedLabel(label) === normalized);
}

function matchVoiceCapability(
  request: VoiceSynthesisRequest,
  profile: VoiceProfile,
  manuallySelected: boolean,
): CapabilityMatch | undefined {
  const requestedBase = request.languageTag.split("-")[0].toLowerCase();
  const matchingLocaleTag = [...profile.localeTags, ...profile.verifiedLanguageTags]
    .find((tag) => tag.toLowerCase() === request.languageTag.toLowerCase());
  const exactLocale = !request.dialect && Boolean(matchingLocaleTag);
  const exactDialect = request.dialect
    ? matchesVerifiedDialect(profile, request.dialect)
    : false;
  const algerianLocaleMatch = isAlgerianRequest(request) && hasAlgerianEvidence(profile);
  const exact = exactLocale || exactDialect || algerianLocaleMatch;

  const requestedDialectVerified = Boolean(
    (request.dialect || request.languageTag.includes("-")) && exact,
  );
  if (exact) {
    const localeEvidence = Boolean(
      matchingLocaleTag &&
      (!request.dialect || (isAlgerianRequest(request) && matchingLocaleTag.toLowerCase() === "ar-dz")),
    );
    return {
      confidence: localeEvidence ? "exact-locale-inventory" : "verified-dialect-inventory",
      matchedLocaleTag: localeEvidence ? matchingLocaleTag : undefined,
      requestedDialectVerified,
    };
  }

  const languageMatches = [
    ...profile.languageTags,
    ...profile.localeTags,
    ...profile.verifiedLanguageTags,
  ].some((tag) => tag.split("-")[0].toLowerCase() === requestedBase);
  const verifiedLanguageMatches = [
    ...profile.localeTags,
    ...profile.verifiedLanguageTags,
  ].some((tag) => tag.split("-")[0].toLowerCase() === requestedBase);

  if (languageMatches && (!hasRegionOrDialectRequest(request) || request.allowUnverifiedDialect)) {
    return {
      confidence: verifiedLanguageMatches ? "verified-language-inventory" : "documented-language-only",
      matchedLocaleTag: [
        ...profile.localeTags,
        ...profile.verifiedLanguageTags,
      ].find((tag) => tag.split("-")[0].toLowerCase() === requestedBase),
      requestedDialectVerified: false,
    };
  }

  if (manuallySelected) {
    return {
      confidence: "manual-unverified",
      requestedDialectVerified: false,
    };
  }

  return undefined;
}

function isStyleCompatible(
  provider: VoiceProviderAdapter,
  profile: VoiceProfile,
  request: VoiceSynthesisRequest,
): boolean {
  if (!request.voiceStyle) return true;
  if (provider.supportsFreeformStyle) return true;
  const normalizedRequest = normalizedLabel(request.voiceStyle);
  return profile.styles.some((style) => normalizedLabel(style) === normalizedRequest);
}

function getDisclosure(
  request: VoiceSynthesisRequest,
  profile: VoiceProfile,
  confidence: VoiceCapabilityConfidence,
): string | undefined {
  if (confidence === "manual-unverified") {
    return "This voice was selected explicitly, but its provider metadata does not verify the requested language or dialect.";
  }
  if (confidence === "documented-language-only" && hasRegionOrDialectRequest(request)) {
    return "Provider documentation lists the base language, but this voice's requested region or dialect is not verified.";
  }
  if (
    confidence === "verified-language-inventory" &&
    (request.dialect || request.languageTag.includes("-"))
  ) {
    return "The provider inventory confirms the base language, but not the requested region or dialect.";
  }
  if (isAlgerianRequest(request) && !hasAlgerianEvidence(profile)) {
    return "Algerian Arabic was requested, but this voice's inventory does not verify that dialect.";
  }
  return undefined;
}

function failureReason(error: VoiceProviderError): VoiceFallbackDisclosure["reason"] {
  if (error.code === "timeout") return "timeout";
  if (error.code === "rate-limited") return "rate-limited";
  if (error.code === "not-found") return "pinned-voice-unavailable";
  if (error.code === "network" || error.code === "unavailable" || error.code === "authentication") {
    return "provider-unavailable";
  }
  return "provider-error";
}

function toPublicEngineError(error: unknown): VoiceEngineError {
  if (error instanceof VoiceEngineError) return error;
  if (error instanceof VoicePinStoreError) {
    return new VoiceEngineError("INTERNAL_ERROR", "Project voice preferences could not be saved safely.");
  }
  if (error instanceof VoiceCacheError) {
    return new VoiceEngineError("INTERNAL_ERROR", "Generated voice audio could not be stored locally.");
  }
  if (error instanceof VoiceProviderError) {
    if (error.code === "not-configured") {
      return new VoiceEngineError("PROVIDER_NOT_CONFIGURED", "The selected voice provider is not configured.");
    }
    if (error.code === "timeout") {
      return new VoiceEngineError("PROVIDER_TIMEOUT", "The voice provider request timed out.");
    }
    if (error.retryable) {
      return new VoiceEngineError("PROVIDER_UNAVAILABLE", "The voice provider is temporarily unavailable.");
    }
    return new VoiceEngineError("SYNTHESIS_FAILED", "The voice provider could not synthesize this request.");
  }
  return new VoiceEngineError("INTERNAL_ERROR", "The voice engine could not complete the request.");
}

function sameVoiceIdentity(left: VoiceSelection, right: VoiceSelection): boolean {
  return left.providerId === right.providerId &&
    left.voiceId === right.voiceId &&
    (left.modelId ?? "") === (right.modelId ?? "");
}

function buildVoiceSelection(
  request: VoiceSynthesisRequest,
  candidate: RankedVoiceCandidate,
  pinned?: VoiceSelection,
): VoiceSelection {
  if (
    pinned &&
    pinned.providerId === candidate.provider.id &&
    pinned.voiceId === candidate.profile.voiceId &&
    pinned.modelId === candidate.profile.modelId &&
    pinned.languageTag === request.languageTag &&
    normalizedLabel(pinned.dialect ?? "") === normalizedLabel(request.dialect ?? "")
  ) {
    return VoiceSelectionSchema.parse({
      ...pinned,
      voiceName: candidate.profile.displayName ?? pinned.voiceName,
      matchedLocaleTag: candidate.matchedLocaleTag ?? pinned.matchedLocaleTag,
      capabilityConfidence: candidate.confidence,
    });
  }

  return VoiceSelectionSchema.parse({
    providerId: candidate.provider.id,
    voiceId: candidate.profile.voiceId,
    voiceName: candidate.profile.displayName,
    modelId: candidate.profile.modelId,
    languageTag: request.languageTag,
    dialect: request.dialect,
    matchedLocaleTag: candidate.matchedLocaleTag,
    capabilityConfidence: candidate.confidence,
    selectedAt: new Date().toISOString(),
  });
}

export class VoiceEngine {
  readonly providers: readonly VoiceProviderAdapter[];
  readonly healthTracker: VoiceProviderHealthTracker;
  readonly pinStore: ProjectVoicePinStore;
  readonly cache: VoiceSynthesisCache;

  private readonly providersById: Map<VoiceProviderId, VoiceProviderAdapter>;
  private readonly environment: VoiceProviderEnvironment;
  private readonly providerOrder: VoiceProviderId[];
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxFallbacks: number;
  private readonly inventoryTtlMs: number;
  private readonly backoffMs: number;
  private readonly inventoryCache = new Map<string, InventoryEntry>();

  constructor(options: VoiceEngineOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.providers = options.providers ?? createDefaultVoiceProviders(this.environment);
    this.providersById = new Map(this.providers.map((provider) => [provider.id, provider]));
    if (this.providersById.size !== this.providers.length) {
      throw new Error("Voice provider IDs must be unique.");
    }
    this.healthTracker = options.healthTracker ?? new VoiceProviderHealthTracker();
    const cacheDirectory = this.environment.VOICE_CACHE_DIR?.trim() || path.join(process.cwd(), ".voice-cache");
    this.pinStore = options.pinStore ?? new ProjectVoicePinStore(cacheDirectory);
    this.cache = options.cache ?? new VoiceSynthesisCache({
      directory: cacheDirectory,
      environment: this.environment,
    });
    this.providerOrder = getProviderOrder(this.environment);
    this.requestTimeoutMs = Math.max(250, Math.min(60_000, Math.floor(options.requestTimeoutMs ?? boundedInteger(
      this.environment.VOICE_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      250,
      60_000,
    ))));
    this.maxRetries = Math.max(0, Math.min(2, Math.floor(options.maxRetries ?? boundedInteger(this.environment.VOICE_MAX_RETRIES, 1, 0, 2))));
    this.maxFallbacks = Math.max(0, Math.min(3, Math.floor(options.maxFallbacks ?? boundedInteger(this.environment.VOICE_MAX_FALLBACKS, 1, 0, 3))));
    this.inventoryTtlMs = Math.max(0, Math.min(300_000, Math.floor(options.inventoryTtlMs ?? boundedInteger(
      this.environment.VOICE_INVENTORY_TTL_MS,
      DEFAULT_INVENTORY_TTL_MS,
      0,
      300_000,
    ))));
    this.backoffMs = Math.max(0, Math.min(1_000, Math.floor(options.backoffMs ?? 250)));
  }

  async listVoices(languageTag: string, providerId?: VoiceProviderId): Promise<VoiceProfile[]> {
    const requestedProviders = providerId
      ? [this.providersById.get(providerId)].filter((provider): provider is VoiceProviderAdapter => Boolean(provider))
      : this.providersInOrder();
    const inventories = await Promise.all(requestedProviders.map((provider) => this.loadInventory(provider, languageTag)));
    return inventories.flatMap((entry) => entry.voices);
  }

  async getProviderHealth(languageTag: string): Promise<VoiceProviderHealth[]> {
    const orderedProviders = this.providersInOrder();
    const inventories = await Promise.all(orderedProviders.map((provider) => this.loadInventory(provider, languageTag)));
    return orderedProviders.map((provider, index) => {
      const inventory = inventories[index];
      const voices = inventory.voices;
      const configured = safeConfigured(provider);
      const inventoryStatus = !configured
        ? "not-configured"
        : inventory.failure
          ? "unavailable"
          : voices.length > 0
            ? "available"
            : "empty";
      return this.healthTracker.snapshot(
        provider.id,
        configured,
        voices.length,
        voices.filter(hasAlgerianEvidence).length,
        inventoryStatus,
      );
    });
  }

  async synthesize(
    input: unknown,
    options: { projectVoiceSelection?: VoiceSelection } = {},
  ): Promise<VoiceEngineOutcome> {
    const parsed = VoiceSynthesisRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new VoiceEngineError("INVALID_REQUEST", "The voice request did not pass validation.");
    }
    const projectSelection = options.projectVoiceSelection === undefined
      ? undefined
      : VoiceSelectionSchema.safeParse(options.projectVoiceSelection);
    if (projectSelection && !projectSelection.success) {
      throw new VoiceEngineError("PROJECT_VOICE_CONFLICT", "The project voice selection is invalid.");
    }

    try {
      return await this.pinStore.runExclusive(parsed.data.projectId, () =>
        this.synthesizeLocked(parsed.data, projectSelection?.data),
      );
    } catch (error) {
      throw toPublicEngineError(error);
    }
  }

  private providersInOrder(): VoiceProviderAdapter[] {
    const orderIndex = new Map(this.providerOrder.map((providerId, index) => [providerId, index]));
    return [...this.providers].sort((left, right) =>
      (orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  private async loadInventory(provider: VoiceProviderAdapter, languageTag: string): Promise<InventoryEntry> {
    if (!safeConfigured(provider)) {
      return { expiresAt: Date.now() + FAILED_INVENTORY_TTL_MS, voices: [], failure: new VoiceProviderError(provider.id, "not-configured") };
    }

    const key = `${provider.id}\u0000${languageTag}`;
    const cached = this.inventoryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached;

    try {
      const voices = await provider.listVoices(languageTag, AbortSignal.timeout(this.requestTimeoutMs));
      if (voices.length > MAX_PROVIDER_VOICES) throw new VoiceProviderError(provider.id, "invalid-response");
      const normalized = voices.map((voice) => {
        const parsed = VoiceProfileSchema.safeParse(voice);
        if (!parsed.success || parsed.data.providerId !== provider.id) {
          throw new VoiceProviderError(provider.id, "invalid-response");
        }
        return parsed.data;
      });
      const entry: InventoryEntry = { expiresAt: Date.now() + this.inventoryTtlMs, voices: normalized };
      this.inventoryCache.set(key, entry);
      return entry;
    } catch (error) {
      const failure = error instanceof VoiceProviderError
        ? error
        : new VoiceProviderError(provider.id, "unavailable");
      const entry: InventoryEntry = {
        expiresAt: Date.now() + FAILED_INVENTORY_TTL_MS,
        voices: [],
        failure,
      };
      this.inventoryCache.set(key, entry);
      return entry;
    }
  }

  private async synthesizeLocked(
    request: VoiceSynthesisRequest,
    projectVoiceSelection?: VoiceSelection,
  ): Promise<VoiceEngineOutcome> {
    const operationStartedAt = performance.now();
    let pinned = await this.pinStore.get(request.projectId);
    if (projectVoiceSelection) {
      if (pinned && !sameVoiceIdentity(pinned, projectVoiceSelection)) {
        throw new VoiceEngineError(
          "PROJECT_VOICE_CONFLICT",
          "The project specification and server-pinned voice differ. Refresh the project before synthesizing.",
        );
      }
      if (!pinned) {
        await this.pinStore.set(request.projectId, projectVoiceSelection);
        pinned = projectVoiceSelection;
      }
    }
    const requestedProvider = request.provider === "auto"
      ? undefined
      : this.providersById.get(request.provider);

    if (request.provider !== "auto" && !requestedProvider) {
      throw new VoiceEngineError("PROVIDER_NOT_CONFIGURED", "The selected voice provider is not available.");
    }

    const providers = requestedProvider ? [requestedProvider] : this.providersInOrder();
    const configuredProviders = providers.filter(safeConfigured);
    if (configuredProviders.length === 0) {
      throw new VoiceEngineError("PROVIDER_NOT_CONFIGURED", "No voice provider is configured.");
    }

    const inventories = await Promise.all(configuredProviders.map(async (provider) => ({
      provider,
      inventory: await this.loadInventory(provider, request.languageTag),
    })));
    const pinMatchesRequest = Boolean(
      pinned &&
      pinned.languageTag === request.languageTag &&
      normalizedLabel(pinned.dialect ?? "") === normalizedLabel(request.dialect ?? ""),
    );
    const shouldHonorPin = Boolean(
      pinned &&
      pinMatchesRequest &&
      !request.voiceId &&
      (request.provider === "auto" || request.provider === pinned.providerId),
    );
    const pinProvider = pinned ? this.providersById.get(pinned.providerId) : undefined;
    const pinInventory = pinProvider
      ? inventories.find(({ provider }) => provider.id === pinProvider.id)?.inventory
      : undefined;
    const pinnedVoice = shouldHonorPin && pinInventory?.voices.find((voice) =>
      voice.voiceId === pinned?.voiceId && (!pinned.modelId || voice.modelId === pinned.modelId),
    );
    const pinnedCandidate = pinned && pinProvider && pinnedVoice && shouldHonorPin
      ? this.toCandidate(request, pinProvider, pinnedVoice, true)
      : undefined;
    const pinWasLost = Boolean(shouldHonorPin && pinned && !pinnedCandidate);

    const candidates: RankedVoiceCandidate[] = [];
    for (const { provider, inventory } of inventories) {
      if (inventory.failure) continue;
      for (const profile of inventory.voices) {
        if (request.provider !== "auto" && provider.id !== request.provider) continue;
        if (request.voiceId && profile.voiceId !== request.voiceId) continue;
        if (request.provider !== "auto" && !request.voiceId && shouldHonorPin && pinned?.providerId === provider.id) {
          if (profile.voiceId !== pinned.voiceId) continue;
        }
        const candidate = this.toCandidate(request, provider, profile, Boolean(request.voiceId));
        if (candidate) candidates.push(candidate);
      }
    }

    const providerOrderIndex = new Map(this.providerOrder.map((providerId, index) => [providerId, index]));
    candidates.sort((left, right) => {
      const scoreDelta = this.scoreCandidate(right) - this.scoreCandidate(left);
      if (scoreDelta !== 0) return scoreDelta;
      const providerDelta = (providerOrderIndex.get(left.provider.id) ?? 999) -
        (providerOrderIndex.get(right.provider.id) ?? 999);
      return providerDelta || left.profile.voiceId.localeCompare(right.profile.voiceId);
    });

    const bestCandidateByProvider: RankedVoiceCandidate[] = [];
    const seenProviders = new Set<VoiceProviderId>();
    for (const candidate of candidates) {
      if (seenProviders.has(candidate.provider.id)) continue;
      seenProviders.add(candidate.provider.id);
      bestCandidateByProvider.push(candidate);
    }
    const orderedCandidates = pinnedCandidate
      ? [pinnedCandidate, ...bestCandidateByProvider.filter((candidate) => candidate.provider.id !== pinnedCandidate.provider.id)]
      : pinWasLost && pinned
        ? bestCandidateByProvider.filter((candidate) => candidate.provider.id !== pinned.providerId)
        : bestCandidateByProvider;
    const maxCandidates = request.provider === "auto" ? this.maxFallbacks + 1 : 1;
    const boundedCandidates = orderedCandidates.slice(0, maxCandidates);

    if (boundedCandidates.length === 0) {
      const targetProviders = request.provider === "auto" ? configuredProviders : [requestedProvider!];
      const targetInventories = targetProviders.map((provider) =>
        inventories.find((item) => item.provider.id === provider.id)?.inventory,
      );
      const targetProfiles = targetInventories.flatMap((inventory) => inventory?.voices ?? []);
      const selectedVoiceExists = request.voiceId && targetProfiles.some((voice) => voice.voiceId === request.voiceId);
      const isStrictDialect = isAlgerianRequest(request) || Boolean(request.dialect) || request.languageTag.includes("-");
      const providerFailures = targetInventories.flatMap((inventory) => inventory?.failure ? [inventory.failure] : []);

      if (!selectedVoiceExists && providerFailures.length === targetInventories.length && providerFailures.length > 0) {
        throw toPublicEngineError(providerFailures[0]);
      }
      if (isStrictDialect) {
        throw new VoiceEngineError("UNVERIFIED_DIALECT", "No available voice has verified support for the requested locale or dialect.");
      }
      throw new VoiceEngineError("NO_COMPATIBLE_VOICE", "No available voice matches the requested language and options.");
    }

    let firstFailure: { providerId: VoiceProviderId; error: VoiceProviderError; pinnedUnavailable: boolean } | undefined =
      pinWasLost && pinned
        ? {
          providerId: pinned.providerId,
          error: new VoiceProviderError(pinned.providerId, "not-found"),
          pinnedUnavailable: true,
        }
        : undefined;
    let lastFailure: VoiceProviderError | undefined;

    for (const candidate of boundedCandidates) {
      const providerVoiceId = candidate.profile.voiceId;
      if (
        request.provider !== "auto" &&
        request.voiceId &&
        providerVoiceId !== request.voiceId
      ) continue;

      const synthesisLanguageTag = candidate.matchedLocaleTag ?? request.languageTag;
      const synthesisRequest = synthesisLanguageTag === request.languageTag
        ? request
        : { ...request, languageTag: synthesisLanguageTag };
      const identity = buildVoiceSynthesisIdentity({
        providerId: candidate.provider.id,
        modelId: candidate.profile.modelId ?? candidate.provider.id,
        voiceId: candidate.profile.voiceId,
        text: request.text,
        requestedLanguageTag: request.languageTag,
        synthesisLanguageTag,
        dialect: request.dialect,
        voiceStyle: request.voiceStyle,
        speakingRate: request.speakingRate,
        outputFormat: request.outputFormat,
      });
      let providerAudio: ProviderAudio | undefined;
      let storedObject: { objectKey: string; sizeBytes: number } | undefined;
      let cacheHit = false;
      try {
        const cached = await this.cache.get(identity);
        if (cached) {
          providerAudio = cached.audio;
          storedObject = { objectKey: cached.objectKey, sizeBytes: cached.audio.bytes.length };
          cacheHit = true;
        } else {
          providerAudio = await this.synthesizeWithRetries(candidate, synthesisRequest);
          const stored = await this.cache.put(identity, providerAudio);
          storedObject = { objectKey: stored.objectKey, sizeBytes: stored.audio.bytes.length };
        }
      } catch (error) {
        if (error instanceof VoiceCacheError) {
          throw new VoiceEngineError("INTERNAL_ERROR", "Generated voice audio could not be stored locally.");
        }
        lastFailure = error instanceof VoiceProviderError
          ? error
          : new VoiceProviderError(candidate.provider.id, "unavailable");
        if (!firstFailure) {
          firstFailure = {
            providerId: candidate.provider.id,
            error: lastFailure,
            pinnedUnavailable: pinWasLost && candidate.provider.id !== pinned?.providerId,
          };
        }
        if (request.provider !== "auto") throw toPublicEngineError(lastFailure);
        continue;
      }
      if (!providerAudio || !storedObject) {
        throw new VoiceEngineError("INTERNAL_ERROR", "Generated voice audio could not be stored locally.");
      }

      const audioReference = await this.cache.createReference(storedObject.objectKey, storedObject.sizeBytes);
      const selection = buildVoiceSelection(request, candidate, pinned);
      const disclosure = getDisclosure(request, candidate.profile, candidate.confidence);
      const disclosures = disclosure ? [disclosure] : [];
      const pinIdentityChanged = pinned && (
        pinned.providerId !== candidate.provider.id ||
        pinned.voiceId !== candidate.profile.voiceId ||
        pinned.modelId !== candidate.profile.modelId
      );
      if (pinned && shouldHonorPin && pinIdentityChanged) {
        disclosures.push("The previously pinned project voice was unavailable; a compatible fallback voice was selected.");
      } else if (pinned && !pinMatchesRequest && pinIdentityChanged) {
        disclosures.push("The project language or dialect changed; the compatible project voice selection was updated.");
      } else if (pinned && !shouldHonorPin && pinIdentityChanged) {
        disclosures.push("An explicit provider or voice selection replaced the project's previously pinned voice.");
      }

      let fallback: VoiceFallbackDisclosure | undefined;
      if (firstFailure && firstFailure.providerId !== candidate.provider.id) {
        const reason = firstFailure.pinnedUnavailable ? "pinned-voice-unavailable" : failureReason(firstFailure.error);
        fallback = VoiceFallbackDisclosureSchema.parse({
          fromProviderId: firstFailure.providerId,
          toProviderId: candidate.provider.id,
          reason,
          message: `The ${firstFailure.providerId} provider could not complete the request; ${candidate.provider.id} was used instead.`,
          dialectVerified: candidate.requestedDialectVerified,
        });
      }

      await this.pinStore.set(request.projectId, selection);
      return {
        projectId: request.projectId,
        request,
        providerId: candidate.provider.id,
        profile: candidate.profile,
        selection,
        audio: providerAudio,
        audioReference,
        latencyMs: performance.now() - operationStartedAt,
        cacheHit,
        fallback,
        disclosures,
        completedAt: new Date().toISOString(),
      };
    }

    if (lastFailure) throw toPublicEngineError(lastFailure);
    if (firstFailure) throw toPublicEngineError(firstFailure.error);
    throw new VoiceEngineError("SYNTHESIS_FAILED", "No voice provider could complete the request.");
  }

  private toCandidate(
    request: VoiceSynthesisRequest,
    provider: VoiceProviderAdapter,
    profile: VoiceProfile,
    manuallySelected: boolean,
  ): RankedVoiceCandidate | undefined {
    if (!isStyleCompatible(provider, profile, request)) return undefined;
    const match = matchVoiceCapability(request, profile, manuallySelected);
    if (!match) return undefined;
    return { provider, profile, ...match };
  }

  private scoreCandidate(candidate: RankedVoiceCandidate): number {
    const health = this.healthTracker.snapshot(candidate.provider.id, true, 0, 0);
    const successRate = health.recentSuccessRate ?? 0.5;
    const latency = health.meanLatencyMs ?? 0;
    return CAPABILITY_RANK[candidate.confidence] * 1_000_000 +
      successRate * 10_000 -
      Math.min(latency, 60_000) -
      health.consecutiveFailures * 5_000;
  }

  private async synthesizeWithRetries(
    candidate: RankedVoiceCandidate,
    request: VoiceSynthesisRequest,
  ): Promise<ProviderAudio> {
    let lastFailure: VoiceProviderError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const startedAt = performance.now();
      try {
        const audio = await candidate.provider.synthesize(
          request,
          candidate.profile,
          AbortSignal.timeout(this.requestTimeoutMs),
        );
        if (audio.mimeType !== "audio/mpeg" || audio.modelId !== candidate.profile.modelId) {
          throw new VoiceProviderError(candidate.provider.id, "invalid-response");
        }
        const validatedAudio = validateProviderMp3Bytes(candidate.provider.id, audio.bytes, audio.modelId);
        this.healthTracker.record(candidate.provider.id, true, performance.now() - startedAt);
        return validatedAudio;
      } catch (error) {
        lastFailure = error instanceof VoiceProviderError
          ? error
          : new VoiceProviderError(candidate.provider.id, "unavailable");
        this.healthTracker.record(candidate.provider.id, false, performance.now() - startedAt);
        if (!lastFailure.retryable || attempt >= this.maxRetries) throw lastFailure;
        if (this.backoffMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(this.backoffMs * (attempt + 1), 1_000)));
      }
    }
    throw lastFailure ?? new VoiceProviderError(candidate.provider.id, "unavailable");
  }
}
