import { connectRedis, storeUnavailable, type RedisHandle } from "@/shared/redis-client";
import type { AgentJobStatus } from "@/agent/job-store";
import { ACTIVE_JOB_STATUSES } from "@/agent/job-store";
import type { AgentLoopResult } from "@/agent/loop";

/**
 * Phase 5 — the persistable subset of an agent job.
 *
 * The live record holds an AbortController and the run closure: those are
 * inherently instance-local. Everything the BROWSER (or a second instance)
 * needs — identity, ownership, status, progress, the final result — is here
 * and is safe to persist as JSON.
 */
export interface JobStateRecord {
  jobId: string;
  taskId: string;
  dedupeKey: string;
  owner?: string;
  status: AgentJobStatus;
  stage: string;
  progress: number;
  createdAt: number;
  updatedAt: number;
  result: AgentLoopResult | null;
  error: string | null;
  localPaths: string[];
}

export interface JobStateStore {
  readonly kind: "process-local" | "shared-redis";
  put(record: JobStateRecord, ttlMs: number): Promise<void>;
  get(jobId: string): Promise<JobStateRecord | undefined>;
  /** Returns the id of an ACTIVE job with this dedupe key, if any. */
  findActiveIdByDedupeKey(dedupeKey: string): Promise<string | undefined>;
  setCancelRequested(jobId: string, ttlMs: number): Promise<void>;
  isCancelRequested(jobId: string): Promise<boolean>;
  close(): Promise<void>;
}

// ─── Redis implementation ─────────────────────────────────────────────────────

interface StateClient {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, options?: { PX?: number }): Promise<unknown>;
  expire(key: string, seconds: number): Promise<number>;
  del(key: string): Promise<number>;
  hGet(key: string, field: string): Promise<string | undefined>;
  hSet(key: string, field: string, value: string): Promise<number>;
  hDel(key: string, field: string): Promise<number>;
}

export class RedisJobStateStore implements JobStateStore {
  readonly kind = "shared-redis" as const;
  private readonly namespace: string;
  private readonly redisUrl: string;
  private readonly connectTimeoutMs: number;
  private handle: Promise<RedisHandle> | null = null;
  private dead = false;

  constructor(options: { redisUrl: string; namespace: string; connectTimeoutMs?: number }) {
    this.redisUrl = options.redisUrl;
    this.namespace = options.namespace;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 3_000;
  }

  private keys(): { jobPrefix: string; activeKey: string; cancelPrefix: string } {
    const base = `fqmg:j:${this.namespace}:`;
    return { jobPrefix: `${base}job:`, activeKey: `${base}active`, cancelPrefix: `${base}cancel:` };
  }

  private async client(): Promise<StateClient> {
    if (this.dead) throw storeUnavailable(new Error("store closed"));
    this.handle ??= connectRedis({
      redisUrl: this.redisUrl,
      connectTimeoutMs: this.connectTimeoutMs,
    }).catch((error: unknown) => {
      this.handle = null;
      throw error;
    });
    const handle = await this.handle;
    return handle.client as unknown as StateClient;
  }

  async put(record: JobStateRecord, ttlMs: number): Promise<void> {
    const { jobPrefix, activeKey } = this.keys();
    try {
      const client = await this.client();
      await client.set(`${jobPrefix}${record.jobId}`, JSON.stringify(record), { PX: ttlMs });
      if (ACTIVE_JOB_STATUSES.includes(record.status)) {
        await client.hSet(activeKey, record.dedupeKey, record.jobId);
        await client.expire(activeKey, Math.ceil(ttlMs / 1_000));
      } else {
        await client.hDel(activeKey, record.dedupeKey);
      }
    } catch (error) {
      // registry mirroring is best-effort: a dead store must not crash the loop,
      // but it IS logged so operators see the degradation.
      console.error("[shared-state] job mirror write failed:", error instanceof Error ? error.message.slice(0, 120) : "unknown");
    }
  }

  async get(jobId: string): Promise<JobStateRecord | undefined> {
    const { jobPrefix } = this.keys();
    try {
      const raw = await (await this.client()).get(`${jobPrefix}${jobId}`);
      if (!raw) return undefined;
      return JSON.parse(raw) as JobStateRecord;
    } catch {
      return undefined;
    }
  }

  async findActiveIdByDedupeKey(dedupeKey: string): Promise<string | undefined> {
    const { activeKey, jobPrefix } = this.keys();
    try {
      const client = await this.client();
      const jobId = await client.hGet(activeKey, dedupeKey);
      if (!jobId) return undefined;
      const raw = await client.get(`${jobPrefix}${jobId}`);
      if (!raw) return undefined; // stale index entry
      const record = JSON.parse(raw) as JobStateRecord;
      if (!ACTIVE_JOB_STATUSES.includes(record.status)) return undefined;
      return jobId;
    } catch {
      return undefined;
    }
  }

  async setCancelRequested(jobId: string, ttlMs: number): Promise<void> {
    const { cancelPrefix } = this.keys();
    try {
      await (await this.client()).set(`${cancelPrefix}${jobId}`, "1", { PX: ttlMs });
    } catch (error) {
      console.error("[shared-state] cancel flag write failed:", error instanceof Error ? error.message.slice(0, 120) : "unknown");
    }
  }

  async isCancelRequested(jobId: string): Promise<boolean> {
    const { cancelPrefix } = this.keys();
    try {
      return Boolean(await (await this.client()).get(`${cancelPrefix}${jobId}`));
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.dead = true;
    const handle = this.handle;
    this.handle = null;
    if (handle) {
      const resolved = await handle.catch(() => undefined);
      await resolved?.close();
    }
  }
}

/** Factory used by the runtime wiring (see src/agent/runtime.ts). */
export function createRedisJobStateStore(options: {
  redisUrl: string;
  namespace: string;
  connectTimeoutMs?: number;
}): RedisJobStateStore {
  return new RedisJobStateStore(options);
}
