import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildVoiceSynthesisIdentity,
  getVoiceSynthesisCacheKey,
  VoiceCacheError,
  VoiceSynthesisCache,
} from "@/voice/cache/synthesis-cache";
import type { VoiceSynthesisIdentity } from "@/voice/contracts/voice-contract";

const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00]);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "fqmg-voice-cache-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function identity(overrides: Partial<Omit<VoiceSynthesisIdentity, "version">> = {}): VoiceSynthesisIdentity {
  return buildVoiceSynthesisIdentity({
    providerId: "openai",
    modelId: "gpt-4o-mini-tts",
    voiceId: "alloy",
    text: "  Cafe\u0301\r\n narration  ",
    requestedLanguageTag: "en-us",
    synthesisLanguageTag: "en-US",
    speakingRate: 1,
    outputFormat: "mp3",
    ...overrides,
  });
}

describe("local voice synthesis cache identity", () => {
  it("normalizes Unicode, whitespace, and BCP-47 tags deterministically", () => {
    const first = identity();
    const equivalent = identity({
      text: "Café\n narration",
      requestedLanguageTag: "en-US",
    });

    expect(first.text).toBe("Café\nnarration");
    expect(first.requestedLanguageTag).toBe("en-US");
    expect(getVoiceSynthesisCacheKey(first)).toBe(getVoiceSynthesisCacheKey(equivalent));
  });

  it("changes the cache identity for every output-affecting setting", () => {
    const baseline = identity();
    const changes: Array<Partial<Omit<VoiceSynthesisIdentity, "version">>> = [
      { providerId: "azure-speech" },
      { modelId: "another-model" },
      { voiceId: "another-voice" },
      { text: "different narration" },
      { requestedLanguageTag: "en-GB" },
      { synthesisLanguageTag: "en-GB" },
      { dialect: "Algerian Arabic" },
      { voiceStyle: "warm narration" },
      { speakingRate: 1.1 },
    ];

    for (const change of changes) {
      expect(getVoiceSynthesisCacheKey(identity(change))).not.toBe(getVoiceSynthesisCacheKey(baseline));
    }
  });
});

describe("VoiceSynthesisCache safe storage and references", () => {
  it("stores content-addressed audio, reuses an exact cache identity, and serves an opaque API reference", async () => {
    const directory = makeDirectory();
    const cache = new VoiceSynthesisCache({ directory, ttlMs: 60_000, maxAudioBytes: 1_000_000 });
    const requestIdentity = identity({ text: "Do not persist this text in cache metadata." });
    const audio = { bytes: mp3, mimeType: "audio/mpeg" as const, modelId: "gpt-4o-mini-tts" };

    const stored = await cache.put(requestIdentity, audio);
    const reference = await cache.createReference(stored.objectKey, audio.bytes.length);
    const hit = await cache.get(requestIdentity);
    const served = await cache.readReference(reference.id);

    expect(reference).toMatchObject({
      href: `/api/voice/audio/${reference.id}`,
      mimeType: "audio/mpeg",
      sizeBytes: mp3.length,
    });
    expect(reference.href).not.toContain(directory);
    expect(hit?.audio.bytes).toEqual(mp3);
    expect(served?.bytes).toEqual(mp3);
    expect(await cache.readReference("../project-voices.json")).toBeUndefined();

    const manifests = readdirSync(path.join(directory, "entries"));
    expect(manifests).toHaveLength(1);
    const manifestText = readFileSync(path.join(directory, "entries", manifests[0]), "utf8");
    expect(manifestText).not.toContain("Do not persist this text");
  });

  it("preserves managed references after the reusable cache TTL expires", async () => {
    const directory = makeDirectory();
    const cache = new VoiceSynthesisCache({ directory, ttlMs: 1, maxAudioBytes: 1_000_000 });
    const requestIdentity = identity();
    const stored = await cache.put(requestIdentity, {
      bytes: mp3,
      mimeType: "audio/mpeg",
      modelId: "gpt-4o-mini-tts",
    });
    const reference = await cache.createReference(stored.objectKey, mp3.length);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(await cache.get(requestIdentity)).toBeUndefined();
    expect((await cache.readReference(reference.id))?.bytes).toEqual(mp3);
  });

  it("replaces expired cache entries with the newly synthesized bytes", async () => {
    const directory = makeDirectory();
    const cache = new VoiceSynthesisCache({ directory, ttlMs: 60_000, maxAudioBytes: 1_000_000 });
    const requestIdentity = identity();
    const first = await cache.put(requestIdentity, {
      bytes: mp3,
      mimeType: "audio/mpeg",
      modelId: "gpt-4o-mini-tts",
    });
    const manifestPath = path.join(directory, "entries", `${getVoiceSynthesisCacheKey(requestIdentity)}.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { storedAt: string };
    manifest.storedAt = new Date(Date.now() - 120_000).toISOString();
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const updatedBytes = Buffer.from([...mp3, 0x01]);

    const refreshed = await cache.put(requestIdentity, {
      bytes: updatedBytes,
      mimeType: "audio/mpeg",
      modelId: "gpt-4o-mini-tts",
    });

    expect(refreshed.objectKey).not.toBe(first.objectKey);
    expect(refreshed.audio.bytes).toEqual(updatedBytes);
    expect((await cache.get(requestIdentity))?.audio.bytes).toEqual(updatedBytes);
  });

  it("still stores managed references when cache reuse is disabled", async () => {
    const directory = makeDirectory();
    const cache = new VoiceSynthesisCache({ directory, enabled: false, maxAudioBytes: 1_000_000 });
    const stored = await cache.put(identity(), {
      bytes: mp3,
      mimeType: "audio/mpeg",
      modelId: "gpt-4o-mini-tts",
    });
    const reference = await cache.createReference(stored.objectKey, mp3.length);

    expect(await cache.get(identity())).toBeUndefined();
    expect((await cache.readReference(reference.id))?.bytes).toEqual(mp3);
    expect(existsSync(path.join(directory, "entries"))).toBe(false);
  });

  it("rejects over-limit storage and does not leak a filesystem path", async () => {
    const directory = makeDirectory();
    const cache = new VoiceSynthesisCache({ directory, maxAudioBytes: 1 });
    await expect(cache.put(identity(), {
      bytes: mp3,
      mimeType: "audio/mpeg",
      modelId: "gpt-4o-mini-tts",
    })).rejects.toBeInstanceOf(VoiceCacheError);
  });

  it("enforces the audio-storage limit across concurrent identities", async () => {
    const directory = makeDirectory();
    const cache = new VoiceSynthesisCache({ directory, maxAudioBytes: 10 });
    const results = await Promise.allSettled([
      cache.put(identity({ text: "first identity" }), {
        bytes: mp3,
        mimeType: "audio/mpeg",
        modelId: "gpt-4o-mini-tts",
      }),
      cache.put(identity({ text: "second identity" }), {
        bytes: Buffer.from([...mp3, 0x01]),
        mimeType: "audio/mpeg",
        modelId: "gpt-4o-mini-tts",
      }),
    ]);
    const fulfilled = results.filter((entry) => entry.status === "fulfilled");
    const rejected = results.filter((entry) => entry.status === "rejected");
    const storedBytes = readdirSync(path.join(directory, "objects"))
      .reduce((sum, name) => sum + readFileSync(path.join(directory, "objects", name)).length, 0);

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(storedBytes).toBeLessThanOrEqual(10);
  });

  it("treats damaged cache objects as misses and does not serve tampered references", async () => {
    const directory = makeDirectory();
    const cache = new VoiceSynthesisCache({ directory, ttlMs: 60_000, maxAudioBytes: 1_000_000 });
    const requestIdentity = identity();
    const stored = await cache.put(requestIdentity, {
      bytes: mp3,
      mimeType: "audio/mpeg",
      modelId: "gpt-4o-mini-tts",
    });
    const reference = await cache.createReference(stored.objectKey, mp3.length);
    writeFileSync(path.join(directory, "objects", `${stored.objectKey}.mp3`), "corrupt");

    expect(await cache.get(requestIdentity)).toBeUndefined();
    expect(await cache.readReference(reference.id)).toBeUndefined();
  });
});
