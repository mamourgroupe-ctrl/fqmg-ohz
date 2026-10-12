import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
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
}

function getErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
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

async function readJsonFile(filePath: string, maxBytes: number): Promise<unknown | undefined> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size > maxBytes) return undefined;
    const text = await readFile(filePath, "utf8");
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return undefined;
    return undefined;
  }
}

export class VoiceSynthesisCache {
  readonly directory: string;
  readonly enabled: boolean;
  readonly ttlMs: number;
  readonly maxAudioBytes: number;

  private readonly objectsDirectory: string;
  private readonly entriesDirectory: string;
  private readonly referencesDirectory: string;
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
    this.objectsDirectory = path.join(this.directory, "objects");
    this.entriesDirectory = path.join(this.directory, "entries");
    this.referencesDirectory = path.join(this.directory, "references");
  }

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
      await this.writeAtomic(this.getObjectPath(objectKey), validatedAudio.bytes);
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
        await this.writeAtomic(this.getManifestPath(identityKey), JSON.stringify(manifest));
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
    await this.writeAtomic(this.getReferencePath(id), JSON.stringify(record), true);
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
    const raw = await readJsonFile(this.getReferencePath(normalizedId), 16_384);
    const parsed = AudioReferenceRecordSchema.safeParse(raw);
    if (!parsed.success || parsed.data.id.toLowerCase() !== normalizedId) return undefined;
    const bytes = await this.readObject(parsed.data.objectKey, parsed.data.sizeBytes);
    if (!bytes) return undefined;
    return { bytes, mimeType: "audio/mpeg", sizeBytes: bytes.length };
  }

  private async readManifest(identityKey: string): Promise<z.infer<typeof CacheManifestSchema> | undefined> {
    if (!HASH_PATTERN.test(identityKey)) return undefined;
    const raw = await readJsonFile(this.getManifestPath(identityKey), 16_384);
    const parsed = CacheManifestSchema.safeParse(raw);
    return parsed.success && parsed.data.identityKey === identityKey ? parsed.data : undefined;
  }

  private async readObject(objectKey: string, expectedSize: number): Promise<Buffer | undefined> {
    if (!HASH_PATTERN.test(objectKey) || !Number.isInteger(expectedSize) || expectedSize <= 0 || expectedSize > MAX_AUDIO_BYTES) {
      return undefined;
    }
    try {
      const filePath = this.getObjectPath(objectKey);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile() || fileStat.size !== expectedSize || fileStat.size > MAX_AUDIO_BYTES) return undefined;
      const bytes = await readFile(filePath);
      if (bytes.length !== expectedSize || hash(bytes) !== objectKey) return undefined;
      return bytes;
    } catch {
      return undefined;
    }
  }

  private async ensureObjectCapacity(objectKey: string, newSize: number): Promise<void> {
    if (await this.readObject(objectKey, newSize)) return;

    try {
      const entries = await readdir(this.objectsDirectory, { withFileTypes: true });
      let storedBytes = 0;
      for (const entry of entries) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.mp3$/.test(entry.name)) continue;
        try {
          storedBytes += (await stat(path.join(this.objectsDirectory, entry.name))).size;
        } catch {
          // A concurrent cache write can remove a temporary object between directory listing and stat.
        }
      }
      if (storedBytes + newSize > this.maxAudioBytes) {
        throw new VoiceCacheError("The configured local voice-audio storage limit has been reached.");
      }
    } catch (error) {
      if (error instanceof VoiceCacheError) throw error;
      if (getErrorCode(error) !== "ENOENT") throw new VoiceCacheError();
      if (newSize > this.maxAudioBytes) {
        throw new VoiceCacheError("The configured local voice-audio storage limit has been reached.");
      }
    }
  }

  private async writeAtomic(filePath: string, data: string | Buffer, exclusive = false): Promise<void> {
    let temporaryPath: string | undefined;
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      if (exclusive) {
        try {
          await writeFile(filePath, data, { flag: "wx", mode: 0o600 });
          return;
        } catch (error) {
          if (getErrorCode(error) === "EEXIST") throw new VoiceCacheError("Audio reference ID collision.");
          throw error;
        }
      }
      temporaryPath = path.join(path.dirname(filePath), `.voice-${randomUUID()}.tmp`);
      await writeFile(temporaryPath, data, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, filePath);
      temporaryPath = undefined;
    } catch (error) {
      if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof VoiceCacheError) throw error;
      throw new VoiceCacheError();
    }
  }

  private getObjectPath(objectKey: string): string {
    if (!HASH_PATTERN.test(objectKey)) throw new VoiceCacheError("Invalid local audio object reference.");
    return path.join(this.objectsDirectory, `${objectKey}.mp3`);
  }

  private getManifestPath(identityKey: string): string {
    if (!HASH_PATTERN.test(identityKey)) throw new VoiceCacheError("Invalid voice cache identity.");
    return path.join(this.entriesDirectory, `${identityKey}.json`);
  }

  private getReferencePath(referenceId: string): string {
    if (!UUID_PATTERN.test(referenceId)) throw new VoiceCacheError("Invalid local audio reference.");
    return path.join(this.referencesDirectory, `${referenceId.toLowerCase()}.json`);
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
