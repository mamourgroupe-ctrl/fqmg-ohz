import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * Phase 5 — voice-audio object storage behind one interface.
 *
 * `VoiceSynthesisCache` owns the POLICY (identity validation, mp3 validation,
 * TTL, capacity on the local disk); implementations of this interface own the
 * BYTES and the small JSON records:
 *  - LocalVoiceObjectStore: the on-disk layout the cache always used
 *    (objects/, entries/, references/ under one directory), atomic writes.
 *  - S3VoiceObjectStore: any S3-compatible endpoint (AWS S3, MinIO, R2,
 *    Wasabi...) with an in-repo SigV4 implementation (zero dependencies),
 *    so the voice cache can be shared across instances. Exclusive record
 *    writes use the If-None-Match precondition, like the local O_EXCL flag.
 */

export interface VoiceObjectStore {
  readonly kind: "local-fs" | "s3";
  getObject(key: string): Promise<Buffer | undefined>;
  putObject(key: string, bytes: Buffer): Promise<void>;
  getRecord(name: string): Promise<unknown | undefined>;
  /** `exclusive: true` fails with a collision error when the name exists. */
  putRecord(name: string, value: unknown, options?: { exclusive?: boolean }): Promise<void>;
  /** Local capability: total bytes currently stored as objects (capacity check). */
  totalObjectBytes?(): Promise<number>;
}

export class VoiceObjectCollisionError extends Error {
  constructor(name: string) {
    super(`A record named ${name} already exists.`);
    this.name = "VoiceObjectCollisionError";
  }
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9/._-]{0,300}$/i;

function assertSafeKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.includes("..")) {
    throw new Error(`Invalid object-store key: refused.`);
  }
}

// ─── Local FS implementation (the original layout, extracted) ────────────────

export class LocalVoiceObjectStore implements VoiceObjectStore {
  readonly kind = "local-fs" as const;
  readonly directory: string;

  constructor(options: { directory: string }) {
    this.directory = path.resolve(options.directory);
  }

  private resolve(key: string): string {
    assertSafeKey(key);
    const resolved = path.resolve(this.directory, key);
    if (!resolved.startsWith(this.directory + path.sep)) {
      throw new Error("Invalid object-store key: refused.");
    }
    return resolved;
  }

  async getObject(key: string): Promise<Buffer | undefined> {
    try {
      const filePath = this.resolve(key);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return undefined;
      return await readFile(filePath);
    } catch {
      return undefined;
    }
  }

  async putObject(key: string, bytes: Buffer): Promise<void> {
    const filePath = this.resolve(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = path.join(path.dirname(filePath), `.voice-${randomUUID()}.tmp`);
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    try {
      await rename(temporaryPath, filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async getRecord(name: string): Promise<unknown | undefined> {
    try {
      const filePath = this.resolve(name);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile() || fileStat.size > 16_384) return undefined;
      const text = await readFile(filePath, "utf8");
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }

  async putRecord(name: string, value: unknown, options?: { exclusive?: boolean }): Promise<void> {
    const filePath = this.resolve(name);
    await mkdir(path.dirname(filePath), { recursive: true });
    const data = JSON.stringify(value);
    try {
      await writeFile(filePath, data, {
        flag: options?.exclusive ? "wx" : "w",
        mode: 0o600,
      });
    } catch (error) {
      if (options?.exclusive && error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        throw new VoiceObjectCollisionError(name);
      }
      throw error;
    }
  }

  async totalObjectBytes(): Promise<number> {
    try {
      const objectsDirectory = path.join(this.directory, "objects");
      const entries = await readdir(objectsDirectory, { withFileTypes: true });
      let total = 0;
      for (const entry of entries) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.mp3$/.test(entry.name)) continue;
        try {
          total += (await stat(path.join(objectsDirectory, entry.name))).size;
        } catch {
          // a concurrent writer can remove a file between listing and stat
        }
      }
      return total;
    } catch {
      return 0;
    }
  }
}

// ─── S3-compatible implementation (SigV4, zero dependencies) ─────────────────

function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

export interface SigV4Input {
  method: string;
  pathname: string;
  query: string;
  headers: Record<string, string>;
  bodyHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  amzDate: string;
}

/**
 * Produces the AWS Signature Version 4 Authorization header.
 * Pinned by the official AWS documentation test vector in
 * tests/voice-object-store.test.ts.
 */
export function signWithSigV4(input: SigV4Input): string {
  const sortedHeaders = Object.keys(input.headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = sortedHeaders.map((name) => `${name}:${input.headers[name]?.trim()}\n`).join("");
  const signedHeaders = sortedHeaders.join(";");

  const canonicalRequest = [
    input.method,
    input.pathname,
    input.query,
    canonicalHeaders,
    signedHeaders,
    input.bodyHash,
  ].join("\n");

  const date = input.amzDate.slice(0, 8);
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const dateKey = hmac(`AWS4${input.secretAccessKey}`, date);
  const regionKey = hmac(dateKey, input.region);
  const serviceKey = hmac(regionKey, input.service);
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export interface S3VoiceObjectStoreOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Request timeout in ms (default 10s). */
  timeoutMs?: number;
}

export class S3VoiceObjectStore implements VoiceObjectStore {
  readonly kind = "s3" as const;
  private readonly endpoint: string;
  private readonly region: string;
  private readonly bucket: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly timeoutMs: number;

  constructor(options: S3VoiceObjectStoreOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.region = options.region;
    this.bucket = options.bucket;
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private requestUrl(key: string): { url: string; pathname: string } {
    assertSafeKey(key);
    // path-style addressing: works against MinIO/R2/Wasabi and AWS alike
    const encoded = key.split("/").map(encodeURIComponent).join("/");
    const pathname = `/${this.bucket}/${encoded}`;
    return { url: `${this.endpoint}${pathname}`, pathname };
  }

  private async dispatch(
    method: "GET" | "PUT",
    key: string,
    body?: Buffer,
    preconditions?: Record<string, string>,
  ): Promise<{ status: number; bytes: Buffer }> {
    const { url, pathname } = this.requestUrl(key);
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const bodyHash = sha256Hex(body ?? Buffer.alloc(0));
    const headers: Record<string, string> = {
      host: new URL(url).host,
      "x-amz-content-sha256": bodyHash,
      "x-amz-date": amzDate,
      ...Object.fromEntries(Object.entries(preconditions ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    };
    if (method === "PUT") headers["content-type"] = key.endsWith(".json") ? "application/json" : "audio/mpeg";

    const authorization = signWithSigV4({
      method,
      pathname,
      query: "",
      headers,
      bodyHash,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      region: this.region,
      service: "s3",
      amzDate,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: { ...headers, authorization },
        ...(body ? { body: new Uint8Array(body) } : {}),
        signal: controller.signal,
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      return { status: response.status, bytes };
    } finally {
      clearTimeout(timer);
    }
  }

  async getObject(key: string): Promise<Buffer | undefined> {
    const { status, bytes } = await this.dispatch("GET", key);
    if (status === 404) return undefined;
    if (status !== 200) throw new Error(`object get failed with status ${status}`);
    return bytes;
  }

  async putObject(key: string, bytes: Buffer): Promise<void> {
    const { status } = await this.dispatch("PUT", key, bytes);
    if (status !== 200 && status !== 204) throw new Error(`object put failed with status ${status}`);
  }

  async getRecord(name: string): Promise<unknown | undefined> {
    const bytes = await this.getObject(name);
    if (!bytes || bytes.length === 0 || bytes.length > 16_384) return undefined;
    try {
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      return undefined;
    }
  }

  async putRecord(name: string, value: unknown, options?: { exclusive?: boolean }): Promise<void> {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    const preconditions = options?.exclusive ? { "If-None-Match": "*" } : undefined;
    const { status } = await this.dispatch("PUT", name, body, preconditions);
    if (status === 200 || status === 204) return;
    if (status === 412 || status === 409) throw new VoiceObjectCollisionError(name);
    throw new Error(`record put failed with status ${status}`);
  }
}
