import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  MAX_AUDIO_BYTES,
  VoiceAudioReferenceSchema,
  VoiceSynthesisIdentitySchema,
  type VoiceAudioReference,
  type VoiceSynthesisIdentity,
} from "@/voice/contracts/voice-contract";
import { validateProviderMp3Bytes } from "@/voice/providers/provider-utils";
import {
  LocalVoiceObjectStore,
  S3VoiceObjectStore,
  VoiceObjectCollisionError,
  type VoiceObjectStore,
} from "@/voice/cache/object-store";
import type { ProviderAudio, VoiceProviderEnvironment } from "@/voice/providers/provider";

const DEFAULT_MAX_AUDIO_BYTES = 1024 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CacheManifestSchema = z.object({
  version: z.literal(1),
  identityKey: z.string().regex(HASH_PATTERN),
  objectKey: z.string().regex(HASH_PATTERN),
  mimeType: z.literal("audio/mpeg"),
  sizeBytes: z.number().int().positive().max(MAX_AUDIO_BYTES),
  storedAt: z.string().datetime(),
}).strict();
const AudioReferenceRecordSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(UUID_PATTERN),
  objectKey: z.string().regex(HASH_PATTERN),
  mimeType: z.literal("audio/mpeg"),
  sizeBytes: z.number().int().positive().max(MAX_AUDIO_BYTES),
  createdAt: z.string().datetime(),
}).strict();

export class VoiceCacheError extends Error {
  constructor(message = "Local voice audio storage is unavailable.") {
    super(message);
    this.name = "VoiceCacheError";
  }
}

export interface VoiceCacheEntry {
  identityKey: string;
  objectKey: string;
  audio: ProviderAudio;
  storedAt: string;
}

export interface VoiceSynthesisCacheOptions {
  directory?: string;
  enabled?: boolean;
  ttlMs?: number;
  maxAudioBytes?: number;
  environment?: VoiceProviderEnvironment;
  /** Phase 5: explicit object store override (tests / programmatic wiring). */
  objectStore?: VoiceObjectStore;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalIdentityJson(identity: VoiceSynthesisIdentity): string {
  return JSON.stringify({
    version: identity.version,
    providerId: identity.providerId,
    modelId: identity.modelId,
    voiceId: identity.voiceId,
    text: identity.text,
    requestedLanguageTag: identity.requestedLanguageTag,
    synthesisLanguageTag: identity.synthesisLanguageTag,
    dialect: identity.dialect ?? null,
    voiceStyle: identity.voiceStyle ?? null,
    speakingRate: identity.speakingRate,
    outputFormat: identity.outputFormat,
  });
}

export function buildVoiceSynthesisIdentity(input: {
  providerId: VoiceSynthesisIdentity["providerId"];
  modelId: string;
  voiceId: string;
  text: string;
  requestedLanguageTag: string;
  synthesisLanguageTag: string;
  dialect?: string;
  voiceStyle?: string;
  speakingRate: number;
  outputFormat: "mp3";
}): VoiceSynthesisIdentity {
  return VoiceSynthesisIdentitySchema.parse({ version: 1, ...input });
}

export function getVoiceSynthesisCacheKey(identity: VoiceSynthesisIdentity): string {
  return hash(canonicalIdentityJson(VoiceSynthesisIdentitySchema.parse(identity)));
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value?.trim()) return fallback;
  return !["false", "0", "off", "no"].includes(value.trim().toLowerCase());
}

function parseNonnegativeInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(maximum, parsed));
}

export class VoiceSynthesisCache {
  readonly directory: string;
  readonly enabled: boolean;
  readonly ttlMs: number;
  readonly maxAudioBytes: number;

  private readonly keyTails = new Map<string, Promise<void>>();

  constructor(options: VoiceSynthesisCacheOptions = {}) {
    const environment = options.environment ?? process.env;
    this.directory = path.resolve(
      /*turbopackIgnore: true*/ options.directory ?? environment.VOICE_CACHE_DIR?.trim() ?? path.join(process.cwd(), ".voice-cache"),
    );
    this.enabled = options.enabled ?? parseBoolean(environment.VOICE_CACHE_ENABLED, true);
    const ttlHours = parseNonnegativeInteger(environment.VOICE_CACHE_TTL_HOURS, 168, 87_600);
    const configuredTtlMs = options.ttlMs ?? ttlHours * 60 * 60 * 1_000;
    this.ttlMs = Number.isFinite(configuredTtlMs)
      ? Math.max(0, Math.min(87_600 * 60 * 60 * 1_000, Math.floor(configuredTtlMs)))
      : 168 * 60 * 60 * 1_000;
    const configuredMaxAudioBytes = options.maxAudioBytes ?? parseNonnegativeInteger(
      environment.VOICE_CACHE_MAX_BYTES,
      DEFAULT_MAX_AUDIO_BYTES,
      100 * 1024 * 1024 * 1024,
    );
    this.maxAudioBytes = Number.isFinite(configuredMaxAudioBytes)
      ? Math.max(1, Math.min(100 * 1024 * 1024 * 1024, Math.floor(configuredMaxAudioBytes)))
      : DEFAULT_MAX_AUDIO_BYTES;
    if (options.objectStore) {
      this.store = options.objectStore;
    } else if (environment.VOICE_CACHE_STORE === "s3") {
      // Phase 5 shared voice cache: any S3-compatible bucket. Missing
      // configuration disables caching rather than half-configuring it.
      const endpoint = environment.FQMG_S3_ENDPOINT?.trim();
      const bucket = environment.FQMG_S3_BUCKET?.trim();
      const accessKeyId = environment.FQMG_S3_ACCESS_KEY_ID?.trim();
      const secretAccessKey = environment.FQMG_S3_SECRET_ACCESS_KEY?.trim();
      if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
        this.enabled = false;
        this.store = new LocalVoiceObjectStore({ directory: this.directory });
      } else {
        this.store = new S3VoiceObjectStore({
          endpoint,
          bucket,
          accessKeyId,
          secretAccessKey,
          region: environment.FQMG_S3_REGION?.trim() || "us-east-1",
        });
      }
    } else {
      this.store = new LocalVoiceObjectStore({ directory: this.directory });
    }
  }

  private readonly store: VoiceObjectStore;

  async get(identity: VoiceSynthesisIdentity): Promise<VoiceCacheEntry | undefined> {
    if (!this.enabled || this.ttlMs === 0) return undefined;
    const parsedIdentity = VoiceSynthesisIdentitySchema.safeParse(identity);
    if (!parsedIdentity.success) throw new VoiceCacheError("Invalid voice cache identity.");
    const identityKey = getVoiceSynthesisCacheKey(parsedIdentity.data);
    const manifest = await this.readManifest(identityKey);
    if (!manifest || Date.now() - Date.parse(manifest.storedAt) > this.ttlMs) return undefined;

    const bytes = await this.readObject(manifest.objectKey, manifest.sizeBytes);
    if (!bytes) return undefined;
    try {
      const audio = validateProviderMp3Bytes(parsedIdentity.data.providerId, bytes, parsedIdentity.data.modelId);
      return { identityKey, objectKey: manifest.objectKey, audio, storedAt: manifest.storedAt };
    } catch {
      return undefined;
    }
  }

  async put(identity: VoiceSynthesisIdentity, audio: ProviderAudio): Promise<VoiceCacheEntry> {
    const parsedIdentity = VoiceSynthesisIdentitySchema.safeParse(identity);
    if (!parsedIdentity.success || audio.mimeType !== "audio/mpeg" || audio.modelId !== parsedIdentity.data?.modelId) {
      throw new VoiceCacheError("Voice audio did not match its validated cache identity.");
    }

    let validatedAudio: ProviderAudio;
    try {
      validatedAudio = validateProviderMp3Bytes(parsedIdentity.data.providerId, audio.bytes, parsedIdentity.data.modelId);
    } catch {
      throw new VoiceCacheError("Provider audio could not be validated for local storage.");
    }

    const identityKey = getVoiceSynthesisCacheKey(parsedIdentity.data);
    const objectKey = hash(validatedAudio.bytes);
    const reuseEnabled = this.enabled && this.ttlMs > 0;
    return this.withKeyLock(identityKey, () => this.withKeyLock("storage-write-capacity", async () => {
      const existingManifest = reuseEnabled ? await this.readManifest(identityKey) : undefined;
      const existingManifestIsFresh = Boolean(
        existingManifest && Date.now() - Date.parse(existingManifest.storedAt) <= this.ttlMs,
      );
      const existingBytes = existingManifestIsFresh && existingManifest
        ? await this.readObject(existingManifest.objectKey, existingManifest.sizeBytes)
        : undefined;
      if (existingManifest && existingBytes) {
        return {
          identityKey,
          objectKey: existingManifest.objectKey,
          audio: validateProviderMp3Bytes(parsedIdentity.data.providerId, existingBytes, parsedIdentity.data.modelId),
          storedAt: existingManifest.storedAt,
        };
      }

      await this.ensureObjectCapacity(objectKey, validatedAudio.bytes.length);
      await this.store.putObject(`objects/${objectKey}.mp3`, validatedAudio.bytes);
      const storedAt = new Date().toISOString();
      if (reuseEnabled) {
        const manifest = CacheManifestSchema.parse({
          version: 1,
          identityKey,
          objectKey,
          mimeType: "audio/mpeg",
          sizeBytes: validatedAudio.bytes.length,
          storedAt,
        });
        await this.store.putRecord(`entries/${identityKey}.json`, manifest);
      }
      return { identityKey, objectKey, audio: validatedAudio, storedAt };
    }));
  }

  async createReference(objectKey: string, sizeBytes: number): Promise<VoiceAudioReference> {
    if (!HASH_PATTERN.test(objectKey)) throw new VoiceCacheError("Invalid local audio object reference.");
    const bytes = await this.readObject(objectKey, sizeBytes);
    if (!bytes) throw new VoiceCacheError("Generated audio is not available in local storage.");

    const id = randomUUID();
    const record = AudioReferenceRecordSchema.parse({
      version: 1,
      id,
      objectKey,
      mimeType: "audio/mpeg",
      sizeBytes: bytes.length,
      createdAt: new Date().toISOString(),
    });
    try {
      await this.store.putRecord(`references/${id.toLowerCase()}.json`, record, { exclusive: true });
    } catch (error) {
      if (error instanceof VoiceObjectCollisionError) {
        throw new VoiceCacheError("Audio reference ID collision.");
      }
      throw error;
    }
    return VoiceAudioReferenceSchema.parse({
      id,
      href: `/api/voice/audio/${id}`,
      mimeType: "audio/mpeg",
      sizeBytes: bytes.length,
    });
  }

  async readReference(referenceId: string): Promise<{ bytes: Buffer; mimeType: "audio/mpeg"; sizeBytes: number } | undefined> {
    if (!UUID_PATTERN.test(referenceId)) return undefined;
    const normalizedId = referenceId.toLowerCase();
    const raw = await this.store.getRecord(`references/${normalizedId}.json`);
    const parsed = AudioReferenceRecordSchema.safeParse(raw);
    if (!parsed.success || parsed.data.id.toLowerCase() !== normalizedId) return undefined;
    const bytes = await this.readObject(parsed.data.objectKey, parsed.data.sizeBytes);
    if (!bytes) return undefined;
    return { bytes, mimeType: "audio/mpeg", sizeBytes: bytes.length };
  }

  private async readManifest(identityKey: string): Promise<z.infer<typeof CacheManifestSchema> | undefined> {
    if (!HASH_PATTERN.test(identityKey)) return undefined;
    const raw = await this.store.getRecord(`entries/${identityKey}.json`);
    const parsed = CacheManifestSchema.safeParse(raw);
    return parsed.success && parsed.data.identityKey === identityKey ? parsed.data : undefined;
  }

  private async readObject(objectKey: string, expectedSize: number): Promise<Buffer | undefined> {
    if (!HASH_PATTERN.test(objectKey) || !Number.isInteger(expectedSize) || expectedSize <= 0 || expectedSize > MAX_AUDIO_BYTES) {
      return undefined;
    }
    try {
      const bytes = await this.store.getObject(`objects/${objectKey}.mp3`);
      if (!bytes || bytes.length !== expectedSize || bytes.length > MAX_AUDIO_BYTES) return undefined;
      if (hash(bytes) !== objectKey) return undefined;
      return bytes;
    } catch {
      return undefined;
    }
  }

  private async ensureObjectCapacity(objectKey: string, newSize: number): Promise<void> {
    if (await this.readObject(objectKey, newSize)) return;

    // The capacity ceiling is a LOCAL-disk control (phase 5): shared object
    // stores delegate capacity to the bucket lifecycle/policy instead.
    const totalObjectBytes = this.store.totalObjectBytes?.bind(this.store);
    if (!totalObjectBytes) return;
    const storedBytes = await totalObjectBytes();
    if (storedBytes + newSize > this.maxAudioBytes) {
      throw new VoiceCacheError("The configured local voice-audio storage limit has been reached.");
    }
  }

  private async withKeyLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.keyTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => tail);
    this.keyTails.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.keyTails.get(key) === queued) this.keyTails.delete(key);
    }
  }
}
