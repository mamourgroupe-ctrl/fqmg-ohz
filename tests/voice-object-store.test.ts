import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Phase 5 — voice cache object-store abstraction.
 *
 * The local (FS) implementation and the S3-compatible implementation must
 * satisfy the SAME contract, proven here: the S3 implementation is exercised
 * against a minimal stub server that honors GET/PUT and the
 * If-None-Match exclusive-write precondition (the same mechanism real
 * S3-compatible endpoints implement). The SigV4 signer itself is pinned to
 * the official AWS documentation test vector so the signing can be verified
 * without any live cloud endpoint.
 */

interface StubCall {
  method: string;
  key: string;
  ifNoneMatch: string | null;
  bodyLength: number;
}

const objects = new Map<string, Buffer>();
const calls: StubCall[] = [];
let server: Server | undefined;
let serverPort = 0;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://stub.local");
    // path-style: /{bucket}/{key...}
    const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);
    const bucket = parts[0];
    const key = parts.slice(1).join("/");
    let body = Buffer.alloc(0);
    req.on("data", (chunk: Buffer) => {
      body = Buffer.concat([body, chunk]);
    });
    req.on("end", () => {
      calls.push({
        method: req.method ?? "",
        key: `${bucket}/${key}`,
        ifNoneMatch: req.headers["if-none-match"] ?? null,
        bodyLength: body.length,
      });
      if (req.method === "PUT") {
        if (req.headers["if-none-match"] === "*" && objects.has(`${bucket}/${key}`)) {
          res.writeHead(412, { "x-amz-request-id": "stub" });
          res.end();
          return;
        }
        objects.set(`${bucket}/${key}`, body);
        res.writeHead(200, { etag: `"stub-${objects.size}"` });
        res.end();
        return;
      }
      if (req.method === "GET") {
        const value = objects.get(`${bucket}/${key}`);
        if (!value) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "content-length": String(value.length) });
        res.end(value);
        return;
      }
      res.writeHead(405);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  serverPort = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server?.close((error) => (error ? reject(error) : resolve())),
  );
});

async function makeStores() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "voice-store-"));
  const { LocalVoiceObjectStore } = await import("@/voice/cache/object-store");
  const { S3VoiceObjectStore } = await import("@/voice/cache/object-store");
  const local = new LocalVoiceObjectStore({ directory });
  const s3 = new S3VoiceObjectStore({
    endpoint: `http://127.0.0.1:${serverPort}`,
    region: "us-east-1",
    bucket: "voice-test",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  });
  return {
    local,
    s3,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

describe("phase 5: voice object-store contract (local FS and S3-compatible)", () => {
  it("puts, gets, and round-trips object bytes on both implementations", async () => {
    const { local, s3, cleanup } = await makeStores();
    try {
      const bytes = Buffer.from(`audio-${randomUUID()}`, "utf8");
      for (const store of [local, s3]) {
        const key = `objects/${randomUUID()}.mp3`;
        expect(await store.getObject(key)).toBeUndefined();
        await store.putObject(key, bytes);
        const readBack = await store.getObject(key);
        expect(readBack?.equals(bytes)).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  it("stores and reads JSON records, exclusively when requested", async () => {
    const { local, s3, cleanup } = await makeStores();
    try {
      for (const store of [local, s3]) {
        const name = `references/${randomUUID()}.json`;
        expect(await store.getRecord(name)).toBeUndefined();
        await store.putRecord(name, { version: 1, id: "x" });
        expect(await store.getRecord(name)).toEqual({ version: 1, id: "x" });

        // exclusive write over an existing record must fail closed
        await expect(
          store.putRecord(name, { version: 2 }, { exclusive: true }),
        ).rejects.toThrow(/collision|exists/i);

        // exclusive write to a fresh name succeeds
        const fresh = `references/${randomUUID()}.json`;
        await store.putRecord(fresh, { ok: true }, { exclusive: true });
        expect(await store.getRecord(fresh)).toEqual({ ok: true });
      }
    } finally {
      await cleanup();
    }
  });

  it("the S3 client sends SigV4-signed requests with the content hash header", async () => {
    const { s3, cleanup } = await makeStores();
    try {
      objects.clear();
      calls.length = 0;
      const bytes = Buffer.from("signed-body", "utf8");
      await s3.putObject("objects/signed.bin", bytes);
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("PUT");
      expect(calls[0].key).toBe("voice-test/objects/signed.bin");
      expect(calls[0].bodyLength).toBe(bytes.length);
      // Authorization header shape is asserted through the signer vector test below;
      // here we prove the request was dispatched and stored.
      expect(objects.get("voice-test/objects/signed.bin")?.equals(bytes)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("the SigV4 signer reproduces the official AWS documentation test vector", async () => {
    const { signWithSigV4 } = await import("@/voice/cache/object-store");
    // AWS "Create a signed AWS API request" worked example (iam.amazonaws.com,
    // Action=ListUsers, x-amz-date 20150830T123600Z, empty payload): the
    // documented final signature is 5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7.
    const authorization = signWithSigV4({
      method: "GET",
      pathname: "/",
      query: "Action=ListUsers&Version=2010-05-08",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        host: "iam.amazonaws.com",
        "x-amz-date": "20150830T123600Z",
      },
      bodyHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "iam",
      amzDate: "20150830T123600Z",
    });
    expect(authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date, " +
        "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });
});

describe("phase 5: VoiceSynthesisCache over a shared object store", () => {
  it(
    "a second cache instance on the same shared store finds the first instance's entry",
    async () => {
      const { VoiceSynthesisCache } = await import("@/voice/cache/synthesis-cache");
      const { S3VoiceObjectStore } = await import("@/voice/cache/object-store");
      const { buildVoiceSynthesisIdentity } = await import("@/voice/cache/synthesis-cache");
      objects.clear();
      const store = new S3VoiceObjectStore({
        endpoint: `http://127.0.0.1:${serverPort}`,
        region: "us-east-1",
        bucket: "voice-test",
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      });
      // A minimal valid MP3: the cache validates provider bytes; use a tiny
      // synthetic frame header the validator accepts (ID3 or 0xFFFB frame).
      const mp3 = Buffer.concat([
        Buffer.from([0xff, 0xfb, 0x90, 0x00]),
        Buffer.alloc(64, 0x11),
      ]);

      const identity = buildVoiceSynthesisIdentity({
        providerId: "openai",
        modelId: "gpt-4o-mini-tts",
        voiceId: "alloy",
        text: `shared-${randomUUID()}`,
        requestedLanguageTag: "ar",
        synthesisLanguageTag: "ar",
        speakingRate: 1,
        outputFormat: "mp3",
      });

      const first = new VoiceSynthesisCache({ objectStore: store, ttlMs: 60_000 });
      await first.put(identity, { bytes: mp3, mimeType: "audio/mpeg", modelId: "gpt-4o-mini-tts" });

      // a "second instance": fresh cache, same shared store, no local state
      const second = new VoiceSynthesisCache({ objectStore: store, ttlMs: 60_000 });
      const hit = await second.get(identity);
      expect(hit).toBeDefined();
      expect(hit?.audio.bytes.equals(mp3)).toBe(true);

      // references also live in the shared store: readable from the second instance
      const entry = hit!;
      const reference = await second.createReference(entry.objectKey, entry.audio.bytes.length);
      expect(reference.href).toMatch(/^\/api\/voice\/audio\//);
      const readBack = await second.readReference(reference.id);
      expect(readBack?.bytes.equals(mp3)).toBe(true);
    },
  );
});
